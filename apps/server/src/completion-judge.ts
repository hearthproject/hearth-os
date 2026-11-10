import { createHash } from "node:crypto";
import { exec, execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type {
  ArtifactRecord,
  EffectRecord,
  GoalCompletionReport,
  GoalContract,
  GoalCriterion,
  GoalCriterionResult,
  TaskRecord
} from "@hearth/core";

export interface GoalValidatorContext {
  goal: GoalContract;
  task: TaskRecord;
  criterion: GoalCriterion;
  artifact: ArtifactRecord | null;
  workspaceRoot: string | null;
}

export interface GoalValidatorRunnerResult {
  status: "passed" | "failed" | "not_run" | "not_required";
  evidenceRefs?: string[];
  detail: string;
}

export type GoalValidatorRunner = (
  context: GoalValidatorContext
) => GoalValidatorRunnerResult | Promise<GoalValidatorRunnerResult>;

export interface CompletionJudgeInput {
  goal: GoalContract;
  task: TaskRecord;
  artifacts: ArtifactRecord[];
  effects: EffectRecord[];
  workspaceRoot?: string | null;
  observedActions?: string[];
  validators?: Record<string, GoalValidatorRunner>;
  now?: Date;
}

export async function judgeCompletion(input: CompletionJudgeInput): Promise<GoalCompletionReport> {
  const criteria: GoalCriterionResult[] = [];
  const evidenceRefs: string[] = [];
  for (const criterion of input.goal.successCriteria) {
    const result = await evaluateCriterion(input, criterion);
    criteria.push(result);
    evidenceRefs.push(...result.evidenceRefs);
  }

  const forbiddenActions = findForbiddenActions(input.goal, input.observedActions ?? []);
  const relevantEffects = input.effects.filter((effect) => effect.taskId === input.task.id || effect.goalId === input.goal.goalId);
  const effectRefs = relevantEffects.map((effect) => `effect:${effect.id}:${effect.status}`);
  evidenceRefs.push(...effectRefs);
  const effectVerdict = evaluateEffects(relevantEffects);
  const missingEvidence = evaluateEvidenceRequirements(
    input.goal.evidenceRequirements,
    input.artifacts,
    relevantEffects,
    [...evidenceRefs, ...criteria.flatMap((criterion) => criterion.evidenceRefs)]
  );

  const requiredCriteria = input.goal.successCriteria.filter((criterion) => criterion.required);
  const failedCriterion = requiredCriteria.find((criterion) => criteria.find((result) => result.criterionId === criterion.id)?.status === "failed");
  const unresolvedCriterion = requiredCriteria.find((criterion) => {
    const status = criteria.find((result) => result.criterionId === criterion.id)?.status;
    return status === "not_run" || status === "not_required";
  });

  let verdict: GoalCompletionReport["verdict"];
  if (forbiddenActions.length > 0 || failedCriterion || effectVerdict === "failed") {
    verdict = "fail";
  } else if (effectVerdict === "blocked") {
    verdict = "blocked";
  } else if (unresolvedCriterion || missingEvidence.length > 0) {
    verdict = "needs_human";
  } else if (input.goal.reviewPolicy !== "auto") {
    verdict = "needs_human";
  } else {
    verdict = "pass";
  }

  const passed = criteria.filter((criterion) => criterion.status === "passed").length;
  const summary = verdict === "pass"
    ? `全部 ${criteria.length} 条验收标准通过，证据链完整。`
    : verdict === "blocked"
      ? `外部动作状态未确定，必须先对账；${effectVerdict === "blocked" ? "存在未结算 effect" : "验收未完成"}。`
      : verdict === "needs_human"
        ? `运行时证据已完成 ${passed}/${criteria.length} 条，仍需人工或外部 validator 确认${missingEvidence.length > 0 ? `；缺少 ${missingEvidence.join("、")}` : ""}。`
        : `完成判定失败：${forbiddenActions.length > 0 ? `发生禁止动作 ${forbiddenActions.join("、")}；` : ""}${failedCriterion ? `验收标准 ${failedCriterion.id} 失败；` : ""}${missingEvidence.length > 0 ? `缺少证据 ${missingEvidence.join("、")}；` : ""}${effectVerdict === "failed" ? "外部动作未成功或已确认未执行。" : ""}`;

  return {
    goalId: input.goal.goalId,
    taskId: input.task.id,
    verdict,
    summary,
    criteria,
    evidenceRefs: [...new Set(evidenceRefs)],
    missingEvidence,
    forbiddenActions,
    checkedAt: (input.now ?? new Date()).toISOString()
  };
}

async function evaluateCriterion(input: CompletionJudgeInput, criterion: GoalCriterion): Promise<GoalCriterionResult> {
  const artifact = findArtifact(input.artifacts, criterion.check);
  const context: GoalValidatorContext = {
    goal: input.goal,
    task: input.task,
    criterion,
    artifact,
    workspaceRoot: input.workspaceRoot ?? null
  };

  if (criterion.validator === "file") return evaluateFileCriterion(criterion, artifact);
  if (criterion.validator === "schema") return evaluateSchemaCriterion(criterion, artifact);

  const custom = input.validators?.[criterion.id];
  if (!custom && criterion.validator === "command") return evaluateCommandCriterion(criterion, context.workspaceRoot);
  if (!custom && criterion.validator === "git") return evaluateGitCriterion(criterion, context.workspaceRoot);
  if (!custom) {
    return {
      criterionId: criterion.id,
      status: criterion.required ? "not_run" : "not_required",
      evidenceRefs: [],
      detail: `${criterion.validator} validator 未运行，不能视为通过`
    };
  }
  try {
    const result = await custom(context);
    return {
      criterionId: criterion.id,
      status: result.status,
      evidenceRefs: result.evidenceRefs ?? [],
      detail: result.detail
    };
  } catch (error) {
    return {
      criterionId: criterion.id,
      status: "failed",
      evidenceRefs: [],
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function evaluateCommandCriterion(criterion: GoalCriterion, workspaceRoot: string | null): Promise<GoalCriterionResult> {
  if (!workspaceRoot) return notRun(criterion, "命令 validator 没有可用的工作区");
  const commandHash = createHash("sha256").update(criterion.check).digest("hex");
  const result = await runShell(criterion.check, workspaceRoot);
  if (result.code !== 0) {
    return failed(criterion.id, `命令校验失败（退出码 ${result.code}）：${outputTail(result)}`);
  }
  return {
    criterionId: criterion.id,
    status: "passed",
    evidenceRefs: [`command:sha256=${commandHash}:exit=0`],
    detail: "命令校验通过（退出码 0）"
  };
}

async function evaluateGitCriterion(criterion: GoalCriterion, workspaceRoot: string | null): Promise<GoalCriterionResult> {
  if (!workspaceRoot) return notRun(criterion, "Git validator 没有可用的工作区");
  const check = criterion.check.trim();
  if (check === "clean" || check === "status-clean") {
    const result = await runFile("git", ["status", "--porcelain"], workspaceRoot);
    if (result.code !== 0) return failed(criterion.id, `Git 状态检查失败：${outputTail(result)}`);
    if (result.stdout.trim()) return failed(criterion.id, `Git 工作区不干净：${outputTail(result)}`);
    return {
      criterionId: criterion.id,
      status: "passed",
      evidenceRefs: [`git:status:clean`],
      detail: "Git 工作区干净"
    };
  }
  const branchPrefix = "branch=";
  if (check.startsWith(branchPrefix)) {
    const expected = check.slice(branchPrefix.length).trim();
    const result = await runFile("git", ["branch", "--show-current"], workspaceRoot);
    const actual = result.stdout.trim();
    if (result.code !== 0 || actual !== expected) {
      return failed(criterion.id, `Git 分支不匹配：期望 ${expected || "非空"}，实际 ${actual || "未知"}`);
    }
    return {
      criterionId: criterion.id,
      status: "passed",
      evidenceRefs: [`git:branch=${actual}`],
      detail: `Git 分支匹配：${actual}`
    };
  }
  const headPrefix = check.startsWith("head=") ? "head=" : check.startsWith("commit=") ? "commit=" : null;
  if (headPrefix) {
    const expected = check.slice(headPrefix.length).trim().toLowerCase();
    const result = await runFile("git", ["rev-parse", "HEAD"], workspaceRoot);
    const actual = result.stdout.trim().toLowerCase();
    if (result.code !== 0 || actual !== expected) {
      return failed(criterion.id, `Git HEAD 不匹配：期望 ${expected || "非空"}，实际 ${actual || "未知"}`);
    }
    return {
      criterionId: criterion.id,
      status: "passed",
      evidenceRefs: [`git:head=${actual}`],
      detail: `Git HEAD 匹配：${actual}`
    };
  }
  const result = await runShell(`git ${criterion.check}`, workspaceRoot);
  if (result.code !== 0) return failed(criterion.id, `Git 校验命令失败（退出码 ${result.code}）：${outputTail(result)}`);
  return {
    criterionId: criterion.id,
    status: "passed",
    evidenceRefs: [`git:command:sha256=${createHash("sha256").update(criterion.check).digest("hex")}:exit=0`],
    detail: "Git 校验命令通过（退出码 0）"
  };
}

function runShell(command: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(command, {
      cwd,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
      env: process.env
    }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : error ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function runFile(file: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
      env: process.env
    }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : error ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function outputTail(result: { stdout: string; stderr: string }): string {
  const combined = `${result.stderr}\n${result.stdout}`.trim().replace(/\s+/g, " ");
  return combined.slice(-500) || "没有输出";
}

function notRun(criterion: GoalCriterion, detail: string): GoalCriterionResult {
  return {
    criterionId: criterion.id,
    status: criterion.required ? "not_run" : "not_required",
    evidenceRefs: [],
    detail
  };
}

function evaluateFileCriterion(criterion: GoalCriterion, artifact: ArtifactRecord | null): GoalCriterionResult {
  const [requestedPath, expectation] = splitCheck(criterion.check);
  if (!artifact || !sameArtifactPath(artifact, requestedPath)) {
    return failed(criterion.id, `产物 ${requestedPath} 未登记，无法证明完成`);
  }
  const inspected = inspectArtifact(artifact);
  if (!inspected.ok) return failed(criterion.id, inspected.detail);
  if (expectation?.startsWith("sha256=") && artifact.sha256 !== expectation.slice("sha256=".length)) {
    return failed(criterion.id, `产物 ${requestedPath} 的 sha256 与验收要求不一致`);
  }
  return {
    criterionId: criterion.id,
    status: "passed",
    evidenceRefs: [`artifact:${artifact.relativePath}#sha256=${artifact.sha256}`],
    detail: `产物存在且哈希与发布记录一致：${artifact.relativePath}`
  };
}

function evaluateSchemaCriterion(criterion: GoalCriterion, artifact: ArtifactRecord | null): GoalCriterionResult {
  const [requestedPath, fieldsSpec] = splitCheck(criterion.check);
  if (!artifact || !sameArtifactPath(artifact, requestedPath)) {
    return failed(criterion.id, `结构校验找不到已登记产物 ${requestedPath}`);
  }
  const inspected = inspectArtifact(artifact);
  if (!inspected.ok) return failed(criterion.id, inspected.detail);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(artifact.absolutePath, "utf8"));
  } catch (error) {
    return failed(criterion.id, `产物 ${requestedPath} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const fields = parseFields(fieldsSpec);
  const missing = fields.filter((field) => !hasRequiredValue(value, field));
  if (missing.length > 0) {
    return failed(criterion.id, `产物 ${requestedPath} 缺少关键字段或字段为空：${missing.join("、")}`);
  }
  return {
    criterionId: criterion.id,
    status: "passed",
    evidenceRefs: [`artifact:${artifact.relativePath}#sha256=${artifact.sha256}`, ...fields.map((field) => `${artifact.relativePath}#${field}`)],
    detail: fields.length > 0 ? `结构与关键字段通过：${fields.join("、")}` : "JSON 结构有效"
  };
}

function evaluateEffects(effects: EffectRecord[]): "ok" | "blocked" | "failed" {
  if (effects.some((effect) => ["prepared", "admitted", "executing", "uncertain"].includes(effect.status))) return "blocked";
  if (effects.some((effect) => ["failed", "abandoned", "reconciled_absent"].includes(effect.status))) return "failed";
  if (effects.some((effect) => ["committed", "succeeded", "reconciled_committed"].includes(effect.status) && !effect.receipt && !effect.providerRef)) return "failed";
  return "ok";
}

function evaluateEvidenceRequirements(
  requirements: string[],
  artifacts: ArtifactRecord[],
  effects: EffectRecord[],
  refs: string[]
): string[] {
  const missing: string[] = [];
  for (const requirement of requirements) {
    if (requirement.startsWith("effect:")) {
      const id = requirement.slice("effect:".length);
      const effect = effects.find((item) => item.id === id);
      if (!effect || !["committed", "succeeded", "reconciled_committed"].includes(effect.status) || (!effect.receipt && !effect.providerRef)) {
        missing.push(requirement);
      }
      continue;
    }
    const path = requirement.startsWith("artifact:") ? requirement.slice("artifact:".length) : requirement;
    if (!artifacts.some((artifact) => sameArtifactPath(artifact, path)) && !refs.some((ref) => ref.includes(path))) {
      missing.push(requirement);
    }
  }
  return missing;
}

function findForbiddenActions(goal: GoalContract, observedActions: string[]): string[] {
  const observed = observedActions.map((action) => action.trim().toLowerCase()).filter(Boolean);
  return goal.forbiddenActions.filter((forbidden) => {
    const needle = forbidden.trim().toLowerCase();
    return Boolean(needle) && observed.some((action) => action === needle || action.startsWith(`${needle}:`));
  });
}

function inspectArtifact(artifact: ArtifactRecord): { ok: true } | { ok: false; detail: string } {
  if (!existsSync(artifact.absolutePath)) return { ok: false, detail: `已登记产物在磁盘上不存在：${artifact.relativePath}` };
  const hash = createHash("sha256").update(readFileSync(artifact.absolutePath)).digest("hex");
  if (hash !== artifact.sha256) return { ok: false, detail: `产物内容已被修改：${artifact.relativePath}` };
  return { ok: true };
}

function findArtifact(artifacts: ArtifactRecord[], check: string): ArtifactRecord | null {
  const [path] = splitCheck(check);
  return artifacts.find((artifact) => sameArtifactPath(artifact, path)) ?? null;
}

function sameArtifactPath(artifact: ArtifactRecord, path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return artifact.relativePath.replaceAll("\\", "/") === normalized || artifact.absolutePath.replaceAll("\\", "/") === normalized;
}

function splitCheck(check: string): [string, string | null] {
  const index = check.indexOf("#");
  return index < 0 ? [check, null] : [check.slice(0, index), check.slice(index + 1)];
}

function parseFields(spec: string | null): string[] {
  if (!spec) return [];
  const value = spec.startsWith("fields=") ? spec.slice("fields=".length) : spec;
  return value.split(",").map((field) => field.trim()).filter(Boolean);
}

function hasRequiredValue(value: unknown, field: string): boolean {
  let current = value;
  for (const part of field.split(".")) {
    if (!current || typeof current !== "object" || !(part in current)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return current !== null && current !== undefined && (typeof current !== "string" || current.trim().length > 0);
}

function failed(criterionId: string, detail: string): GoalCriterionResult {
  return { criterionId, status: "failed", evidenceRefs: [], detail };
}

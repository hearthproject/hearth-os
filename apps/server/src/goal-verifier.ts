import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Ajv } from "ajv";
import type {
  ArtifactRecord,
  GoalCompletionReport,
  GoalContract,
  GoalCriterion,
  GoalCriterionResult,
  GoalEvidenceRef,
  GoalRoundRecord
} from "@hearth/core";
import { goalEvidenceKey } from "@hearth/core";
import { parseCommandCheck, type GoalCommandResult } from "./goal-command.ts";

export interface GoalObservedAction {
  kind: string;
  summary: string;
}

export interface GoalVerifierInput {
  goal: GoalContract;
  taskId: string;
  roundRunId: string;
  /** Actual execution root recorded by the scheduler (worktree, project folder or task workspace). */
  workspaceRoot: string;
  /** Per-run output directory holding goal-intent.json and run evidence. */
  outDir: string;
  artifacts: ArtifactRecord[];
  /** Evidence submitted by the current round's goal-intent.json. */
  intentEvidence?: GoalEvidenceRef[];
  /** Recent immutable rounds provide continuity without trusting the model's self-report. */
  previousRounds?: GoalRoundRecord[];
  actions: GoalObservedAction[];
  review: ((prompt: string) => Promise<string | null>) | null;
  runCommand?: (argv: string[], cwd: string) => Promise<GoalCommandResult>;
}

const DEFAULT_CRITERION: GoalCriterion = {
  id: "objective",
  description: "目标已经达成",
  validator: "llm_review",
  check: "目标是否已经达成，且证据足以支撑结论",
  required: true
};

export async function verifyGoalCompletion(input: GoalVerifierInput): Promise<GoalCompletionReport> {
  const goal = input.goal;
  const criteria = goal.successCriteria.length > 0 ? goal.successCriteria : [DEFAULT_CRITERION];
  const artifactPaths = input.artifacts.map((artifact) => artifact.relativePath);
  const artifactHashes = input.artifacts.map((artifact) => `${artifact.relativePath}:${artifact.sha256}`);
  const evidenceRefs = [
    ...artifactPaths,
    ...artifactPaths.map((path) => `artifact:${path}`),
    ...(input.intentEvidence ?? []).map(goalEvidenceKey),
    "run-evidence.json",
    `run:${input.roundRunId}`
  ];
  const results: GoalCriterionResult[] = [];

  for (const criterion of criteria) {
    const result = await verifyCriterion(criterion, {
      ...input,
      artifactPaths,
      artifactHashes,
      review: input.review
    });
    results.push(result);
    evidenceRefs.push(...result.evidenceRefs);
  }

  const missingEvidence = findMissingEvidence(goal.evidenceRequirements, artifactPaths, input.outDir, input.intentEvidence ?? []);
  const forbiddenActions = findForbiddenActions(goal.forbiddenActions, input.actions);
  const requiredResults = results.filter((result) => {
    const criterion = criteria.find((item) => item.id === result.criterionId);
    return criterion?.required ?? true;
  });
  const failed = requiredResults.some((result) => result.status === "failed");
  const notRun = requiredResults.some((result) => result.status === "not_run");
  const verifierUnavailable = requiredResults.some((result) =>
    result.status === "not_run" && /无法|不可用|未配置|尚未确认/.test(result.detail));

  let verdict: GoalCompletionReport["verdict"];
  if (failed || forbiddenActions.length > 0) {
    verdict = "fail";
  } else if (notRun || missingEvidence.length > 0 || verifierUnavailable) {
    verdict = "needs_human";
  } else {
    verdict = "pass";
  }

  const summary = verdict === "pass"
    ? "所有必需验收标准通过，证据满足目标契约。"
    : verdict === "fail"
      ? `验收失败：${[
        ...results.filter((result) => result.status === "failed").map((result) => `${result.criterionId}: ${result.detail}`),
        ...(forbiddenActions.length > 0 ? [`命中禁止动作：${forbiddenActions.join("、")}`] : [])
      ].join("；")}`
      : `需要人工确认：${[
        ...results.filter((result) => result.status === "not_run").map((result) => `${result.criterionId}: ${result.detail}`),
        ...(missingEvidence.length > 0 ? [`缺少证据：${missingEvidence.join("、")}`] : [])
      ].join("；")}`;

  return {
    goalId: goal.goalId,
    taskId: input.taskId,
    verdict,
    summary,
    criteria: results,
    evidenceRefs: unique(evidenceRefs),
    missingEvidence,
    forbiddenActions,
    checkedAt: new Date().toISOString()
  };
}

interface CriterionContext extends GoalVerifierInput {
  artifactPaths: string[];
  artifactHashes: string[];
}

async function verifyCriterion(criterion: GoalCriterion, input: CriterionContext): Promise<GoalCriterionResult> {
  switch (criterion.validator) {
    case "file": return verifyFile(criterion, input);
    case "git": return verifyGit(criterion, input);
    case "schema": return verifySchema(criterion, input);
    case "command": return verifyCommand(criterion, input);
    case "manual": return {
      criterionId: criterion.id,
      status: "not_run",
      evidenceRefs: [],
      detail: `需要人工确认：${criterion.check}`
    };
    case "llm_review": return verifyReview(criterion, input);
    default: return {
      criterionId: criterion.id,
      status: "not_run",
      evidenceRefs: [],
      detail: `未知验收器：${String(criterion.validator)}`
    };
  }
}

function verifyFile(criterion: GoalCriterion, input: CriterionContext): GoalCriterionResult {
  const parsed = parseJsonCheck(criterion.check);
  const path = typeof parsed?.path === "string" ? parsed.path : criterion.check.trim();
  const expectExists = parsed?.exists !== false;
  const expectedSha = typeof parsed?.sha256 === "string" ? parsed.sha256.toLowerCase() : null;
  const absolute = safeResolve(input.workspaceRoot, path);
  if (!absolute.ok) {
    return failedCriterion(criterion, absolute.error);
  }
  if (!existsSync(absolute.path)) {
    return expectExists
      ? failedCriterion(criterion, `文件不存在：${path}`)
      : { criterionId: criterion.id, status: "passed", evidenceRefs: [path], detail: `文件确已不存在：${path}` };
  }
  if (!expectExists) {
    return failedCriterion(criterion, `文件仍然存在：${path}`);
  }
  if (expectedSha) {
    const actual = createHash("sha256").update(readFileSync(absolute.path)).digest("hex");
    if (actual !== expectedSha) {
      return failedCriterion(criterion, `文件哈希不匹配：${actual}`);
    }
    return { criterionId: criterion.id, status: "passed", evidenceRefs: [`${path}#sha256:${actual}`], detail: `文件存在且哈希匹配：${path}` };
  }
  return { criterionId: criterion.id, status: "passed", evidenceRefs: [path], detail: `文件存在：${path}` };
}

async function verifyGit(criterion: GoalCriterion, input: CriterionContext): Promise<GoalCriterionResult> {
  const parsed = parseJsonCheck(criterion.check) ?? {};
  const runner = input.runCommand ?? null;
  if (!runner) {
    return notRunCriterion(criterion, "git 校验命令不可用");
  }
  const run = (argv: string[]) => runner(argv, input.workspaceRoot);
  const evidence: string[] = [];
  if (typeof parsed.branch === "string") {
    const branch = await run(["git", "branch", "--show-current"]);
    if (!branch.ok) return failedCriterion(criterion, branch.error ?? "git 分支读取失败");
    const actual = branch.stdout.trim();
    evidence.push(`branch:${actual}`);
    if (actual !== parsed.branch) return failedCriterion(criterion, `当前分支 ${actual}，期望 ${parsed.branch}`);
  }
  if (parsed.clean === true) {
    const status = await run(["git", "status", "--porcelain"]);
    if (!status.ok) return failedCriterion(criterion, status.error ?? "git 状态读取失败");
    const dirty = status.stdout.trim();
    evidence.push(`status:${dirty ? "dirty" : "clean"}`);
    if (dirty) return failedCriterion(criterion, "工作区不是 clean");
  }
  if (typeof parsed.commit === "string") {
    const head = await run(["git", "rev-parse", "HEAD"]);
    if (!head.ok) return failedCriterion(criterion, head.error ?? "git HEAD 读取失败");
    const actual = head.stdout.trim();
    evidence.push(`head:${actual}`);
    if (actual !== parsed.commit) return failedCriterion(criterion, `HEAD ${actual}，期望 ${parsed.commit}`);
  }
  return { criterionId: criterion.id, status: "passed", evidenceRefs: evidence, detail: "git 校验通过" };
}

function verifySchema(criterion: GoalCriterion, input: CriterionContext): GoalCriterionResult {
  const parsed = parseJsonCheck(criterion.check);
  if (!parsed || typeof parsed.file !== "string" || !parsed.schema || typeof parsed.schema !== "object") {
    return notRunCriterion(criterion, "schema 校验需要 JSON：{ file, schema }");
  }
  const absolute = safeResolve(input.workspaceRoot, parsed.file);
  if (!absolute.ok) return failedCriterion(criterion, absolute.error);
  if (!existsSync(absolute.path)) return failedCriterion(criterion, `文件不存在：${parsed.file}`);
  try {
    const data = JSON.parse(readFileSync(absolute.path, "utf8")) as unknown;
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const validate = ajv.compile(parsed.schema as object);
    if (validate(data)) {
      return { criterionId: criterion.id, status: "passed", evidenceRefs: [parsed.file], detail: "JSON schema 校验通过" };
    }
    const errors = (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`).join("; ");
    return failedCriterion(criterion, `JSON schema 不匹配：${errors}`);
  } catch (error) {
    return failedCriterion(criterion, `schema 校验失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function verifyCommand(criterion: GoalCriterion, input: CriterionContext): Promise<GoalCriterionResult> {
  const argv = parseCommandCheck(criterion.check);
  if (!Array.isArray(argv)) return notRunCriterion(criterion, argv.error);
  const runner = input.runCommand ?? null;
  if (!runner) return notRunCriterion(criterion, "命令执行器不可用");
  const result = await runner(argv, input.workspaceRoot);
  const detail = [
    `exit=${result.exitCode}`,
    result.error ? `error=${result.error}` : "",
    firstLine(result.stdout), firstLine(result.stderr)
  ].filter(Boolean).join(" | ");
  return result.ok
    ? { criterionId: criterion.id, status: "passed", evidenceRefs: [`command:${argv.join(" ")}`], detail }
    : failedCriterion(criterion, detail || "命令失败");
}

async function verifyReview(criterion: GoalCriterion, input: CriterionContext): Promise<GoalCriterionResult> {
  if (!input.review) {
    return notRunCriterion(criterion, "评审模型未配置，无法自动判定");
  }
  const evidence = summarizeEvidence(input);
  const prompt = [
    "你是 Hearth 的目标验收器。只根据给定证据判断验收标准是否通过，不要替执行器补理由。",
    "返回严格 JSON：{\"verdict\":\"pass|fail\",\"reason\":\"一句话\",\"missing\":[]}",
    "",
    `目标：${input.goal.objective}`,
    `验收标准：${criterion.description}`,
    `检查问题：${criterion.check}`,
    "",
    `本轮摘要：${summarizeText(input.artifacts.map((artifact) => artifact.relativePath).join(", "))}`,
    `证据清单：\n${evidence}`
  ].join("\n");
  try {
    const answer = await input.review(prompt);
    if (!answer) return notRunCriterion(criterion, "评审模型没有返回结果");
    const parsed = parseReviewAnswer(answer);
    if (!parsed) return notRunCriterion(criterion, "评审结果无法解析，需要人工确认");
    return parsed.verdict === "pass"
      ? { criterionId: criterion.id, status: "passed", evidenceRefs: ["llm_review"], detail: parsed.reason }
      : failedCriterion(criterion, parsed.reason || "评审模型判定未达成");
  } catch (error) {
    return notRunCriterion(criterion, `评审调用失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function summarizeEvidence(input: CriterionContext): string {
  const recentRounds = (input.previousRounds ?? []).slice(-4).map((round) =>
    `第 ${round.index} 轮 ${round.status}: ${summarizeText(round.summary ?? "无摘要")}${round.verifier ? ` | 验收 ${round.verifier.verdict}: ${round.verifier.summary}` : ""}`
  );
  const lines = [
    `任务：${input.taskId}`,
    `运行：${input.roundRunId}`,
    `工作区：${input.workspaceRoot}`,
    `产物：${input.artifactPaths.join(", ") || "无"}`,
    `产物哈希：${input.artifactHashes.join(", ") || "无"}`,
    `意图：${input.outDir}/goal-intent.json`,
    `意图证据：${(input.intentEvidence ?? []).map(goalEvidenceKey).join(", ") || "无"}`,
    `最近轮次：${recentRounds.join(" || ") || "无"}`,
    `原始目标：${input.goal.originalObjective ?? input.goal.objective}`,
    `契约修订：${input.goal.contractRevision ?? 0}`,
    `禁止动作：${input.goal.forbiddenActions.join(", ") || "无"}`,
    `证据要求：${input.goal.evidenceRequirements.join(", ") || "无"}`
  ];
  return lines.join("\n");
}

function parseReviewAnswer(answer: string): { verdict: "pass" | "fail"; reason: string } | null {
  const jsonMatch = answer.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { verdict?: unknown; reason?: unknown };
      if (parsed.verdict === "pass" || parsed.verdict === "fail") {
        return { verdict: parsed.verdict, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
      }
    } catch {
      // Fall through to plain-text parsing.
    }
  }
  const normalized = answer.trim().toLowerCase();
  if (normalized.startsWith("pass") || normalized.startsWith("通过")) return { verdict: "pass", reason: answer.trim().slice(0, 500) };
  if (normalized.startsWith("fail") || normalized.startsWith("不通过")) return { verdict: "fail", reason: answer.trim().slice(0, 500) };
  return null;
}

function findMissingEvidence(
  requirements: string[],
  artifactPaths: string[],
  outDir: string,
  intentEvidence: GoalEvidenceRef[]
): string[] {
  if (requirements.length === 0) return [];
  const observed = new Set([
    ...artifactPaths,
    ...artifactPaths.map((path) => path.replace(/\\/g, "/")),
    ...intentEvidence.map(goalEvidenceKey),
    "run-evidence.json",
    "goal-intent.json",
    existsSync(resolve(outDir, "run-evidence.json")) ? "run-evidence.json" : "",
    existsSync(resolve(outDir, "goal-intent.json")) ? "goal-intent.json" : ""
  ].filter(Boolean));
  return requirements.filter((requirement) => {
    const normalized = requirement.replace(/\\/g, "/");
    for (const item of observed) {
      if (item.includes(normalized) || normalized.includes(item)) return false;
    }
    return true;
  });
}

function findForbiddenActions(forbidden: string[], actions: GoalObservedAction[]): string[] {
  if (forbidden.length === 0) return [];
  const hits: string[] = [];
  for (const rule of forbidden) {
    const needle = rule.trim().toLowerCase();
    if (!needle) continue;
    for (const action of actions) {
      const haystack = `${action.kind} ${action.summary}`.toLowerCase();
      if (haystack.includes(needle)) {
        hits.push(`${rule}（${action.summary.slice(0, 120)}）`);
        break;
      }
    }
  }
  return unique(hits);
}

function safeResolve(root: string, path: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!path.trim()) return { ok: false, error: "路径为空" };
  if (isAbsolute(path)) return { ok: false, error: "验收路径必须是工作区相对路径" };
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return { ok: false, error: `路径越出工作区：${path}` };
  return { ok: true, path: absolute };
}

function parseJsonCheck(check: string): Record<string, unknown> | null {
  const trimmed = check.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function failedCriterion(criterion: GoalCriterion, detail: string): GoalCriterionResult {
  return { criterionId: criterion.id, status: "failed", evidenceRefs: [], detail };
}

function notRunCriterion(criterion: GoalCriterion, detail: string): GoalCriterionResult {
  return { criterionId: criterion.id, status: "not_run", evidenceRefs: [], detail };
}

function firstLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function summarizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 2000);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

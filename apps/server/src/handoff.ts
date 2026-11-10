import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  ExecutorId,
  FailureCause,
  FailureDiagnosis,
  HandoffPacket,
  HandoffRecord,
  HandoffStatus,
  HandoffVerification,
  TaskPermissions,
  TaskRecord
} from "@hearth/core";
import { redactSecrets, type ContextService } from "./context.ts";
import type { HearthService } from "./service.ts";

export interface PrepareHandoffInput {
  taskId: string;
  fromRunId: string;
  fromExecutor: ExecutorId;
  toExecutor: ExecutorId;
  status: HandoffStatus;
  reasonCode: FailureCause;
  diagnosis: FailureDiagnosis | null;
  packet: HandoffPacket;
  initiatedBy: "auto" | "user";
  contextWatermarkSeq?: number;
}

export interface PrepareHandoffResult {
  handoff: HandoffRecord;
  packet: HandoffPacket;
}

export interface HandoffVerificationInput {
  baseDir?: string;
  evidenceRefs?: string[];
}

export interface HandoffVerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HandoffVerificationResult {
  status: "passed" | "failed";
  checks: HandoffVerificationCheck[];
  evidenceRefs: string[];
}

export class HandoffError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "HandoffError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class HandoffService {
  constructor(
    private readonly service: HearthService,
    private readonly context: ContextService
  ) {}

  prepare(input: PrepareHandoffInput): PrepareHandoffResult {
    const task = this.service.requireTask(input.taskId);
    const existing = this.context.listHandoffs(task.id);
    const generation = Math.max(0, ...existing.map((handoff) => handoff.generation)) + 1;
    const sourceCursor = input.contextWatermarkSeq
      ?? this.context.getState(task.id)?.summarySeq
      ?? this.service.store.latestEventSeq();
    const now = new Date().toISOString();
    const redacted = redactPacket(input.packet);
    const packet: HandoffPacket = {
      ...redacted.packet,
      handoffId: "pending",
      generation,
      sourceCursor,
      createdAt: now,
      redaction: { policy: "host-redaction-v1", redactedFields: redacted.fields },
      verification: normalizeVerification(input.packet.verification)
    };
    assertPacketStructure(packet, task);
    assertPermissionsSubset(packet.permissions, task.permissions);
    const created = this.context.createHandoff({
      taskId: task.id,
      fromRunId: input.fromRunId,
      fromExecutor: input.fromExecutor,
      toExecutor: input.toExecutor,
      status: input.status,
      reasonCode: input.reasonCode,
      diagnosis: input.diagnosis,
      packet,
      generation,
      sourceCursor,
      verification: packet.verification,
      contextWatermarkSeq: input.contextWatermarkSeq ?? sourceCursor,
      initiatedBy: input.initiatedBy
    });
    const finalPacket: HandoffPacket = { ...packet, handoffId: created.id };
    const handoff = this.context.updateHandoff(created.id, {
      packet: finalPacket,
      verification: packet.verification,
      artifactRef: `handoff://${created.id}/HANDOFF.md`
    }) ?? { ...created, packet: finalPacket };
    return { handoff, packet: finalPacket };
  }

  verify(packet: HandoffPacket, input: HandoffVerificationInput = {}): HandoffVerificationResult {
    const task = this.service.requireTask(packet.taskId);
    const checks: HandoffVerificationCheck[] = [];
    const add = (name: string, ok: boolean, detail: string): void => {
      checks.push({ name, ok, detail });
    };
    add("generation", packet.generation > 0, `generation=${packet.generation}`);
    add("cursor", packet.sourceCursor >= 0, `sourceCursor=${packet.sourceCursor}`);
    add("goal", packet.goal.trim().length > 0, packet.goal.trim() || "目标为空");
    add("nextAction", packet.nextAction.trim().length > 0, packet.nextAction.trim() || "下一步为空");
    add("acceptance", packet.acceptance.length > 0 || packet.verification.expected.length > 0, `验收/验证项=${packet.acceptance.length}/${packet.verification.expected.length}`);
    try {
      assertPermissionsSubset(packet.permissions, task.permissions);
      add("permissions", true, "交接权限未超过父任务");
    } catch (error) {
      add("permissions", false, error instanceof Error ? error.message : String(error));
    }
    if (packet.artifacts.length === 0) {
      add("artifacts", true, "无文件产物，使用结构化摘要与验证项");
    } else {
      for (const artifact of packet.artifacts) {
        const target = isAbsolute(artifact.path)
          ? resolve(artifact.path)
          : resolve(input.baseDir ?? process.cwd(), artifact.path);
        if (!existsSync(target)) {
          add(`artifact:${artifact.path}`, false, "文件不存在");
          continue;
        }
        const bytes = readFileSync(target);
        const digest = createHash("sha256").update(bytes).digest("hex");
        add(`artifact:${artifact.path}`, digest === artifact.sha256, digest === artifact.sha256 ? "哈希一致" : "哈希不一致");
      }
    }
    const evidenceRefs = [...new Set([
      ...(input.evidenceRefs ?? []),
      ...packet.artifacts.map((artifact) => `artifact:${artifact.path}#${artifact.sha256}`),
      ...packet.completed.map((step) => `step:${step.text}`).slice(0, 8)
    ])];
    const status = checks.every((check) => check.ok) ? "passed" : "failed";
    return { status, checks, evidenceRefs };
  }

  markVerification(handoffId: string, result: HandoffVerificationResult): HandoffRecord | null {
    const current = this.service.store.getHandoff(handoffId);
    if (!current) return null;
    const verification: HandoffVerification = {
      action: current.packet?.verification.action ?? "宿主校验交接包",
      expected: current.packet?.verification.expected ?? [],
      status: result.status,
      checkedAt: new Date().toISOString(),
      evidenceRefs: result.evidenceRefs
    };
    const packet = current.packet ? { ...current.packet, verification } : null;
    return this.context.updateHandoff(handoffId, { packet, verification });
  }

  latestHandoff(taskId: string): HandoffRecord | null {
    const handoffs = this.context.listHandoffs(taskId);
    return handoffs.sort((left, right) => right.generation - left.generation)[0] ?? null;
  }

  assertFreshGeneration(taskId: string, generation: number): void {
    const latest = this.latestHandoff(taskId);
    if (latest && generation < latest.generation) {
      throw new HandoffError("HANDOFF_GENERATION_STALE", `交接代次已过期：写入 ${generation}，当前 ${latest.generation}`);
    }
  }

  assertExecutorWrite(taskId: string, generation: number, executorId: ExecutorId): void {
    this.assertFreshGeneration(taskId, generation);
    const latest = this.latestHandoff(taskId);
    if (!latest) return;
    if (latest.status === "cancelled" || latest.status === "failed") {
      throw new HandoffError("HANDOFF_CLOSED", `交接 ${latest.id} 已结束：${latest.status}`);
    }
    if (latest.generation === generation && latest.toExecutor !== executorId && latest.status !== "completed") {
      throw new HandoffError("HANDOFF_EXECUTOR_MISMATCH", `执行器 ${executorId} 不能写入由 ${latest.toExecutor} 接管的交接`);
    }
  }
}

export function assertPermissionsSubset(child: TaskPermissions, parent: TaskPermissions | undefined): void {
  if (!parent) {
    if (child.readRoots.length || child.writeRoots.length || child.networkHosts.length || child.tools.length) {
      throw new HandoffError("HANDOFF_PERMISSION_ESCALATION", "父任务没有声明权限，交接包不能自行扩大权限");
    }
    return;
  }
  for (const root of child.readRoots) {
    if (!parent.readRoots.some((candidate) => pathWithin(candidate, root))) {
      throw new HandoffError("HANDOFF_PERMISSION_ESCALATION", `读取目录超出父任务：${root}`);
    }
  }
  for (const root of child.writeRoots) {
    if (!parent.writeRoots.some((candidate) => pathWithin(candidate, root))) {
      throw new HandoffError("HANDOFF_PERMISSION_ESCALATION", `写入目录超出父任务：${root}`);
    }
  }
  for (const host of child.networkHosts) {
    if (!parent.networkHosts.some((candidate) => hostWithin(candidate, host))) {
      throw new HandoffError("HANDOFF_PERMISSION_ESCALATION", `网络域超出父任务：${host}`);
    }
  }
  for (const tool of child.tools) {
    if (!parent.tools.includes(tool)) {
      throw new HandoffError("HANDOFF_PERMISSION_ESCALATION", `工具超出父任务：${tool}`);
    }
  }
}

function assertPacketStructure(packet: HandoffPacket, task: TaskRecord): void {
  if (packet.taskId !== task.id) throw new HandoffError("HANDOFF_TASK_MISMATCH", "交接包不属于当前任务");
  if (!packet.goal.trim()) throw new HandoffError("HANDOFF_GOAL_MISSING", "交接包缺少目标");
  if (!packet.nextAction.trim()) throw new HandoffError("HANDOFF_NEXT_ACTION_MISSING", "交接包缺少下一步");
  if (packet.generation <= 0) throw new HandoffError("HANDOFF_GENERATION_INVALID", "交接代次必须大于 0");
  if (packet.sourceCursor < 0) throw new HandoffError("HANDOFF_CURSOR_INVALID", "交接游标不能为负数");
}

function normalizeVerification(verification: HandoffVerification | undefined): HandoffVerification {
  if (verification?.action?.trim() && verification.expected.length > 0) {
    return {
      ...verification,
      status: verification.status ?? "pending",
      checkedAt: verification.checkedAt ?? null,
      evidenceRefs: verification.evidenceRefs ?? []
    };
  }
  return {
    action: "先读取当前工作区并核对目标、权限、证据和下一步，再执行一个只读最小验证动作",
    expected: ["目标与验收标准一致", "权限没有扩大", "证据引用可读取", "下一步明确且无重复副作用"],
    status: "pending",
    checkedAt: null,
    evidenceRefs: []
  };
}

function redactPacket(packet: HandoffPacket): { packet: HandoffPacket; fields: string[] } {
  const fields: string[] = [];
  const redact = (field: string, value: string): string => {
    const next = redactSecrets(value);
    if (next !== value) fields.push(field);
    return next;
  };
  return {
    fields,
    packet: {
      ...packet,
      goal: redact("goal", packet.goal),
      acceptance: packet.acceptance.map((item, index) => redact(`acceptance[${index}]`, item)),
      summary: redact("summary", packet.summary),
      completed: packet.completed.map((item, index) => ({ ...item, text: redact(`completed[${index}]`, item.text) })),
      failed: packet.failed.map((item, index) => ({ ...item, text: redact(`failed[${index}]`, item.text) })),
      doNotRepeat: packet.doNotRepeat.map((item, index) => redact(`doNotRepeat[${index}]`, item)),
      openQuestions: packet.openQuestions.map((item, index) => redact(`openQuestions[${index}]`, item)),
      nextAction: redact("nextAction", packet.nextAction),
      omittedHistory: packet.omittedHistory.map((item, index) => redact(`omittedHistory[${index}]`, item)),
      verification: {
        ...packet.verification,
        action: redact("verification.action", packet.verification.action),
        expected: packet.verification.expected.map((item, index) => redact(`verification.expected[${index}]`, item))
      }
    }
  };
}

function pathWithin(parent: string, child: string): boolean {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  const rel = relative(parentPath, childPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function hostWithin(parent: string, child: string): boolean {
  if (parent === child) return true;
  if (!parent.startsWith("*.")) return false;
  const base = parent.slice(2);
  return child.endsWith(`.${base}`);
}

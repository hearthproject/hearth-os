import { createHash, randomUUID } from "node:crypto";
import type { ApprovalRecord, EffectRecord, TaskRecord } from "@hearth/core";
import type { HearthService } from "./service.ts";

export type ApprovalDecision = "approve" | "reject";

export interface ApprovalRequest {
  taskId: string;
  runId: string;
  kind: string;
  summary: string;
  target: Record<string, unknown>;
  preview: Record<string, unknown>;
  ttlMs?: number;
}

export interface ApprovalResult {
  approval: ApprovalRecord;
  task: TaskRecord;
  effect: EffectRecord | null;
}

export type EffectExecutor = (effect: EffectRecord) => Promise<Record<string, unknown>>;

export class ApprovalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}

export class EffectUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EffectUncertainError";
  }
}

export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export class ApprovalManager {
  private readonly service: HearthService;
  private readonly executor: EffectExecutor;
  private readonly inFlight = new Set<string>();

  constructor(service: HearthService, executor: EffectExecutor) {
    this.service = service;
    this.executor = executor;
  }

  request(input: ApprovalRequest): ApprovalRecord {
    const task = this.service.requireTask(input.taskId);
    const run = this.service.store.getRun(input.runId);
    if (!run || run.taskId !== task.id) throw new ApprovalError("RUN_NOT_FOUND", "审批关联的运行不存在");
    if (task.status !== "waiting_approval") {
      throw new ApprovalError("WRONG_TASK_STATUS", `任务当前不在等待审批状态：${task.status}`);
    }
    if (this.service.store.listApprovals(task.id).some((approval) => approval.status === "pending")) {
      throw new ApprovalError("APPROVAL_PENDING", "这个任务已经有待处理的审批");
    }

    const createdAt = new Date().toISOString();
    const parameterHash = hashApprovalParameters(input.kind, input.summary, input.target, input.preview);
    const approval: ApprovalRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      runId: input.runId,
      kind: input.kind,
      summary: input.summary,
      target: input.target,
      preview: input.preview,
      parameterHash,
      status: "pending",
      expiresAt: new Date(Date.now() + (input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS)).toISOString(),
      decidedAt: null,
      effectId: null,
      createdAt
    };
    const created = this.service.createApproval(approval);
    this.service.updateTask(task.id, {
      status: "waiting_approval",
      currentRunId: input.runId,
      nextAction: "等待你确认外部动作",
      error: null
    }, input.runId);
    return created;
  }

  expireForTask(taskId: string): number {
    const now = new Date().toISOString();
    const pending = this.service.store.listApprovals(taskId).filter((approval) => approval.status === "pending");
    for (const approval of pending) {
      this.service.updateApproval(approval.id, { status: "expired", decidedAt: now });
    }
    return pending.length;
  }

  async decide(approvalId: string, decision: ApprovalDecision, parameterHash: string): Promise<ApprovalResult> {
    const approval = this.service.store.getApproval(approvalId);
    if (!approval) throw new ApprovalError("APPROVAL_NOT_FOUND", "审批不存在");
    const task = this.service.requireTask(approval.taskId);
    if (approval.parameterHash !== parameterHash) {
      throw new ApprovalError("PARAMETERS_CHANGED", "审批参数已经变化，请重新检查后再确认");
    }
    if (approval.status !== "pending") {
      const effect = approval.effectId ? this.service.store.getEffect(approval.effectId) : null;
      return { approval, task, effect };
    }
    if (new Date(approval.expiresAt).getTime() <= Date.now()) {
      this.service.updateApproval(approval.id, { status: "expired", decidedAt: new Date().toISOString() });
      this.service.updateTask(task.id, {
        status: "recoverable",
        currentRunId: approval.runId,
        nextAction: "审批已过期，可以重试任务",
        error: {
          kind: "approval_expired",
          message: "这次外部动作的确认已经过期",
          recoverable: true,
          guidance: "重新执行任务并生成新的审批"
        }
      }, approval.runId);
      throw new ApprovalError("APPROVAL_EXPIRED", "审批已过期，请重新执行任务");
    }
    if (task.status !== "waiting_approval") {
      throw new ApprovalError("WRONG_TASK_STATUS", `任务当前不在等待审批状态：${task.status}`);
    }

    if (decision === "reject") {
      const updated = this.service.updateApproval(approval.id, { status: "rejected", decidedAt: new Date().toISOString() });
      const rejectedTask = this.service.updateTask(task.id, {
        status: "recoverable",
        currentRunId: approval.runId,
        nextAction: "你拒绝了外部动作，没有产生外部副作用",
        error: {
          kind: "approval_rejected",
          message: "外部动作已被你拒绝",
          recoverable: true,
          guidance: "检查产物后可以重试任务"
        }
      }, approval.runId);
      return { approval: updated, task: rejectedTask, effect: null };
    }

    const existing = this.service.store.listEffects(task.id).find((effect) => effect.approvalId === approval.id);
    if (existing) return { approval, task, effect: existing };
    if (this.inFlight.has(approval.id)) throw new ApprovalError("EFFECT_IN_PROGRESS", "这个外部动作正在执行，请稍后刷新");
    this.inFlight.add(approval.id);

    const now = new Date().toISOString();
    const effect: EffectRecord = {
      id: randomUUID(),
      taskId: task.id,
      approvalId: approval.id,
      kind: approval.kind,
      idempotencyKey: `approval:${approval.id}:${approval.parameterHash}`,
      status: "executing",
      target: approval.target,
      receipt: null,
      error: null,
      createdAt: now,
      updatedAt: now
    };
    this.service.createEffect(effect);
    this.service.updateApproval(approval.id, { status: "approved", decidedAt: now, effectId: effect.id });
    this.service.updateTask(task.id, { status: "running", nextAction: "正在执行已批准的外部动作" }, approval.runId);

    try {
      const receipt = await this.executor(effect);
      const succeeded = this.service.updateEffect(effect.id, {
        status: "succeeded",
        receipt,
        error: null,
        updatedAt: new Date().toISOString()
      });
      const completedTask = this.service.updateTask(task.id, {
        status: "completed",
        currentRunId: approval.runId,
        nextAction: "外部动作已完成",
        error: null
      }, approval.runId);
      return { approval: this.requireApproval(approval.id), task: completedTask, effect: succeeded };
    } catch (error) {
      const uncertain = error instanceof EffectUncertainError;
      const failed = this.service.updateEffect(effect.id, {
        status: uncertain ? "uncertain" : "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      });
      const recoverableTask = this.service.updateTask(task.id, {
        status: "recoverable",
        currentRunId: approval.runId,
        nextAction: uncertain ? "外部动作结果不确定，请先核对再重试" : "外部动作失败，可以重试",
        error: {
          kind: uncertain ? "effect_uncertain" : "effect_failed",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
          guidance: uncertain ? "先到目标系统核对是否已经生效，避免重复执行" : "检查原因后重试任务"
        }
      }, approval.runId);
      return { approval: this.requireApproval(approval.id), task: recoverableTask, effect: failed };
    } finally {
      this.inFlight.delete(approval.id);
    }
  }

  recoverInterruptedEffects(): void {
    for (const effect of this.service.store.listAllEffects()) {
      if (effect.status !== "executing") continue;
      this.service.updateEffect(effect.id, {
        status: "uncertain",
        error: "服务在外部动作执行期间停止；需要先核对目标系统再决定是否重试",
        updatedAt: new Date().toISOString()
      });
    }
  }

  private requireApproval(id: string): ApprovalRecord {
    const approval = this.service.store.getApproval(id);
    if (!approval) throw new ApprovalError("APPROVAL_NOT_FOUND", "审批不存在");
    return approval;
  }
}

export function hashApprovalParameters(
  kind: string,
  summary: string,
  target: Record<string, unknown>,
  preview: Record<string, unknown>
): string {
  return createHash("sha256").update(stableStringify({ kind, summary, target, preview })).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

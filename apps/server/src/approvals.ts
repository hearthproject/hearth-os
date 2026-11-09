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

export interface ToolApprovalRequest {
  taskId: string;
  runId: string;
  toolName: string;
  summary: string;
  target: Record<string, unknown>;
  preview: Record<string, unknown>;
  ttlMs?: number;
}

export interface ToolApprovalDecision {
  allowed: boolean;
  reason: string;
}

export interface PendingToolApproval {
  approval: ApprovalRecord;
  decision: Promise<ToolApprovalDecision>;
}

export type EffectExecutor = (effect: EffectRecord) => Promise<Record<string, unknown>>;

export interface ApprovalManagerOptions {
  guard?: (taskId: string) => void;
}

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
  private readonly guard: ((taskId: string) => void) | undefined;
  private readonly inFlight = new Set<string>();
  private readonly toolWaiters = new Map<string, (decision: ToolApprovalDecision) => void>();

  constructor(service: HearthService, executor: EffectExecutor, options: ApprovalManagerOptions = {}) {
    this.service = service;
    this.executor = executor;
    this.guard = options.guard;
  }

  async request(input: ApprovalRequest): Promise<ApprovalRecord> {
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
    if (this.service.approvalModeForTask(task) === "full") {
      const result = await this.decide(created.id, "approve", created.parameterHash);
      const event = this.service.store.appendEvent({
        type: "approval.auto_approved",
        taskId: task.id,
        runId: input.runId,
        payload: {
          approvalId: created.id,
          kind: created.kind,
          conversationId: task.conversationId ?? null,
          policy: "conversation.full",
          effectId: result.effect?.id ?? null
        }
      });
      this.service.bus.publish(event);
      return this.requireApproval(created.id);
    }
    return created;
  }

  async requestTool(input: ToolApprovalRequest): Promise<PendingToolApproval> {
    const task = this.service.requireTask(input.taskId);
    const run = this.service.store.getRun(input.runId);
    if (!run || run.taskId !== task.id) throw new ApprovalError("RUN_NOT_FOUND", "审批关联的运行不存在");
    if (task.status !== "running") {
      throw new ApprovalError("WRONG_TASK_STATUS", `任务当前不在运行状态：${task.status}`);
    }
    if (this.service.store.listApprovals(task.id).some((approval) => approval.status === "pending")) {
      throw new ApprovalError("APPROVAL_PENDING", "这个任务已经有待处理的审批");
    }
    this.guard?.(task.id);

    const kind = `tool.${input.toolName}`;
    const createdAt = new Date().toISOString();
    const parameterHash = hashApprovalParameters(kind, input.summary, input.target, input.preview);
    const approval: ApprovalRecord = {
      id: randomUUID(),
      taskId: task.id,
      runId: input.runId,
      kind,
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
    const decision = new Promise<ToolApprovalDecision>((resolve) => {
      this.toolWaiters.set(approval.id, resolve);
    });
    this.service.createApproval(approval);
    this.service.updateTask(task.id, {
      status: "waiting_approval",
      currentRunId: input.runId,
      nextAction: `等待你确认工具：${input.toolName}`,
      error: null
    }, input.runId);
    return { approval, decision };
  }

  expireForTask(taskId: string): number {
    const now = new Date().toISOString();
    const pending = this.service.store.listApprovals(taskId).filter((approval) => approval.status === "pending");
    for (const approval of pending) {
      this.service.updateApproval(approval.id, { status: "expired", decidedAt: now });
      if (isToolApproval(approval)) this.resolveTool(approval.id, false, "任务已取消");
    }
    return pending.length;
  }

  expirePastDue(): { approvals: number; tasks: number } {
    const now = new Date().toISOString();
    let approvals = 0;
    let tasks = 0;
    for (const task of this.service.store.listTasks()) {
      const pending = this.service.store.listApprovals(task.id)
        .filter((approval) => approval.status === "pending" && Date.parse(approval.expiresAt) <= Date.now());
      if (pending.length === 0) continue;
      for (const approval of pending) {
        this.service.updateApproval(approval.id, { status: "expired", decidedAt: now });
        if (isToolApproval(approval)) this.resolveTool(approval.id, false, "工具审批已过期");
        approvals += 1;
      }
      if (task.status === "waiting_approval") {
        const runId = pending[0]?.runId ?? task.currentRunId ?? undefined;
        if (pending.some(isToolApproval)) {
          this.service.updateTask(task.id, {
            status: "running",
            currentRunId: task.currentRunId,
            nextAction: "工具审批已过期，Agent 将跳过该工具继续",
            error: null
          }, runId);
        } else {
          this.service.updateTask(task.id, {
            status: "recoverable",
            currentRunId: task.currentRunId,
            nextAction: "审批已过期，可以重试任务",
            error: {
              kind: "approval_expired",
              message: "外部动作的确认已经过期",
              recoverable: true,
              guidance: "重新执行任务以生成新的审批"
            }
          }, runId);
        }
        tasks += 1;
      }
    }
    return { approvals, tasks };
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
    const toolApproval = isToolApproval(approval);
    if (new Date(approval.expiresAt).getTime() <= Date.now()) {
      this.service.updateApproval(approval.id, { status: "expired", decidedAt: new Date().toISOString() });
      if (toolApproval) {
        this.resolveTool(approval.id, false, "工具审批已过期");
        this.service.updateTask(task.id, {
          status: "running",
          currentRunId: approval.runId,
          nextAction: "工具审批已过期，Agent 将跳过该工具继续",
          error: null
        }, approval.runId);
        throw new ApprovalError("APPROVAL_EXPIRED", "工具审批已过期，Agent 将跳过该工具继续");
      }
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

    if (toolApproval) {
      if (decision === "reject") {
        const updated = this.service.updateApproval(approval.id, { status: "rejected", decidedAt: new Date().toISOString() });
        this.resolveTool(approval.id, false, "用户拒绝了这个工具调用");
        const continuedTask = this.service.updateTask(task.id, {
          status: "running",
          currentRunId: approval.runId,
          nextAction: "已拒绝工具，Agent 将继续执行",
          error: null
        }, approval.runId);
        return { approval: updated, task: continuedTask, effect: null };
      }
      this.guard?.(task.id);
      const updated = this.service.updateApproval(approval.id, { status: "approved", decidedAt: new Date().toISOString() });
      const continuedTask = this.service.updateTask(task.id, {
        status: "running",
        currentRunId: approval.runId,
        nextAction: "工具已获批准，继续执行",
        error: null
      }, approval.runId);
      this.resolveTool(approval.id, true, "已批准");
      return { approval: updated, task: continuedTask, effect: null };
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
    this.guard?.(task.id);
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
      const queuedFollowUps = this.service.store.listTaskFollowUps(task.id, "queued").length;
      const completedTask = this.service.updateTask(task.id, {
        status: queuedFollowUps > 0 ? "recoverable" : "completed",
        currentRunId: approval.runId,
        nextAction: queuedFollowUps > 0 ? "外部动作已完成，补充信息待继续" : "外部动作已完成",
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
    for (const task of this.service.store.listTasks()) {
      for (const approval of this.service.store.listApprovals(task.id)) {
        if (approval.status !== "pending" || !isToolApproval(approval)) continue;
        this.service.updateApproval(approval.id, { status: "expired", decidedAt: new Date().toISOString() });
        this.resolveTool(approval.id, false, "服务重启中断了工具审批");
        if (this.service.requireTask(task.id).status === "waiting_approval") {
          this.service.updateTask(task.id, {
            status: "recoverable",
            currentRunId: approval.runId,
            nextAction: "工具审批在服务重启时中断，可以重试任务",
            error: {
              kind: "approval_interrupted",
              message: "服务重启时仍在等待工具审批",
              recoverable: true,
              guidance: "检查工作区后重试任务"
            }
          }, approval.runId);
        }
      }
    }
  }

  cancelToolApproval(approvalId: string, reason: string): boolean {
    const approval = this.service.store.getApproval(approvalId);
    if (!approval || approval.status !== "pending" || !isToolApproval(approval)) return false;
    this.service.updateApproval(approval.id, { status: "expired", decidedAt: new Date().toISOString() });
    this.resolveTool(approval.id, false, reason);
    const task = this.service.requireTask(approval.taskId);
    if (task.status === "waiting_approval") {
      this.service.updateTask(task.id, {
        status: "running",
        currentRunId: approval.runId,
        nextAction: `${reason}，Agent 将继续执行`,
        error: null
      }, approval.runId);
    }
    return true;
  }

  private resolveTool(approvalId: string, allowed: boolean, reason: string): void {
    const resolve = this.toolWaiters.get(approvalId);
    if (!resolve) return;
    this.toolWaiters.delete(approvalId);
    resolve({ allowed, reason });
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

function isToolApproval(approval: ApprovalRecord): boolean {
  return approval.kind.startsWith("tool.");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

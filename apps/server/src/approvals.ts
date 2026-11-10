import { createHash, randomUUID } from "node:crypto";
import type {
  ApprovalContext,
  ApprovalDecider,
  ApprovalRecord,
  EffectRecord,
  EffectReplayPolicy,
  PermissionMode,
  TaskRecord
} from "@hearth/core";
import {
  decideActionPolicy,
  verifyResolvedAction,
  type ResolvedAction
} from "./action-resolver.ts";
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
  goalId?: string;
  action?: ResolvedAction;
  context?: ApprovalContext;
  permissionMode?: PermissionMode;
  preauthorized?: boolean;
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
  goalId?: string;
  action?: ResolvedAction;
  context?: ApprovalContext;
  permissionMode?: PermissionMode;
  preauthorized?: boolean;
}

export interface ToolApprovalDecision {
  allowed: boolean;
  reason: string;
}

export interface ApprovalDecisionOptions {
  decider?: ApprovalDecider;
  preauthorized?: boolean;
}

export interface PendingToolApproval {
  approval: ApprovalRecord;
  decision: Promise<ToolApprovalDecision>;
}

export type EffectExecutor = (effect: EffectRecord) => Promise<Record<string, unknown>>;

export interface ApprovalManagerOptions {
  guard?: (taskId: string) => void;
  onUncertain?: (effect: EffectRecord, reason: string) => void;
  onDecided?: (approval: ApprovalRecord) => void;
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
  private readonly onUncertain: ((effect: EffectRecord, reason: string) => void) | undefined;
  private readonly onDecided: ((approval: ApprovalRecord) => void) | undefined;
  private readonly inFlight = new Set<string>();
  private readonly toolWaiters = new Map<string, (decision: ToolApprovalDecision) => void>();

  constructor(service: HearthService, executor: EffectExecutor, options: ApprovalManagerOptions = {}) {
    this.service = service;
    this.executor = executor;
    this.guard = options.guard;
    this.onUncertain = options.onUncertain;
    this.onDecided = options.onDecided;
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

    const context = input.action?.context ?? input.context ?? "interactive";
    const permissionMode = input.action?.permissionMode ?? input.permissionMode ?? this.permissionModeForTask(task);
    if (input.action) {
      const policy = decideActionPolicy(input.action, {
        context,
        permissionMode,
        preauthorized: input.preauthorized ?? false
      });
      if (!policy.allowed) {
        this.recordPolicyDenial(task, run.id, input.action, policy.reason);
        throw new ApprovalError("POLICY_DENIED", policy.reason);
      }
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
      createdAt,
      goalId: input.goalId ?? null,
      actionDigest: input.action?.actionDigest ?? null,
      permissionMode,
      context,
      maxUses: 1,
      usedCount: 0,
      approvedBy: null,
      issuedAt: createdAt,
      revokedAt: null,
      action: input.action ? {
        resolvedAction: input.action as unknown as Record<string, unknown>,
        preauthorized: input.preauthorized ?? false
      } : null,
      rejectionCount: 0
    };
    const created = this.service.createApproval(approval);
    this.service.updateTask(task.id, {
      status: "waiting_approval",
      currentRunId: input.runId,
      nextAction: "等待你确认外部动作",
      error: null
    }, input.runId);
    if (this.service.approvalModeForTask(task) === "full") {
      const result = await this.decide(created.id, "approve", created.parameterHash, { decider: "policy" });
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
    const context = input.action?.context ?? input.context ?? "interactive";
    const permissionMode = input.action?.permissionMode ?? input.permissionMode ?? this.permissionModeForTask(task);
    if (input.action) {
      const policy = decideActionPolicy(input.action, {
        context,
        permissionMode,
        preauthorized: input.preauthorized ?? false
      });
      if (!policy.allowed) {
        this.recordPolicyDenial(task, run.id, input.action, policy.reason);
        throw new ApprovalError("POLICY_DENIED", policy.reason);
      }
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
      createdAt,
      goalId: input.goalId ?? null,
      actionDigest: input.action?.actionDigest ?? null,
      permissionMode,
      context,
      maxUses: 1,
      usedCount: 0,
      approvedBy: null,
      issuedAt: createdAt,
      revokedAt: null,
      action: input.action ? {
        resolvedAction: input.action as unknown as Record<string, unknown>,
        preauthorized: input.preauthorized ?? false
      } : null,
      rejectionCount: 0
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

  async decide(
    approvalId: string,
    decision: ApprovalDecision,
    parameterHash: string,
    options: ApprovalDecisionOptions = {}
  ): Promise<ApprovalResult> {
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
    this.revalidateAction(approval, options);

    if (toolApproval) {
      if (decision === "reject") {
        const updated = this.service.updateApproval(approval.id, {
          status: "rejected",
          decidedAt: new Date().toISOString(),
          rejectionCount: (approval.rejectionCount ?? 0) + 1
        });
        this.notifyDecided(updated);
        this.resolveTool(approval.id, false, "用户拒绝了这个工具调用");
        const continuedTask = this.service.updateTask(task.id, {
          status: "running",
          currentRunId: approval.runId,
          nextAction: "已拒绝工具，Agent 将继续执行",
          error: null
        }, approval.runId);
        this.recordRejection(task, approval, options.decider ?? "user");
        return { approval: updated, task: continuedTask, effect: null };
      }
      this.guard?.(task.id);
      const now = new Date().toISOString();
      const updated = this.service.updateApproval(approval.id, {
        status: "consumed",
        decidedAt: now,
        approvedBy: options.decider ?? "user",
        usedCount: 1
      });
      const continuedTask = this.service.updateTask(task.id, {
        status: "running",
        currentRunId: approval.runId,
        nextAction: "工具已获批准，继续执行",
        error: null
      }, approval.runId);
      this.notifyDecided(updated);
      this.resolveTool(approval.id, true, "已批准");
      return { approval: updated, task: continuedTask, effect: null };
    }

    if (decision === "reject") {
      const updated = this.service.updateApproval(approval.id, {
        status: "rejected",
        decidedAt: new Date().toISOString(),
        rejectionCount: (approval.rejectionCount ?? 0) + 1
      });
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
      this.notifyDecided(updated);
      this.recordRejection(task, approval, options.decider ?? "user");
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
      updatedAt: now,
      goalId: approval.goalId ?? null,
      effectType: approval.kind,
      replayPolicy: replayPolicyForKind(approval.kind),
      actionDigest: approval.actionDigest ?? null,
      resolvedActionDigest: approval.actionDigest ?? null,
      attemptCount: 1,
      maxAttempts: 1,
      leaseOwner: approval.runId,
      leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      availableAt: now,
      targetKey: `${approval.kind}:${stableStringify(approval.target)}`
    };
    this.service.createEffect(effect);
    const decided = this.service.updateApproval(approval.id, {
      status: "approved",
      decidedAt: now,
      effectId: effect.id,
      approvedBy: options.decider ?? "user",
      usedCount: 1
    });
    this.notifyDecided(decided);
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
      this.service.updateApproval(approval.id, { status: "consumed", usedCount: 1 });
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
      this.service.updateApproval(approval.id, { status: "consumed", usedCount: 1 });
      if (uncertain) this.onUncertain?.(failed, failed.error ?? "外部动作结果不确定");
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
    if (task.status === "running" || task.status === "waiting_approval") {
      this.service.updateTask(task.id, {
        status: "running",
        currentRunId: approval.runId,
        nextAction: `${reason}，Agent 将继续执行`,
        error: null
      }, approval.runId);
    }
    return true;
  }

  private permissionModeForTask(task: TaskRecord): PermissionMode {
    return this.service.approvalModeForTask(task) === "full" ? "full" : "guarded";
  }

  private revalidateAction(approval: ApprovalRecord, options: ApprovalDecisionOptions): void {
    if (!approval.action) return;
    const wrapper = approval.action as { resolvedAction?: unknown; preauthorized?: boolean };
    const candidate = wrapper.resolvedAction ?? approval.action;
    if (!isResolvedAction(candidate)) return;
    const expected = candidate;
    if (approval.actionDigest && expected.actionDigest !== approval.actionDigest) {
      this.revokeAction(approval, "审批票绑定的动作摘要与审批记录不一致");
      throw new ApprovalError("ACTION_CHANGED", "审批票绑定的动作摘要与审批记录不一致");
    }
    const verification = verifyResolvedAction(expected);
    if (!verification.ok) {
      this.revokeAction(approval, verification.reason, verification.current?.actionDigest ?? null);
      throw new ApprovalError("ACTION_CHANGED", verification.reason);
    }
    const policy = decideActionPolicy(verification.current ?? expected, {
      context: approval.context ?? "interactive",
      permissionMode: approval.permissionMode ?? "guarded",
      preauthorized: options.preauthorized ?? wrapper.preauthorized ?? false
    });
    if (!policy.allowed) {
      this.revokeAction(approval, policy.reason);
      throw new ApprovalError("POLICY_DENIED", policy.reason);
    }
  }

  private notifyDecided(approval: ApprovalRecord): void {
    try {
      this.onDecided?.(approval);
    } catch {
      // Ontology writeback is best effort and never blocks approval handling.
    }
  }

  private revokeAction(approval: ApprovalRecord, reason: string, currentDigest: string | null = null): void {
    const now = new Date().toISOString();
    const revoked = this.service.updateApproval(approval.id, { status: "revoked", revokedAt: now, decidedAt: now });
    this.notifyDecided(revoked);
    const event = this.service.store.appendEvent({
      type: "approval.revalidation_failed",
      taskId: approval.taskId,
      runId: approval.runId,
      payload: {
        approvalId: approval.id,
        expectedDigest: approval.actionDigest ?? null,
        currentDigest,
        reason
      }
    });
    this.service.bus.publish(event);
    this.service.updateTask(approval.taskId, {
      status: "recoverable",
      currentRunId: approval.runId,
      nextAction: "动作在审批后发生变化，已拒绝执行",
      error: {
        kind: "action_changed",
        message: reason,
        recoverable: true,
        guidance: "重新检查动作并生成新的审批"
      }
    }, approval.runId);
  }

  private recordPolicyDenial(task: TaskRecord, runId: string, action: ResolvedAction, reason: string): void {
    const event = this.service.store.appendEvent({
      type: "approval.policy_denied",
      taskId: task.id,
      runId,
      payload: {
        actionId: action.actionId,
        actionDigest: action.actionDigest,
        context: action.context,
        permissionMode: action.permissionMode,
        risk: action.risk,
        reason
      }
    });
    this.service.bus.publish(event);
    if (task.status === "running" || task.status === "waiting_approval") {
      this.service.updateTask(task.id, {
        status: "recoverable",
        currentRunId: runId,
        nextAction: "动作被策略拒绝",
        error: {
          kind: "policy_denied",
          message: reason,
          recoverable: true,
          guidance: "调整动作范围或由用户在场确认"
        }
      }, runId);
    }
  }

  private recordRejection(task: TaskRecord, approval: ApprovalRecord, decider: ApprovalDecider): void {
    const event = this.service.store.appendEvent({
      type: "approval.rejected",
      taskId: task.id,
      runId: approval.runId,
      payload: { approvalId: approval.id, decider, actionDigest: approval.actionDigest ?? null }
    });
    this.service.bus.publish(event);
    const recent = this.service.store.listApprovals(task.id)
      .filter((item) => item.status === "rejected" && Date.now() - Date.parse(item.decidedAt ?? item.createdAt) <= 30 * 60 * 1000)
      .length;
    if (recent < 3) return;
    const escalation = this.service.store.appendEvent({
      type: "approval.escalation_required",
      taskId: task.id,
      runId: approval.runId,
      payload: { approvalId: approval.id, rejections: recent, reason: "连续拒绝达到人工复核阈值" }
    });
    this.service.bus.publish(escalation);
    this.service.updateTask(task.id, {
      status: "recoverable",
      currentRunId: approval.runId,
      nextAction: "连续多次被拒绝，需要人工复核任务方案",
      error: {
        kind: "approval_escalated",
        message: "同一任务连续多次审批被拒绝",
        recoverable: true,
        guidance: "请人工检查任务目标与动作方案，不要继续换写法绕过"
      }
    }, approval.runId);
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

function isResolvedAction(value: unknown): value is ResolvedAction {
  return Boolean(
    value
    && typeof value === "object"
    && "actionDigest" in value
    && "proposal" in value
    && "sessionRoot" in value
    && typeof (value as { sessionRoot?: unknown }).sessionRoot === "string"
  );
}

function replayPolicyForKind(kind: string): EffectReplayPolicy {
  if (kind.startsWith("tool.")) return "process_bound";
  return "never_replay";
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

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  DelegationBudget,
  DelegationJob,
  DelegationResult,
  DelegationVerification,
  DelegationWorkspacePolicy,
  ExecutorId,
  TaskPermissions,
  TaskRecord
} from "@hearth/core";
import { EXECUTOR_IDS } from "@hearth/core";
import { redactSecrets } from "./context.ts";
import { WORKSPACE_DIR } from "./config.ts";
import type { HearthService } from "./service.ts";
import type { SandboxService } from "./sandbox.ts";

export const SAFE_DELEGATION_TOOLS = [
  "read_file",
  "list_files",
  "search_text",
  "fetch_url",
  "ask_user",
  "finish_task",
  "shell"
] as const;

const ACTIVE_STATUSES = new Set(["queued", "leased", "running", "awaiting_verification"]);

export interface CreateDelegationInput {
  parentTaskId: string;
  parentRunId?: string | null;
  goalSlice: string;
  targetExecutor: ExecutorId;
  contextPackRef: string;
  contextPack?: Record<string, unknown>;
  workspacePolicy?: DelegationWorkspacePolicy;
  toolPolicy?: string[];
  networkPolicy?: string[];
  budget?: DelegationBudget;
  deadline?: string | null;
  resultSchemaRef?: string | null;
  idempotencyKey: string;
  requestedPermissions?: Partial<TaskPermissions>;
  createChildTask?: boolean;
}

export interface DelegationServiceOptions {
  service: HearthService;
  workspaceRoot?: string;
  now?: () => Date;
  sandbox?: SandboxService;
}

export class DelegationError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "DelegationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class DelegationService {
  private readonly service: HearthService;
  private readonly workspaceRoot: string;
  private readonly now: () => Date;
  private readonly sandbox: SandboxService | undefined;

  constructor(options: DelegationServiceOptions) {
    this.service = options.service;
    this.workspaceRoot = resolve(options.workspaceRoot ?? join(WORKSPACE_DIR, "delegations"));
    this.now = options.now ?? (() => new Date());
    this.sandbox = options.sandbox;
  }

  create(input: CreateDelegationInput): DelegationJob {
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw new DelegationError("DELEGATION_IDEMPOTENCY_KEY_REQUIRED", "委派必须提供幂等 key", 400);
    const existing = this.service.store.getDelegationJobByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.parentTaskId === input.parentTaskId && existing.goalSlice === input.goalSlice.trim()) return existing;
      throw new DelegationError("DELEGATION_IDEMPOTENCY_CONFLICT", "幂等 key 已绑定到另一个委派任务");
    }
    const parent = this.service.requireTask(input.parentTaskId);
    if (["completed", "cancelled"].includes(parent.status)) {
      throw new DelegationError("DELEGATION_PARENT_CLOSED", `父任务已结束：${parent.status}`);
    }
    if (this.service.store.getDelegationJobByChildTask(parent.id)) {
      throw new DelegationError("DELEGATION_RECURSION_NOT_ALLOWED", "第一版只允许单层委派，子任务不能继续委派");
    }
    if (!EXECUTOR_IDS.includes(input.targetExecutor)) {
      throw new DelegationError("DELEGATION_EXECUTOR_INVALID", `未知执行器：${input.targetExecutor}`, 400);
    }
    const goalSlice = input.goalSlice.trim();
    if (!goalSlice) throw new DelegationError("DELEGATION_GOAL_REQUIRED", "委派目标不能为空", 400);
    const contextPackRef = input.contextPackRef.trim();
    if (!contextPackRef) throw new DelegationError("DELEGATION_CONTEXT_REQUIRED", "委派必须提供最小上下文引用", 400);
    const workspacePolicy = input.workspacePolicy ?? "read-only";
    if (!["read-only", "isolated-write", "shared-read"].includes(workspacePolicy)) {
      throw new DelegationError("DELEGATION_WORKSPACE_POLICY_INVALID", "工作区策略不正确", 400);
    }
    const budget = normalizeBudget(input.budget);
    if (input.deadline && Number.isNaN(Date.parse(input.deadline))) {
      throw new DelegationError("DELEGATION_DEADLINE_INVALID", "委派截止时间格式不正确", 400);
    }
    const id = randomUUID();
    const toolPolicy = this.deriveTools(parent, workspacePolicy, input.toolPolicy);
    const permissions = this.derivePermissions(parent, workspacePolicy, input.requestedPermissions);
    permissions.tools = toolPolicy;
    const networkPolicy = this.deriveNetwork(parent, input.networkPolicy);
    this.sandbox?.evaluate({
      workspaceRoot: permissions.readRoots[0] ?? parent.outputDir,
      permissions,
      allowedProcesses: toolPolicy.includes("shell") ? ["shell"] : []
    }, {
      readPaths: permissions.readRoots,
      writePaths: permissions.writeRoots,
      networkHosts: networkPolicy,
      tools: toolPolicy
    });
    const now = this.now().toISOString();
    let job: DelegationJob = {
      id,
      parentTaskId: parent.id,
      parentRunId: input.parentRunId ?? null,
      childTaskId: null,
      childRunId: null,
      goalSlice,
      targetExecutor: input.targetExecutor,
      contextPackRef,
      contextPack: redactObject(input.contextPack ?? {}),
      workspacePolicy,
      permissions,
      toolPolicy,
      networkPolicy,
      budget,
      deadline: input.deadline ?? null,
      resultSchemaRef: input.resultSchemaRef ?? null,
      status: "queued",
      depth: 1,
      idempotencyKey,
      lease: null,
      attempt: 1,
      result: null,
      verification: null,
      failure: null,
      cancelReason: null,
      createdAt: now,
      updatedAt: now
    };
    this.service.store.createDelegationJob(job);
    if (input.createChildTask !== false) {
      const childOutputDir = permissions.writeRoots[0] ?? join(this.workspaceRoot, id);
      mkdirSync(childOutputDir, { recursive: true });
      const child = this.service.createTask({
        title: `委派：${goalSlice.slice(0, 80)}`,
        goal: goalSlice,
        executorId: input.targetExecutor,
        taskKind: "general",
        permissions,
        networkHosts: networkPolicy,
        outputDir: childOutputDir,
        ...(parent.goalId ? { goalId: parent.goalId } : {})
      });
      job = this.service.store.updateDelegationJob(id, { childTaskId: child.id }) ?? job;
    }
    this.emit("delegation.created", job);
    return job;
  }

  lease(jobId: string, owner: string, ttlMs = 30_000): DelegationJob {
    const job = this.require(jobId);
    const now = this.now();
    if (!ACTIVE_STATUSES.has(job.status) || ["awaiting_verification", "succeeded"].includes(job.status)) {
      throw new DelegationError("DELEGATION_NOT_LEASABLE", `委派当前不能租用：${job.status}`);
    }
    if (job.lease && new Date(job.lease.expiresAt).getTime() > now.getTime() && job.lease.owner !== owner) {
      throw new DelegationError("DELEGATION_LEASE_HELD", `委派已被 ${job.lease.owner} 持有`);
    }
    const busy = this.service.store.listActiveDelegationJobs().find((candidate) =>
      candidate.id !== job.id
      && candidate.targetExecutor === job.targetExecutor
      && ["leased", "running"].includes(candidate.status)
    );
    if (busy) {
      throw new DelegationError("DELEGATION_EXECUTOR_BUSY", `${job.targetExecutor} 已有委派 ${busy.id} 在运行`);
    }
    const updated = this.service.store.updateDelegationJob(job.id, {
      status: "leased",
      lease: { owner, expiresAt: new Date(now.getTime() + Math.max(1_000, ttlMs)).toISOString() },
      updatedAt: now.toISOString()
    });
    this.emit("delegation.leased", updated ?? job);
    return updated ?? job;
  }

  start(jobId: string, owner: string): DelegationJob {
    const job = this.require(jobId);
    this.assertLease(job, owner);
    const updated = this.service.store.updateDelegationJob(job.id, {
      status: "running",
      updatedAt: this.now().toISOString()
    });
    this.emit("delegation.started", updated ?? job);
    return updated ?? job;
  }

  complete(jobId: string, result: DelegationResult): DelegationJob {
    const job = this.require(jobId);
    if (!["leased", "running"].includes(job.status)) {
      throw new DelegationError("DELEGATION_NOT_COMPLETABLE", `委派当前不能提交结果：${job.status}`);
    }
    if (!result.summary.trim() || result.evidenceRefs.length === 0) {
      throw new DelegationError("DELEGATION_RESULT_INCOMPLETE", "委派结果必须有摘要和证据引用", 400);
    }
    const updated = this.service.store.updateDelegationJob(job.id, {
      status: "awaiting_verification",
      result: { ...result, producedAt: result.producedAt || this.now().toISOString() },
      lease: null,
      updatedAt: this.now().toISOString()
    });
    this.emit("delegation.result.submitted", updated ?? job);
    return updated ?? job;
  }

  verify(jobId: string, verification: DelegationVerification): DelegationJob {
    const job = this.require(jobId);
    if (job.status !== "awaiting_verification") {
      throw new DelegationError("DELEGATION_NOT_VERIFIABLE", `委派当前不能验收：${job.status}`);
    }
    if (verification.parentTaskId !== job.parentTaskId) {
      throw new DelegationError("DELEGATION_VERIFIER_MISMATCH", "只有父任务可以验收委派结果");
    }
    if (!verification.evidenceRefs.length) {
      throw new DelegationError("DELEGATION_VERIFICATION_EVIDENCE_REQUIRED", "父任务验收必须引用证据", 400);
    }
    const accepted = verification.verdict === "accepted";
    const updated = this.service.store.updateDelegationJob(job.id, {
      status: accepted ? "succeeded" : "failed",
      verification: { ...verification, checkedAt: verification.checkedAt || this.now().toISOString() },
      failure: accepted ? null : {
        code: "DELEGATION_RESULT_REJECTED",
        message: verification.summary,
        retryable: true,
        occurredAt: this.now().toISOString()
      },
      updatedAt: this.now().toISOString()
    });
    this.emit(accepted ? "delegation.verified" : "delegation.rejected", updated ?? job);
    return updated ?? job;
  }

  fail(jobId: string, message: string, retryable = true): DelegationJob {
    const job = this.require(jobId);
    if (job.status === "succeeded") throw new DelegationError("DELEGATION_ALREADY_SUCCEEDED", "已成功的委派不能标记失败");
    if (job.status === "cancelled") return job;
    if (job.status === "failed") return job;
    const updated = this.service.store.updateDelegationJob(job.id, {
      status: "failed",
      lease: null,
      failure: {
        code: "DELEGATION_CHILD_FAILED",
        message,
        retryable,
        occurredAt: this.now().toISOString()
      },
      updatedAt: this.now().toISOString()
    });
    this.emit("delegation.failed", updated ?? job);
    return updated ?? job;
  }

  cancel(jobId: string, reason: string): DelegationJob {
    const job = this.require(jobId);
    if (job.status === "succeeded") throw new DelegationError("DELEGATION_ALREADY_SUCCEEDED", "已成功的委派不能取消");
    if (job.status === "cancelled") return job;
    const child = job.childTaskId ? this.service.store.getTask(job.childTaskId) : null;
    if (child && !["completed", "cancelled"].includes(child.status)) {
      try {
        this.service.updateTask(child.id, { status: "cancelled", nextAction: null, error: null });
      } catch {
        // A terminal child task is already fenced; the delegation job remains cancelled.
      }
    }
    const updated = this.service.store.updateDelegationJob(job.id, {
      status: "cancelled",
      lease: null,
      cancelReason: reason,
      failure: {
        code: "DELEGATION_CANCELLED",
        message: reason,
        retryable: false,
        occurredAt: this.now().toISOString()
      },
      updatedAt: this.now().toISOString()
    });
    this.emit("delegation.cancelled", updated ?? job);
    return updated ?? job;
  }

  retry(jobId: string): DelegationJob {
    const job = this.require(jobId);
    if (!["failed", "orphaned"].includes(job.status)) {
      throw new DelegationError("DELEGATION_NOT_RETRYABLE", `委派当前不能重试：${job.status}`);
    }
    const child = job.childTaskId ? this.service.store.getTask(job.childTaskId) : null;
    if (child && child.status === "failed") {
      try {
        this.service.updateTask(child.id, { status: "queued", nextAction: null, error: null });
      } catch {
        // Retry remains available even if an execution owner advances the child first.
      }
    }
    const updated = this.service.store.updateDelegationJob(job.id, {
      status: "queued",
      lease: null,
      attempt: job.attempt + 1,
      result: null,
      verification: null,
      failure: null,
      cancelReason: null,
      updatedAt: this.now().toISOString()
    });
    this.emit("delegation.retried", updated ?? job);
    return updated ?? job;
  }

  recoverOrphans(): DelegationJob[] {
    const now = this.now();
    const recovered: DelegationJob[] = [];
    for (const job of this.service.store.listActiveDelegationJobs()) {
      const parent = this.service.store.getTask(job.parentTaskId);
      const leaseExpired = job.lease ? new Date(job.lease.expiresAt).getTime() <= now.getTime() : false;
      const deadlineExpired = job.deadline ? new Date(job.deadline).getTime() <= now.getTime() : false;
      const parentGone = !parent || ["completed", "failed", "cancelled"].includes(parent.status);
      if (!leaseExpired && !deadlineExpired && !parentGone) continue;
      const reason = parentGone ? "父任务已结束或丢失" : deadlineExpired ? "委派截止时间已到" : "委派租约已过期";
      const updated = this.service.store.updateDelegationJob(job.id, {
        status: "orphaned",
        lease: null,
        failure: {
          code: "DELEGATION_ORPHANED",
          message: reason,
          retryable: true,
          occurredAt: now.toISOString()
        },
        updatedAt: now.toISOString()
      });
      if (updated) recovered.push(updated);
      this.emit("delegation.orphaned", updated ?? job);
    }
    return recovered;
  }

  assertEffectAllowed(taskId: string): void {
    const job = this.service.store.getDelegationJobByChildTask(taskId);
    if (!job) return;
    if (["queued", "leased", "running"].includes(job.status)) return;
    throw new DelegationError("DELEGATION_CLOSED", `委派 ${job.id} 已结束，不能再产生外部效果：${job.status}`);
  }

  list(parentTaskId: string): DelegationJob[] {
    return this.service.store.listDelegationJobs(parentTaskId);
  }

  private require(jobId: string): DelegationJob {
    const job = this.service.store.getDelegationJob(jobId);
    if (!job) throw new DelegationError("DELEGATION_NOT_FOUND", "委派不存在", 404);
    return job;
  }

  private assertLease(job: DelegationJob, owner: string): void {
    if (!job.lease || job.lease.owner !== owner) {
      throw new DelegationError("DELEGATION_LEASE_REQUIRED", "委派执行需要当前租约持有者");
    }
    if (new Date(job.lease.expiresAt).getTime() <= this.now().getTime()) {
      throw new DelegationError("DELEGATION_LEASE_EXPIRED", "委派租约已过期");
    }
  }

  private derivePermissions(parent: TaskRecord, workspacePolicy: DelegationWorkspacePolicy, requested?: Partial<TaskPermissions>): TaskPermissions {
    const parentPermissions = this.parentPermissions(parent);
    const readRoots = requested?.readRoots?.length ? requested.readRoots : parentPermissions.readRoots;
    for (const root of readRoots) {
      if (!parentPermissions.readRoots.some((candidate) => pathWithin(candidate, root))) {
        throw new DelegationError("DELEGATION_PERMISSION_ESCALATION", `读取目录超出父任务：${root}`);
      }
    }
    let writeRoots = requested?.writeRoots?.length ? requested.writeRoots : [];
    if (!requested?.writeRoots?.length && workspacePolicy === "isolated-write") {
      const base = parentPermissions.writeRoots[0];
      if (!base) throw new DelegationError("DELEGATION_WORKSPACE_DENIED", "父任务没有写权限，不能创建隔离写工作区");
      writeRoots = [join(base, ".hearth-delegations", randomUUID())];
    }
    for (const root of writeRoots) {
      if (!parentPermissions.writeRoots.some((candidate) => pathWithin(candidate, root))) {
        throw new DelegationError("DELEGATION_PERMISSION_ESCALATION", `写入目录超出父任务：${root}`);
      }
    }
    const networkHosts = requested?.networkHosts?.length ? requested.networkHosts : parentPermissions.networkHosts;
    for (const host of networkHosts) {
      if (!parentPermissions.networkHosts.some((candidate) => hostWithin(candidate, host))) {
        throw new DelegationError("DELEGATION_PERMISSION_ESCALATION", `网络域超出父任务：${host}`);
      }
    }
    const tools = requested?.tools?.length ? requested.tools : parentPermissions.tools;
    for (const tool of tools) {
      if (!parentPermissions.tools.includes(tool) || !SAFE_DELEGATION_TOOLS.includes(tool as typeof SAFE_DELEGATION_TOOLS[number])) {
        throw new DelegationError("DELEGATION_PERMISSION_ESCALATION", `工具超出委派白名单：${tool}`);
      }
    }
    return {
      readRoots: [...readRoots],
      writeRoots: [...writeRoots],
      networkHosts: [...networkHosts],
      tools: [...tools]
    };
  }

  private deriveTools(parent: TaskRecord, workspacePolicy: DelegationWorkspacePolicy, requested: string[] | undefined): string[] {
    const parentPermissions = this.parentPermissions(parent);
    const tools = (requested?.length ? requested : parentPermissions.tools)
      .filter((tool) => workspacePolicy === "isolated-write" || tool !== "shell");
    for (const tool of tools) {
      if (!parentPermissions.tools.includes(tool) || !SAFE_DELEGATION_TOOLS.includes(tool as typeof SAFE_DELEGATION_TOOLS[number])) {
        throw new DelegationError("DELEGATION_PERMISSION_ESCALATION", `工具超出委派白名单：${tool}`);
      }
      if (tool === "shell" && workspacePolicy !== "isolated-write") {
        throw new DelegationError("DELEGATION_TOOL_DENIED", "只读或共享读取委派不能直接运行 shell");
      }
    }
    return [...tools];
  }

  private deriveNetwork(parent: TaskRecord, requested: string[] | undefined): string[] {
    const parentPermissions = this.parentPermissions(parent);
    const hosts = requested?.length ? requested : parentPermissions.networkHosts;
    for (const host of hosts) {
      if (!parentPermissions.networkHosts.some((candidate) => hostWithin(candidate, host))) {
        throw new DelegationError("DELEGATION_PERMISSION_ESCALATION", `网络域超出父任务：${host}`);
      }
    }
    return [...hosts];
  }

  private parentPermissions(parent: TaskRecord): TaskPermissions {
    const declared = parent.permissions;
    if (!declared) {
      return {
        readRoots: [parent.outputDir],
        writeRoots: [],
        networkHosts: [...parent.networkHosts],
        tools: []
      };
    }
    return {
      readRoots: [...declared.readRoots],
      writeRoots: [...declared.writeRoots],
      networkHosts: [...declared.networkHosts],
      tools: [...declared.tools]
    };
  }

  private emit(type: string, job: DelegationJob): void {
    const event = this.service.store.appendEvent({
      type,
      taskId: job.parentTaskId,
      runId: job.childRunId ?? job.parentRunId,
      payload: job
    });
    this.service.bus.publish(event);
  }
}

function normalizeBudget(input: DelegationBudget | undefined): DelegationBudget {
  const budget = input ?? {};
  for (const [key, value] of Object.entries(budget)) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new DelegationError("DELEGATION_BUDGET_INVALID", `委派预算 ${key} 必须为正数`, 400);
    }
  }
  return {
    ...(budget.tokens !== undefined ? { tokens: Math.floor(budget.tokens) } : {}),
    ...(budget.wallClockMs !== undefined ? { wallClockMs: Math.floor(budget.wallClockMs) } : {}),
    ...(budget.maxSteps !== undefined ? { maxSteps: Math.floor(budget.maxSteps) } : {})
  };
}

function redactObject(value: Record<string, unknown>): Record<string, unknown> {
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") return redactSecrets(input);
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, item]) => [key, walk(item)]));
    }
    return input;
  };
  return walk(value) as Record<string, unknown>;
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

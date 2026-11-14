import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  ApprovalListItem,
  ApprovalMode,
  ApprovalRecord,
  ArtifactRecord,
  ChatMessageRecord,
  ConversationSettings,
  DesktopCommandRecord,
  DesktopFrameRecord,
  DesktopSessionRecord,
  DevicePairingRequest,
  DeviceRecord,
  EffectListItem,
  EffectRecord,
  EventWindow,
  ExecutorId,
  GoalCompletionReport,
  GoalContract,
  GoalState,
  OutboxDraft,
  ReconcileItem,
  RunListItem,
  RunBudget,
  RunCheckpointRecord,
  RunRecord,
  StatsSnapshot,
  TaskDeliverable,
  TaskFollowUpRecord,
  TaskInput,
  TaskKind,
  TaskListItem,
  TaskPermissions,
  TaskProposalRecord,
  TaskRecord,
  TaskStatus
} from "@hearth/core";
import { assertTransition, defaultConversationSettings, EXECUTOR_IDS, TASK_STATUS_LABELS, TASK_STATUSES } from "@hearth/core";
import { HearthStore, type PageOptions } from "@hearth/eventlog";
import { getTemplate, TEMPLATES } from "@hearth/templates";
import { resolveRepoPath } from "./config.ts";
import { EventBus } from "./events.ts";
import { executorName, resolveExecutorFromEnabled, resolveExecutorLocked } from "./executors.ts";
import { buildTaskStatusMessage } from "./task-status-messages.ts";
import { GITHUB_NETWORK_HOSTS, wantsGithubAccess, wantsPublicWebResearch } from "./task-intent.ts";

export interface CreateTaskInput {
  executionMode?: TaskRecord["executionMode"];
  externalRef?: string;
  requestHash?: string;
  templateId?: string;
  title?: string;
  goal?: string;
  textInput?: string;
  sourceItemIds?: string[];
  fileInputs?: { label: string; path: string }[];
  inputs?: TaskInput[];
  url?: string;
  networkHosts?: string[];
  conversationId?: string;
  executorId?: ExecutorId;
  taskKind?: TaskKind;
  expectedOutputs?: string[];
  permissions?: TaskPermissions;
  outputDir?: string;
  methodId?: string;
  methodVersion?: number;
  goalId?: string;
  projectId?: string;
}

export interface CreateGoalInput {
  title: string;
  objective: string;
  constraints?: string[];
  forbiddenActions?: string[];
  authoritySources?: GoalContract["authoritySources"];
  successCriteria?: GoalContract["successCriteria"];
  evidenceRequirements?: string[];
  budget?: GoalContract["budget"];
  deadline?: string;
  stopConditions?: string[];
  reviewPolicy?: GoalContract["reviewPolicy"];
  currentState?: GoalState;
}

export class TaskInputSelectionError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "TaskInputSelectionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface TaskView {
  task: TaskRecord;
  goal: GoalContract | null;
  completionReport: GoalCompletionReport | null;
  runs: ReturnType<HearthStore["listRuns"]>;
  approvals: ReturnType<HearthStore["listApprovals"]>;
  artifacts: ReturnType<HearthStore["listArtifacts"]>;
  effects: ReturnType<HearthStore["listEffects"]>;
  followUps: TaskFollowUpRecord[];
  checkpoints: RunCheckpointRecord[];
  events: ReturnType<HearthStore["listEvents"]>;
  eventTotal: number;
}

export interface EventWindowQuery {
  limit: number;
  afterSeq?: number | undefined;
  beforeSeq?: number | undefined;
  taskId?: string | undefined;
  type?: string | undefined;
}

export interface ExportSnapshot {
  format: "hearth-export";
  version: 1;
  exportedAt: string;
  tasks: TaskRecord[];
  runs: RunRecord[];
  approvals: ApprovalRecord[];
  artifacts: ArtifactRecord[];
  effects: EffectRecord[];
  followUps: TaskFollowUpRecord[];
  outboxDrafts: OutboxDraft[];
  goals: GoalContract[];
  events: ReturnType<HearthStore["listEvents"]>;
}

const VIEW_EVENT_TAIL = 200;

export class HearthService {
  readonly store: HearthStore;
  readonly bus = new EventBus();
  private contextSink: ((message: ChatMessageRecord) => void) | null = null;

  constructor(store: HearthStore) {
    this.store = store;
  }

  setContextSink(sink: ((message: ChatMessageRecord) => void) | null): void {
    this.contextSink = sink;
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const now = new Date().toISOString();
    const template = input.templateId ? getTemplate(input.templateId) : undefined;
    if (input.templateId && !template) throw new Error(`Unknown template: ${input.templateId}`);
    const project = input.projectId ? this.store.getLocalProject(input.projectId) : null;
    if (input.projectId && !project) {
      throw new TaskInputSelectionError("PROJECT_NOT_FOUND", "选择的本地项目不存在", 404);
    }
    if (project && template?.github) {
      throw new TaskInputSelectionError("PROJECT_GITHUB_CONFLICT", "本地项目任务不能同时使用 GitHub 仓库模板", 409);
    }
    if (project && input.executorId && input.executorId !== "native") {
      throw new TaskInputSelectionError("PROJECT_EXECUTOR_UNSUPPORTED", "本地项目任务当前仅支持 native 执行器", 409);
    }
    const id = `${template?.id ?? "CUSTOM"}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const inputs = template ? [...template.inputs] : [];
    if (input.inputs) inputs.push(...input.inputs);
    if (project && inputs.some((item) => item.kind === "github")) {
      throw new TaskInputSelectionError("PROJECT_GITHUB_CONFLICT", "本地项目任务不能同时包含 GitHub 仓库输入", 409);
    }
    const sourceItemIds = [...new Set(input.sourceItemIds ?? [])];
    if (sourceItemIds.length > 20) {
      throw new TaskInputSelectionError("TOO_MANY_SOURCE_ITEMS", "一次最多附加 20 个来源条目", 400);
    }
    for (const itemId of sourceItemIds) {
      const item = this.store.getSourceItem(itemId);
      if (!item) throw new TaskInputSelectionError("SOURCE_ITEM_NOT_FOUND", "选择的来源条目不存在", 404);
      const source = this.store.getSource(item.sourceId);
      if (!source) throw new TaskInputSelectionError("SOURCE_NOT_FOUND", "来源条目所属来源不存在", 404);
      if (source.status === "disconnected") {
        throw new TaskInputSelectionError("SOURCE_DISCONNECTED", `来源“${source.displayName}”已断开，不能新建任务`, 409);
      }
      if (item.status !== "ready" || !item.contentPath || !item.contentHash) {
        throw new TaskInputSelectionError("SOURCE_ITEM_NOT_READY", `来源条目“${item.label}”不可用，请重新读取来源`, 409);
      }
      inputs.push({
        kind: "source",
        label: `${source.displayName} · ${item.title || item.label}`,
        value: item.id,
        sha256: item.contentHash,
        source: {
          sourceId: source.id,
          sourceKind: source.kind,
          sourceName: source.displayName,
          itemId: item.id,
          itemKey: item.itemKey,
          title: item.title,
          locator: item.locator,
          fetchedAt: item.fetchedAt,
          contentHash: item.contentHash,
          coverage: item.coverage
        }
      });
    }
    for (const file of input.fileInputs ?? []) {
      inputs.push({ kind: "file", label: file.label, value: file.path });
    }
    let networkHosts = template?.networkHosts ?? input.networkHosts ?? [];
    if (template?.github || wantsGithubAccess([input.title, input.goal, input.textInput].filter(Boolean).join("\n"))) {
      networkHosts = [...new Set([...networkHosts, ...GITHUB_NETWORK_HOSTS])];
    }
    if (wantsPublicWebResearch([input.title, input.goal, input.textInput].filter(Boolean).join("\n"))) {
      networkHosts = [...new Set([...networkHosts, "*"])];
    }
    if (input.url) {
      inputs.push({ kind: "url", label: "网页", value: input.url });
      try {
        const host = new URL(input.url).hostname;
        if (host) networkHosts = [...new Set([...networkHosts, host])];
      } catch {
        throw new TaskInputSelectionError("INVALID_URL", "网址格式不正确", 400);
      }
    }
    if (input.textInput) inputs.push({ kind: "text", label: "用户请求", value: input.textInput });
    const executorId = project ? "native" : input.executorId ?? (template ? "codex" : "native");
    if (input.goalId && !this.store.getGoal(input.goalId)) throw new Error(`Unknown goal: ${input.goalId}`);
    const taskKind = input.taskKind ?? (template?.github || project ? "workspace" : "general");
    const expectedOutputs = input.expectedOutputs ?? template?.expectedOutputs ?? ["result.md"];
    const task: TaskRecord = {
      id,
      ...(input.executionMode ? { executionMode: input.executionMode } : {}),
      goalId: input.goalId ?? null,
      ...(input.externalRef ? { externalRef: input.externalRef, requestHash: input.requestHash ?? null } : {}),
      templateId: template?.id ?? null,
      title: input.title?.trim() || template?.title || "未命名任务",
      goal: input.goal?.trim() || template?.goal || input.textInput?.trim() || "完成用户描述的任务",
      status: "queued",
      createdAt: now,
      updatedAt: now,
      deadline: null,
      inputs,
      networkHosts,
      outputDir: input.outputDir ?? template?.outputDir ?? `.hearth/artifacts/${id}`,
      currentRunId: null,
      nextAction: "等待执行",
      error: null,
      resultSummary: null,
      conversationId: input.conversationId ?? null,
      executorId,
      taskKind,
      expectedOutputs,
      ...(input.permissions ? { permissions: input.permissions } : {}),
      methodId: input.methodId ?? null,
      methodVersion: input.methodVersion ?? null,
      ...(project ? { projectId: project.id } : {})
    };
    const event = this.store.appendEvent({ type: "task.created", taskId: id, payload: task });
    this.bus.publish(event);
    return task;
  }

  listTemplates(): typeof TEMPLATES {
    return TEMPLATES;
  }

  listTasks(): TaskRecord[] {
    return this.store.listTasks();
  }

  createGoal(input: CreateGoalInput): GoalContract {
    const now = new Date().toISOString();
    const criteria = input.successCriteria ?? [];
    const criterionIds = new Set<string>();
    for (const criterion of criteria) {
      if (!criterion.id.trim()) throw new Error("Goal criterion id is required");
      if (criterionIds.has(criterion.id)) throw new Error(`Duplicate goal criterion: ${criterion.id}`);
      criterionIds.add(criterion.id);
      if (!criterion.description.trim() || !criterion.check.trim()) throw new Error("Goal criterion description and check are required");
    }
    const goal: GoalContract = {
      goalId: randomUUID(),
      title: input.title.trim(),
      objective: input.objective.trim(),
      constraints: input.constraints ?? [],
      forbiddenActions: input.forbiddenActions ?? [],
      authoritySources: input.authoritySources ?? [{ kind: "user", ref: "local-user" }],
      successCriteria: criteria,
      evidenceRequirements: input.evidenceRequirements ?? [],
      budget: input.budget ?? {},
      ...(input.deadline ? { deadline: input.deadline } : {}),
      stopConditions: input.stopConditions ?? [],
      reviewPolicy: input.reviewPolicy ?? "human_on_risk",
      currentState: input.currentState ?? "draft",
      createdAt: now,
      updatedAt: now
    };
    if (!goal.title || !goal.objective) throw new Error("Goal title and objective are required");
    const event = this.store.appendEvent({ type: "goal.created", payload: goal });
    this.bus.publish(event);
    return goal;
  }

  getGoal(goalId: string): GoalContract | null {
    return this.store.getGoal(goalId);
  }

  listGoals(): GoalContract[] {
    return this.store.listGoals();
  }

  updateGoal(goalId: string, patch: Partial<Omit<GoalContract, "goalId" | "createdAt" | "updatedAt">>): GoalContract {
    const current = this.store.getGoal(goalId);
    if (!current) throw new Error(`Unknown goal: ${goalId}`);
    const updated: GoalContract = { ...current, ...patch, goalId, updatedAt: new Date().toISOString() };
    const event = this.store.appendEvent({ type: "goal.updated", payload: updated });
    this.bus.publish(event);
    return this.store.getGoal(goalId) ?? updated;
  }

  recordCompletionReport(report: GoalCompletionReport): GoalCompletionReport {
    const event = this.store.appendEvent({ type: "goal.completion.recorded", taskId: report.taskId, payload: report });
    this.bus.publish(event);
    return report;
  }

  latestCompletionReport(goalId: string): GoalCompletionReport | null {
    return this.store.latestGoalCompletionReport(goalId);
  }

  exportSnapshot(): ExportSnapshot {
    const tasks = this.store.listTasks();
    return {
      format: "hearth-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      tasks,
      runs: tasks.flatMap((task) => this.store.listRuns(task.id)),
      approvals: tasks.flatMap((task) => this.store.listApprovals(task.id)),
      artifacts: this.store.listAllArtifacts(),
      effects: this.store.listAllEffects(),
      followUps: tasks.flatMap((task) => this.store.listTaskFollowUps(task.id)),
      outboxDrafts: this.store.listOutboxDrafts(),
      goals: this.store.listGoals(),
      events: this.store.listEvents(0)
    };
  }

  view(taskId: string): TaskView | null {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    const events = this.store.listEvents(0, taskId);
    const runs = this.store.listRuns(taskId);
    return {
      task,
      goal: task.goalId ? this.store.getGoal(task.goalId) : null,
      completionReport: task.goalId ? this.store.latestGoalCompletionReport(task.goalId) : null,
      runs,
      approvals: this.store.listApprovals(taskId),
      artifacts: this.store.listArtifacts(taskId),
      effects: this.store.listEffects(taskId),
      followUps: this.store.listTaskFollowUps(taskId),
      checkpoints: runs.flatMap((run) => this.store.listRunCheckpoints(run.id)),
      events: events.slice(-VIEW_EVENT_TAIL),
      eventTotal: events.length
    };
  }

  listTaskItems(): TaskListItem[] {
    const runAggregates = this.store.runAggregatesByTask();
    const artifactCounts = this.store.artifactCountsByTask();
    const effectAggregates = this.store.effectAggregatesByTask();
    const pendingApprovals = this.store.pendingApprovalByTask();
    return this.store.listTasks().map((task) => {
      const runs = runAggregates.get(task.id);
      return {
        ...task,
        summary: {
          runs: runs?.runs ?? 0,
          lastDurationMs: runs?.lastDurationMs ?? null,
          lastUsage: runs?.lastUsage ?? null,
          artifacts: artifactCounts.get(task.id) ?? 0,
          phase: taskPhase(task),
          deliverables: visibleDeliverables(this.store.listArtifacts(task.id), task.expectedOutputs),
          effects: effectAggregates.get(task.id) ?? { total: 0, uncertain: 0 },
          approvalId: pendingApprovals.get(task.id) ?? null
        }
      };
    });
  }

  listRunItems(opts: PageOptions): { runs: RunListItem[]; total: number } {
    const titles = this.taskTitles();
    const page = this.store.listRunsPage(opts);
    return {
      runs: page.runs.map((run) => ({ ...run, taskTitle: titles.get(run.taskId) ?? "未命名任务" })),
      total: page.total
    };
  }

  listApprovalItems(opts: PageOptions & { brief?: boolean }): { approvals: ApprovalListItem[]; total: number } {
    const titles = this.taskTitles();
    const page = this.store.listApprovalsPage(opts);
    return {
      approvals: page.approvals.map((approval) => {
        const item = { ...approval, taskTitle: titles.get(approval.taskId) ?? "未命名任务" };
        if (opts.brief) {
          item.target = omitKey(approval.target, "body");
          item.preview = omitKey(approval.preview, "body");
        }
        return item;
      }),
      total: page.total
    };
  }

  listEffectItems(opts: PageOptions): { effects: EffectListItem[]; total: number } {
    const titles = this.taskTitles();
    const page = this.store.listEffectsPage(opts);
    return {
      effects: page.effects.map((effect) => ({ ...effect, taskTitle: titles.get(effect.taskId) ?? "未命名任务" })),
      total: page.total
    };
  }

  eventWindow(query: EventWindowQuery): EventWindow {
    const events = this.store.listEventsWindow(query);
    const first = events.at(0);
    const last = events.at(-1);
    const full = events.length === query.limit;
    const forward = query.afterSeq !== undefined && query.beforeSeq === undefined;
    return {
      events,
      total: this.store.countEvents(query.taskId, query.type),
      nextAfter: forward && full && last ? last.seq : null,
      nextBefore: !forward && full && first ? first.seq : null
    };
  }

  stats(): StatsSnapshot {
    const taskCounts = this.store.countTasksByStatus();
    const runCounts = this.store.countRunsByStatus();
    const durations = this.store.runDurationTotals();
    return {
      tasks: {
        total: TASK_STATUSES.reduce((sum, status) => sum + taskCounts[status], 0),
        byStatus: taskCounts
      },
      runs: {
        total: Object.values(runCounts).reduce((sum, count) => sum + count, 0),
        byStatus: runCounts,
        durationMs: durations.ms,
        durationCounted: durations.counted,
        durationUncounted: durations.uncounted,
        usage: this.store.usageTotals()
      },
      approvals: { byStatus: this.store.countApprovalsByStatus() },
      effects: { byStatus: this.store.countEffectsByStatus() },
      artifacts: this.store.artifactTotals(),
      events: { total: this.store.countEvents(), latestSeq: this.store.latestEventSeq() }
    };
  }

  taskTitles(): Map<string, string> {
    return new Map(this.store.listTasks().map((task) => [task.id, task.title]));
  }

  updateTask(taskId: string, patch: Partial<Pick<TaskRecord, "status" | "title" | "goal" | "goalId" | "currentRunId" | "nextAction" | "error" | "resultSummary" | "conversationId" | "executorId" | "taskKind" | "expectedOutputs" | "permissions" | "pendingInput" | "methodId" | "methodVersion" | "pinnedAt" | "archivedAt" | "budgetOverride">>, runId?: string): TaskRecord {
    const task = this.requireTask(taskId);
    if (patch.status && patch.status !== task.status) assertTransition(task.status, patch.status);
    const previousStatus = task.status;
    const statusChanged = Boolean(patch.status && patch.status !== previousStatus);
    const event = this.store.appendEvent({
      type: "task.updated",
      taskId,
      runId: runId ?? task.currentRunId,
      payload: { ...patch, updatedAt: new Date().toISOString() }
    });
    this.bus.publish(event);
    const updated = this.requireTask(taskId);
    if (statusChanged) this.appendTaskStatusMessage(updated, previousStatus);
    return updated;
  }

  setTaskOrganization(taskId: string, patch: { pinned?: boolean; archived?: boolean }): TaskRecord {
    const task = this.requireTask(taskId);
    const now = new Date().toISOString();
    return this.updateTask(taskId, {
      ...(patch.pinned === undefined ? {} : { pinnedAt: patch.pinned ? task.pinnedAt ?? now : null }),
      ...(patch.archived === undefined ? {} : { archivedAt: patch.archived ? task.archivedAt ?? now : null })
    });
  }

  conversationSettings(conversationId: string | null | undefined): ConversationSettings | null {
    if (!conversationId) return null;
    return this.store.getConversation(conversationId)?.settings ?? null;
  }

  approvalModeForTask(task: TaskRecord): ApprovalMode {
    return task.permissions?.approvalMode
      ?? this.conversationSettings(task.conversationId)?.approvalMode
      ?? "necessary";
  }

  appendChatMessage(message: ChatMessageRecord): ChatMessageRecord {
    const stored = this.store.createChatMessage(message);
    const event = this.store.appendEvent({
      type: "chat.message.created",
      taskId: message.taskId,
      payload: { message: stored, conversationId: message.conversationId }
    });
    this.bus.publish(event);
    try {
      this.contextSink?.(stored);
    } catch {
      // Context capture is best effort and never blocks chat delivery.
    }
    return stored;
  }

  private upsertTaskStatusChatMessage(message: ChatMessageRecord): ChatMessageRecord {
    const { message: stored, created } = this.store.upsertTaskStatusMessage(message);
    const event = this.store.appendEvent({
      type: created ? "chat.message.created" : "chat.message.updated",
      taskId: message.taskId,
      payload: { message: stored, conversationId: message.conversationId }
    });
    this.bus.publish(event);
    try {
      this.contextSink?.(stored);
    } catch {
      // Context capture is best effort and never blocks chat delivery.
    }
    return stored;
  }

  private appendTaskStatusMessage(task: TaskRecord, previousStatus: TaskStatus): void {
    if (!task.conversationId) return;
    const conversation = this.store.getConversation(task.conversationId);
    if (!conversation) return;
    const approval = task.status === "waiting_approval"
      ? this.store.listApprovals(task.id).find((item) => item.status === "pending")
      : null;
    const runs = this.store.listRuns(task.id);
    const attempt = task.status === "queued" ? runs.length + 1 : Math.max(runs.length, 1);
    const content = buildTaskStatusMessage({
      task,
      previousStatus,
      approvalMode: conversation.settings.approvalMode,
      approvalSummary: approval?.summary ?? task.nextAction,
      attempt
    });
    this.upsertTaskStatusChatMessage({
      id: randomUUID(),
      conversationId: task.conversationId ?? null,
      role: "assistant",
      content,
      taskId: task.id,
      attachments: [],
      createdAt: new Date().toISOString(),
      kind: "task_status",
      taskStatus: task.status
    });
  }

  createRun(run: RunRecord): RunRecord {
    this.store.appendEvent({ type: "run.created", taskId: run.taskId, runId: run.id, payload: run });
    return run;
  }

  updateRun(runId: string, taskId: string, patch: Partial<Pick<RunRecord, "status" | "threadId" | "startedAt" | "endedAt" | "failure" | "usage" | "executorId" | "checkpointSeq" | "budget">>): void {
    const event = this.store.appendEvent({
      type: "run.updated",
      taskId,
      runId,
      payload: patch
    });
    this.bus.publish(event);
  }

  createRunCheckpoint(checkpoint: RunCheckpointRecord): RunCheckpointRecord {
    const event = this.store.appendEvent({
      type: "run.checkpoint.created",
      taskId: checkpoint.taskId,
      runId: checkpoint.runId,
      payload: checkpoint
    });
    this.bus.publish(event);
    return checkpoint;
  }

  listRunCheckpoints(runId: string): RunCheckpointRecord[] {
    return this.store.listRunCheckpoints(runId);
  }

  latestRunCheckpoint(runId: string): RunCheckpointRecord | null {
    return this.store.latestRunCheckpoint(runId);
  }

  createTaskProposal(input: {
    conversationId: string;
    title: string;
    goal: string;
    executorId: ExecutorId;
    taskKind: TaskKind;
    expectedOutputs: string[];
    permissions: TaskPermissions;
    inputs?: TaskInput[];
    reason: string;
    ttlMs?: number;
  }): TaskProposalRecord {
    const now = new Date();
    const proposal: TaskProposalRecord = {
      id: `PROP-${randomUUID()}`,
      conversationId: input.conversationId,
      title: input.title,
      goal: input.goal,
      executorId: input.executorId,
      taskKind: input.taskKind,
      expectedOutputs: input.expectedOutputs,
      permissions: input.permissions,
      inputs: input.inputs ?? [],
      reason: input.reason,
      status: "pending",
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? 15 * 60_000)).toISOString(),
      createdAt: now.toISOString(),
      decidedAt: null
    };
    const event = this.store.appendEvent({ type: "task.proposal.created", payload: proposal });
    this.bus.publish(event);
    return proposal;
  }

  updateTaskProposal(id: string, patch: Partial<Pick<TaskProposalRecord, "status" | "decidedAt">>): TaskProposalRecord {
    const updated = this.store.updateTaskProposal(id, patch);
    if (!updated) throw new Error(`Task proposal not found: ${id}`);
    const event = this.store.appendEvent({ type: "task.proposal.updated", payload: updated });
    this.bus.publish(event);
    return updated;
  }

  createTaskFollowUp(taskId: string, content: string, mode: TaskFollowUpRecord["mode"]): TaskFollowUpRecord {
    const task = this.requireTask(taskId);
    const now = new Date().toISOString();
    const record: TaskFollowUpRecord = {
      id: randomUUID(),
      taskId,
      conversationId: task.conversationId ?? null,
      content,
      mode,
      status: mode === "steer" ? "steering" : "queued",
      appliedRunId: null,
      error: null,
      createdAt: now,
      updatedAt: now
    };
    const event = this.store.appendEvent({ type: "task.follow-up.created", taskId, payload: record });
    this.bus.publish(event);
    if (task.conversationId) {
      this.appendChatMessage({
        id: randomUUID(),
        conversationId: task.conversationId,
        role: "user",
        content,
        taskId,
        attachments: [],
        createdAt: now
      });
    }
    return record;
  }

  updateTaskFollowUp(
    id: string,
    patch: Partial<Pick<TaskFollowUpRecord, "content" | "status" | "appliedRunId" | "error">>
  ): TaskFollowUpRecord {
    const updated = this.store.updateTaskFollowUp(id, {
      ...patch,
      updatedAt: new Date().toISOString()
    });
    if (!updated) throw new Error(`Task follow-up not found: ${id}`);
    const event = this.store.appendEvent({
      type: "task.follow-up.updated",
      taskId: updated.taskId,
      runId: updated.appliedRunId,
      payload: updated
    });
    this.bus.publish(event);
    return updated;
  }

  confirmTaskProposal(
    id: string,
    available: Record<ExecutorId, boolean> = defaultExecutorAvailability(),
    options: { projectId?: string | null | undefined } = {}
  ): { proposal: TaskProposalRecord; task: TaskRecord } {
    const proposal = this.requireProposal(id);
    if (proposal.status !== "pending") throw new Error(`提案状态不能确认：${proposal.status}`);
    if (Date.parse(proposal.expiresAt) <= Date.now()) {
      this.updateTaskProposal(id, { status: "expired", decidedAt: new Date().toISOString() });
      throw new Error("提案已过期，请重新发起");
    }
    const conversationSettings = this.conversationSettings(proposal.conversationId);
    const enabled = conversationSettings?.executorEnabled ?? defaultConversationSettings().executorEnabled;
    const lockedExecutorId = conversationSettings?.preferredExecutorId ?? null;
    const resolution = lockedExecutorId
      ? resolveExecutorLocked(lockedExecutorId, enabled, available)
      : resolveExecutorFromEnabled(proposal.executorId, enabled, available);
    if (!resolution.executorId) {
      if (lockedExecutorId) {
        throw new Error(`已锁定 ${executorName(lockedExecutorId)}，但${resolution.reason ?? "当前无法执行"}。请检查执行器设置，或取消锁定后重试`);
      }
      throw new Error("所有执行器都已关闭，请先在对话输入框上方启用一个执行器，再确认任务");
    }
    const executorId: ExecutorId = resolution.executorId;
    const reroutedFrom = resolution.reroutedFrom;
    const projectId = options.projectId?.trim() || null;
    if (projectId && executorId !== "native") {
      throw new Error("本地项目任务当前仅支持 native 执行器，请先切换到 native 再确认");
    }
    const task = this.createTask({
      title: proposal.title,
      goal: proposal.goal,
      conversationId: proposal.conversationId,
      executorId,
      taskKind: projectId ? "workspace" : proposal.taskKind,
      expectedOutputs: proposal.expectedOutputs,
      permissions: proposal.permissions,
      inputs: proposal.inputs,
      networkHosts: proposal.permissions.networkHosts,
      ...(projectId ? { projectId } : {})
    });
    const updated = this.updateTaskProposal(id, { status: "confirmed", decidedAt: new Date().toISOString() });
    this.appendChatMessage({
      id: randomUUID(),
      conversationId: proposal.conversationId,
      role: "assistant",
      content: `任务「${task.title}」已确认并排队。\n\n执行器：${executorName(executorId)}${reroutedFrom
        ? `\n\n${resolution.reason ?? "原执行器不可用"}，已自动改由 ${executorName(executorId)} 接管。`
        : ""}`,
      taskId: task.id,
      attachments: [],
      createdAt: new Date().toISOString(),
      kind: "task_status",
      taskStatus: "queued"
    });
    return { proposal: updated, task };
  }

  rejectTaskProposal(id: string): TaskProposalRecord {
    const proposal = this.requireProposal(id);
    if (proposal.status !== "pending") throw new Error(`提案状态不能拒绝：${proposal.status}`);
    return this.updateTaskProposal(id, { status: "rejected", decidedAt: new Date().toISOString() });
  }

  requireProposal(id: string): TaskProposalRecord {
    const proposal = this.store.getTaskProposal(id);
    if (!proposal) throw new Error(`Task proposal not found: ${id}`);
    return proposal;
  }

  publishArtifact(artifact: ArtifactRecord): ArtifactRecord {
    const event = this.store.appendEvent({
      type: "artifact.published",
      taskId: artifact.taskId,
      runId: artifact.runId,
      payload: artifact
    });
    this.bus.publish(event);
    return artifact;
  }

  createApproval(approval: ApprovalRecord): ApprovalRecord {
    const event = this.store.appendEvent({
      type: "approval.created",
      taskId: approval.taskId,
      runId: approval.runId,
      payload: approval
    });
    this.bus.publish(event);
    return approval;
  }

  updateApproval(
    approvalId: string,
    patch: Partial<Pick<ApprovalRecord,
      "status" | "decidedAt" | "effectId" | "goalId" | "actionDigest" | "permissionMode" |
      "context" | "maxUses" | "usedCount" | "approvedBy" | "issuedAt" | "revokedAt" |
      "action" | "rejectionCount">>
  ): ApprovalRecord {
    const current = this.store.getApproval(approvalId);
    if (!current) throw new Error(`Approval not found: ${approvalId}`);
    const event = this.store.appendEvent({
      type: "approval.updated",
      taskId: current.taskId,
      runId: current.runId,
      payload: { id: approvalId, ...patch }
    });
    this.bus.publish(event);
    const updated = this.store.getApproval(approvalId);
    if (!updated) throw new Error(`Approval projection missing: ${approvalId}`);
    return updated;
  }

  createEffect(effect: EffectRecord): EffectRecord {
    const event = this.store.appendEvent({
      type: "effect.created",
      taskId: effect.taskId,
      payload: effect
    });
    this.bus.publish(event);
    return effect;
  }

  updateEffect(
    effectId: string,
    patch: Partial<Pick<EffectRecord,
      "status" | "receipt" | "error" | "updatedAt" | "goalId" | "effectType" |
      "replayPolicy" | "actionDigest" | "resolvedActionDigest" | "attemptCount" |
      "maxAttempts" | "leaseOwner" | "leaseExpiresAt" | "availableAt" | "provider" |
      "providerRef" | "reconcileRef" | "reconciledAt" | "targetKey" | "suspendReason">>
  ): EffectRecord {
    const current = this.store.getEffect(effectId);
    if (!current) throw new Error(`Effect not found: ${effectId}`);
    const event = this.store.appendEvent({
      type: "effect.updated",
      taskId: current.taskId,
      payload: { id: effectId, ...patch }
    });
    this.bus.publish(event);
    const updated = this.store.getEffect(effectId);
    if (!updated) throw new Error(`Effect projection missing: ${effectId}`);
    return updated;
  }

  createReconcileItem(item: ReconcileItem): ReconcileItem {
    const event = this.store.appendEvent({
      type: "reconcile.opened",
      taskId: item.taskId,
      payload: item
    });
    this.bus.publish(event);
    return item;
  }

  updateReconcileItem(
    itemId: string,
    patch: Partial<Pick<ReconcileItem,
      "status" | "reason" | "attempted" | "suggestedActions" | "checkCount" |
      "resolutionNote" | "updatedAt" | "resolvedAt">>
  ): ReconcileItem {
    const current = this.store.getReconcileItem(itemId);
    if (!current) throw new Error(`Reconcile item not found: ${itemId}`);
    const next: ReconcileItem = { ...current, ...patch };
    const type = patch.status === "resolved_committed" || patch.status === "resolved_absent" || patch.status === "abandoned"
      ? "reconcile.resolved"
      : "reconcile.updated";
    const event = this.store.appendEvent({
      type,
      taskId: current.taskId,
      payload: next
    });
    this.bus.publish(event);
    const updated = this.store.getReconcileItem(itemId);
    if (!updated) throw new Error(`Reconcile projection missing: ${itemId}`);
    return updated;
  }

  createOutboxDraft(draft: OutboxDraft): OutboxDraft {
    const event = this.store.appendEvent({ type: "outbox.created", payload: draft });
    this.bus.publish(event);
    return draft;
  }

  updateOutboxDraft(
    draftId: string,
    patch: Partial<Pick<OutboxDraft,
      "account" | "to" | "cc" | "bcc" | "subject" | "body" | "attachments" | "status" |
      "taskId" | "approvalId" | "effectId" | "updatedAt" | "submittedAt" | "discardedAt">>
  ): OutboxDraft {
    const current = this.store.getOutboxDraft(draftId);
    if (!current) throw new Error(`Outbox draft not found: ${draftId}`);
    const event = this.store.appendEvent({ type: "outbox.updated", payload: { id: draftId, ...patch } });
    this.bus.publish(event);
    const updated = this.store.getOutboxDraft(draftId);
    if (!updated) throw new Error(`Outbox projection missing: ${draftId}`);
    return updated;
  }

  requireOutboxDraft(draftId: string): OutboxDraft {
    const draft = this.store.getOutboxDraft(draftId);
    if (!draft) throw new Error(`Outbox draft not found: ${draftId}`);
    return draft;
  }

  createPairingRequest(request: DevicePairingRequest): DevicePairingRequest {
    const event = this.store.appendEvent({ type: "device.pairing-requested", payload: request });
    this.bus.publish(event);
    return request;
  }

  updatePairingRequest(request: DevicePairingRequest): DevicePairingRequest {
    const event = this.store.appendEvent({ type: "device.pairing-updated", payload: request });
    this.bus.publish(event);
    return request;
  }

  createDevice(device: DeviceRecord): DeviceRecord {
    const event = this.store.appendEvent({ type: "device.paired", payload: device });
    this.bus.publish(event);
    return device;
  }

  updateDevice(device: DeviceRecord): DeviceRecord {
    const event = this.store.appendEvent({ type: "device.updated", payload: device });
    this.bus.publish(event);
    return device;
  }

  createDesktopSession(session: DesktopSessionRecord): DesktopSessionRecord {
    const event = this.store.appendEvent({ type: "desktop.session.created", payload: session });
    this.bus.publish(event);
    return session;
  }

  updateDesktopSession(session: DesktopSessionRecord): DesktopSessionRecord {
    const event = this.store.appendEvent({ type: "desktop.session.updated", payload: session });
    this.bus.publish(event);
    return session;
  }

  updateDesktopFrame(frame: DesktopFrameRecord): DesktopFrameRecord {
    const event = this.store.appendEvent({ type: "desktop.frame.updated", payload: frame });
    this.bus.publish(event);
    return frame;
  }

  createDesktopCommand(command: DesktopCommandRecord): DesktopCommandRecord {
    const event = this.store.appendEvent({ type: "desktop.command.created", payload: command });
    this.bus.publish(event);
    return command;
  }

  updateDesktopCommand(command: DesktopCommandRecord): DesktopCommandRecord {
    const event = this.store.appendEvent({ type: "desktop.command.updated", payload: command });
    this.bus.publish(event);
    return command;
  }

  requireTask(taskId: string): TaskRecord {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  validateInputFiles(task: TaskRecord): void {
    for (const input of task.inputs) {
      if (input.kind === "file" && !existsSync(resolveRepoPath(input.value))) {
        throw new Error(`Missing input file: ${input.value}`);
      }
    }
  }

  allowedNetworkHosts(task: TaskRecord): string[] {
    return [...task.networkHosts];
  }

  statusLabel(status: TaskStatus): string {
    return TASK_STATUS_LABELS[status];
  }
}

function taskPhase(task: TaskRecord): string {
  if (task.status === "running") return task.nextAction || "正在执行";
  return TASK_STATUS_LABELS[task.status];
}

export function visibleDeliverables(artifacts: ArtifactRecord[], expectedOutputs?: string[]): TaskDeliverable[] {
  return artifacts
    .filter((artifact) => {
      const path = artifact.relativePath.replace(/\\/g, "/");
      if (path === "run-manifest.json" || path === "pr-preview.json") return false;
      if (path.startsWith("inputs/") || path.startsWith("runtime/") || path.startsWith(".hearth/")) return false;
      if (path.toLowerCase().endsWith(".json") && !isExpectedPath(path, expectedOutputs)) return false;
      return true;
    })
    .map((artifact) => ({
      id: artifact.id,
      name: artifact.relativePath.split("/").pop() ?? artifact.relativePath,
      relativePath: artifact.relativePath,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes
    }));
}

function defaultExecutorAvailability(): Record<ExecutorId, boolean> {
  const available = {} as Record<ExecutorId, boolean>;
  for (const id of EXECUTOR_IDS) {
    available[id] = id === "native" || id === "codex" || id === "hermes";
  }
  return available;
}

function isExpectedPath(path: string, expectedOutputs: string[] | undefined): boolean {
  if (!expectedOutputs) return true;
  return expectedOutputs.some((expected) => {
    const normalized = expected.replace(/\\/g, "/").replace(/\/+$/, "");
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

function omitKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
}

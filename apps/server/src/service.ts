import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  ApprovalListItem,
  ApprovalRecord,
  ArtifactRecord,
  EffectListItem,
  EffectRecord,
  EventWindow,
  RunListItem,
  RunRecord,
  StatsSnapshot,
  TaskListItem,
  TaskRecord,
  TaskStatus
} from "@hearth/core";
import { assertTransition, TASK_STATUS_LABELS, TASK_STATUSES } from "@hearth/core";
import { HearthStore, type PageOptions } from "@hearth/eventlog";
import { getTemplate, TEMPLATES } from "@hearth/templates";
import { resolveRepoPath } from "./config.ts";
import { EventBus } from "./events.ts";

export interface CreateTaskInput {
  templateId?: string;
  title?: string;
  goal?: string;
  textInput?: string;
  sourceItemIds?: string[];
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
  runs: ReturnType<HearthStore["listRuns"]>;
  approvals: ReturnType<HearthStore["listApprovals"]>;
  artifacts: ReturnType<HearthStore["listArtifacts"]>;
  effects: ReturnType<HearthStore["listEffects"]>;
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
  events: ReturnType<HearthStore["listEvents"]>;
}

const VIEW_EVENT_TAIL = 200;

export class HearthService {
  readonly store: HearthStore;
  readonly bus = new EventBus();

  constructor(store: HearthStore) {
    this.store = store;
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const now = new Date().toISOString();
    const template = input.templateId ? getTemplate(input.templateId) : undefined;
    if (input.templateId && !template) throw new Error(`Unknown template: ${input.templateId}`);
    const id = `${template?.id ?? "CUSTOM"}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const inputs = template ? [...template.inputs] : [];
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
    if (input.textInput) inputs.push({ kind: "text", label: "用户说明", value: input.textInput });
    const task: TaskRecord = {
      id,
      templateId: template?.id ?? null,
      title: input.title?.trim() || template?.title || "未命名任务",
      goal: input.goal?.trim() || template?.goal || input.textInput?.trim() || "完成用户描述的任务",
      status: "queued",
      createdAt: now,
      updatedAt: now,
      deadline: null,
      inputs,
      networkHosts: template?.networkHosts ?? [],
      outputDir: template?.outputDir ?? `.hearth/artifacts/${id}`,
      currentRunId: null,
      nextAction: "等待执行",
      error: null
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
      events: this.store.listEvents(0)
    };
  }

  view(taskId: string): TaskView | null {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    const events = this.store.listEvents(0, taskId);
    return {
      task,
      runs: this.store.listRuns(taskId),
      approvals: this.store.listApprovals(taskId),
      artifacts: this.store.listArtifacts(taskId),
      effects: this.store.listEffects(taskId),
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

  updateTask(taskId: string, patch: Partial<Pick<TaskRecord, "status" | "title" | "goal" | "currentRunId" | "nextAction" | "error">>, runId?: string): TaskRecord {
    const task = this.requireTask(taskId);
    if (patch.status && patch.status !== task.status) assertTransition(task.status, patch.status);
    const event = this.store.appendEvent({
      type: "task.updated",
      taskId,
      runId: runId ?? task.currentRunId,
      payload: { ...patch, updatedAt: new Date().toISOString() }
    });
    this.bus.publish(event);
    return this.requireTask(taskId);
  }

  createRun(run: RunRecord): RunRecord {
    this.store.appendEvent({ type: "run.created", taskId: run.taskId, runId: run.id, payload: run });
    return run;
  }

  updateRun(runId: string, taskId: string, patch: Partial<Pick<RunRecord, "status" | "threadId" | "startedAt" | "endedAt" | "failure" | "usage">>): void {
    const event = this.store.appendEvent({
      type: "run.updated",
      taskId,
      runId,
      payload: patch
    });
    this.bus.publish(event);
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
    patch: Partial<Pick<ApprovalRecord, "status" | "decidedAt" | "effectId">>
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
    patch: Partial<Pick<EffectRecord, "status" | "receipt" | "error" | "updatedAt">>
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

function omitKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
}

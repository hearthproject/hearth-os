import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ArtifactRecord, RunRecord, TaskRecord, TaskStatus } from "@hearth/core";
import { assertTransition, TASK_STATUS_LABELS } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { getTemplate, TEMPLATES } from "@hearth/templates";
import { resolveRepoPath } from "./config.ts";
import { EventBus } from "./events.ts";

export interface CreateTaskInput {
  templateId?: string;
  title?: string;
  goal?: string;
  textInput?: string;
}

export interface TaskView {
  task: TaskRecord;
  runs: ReturnType<HearthStore["listRuns"]>;
  approvals: ReturnType<HearthStore["listApprovals"]>;
  artifacts: ReturnType<HearthStore["listArtifacts"]>;
  effects: ReturnType<HearthStore["listEffects"]>;
  events: ReturnType<HearthStore["listEvents"]>;
}

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

  view(taskId: string): TaskView | null {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    return {
      task,
      runs: this.store.listRuns(taskId),
      approvals: this.store.listApprovals(taskId),
      artifacts: this.store.listArtifacts(taskId),
      effects: this.store.listEffects(taskId),
      events: this.store.listEvents(0, taskId).slice(-200)
    };
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

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ChatMessageRecord,
  ContextArtifactRef,
  ContextDeleteReceipt,
  ContextItem,
  ContextItemKind,
  ContextItemPage,
  ContextItemRole,
  ContextSensitivity,
  ContextSettings,
  ContextSettingsPatch,
  ContextSnapshot,
  ContextStep,
  ExecutorId,
  FailureCause,
  FailureDiagnosis,
  HandoffPacket,
  HandoffRecord,
  HandoffStatus,
  TaskContextState,
  TaskError,
  TaskRecord
} from "@hearth/core";
import { DEFAULT_CONTEXT_SETTINGS } from "@hearth/core";
import type { ContextIndex, ContextIndexHit, ContextIndexQuery } from "./context-index.ts";
import type { HearthService } from "./service.ts";

export interface ContextRecordInput {
  taskId: string;
  conversationId?: string | null;
  runId?: string | null;
  executorId?: ExecutorId | null;
  kind: ContextItemKind;
  role: ContextItemRole;
  content: string;
  provenance?: Record<string, unknown>;
  sensitivity?: ContextSensitivity;
  parentId?: string | null;
  executorEventId?: string | null;
  createdAt?: string;
}

export interface CreateHandoffInput {
  taskId: string;
  fromRunId: string;
  toRunId?: string | null;
  fromExecutor: ExecutorId;
  toExecutor: ExecutorId;
  generation?: number;
  sourceCursor?: number;
  status: HandoffStatus;
  reasonCode: FailureCause;
  diagnosis: FailureDiagnosis | null;
  packet: HandoffPacket | null;
  verification?: HandoffPacket["verification"] | null;
  artifactRef?: string | null;
  contextWatermarkSeq: number;
  initiatedBy: "auto" | "user";
}

export interface DiagnosisObservability {
  durationMs: number;
  contextTokens: number;
  modelAttempted: boolean;
  modelUsed: boolean;
}

export interface ContextRetentionReceipt {
  cutoff: string;
  tasksPruned: number;
  deletedItems: number;
  deletedBlobs: number;
  deletedHandoffs: number;
}

export class HandoffFenceError extends Error {
  readonly code = "HANDOFF_GENERATION_STALE";

  constructor(message: string) {
    super(message);
    this.name = "HandoffFenceError";
  }
}

export class ContextService {
  private readonly service: HearthService;
  private readonly blobRoot: string;
  private index: ContextIndex | null = null;

  constructor(service: HearthService, blobRoot: string) {
    this.service = service;
    this.blobRoot = resolve(blobRoot);
  }

  settings(): ContextSettings {
    return this.service.store.getContextSettings();
  }

  setIndex(index: ContextIndex | null): void {
    this.index = index;
  }

  async searchIndex(query: ContextIndexQuery): Promise<ContextIndexHit[]> {
    if (!this.index) return [];
    return this.index.search(query);
  }

  updateSettings(patch: ContextSettingsPatch): ContextSettings {
    const current = this.settings();
    if (patch.mode !== undefined && !["off", "shadow", "on"].includes(patch.mode)) {
      throw new Error("上下文模式不正确");
    }
    if (patch.maxHandoffs !== undefined && (!Number.isInteger(patch.maxHandoffs) || patch.maxHandoffs < 0 || patch.maxHandoffs > 5)) {
      throw new Error("最大接管次数必须在 0 到 5 之间");
    }
    if (patch.maxSameExecutorRetries !== undefined && (!Number.isInteger(patch.maxSameExecutorRetries) || patch.maxSameExecutorRetries < 0 || patch.maxSameExecutorRetries > 3)) {
      throw new Error("同执行器重试次数必须在 0 到 3 之间");
    }
    if (patch.retentionDays !== undefined && (!Number.isInteger(patch.retentionDays) || patch.retentionDays < 1 || patch.retentionDays > 3650)) {
      throw new Error("保留天数必须在 1 到 3650 之间");
    }
    if (patch.maxInlineBytes !== undefined && (!Number.isInteger(patch.maxInlineBytes) || patch.maxInlineBytes < 1024 || patch.maxInlineBytes > 1_000_000)) {
      throw new Error("单条内联上限必须在 1024 到 1000000 字节之间");
    }
    if (patch.projectionTokenBudget !== undefined && (!Number.isInteger(patch.projectionTokenBudget) || patch.projectionTokenBudget < 1000 || patch.projectionTokenBudget > 200_000)) {
      throw new Error("上下文预算必须在 1000 到 200000 token 之间");
    }
    if (patch.summarizeAfterTokens !== undefined && (!Number.isInteger(patch.summarizeAfterTokens) || patch.summarizeAfterTokens < 1000 || patch.summarizeAfterTokens > 500_000)) {
      throw new Error("摘要阈值必须在 1000 到 500000 token 之间");
    }
    if (patch.autoHandoffRisk !== undefined && !["low", "none"].includes(patch.autoHandoffRisk)) {
      throw new Error("自动接管风险级别不正确");
    }
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<ContextSettings>;
    const next: ContextSettings = {
      ...current,
      ...defined,
      updatedAt: new Date().toISOString()
    };
    const saved = this.service.store.setContextSettings(next);
    const event = this.service.store.appendEvent({ type: "context.settings.updated", payload: saved });
    this.service.bus.publish(event);
    return saved;
  }

  record(input: ContextRecordInput): ContextItem {
    this.assertHandoffFence(input);
    const settings = this.settings();
    const content = redactSecrets(input.content);
    const sha256 = createHash("sha256").update(content).digest("hex");
    let inline = content;
    let contentRef: string | null = null;
    if (Buffer.byteLength(content, "utf8") > settings.maxInlineBytes) {
      const blobPath = join(this.blobRoot, `${sha256}.txt`);
      mkdirSync(dirname(blobPath), { recursive: true });
      writeFileSync(blobPath, content, "utf8");
      contentRef = relative(this.blobRoot, blobPath).replace(/\\/g, "/");
      inline = `${content.slice(0, settings.maxInlineBytes)}\n\n[内容已截断，完整内容见 blob ${sha256}]`;
    }
    const itemId = randomUUID();
    const item = this.service.store.appendContextItem({
      seq: 0,
      id: itemId,
      conversationId: input.conversationId ?? null,
      taskId: input.taskId,
      runId: input.runId ?? null,
      executorId: input.executorId ?? null,
      kind: input.kind,
      role: input.role,
      content: inline,
      contentRef,
      sha256,
      tokens: estimateTokens(content),
      sensitivity: input.sensitivity ?? "normal",
      provenance: input.provenance ?? {},
      parentId: input.parentId ?? null,
      executorEventId: input.executorEventId ?? null,
      createdAt: input.createdAt ?? new Date().toISOString()
    });
    if (item.id !== itemId) return item;
    this.runIndexAction(() => this.index?.index(item));
    const event = this.service.store.appendEvent({
      type: "context.item.appended",
      taskId: item.taskId,
      runId: item.runId,
      payload: item
    });
    this.service.bus.publish(event);
    return item;
  }

  recordChatMessage(message: ChatMessageRecord): ContextItem | null {
    if (!message.taskId) return null;
    return this.record({
      taskId: message.taskId,
      conversationId: message.conversationId,
      kind: message.role === "user" ? "user_message" : "assistant_message",
      role: message.role,
      content: message.content,
      provenance: { source: "chat", chatMessageId: message.id, taskStatus: message.taskStatus ?? null },
      executorEventId: `chat:${message.id}`,
      createdAt: message.createdAt
    });
  }

  private assertHandoffFence(input: ContextRecordInput): void {
    if (!input.runId || input.kind === "handoff") return;
    const run = this.service.store.getRun(input.runId);
    if (!run) return;
    const latest = [...this.service.store.listHandoffs(input.taskId)]
      .sort((left, right) => right.generation - left.generation)[0];
    if (!latest) return;
    const runHandoff = run.handoffId ? this.service.store.getHandoff(run.handoffId) : null;
    const runGeneration = runHandoff?.generation ?? 0;
    if (runGeneration < latest.generation) {
      throw new HandoffFenceError(`执行器代次已过期：当前 ${latest.generation}，写入来自 ${runGeneration}`);
    }
    if (runGeneration === latest.generation && (latest.status === "failed" || latest.status === "cancelled")) {
      if (["failure", "diagnosis", "decision", "notice", "usage"].includes(input.kind)) return;
      throw new HandoffFenceError(`交接 ${latest.id} 已结束：${latest.status}`);
    }
  }

  recordFailure(task: TaskRecord, runId: string, executorId: ExecutorId, error: unknown): ContextItem {
    const message = error instanceof Error ? error.message : String(error);
    return this.record({
      taskId: task.id,
      conversationId: task.conversationId ?? null,
      runId,
      executorId,
      kind: "failure",
      role: "system",
      content: message,
      provenance: { source: "scheduler", errorName: error instanceof Error ? error.name : typeof error }
    });
  }

  recordDiagnosis(diagnosis: FailureDiagnosis, observability?: DiagnosisObservability): ContextItem {
    const item = this.record({
      taskId: diagnosis.taskId,
      runId: diagnosis.runId,
      kind: "diagnosis",
      role: "system",
      content: diagnosis.summary,
      provenance: { source: diagnosis.source, diagnosis, ...(observability ? { observability } : {}) },
      executorEventId: `diagnosis:${diagnosis.id}`
    });
    const event = this.service.store.appendEvent({
      type: "execution.diagnosed",
      taskId: diagnosis.taskId,
      runId: diagnosis.runId,
      payload: { ...diagnosis, ...(observability ? { observability } : {}) }
    });
    this.service.bus.publish(event);
    return item;
  }

  createHandoff(input: CreateHandoffInput): HandoffRecord {
    const now = new Date().toISOString();
    const handoff: HandoffRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      fromRunId: input.fromRunId,
      toRunId: input.toRunId ?? null,
      fromExecutor: input.fromExecutor,
      toExecutor: input.toExecutor,
      generation: input.generation ?? 1,
      sourceCursor: input.sourceCursor ?? input.contextWatermarkSeq,
      status: input.status,
      reasonCode: input.reasonCode,
      diagnosis: input.diagnosis,
      packet: input.packet,
      verification: input.verification ?? input.packet?.verification ?? null,
      artifactRef: input.artifactRef ?? null,
      contextWatermarkSeq: input.contextWatermarkSeq,
      initiatedBy: input.initiatedBy,
      createdAt: now,
      updatedAt: now
    };
    this.service.store.createHandoff(handoff);
    this.record({
      taskId: handoff.taskId,
      runId: handoff.fromRunId,
      executorId: handoff.fromExecutor,
      kind: "handoff",
      role: "system",
      content: handoff.packet?.summary ?? input.diagnosis?.summary ?? `${handoff.fromExecutor} 切换到 ${handoff.toExecutor}`,
      provenance: { source: "handoff", handoffId: handoff.id, status: handoff.status },
      executorEventId: `handoff:${handoff.id}`
    });
    const event = this.service.store.appendEvent({
      type: handoff.status === "pending_user" ? "execution.handoff.prepared" : "execution.handoff.started",
      taskId: handoff.taskId,
      runId: handoff.fromRunId,
      payload: handoff
    });
    this.service.bus.publish(event);
    return handoff;
  }

  updateHandoff(id: string, patch: Partial<Pick<HandoffRecord, "toRunId" | "status" | "diagnosis" | "packet" | "verification" | "artifactRef" | "updatedAt">>): HandoffRecord | null {
    const updated = this.service.store.updateHandoff(id, { ...patch, updatedAt: new Date().toISOString() });
    if (!updated) return null;
    const type = updated.status === "completed"
      ? "execution.handoff.completed"
      : updated.status === "failed" || updated.status === "cancelled"
        ? "execution.handoff.failed"
        : "execution.handoff.started";
    const event = this.service.store.appendEvent({ type, taskId: updated.taskId, runId: updated.toRunId ?? updated.fromRunId, payload: updated });
    this.service.bus.publish(event);
    return updated;
  }

  listHandoffs(taskId: string): HandoffRecord[] {
    return this.service.store.listHandoffs(taskId);
  }

  listItems(taskId: string, opts: { limit?: number; beforeSeq?: number | null } = {}): ContextItemPage {
    return this.service.store.listContextItems(taskId, opts);
  }

  getState(taskId: string): TaskContextState | null {
    return this.service.store.getTaskContextState(taskId);
  }

  snapshot(taskId: string, opts: { limit?: number; beforeSeq?: number | null } = {}): ContextSnapshot {
    return {
      settings: this.settings(),
      state: this.getState(taskId),
      handoffs: this.listHandoffs(taskId),
      items: this.listItems(taskId, opts)
    };
  }

  refreshSummary(taskId: string, options: { lastFailure?: TaskError | null; handoffCount?: number } = {}): TaskContextState {
    const task = this.service.requireTask(taskId);
    const runs = this.service.store.listRuns(taskId);
    const artifacts = this.service.store.listArtifacts(taskId);
    const handoffs = this.service.store.listHandoffs(taskId);
    const items = this.service.store.listContextItems(taskId, { limit: 200 }).items;
    const latestSeq = items[0]?.seq ?? 0;
    const completed: ContextStep[] = runs
      .filter((run) => run.status === "completed")
      .map((run) => ({ text: `${run.executorId ?? "codex"} 完成第 ${run.attempt} 次运行`, contextItemId: null }));
    const failed: ContextStep[] = runs
      .filter((run) => run.status === "failed")
      .map((run) => ({ text: `${run.executorId ?? "codex"} 第 ${run.attempt} 次运行失败：${run.failure?.message ?? "未知错误"}`, contextItemId: null }));
    const artifactRefs: ContextArtifactRef[] = artifacts.map((artifact) => ({
      artifactId: artifact.id,
      path: artifact.relativePath,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      mimeType: artifact.mimeType
    }));
    const openQuestions = task.pendingInput?.trim() ? [task.pendingInput.trim()] : [];
    const lastFailure = options.lastFailure ?? ([...runs].reverse().find((run) => run.failure)?.failure ?? task.error ?? null);
    const handoffCount = options.handoffCount ?? handoffs.length;
    const recent = items
      .filter((item) => ["assistant_message", "failure", "handoff", "diagnosis"].includes(item.kind))
      .slice(0, 6)
      .reverse()
      .map((item) => `- [${item.kind}] ${clip(item.content.replace(/\s+/g, " ").trim(), 200)}`);
    const summary = [
      `任务：${task.title}`,
      `目标：${clip(task.goal, 500)}`,
      `当前状态：${task.status}`,
      `执行器：${task.executorId ?? "native"}`,
      `已完成：${completed.length ? completed.map((step) => step.text).join("；") : "无"}`,
      `失败：${failed.length ? failed.map((step) => step.text).join("；") : "无"}`,
      `产物：${artifactRefs.length ? artifactRefs.map((artifact) => `${artifact.path} (${artifact.sha256.slice(0, 12)})`).join("；") : "无"}`,
      `接管次数：${handoffCount}`,
      `未决问题：${openQuestions.length ? openQuestions.join("；") : "无"}`,
      recent.length ? `最近进展：\n${recent.join("\n")}` : "最近进展：无",
      `下一步：${task.nextAction ?? "继续推进任务"}`
    ].join("\n");
    const state: TaskContextState = {
      taskId,
      summary,
      plan: [],
      completed,
      failed,
      artifacts: artifactRefs,
      openQuestions,
      lastFailure,
      handoffCount,
      summarySeq: latestSeq,
      updatedAt: new Date().toISOString()
    };
    return this.saveState(state);
  }

  saveState(state: TaskContextState): TaskContextState {
    this.service.store.upsertTaskContextState(state);
    const event = this.service.store.appendEvent({ type: "context.summary.updated", taskId: state.taskId, payload: state });
    this.service.bus.publish(event);
    return state;
  }

  pruneExpired(options: { now?: Date } = {}): ContextRetentionReceipt {
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - this.settings().retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const tasks = new Map(this.service.store.listTasks().map((task) => [task.id, task]));
    const receipt: ContextRetentionReceipt = {
      cutoff,
      tasksPruned: 0,
      deletedItems: 0,
      deletedBlobs: 0,
      deletedHandoffs: 0
    };
    for (const activity of this.service.store.listContextTaskActivity()) {
      const task = tasks.get(activity.taskId);
      if (!task || !["completed", "failed", "cancelled", "recoverable"].includes(task.status)) continue;
      if (activity.latestCreatedAt >= cutoff) continue;
      const deleted = this.deleteTaskContext(activity.taskId);
      receipt.tasksPruned += 1;
      receipt.deletedItems += deleted.deletedItems;
      receipt.deletedBlobs += deleted.deletedBlobs;
      receipt.deletedHandoffs += deleted.deletedHandoffs;
    }
    return receipt;
  }

  deleteTaskContext(taskId: string): ContextDeleteReceipt {
    this.service.requireTask(taskId);
    const refs = this.service.store.listContextContentRefs(taskId);
    const deleted = this.service.store.deleteTaskContext(taskId);
    this.runIndexAction(() => this.index?.removeTask(taskId));
    let deletedBlobs = 0;
    for (const ref of refs) {
      const target = isAbsolute(ref) ? resolve(ref) : resolve(this.blobRoot, ref);
      const rel = relative(this.blobRoot, target);
      if (rel.startsWith("..") || isAbsolute(rel)) continue;
      if (this.service.store.countContextContentRef(ref) > 0) continue;
      if (existsSync(target)) {
        unlinkSync(target);
        deletedBlobs += 1;
      }
    }
    const receipt: ContextDeleteReceipt = {
      taskId,
      deletedItems: deleted.deletedItems,
      deletedBlobs,
      deletedHandoffs: deleted.deletedHandoffs,
      createdAt: new Date().toISOString()
    };
    const event = this.service.store.appendEvent({ type: "context.task.deleted", taskId, payload: receipt });
    this.service.bus.publish(event);
    return receipt;
  }

  readBlob(contentRef: string): string | null {
    const target = isAbsolute(contentRef) ? resolve(contentRef) : resolve(this.blobRoot, contentRef);
    const rel = relative(this.blobRoot, target);
    if (rel.startsWith("..") || isAbsolute(rel) || rel === "" || !existsSync(target)) return null;
    return readFileSync(target, "utf8");
  }

  private runIndexAction(action: () => void | Promise<void> | undefined): void {
    try {
      const result = action();
      if (result) void result.catch(() => undefined);
    } catch {
      // Optional retrieval backends must never break the ledger.
    }
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3));
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED_TOKEN]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"',;]{6,}/gi, "$1=[REDACTED]")
    .replace(/\b(Authorization|Cookie)\s*:\s*[^\n]{6,}/gi, "$1: [REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

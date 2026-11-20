import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { MemoryRecord, SourceItem, TaskRecord } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";
import { redactSecrets } from "../context.ts";
import { isEvaluationMemory } from "../draft-intent.ts";
import { KnowledgeClient, type KnowledgeWriteInput } from "./client.ts";
import type { KnowledgeSettings, KnowledgeSettingsStore } from "./settings.ts";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_ATTEMPTS = 5;

export interface KnowledgeSyncDeps {
  store: HearthStore;
  settings: KnowledgeSettingsStore;
  clientFactory?: (settings: KnowledgeSettings) => KnowledgeClient;
  clock?: () => Date;
  readFile?: (path: string) => string;
}

export interface KnowledgeFlushResult {
  written: number;
  failed: number;
  skipped: number;
}

export interface KnowledgeDocument {
  uri: string;
  content: string;
  tags: string[];
  contentHash: string;
}

export class KnowledgeSyncService {
  private readonly store: HearthStore;
  private readonly settings: KnowledgeSettingsStore;
  private readonly clientFactory: (settings: KnowledgeSettings) => KnowledgeClient;
  private readonly clock: () => Date;
  private readonly readFile: (path: string) => string;
  private flushing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: KnowledgeSyncDeps) {
    this.store = deps.store;
    this.settings = deps.settings;
    this.clock = deps.clock ?? (() => new Date());
    this.readFile = deps.readFile ?? ((path) => readFileSync(path, "utf8"));
    this.clientFactory = deps.clientFactory ?? ((settings) => new KnowledgeClient(settings));
  }

  enqueueMemory(memory: MemoryRecord): boolean {
    const settings = this.settings.get();
    if (!settings.enabled || settings.write.memories === "off") return false;
    if (!isMemoryWritable(memory, settings.write.memories)) return false;
    const document = memoryDocument(memory);
    return this.enqueue({ kind: "memory", ref: memory.id, document });
  }

  enqueueTask(task: TaskRecord): boolean {
    const settings = this.settings.get();
    if (!settings.enabled || settings.write.tasks === "off") return false;
    if (task.status !== "completed") return false;
    if (isEvaluationMemory([task.title, task.goal, task.resultSummary ?? "", task.nextAction ?? ""].join("\n"))) return false;
    const document = taskDocument(task);
    return this.enqueue({ kind: "task", ref: task.id, document });
  }

  enqueueSource(item: SourceItem): boolean {
    const settings = this.settings.get();
    if (!settings.enabled || !settings.write.sources) return false;
    if (item.status !== "ready" || !item.contentPath) return false;
    if (isEvaluationMemory([item.title, item.locator, item.contentPath].join("\n"))) return false;
    try {
      if (statSync(item.contentPath).size > MAX_SOURCE_BYTES) return false;
    } catch {
      return false;
    }
    let text: string;
    try {
      text = this.readFile(item.contentPath);
    } catch {
      return false;
    }
    const document = sourceDocument(item, text);
    return this.enqueue({ kind: "source", ref: item.id, document });
  }

  enqueueDelete(kind: "memory" | "task" | "source", ref: string): boolean {
    const settings = this.settings.get();
    if (!settings.enabled) return false;
    const mapping = this.store.knowledgeMapGet(ref);
    if (!mapping) return false;
    const previous = this.store.getKnowledgeJob("delete", ref, mapping.uri, "delete");
    if (previous && ["pending", "running", "done"].includes(previous.status)) return false;
    const now = this.clock().toISOString();
    this.store.upsertKnowledgeJob({
      id: randomUUID(),
      kind: "delete",
      ref,
      uri: mapping.uri,
      op: "delete",
      contentHash: null,
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    });
    return true;
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
      void this.maybeReindex();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async reconcile(): Promise<{ memories: number; tasks: number; sources: number }> {
    const result = { memories: 0, tasks: 0, sources: 0 };
    if (!this.settings.get().enabled) return result;
    for (const memory of this.store.listMemories({ status: "active", limit: 10_000 })) {
      if (this.enqueueMemory(memory)) result.memories += 1;
    }
    for (const task of this.store.listTasks()) {
      if (task.status === "completed" && this.enqueueTask(task)) result.tasks += 1;
    }
    for (const item of this.store.listReadySourceItems(1000)) {
      if (this.enqueueSource(item)) result.sources += 1;
    }
    this.store.knowledgeStateSet("last_full_reconcile_at", this.clock().toISOString());
    await this.flush(50);
    return result;
  }

  async maybeReindex(): Promise<boolean> {
    const settings = this.settings.get();
    if (!settings.enabled || !settings.write.reindexCron) return false;
    const now = this.clock();
    if (!cronMatches(settings.write.reindexCron, now)) return false;
    const today = now.toISOString().slice(0, 10);
    if (this.store.knowledgeStateGet("last_reindex_date") === today) return false;
    return this.reindexNow();
  }

  async reindexNow(): Promise<boolean> {
    const settings = this.settings.get();
    if (!settings.enabled) return false;
    try {
      const client = this.clientFactory(settings);
      await Promise.all([
        client.reindex("viking://resources/hearth", { mode: "vectors_only", wait: false, recursive: true }),
        client.reindex("viking://user/default", { mode: "vectors_only", wait: false, recursive: true })
      ]);
      this.store.knowledgeStateSet("last_reindex_date", this.clock().toISOString().slice(0, 10));
      return true;
    } catch {
      return false;
    }
  }

  async flush(limit = 8): Promise<KnowledgeFlushResult> {
    if (this.flushing) return { written: 0, failed: 0, skipped: 0 };
    const settings = this.settings.get();
    if (!settings.enabled) return { written: 0, failed: 0, skipped: 0 };
    this.flushing = true;
    const result: KnowledgeFlushResult = { written: 0, failed: 0, skipped: 0 };
    try {
      const jobs = this.store.claimKnowledgeJobs(limit, this.clock().toISOString());
      for (const job of jobs) {
        if (job.op === "delete") {
          try {
            await this.clientFactory(settings).remove(job.uri, { recursive: false });
            this.store.knowledgeMapDelete(job.ref);
            this.store.finishKnowledgeJob(job.id, { status: "done", attempts: job.attempts });
            result.written += 1;
          } catch (error) {
            this.markFailure(job, error, result);
          }
          continue;
        }
        const document = this.resolveDocument(job.kind, job.ref);
        if (!document) {
          this.store.finishKnowledgeJob(job.id, { status: "dead", lastError: "source object not found" });
          result.skipped += 1;
          continue;
        }
        try {
          const input: KnowledgeWriteInput = {
            uri: document.uri,
            content: document.content,
            mode: "create",
            processingMode: "vectors_only",
            tags: document.tags,
            wait: false
          };
          await this.clientFactory(settings).write(input);
          this.store.knowledgeMapUpsert({
            hearthId: job.ref,
            uri: document.uri,
            kind: job.kind,
            contentHash: document.contentHash,
            updatedAt: this.clock().toISOString()
          });
          this.store.finishKnowledgeJob(job.id, { status: "done", attempts: job.attempts });
          result.written += 1;
        } catch (error) {
          this.markFailure(job, error, result);
        }
      }
      return result;
    } finally {
      this.flushing = false;
    }
  }

  private markFailure(job: { id: string; attempts: number }, error: unknown, result: KnowledgeFlushResult): void {
    const attempts = job.attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    const delayMs = Math.min(2 ** attempts * 30_000, 30 * 60_000);
    this.store.finishKnowledgeJob(job.id, {
      status: dead ? "dead" : "failed",
      attempts,
      lastError: error instanceof Error ? error.message : String(error),
      nextAttemptAt: dead ? null : new Date(this.clock().getTime() + delayMs).toISOString()
    });
    result.failed += 1;
  }

  private enqueue(input: { kind: "memory" | "task" | "source"; ref: string; document: KnowledgeDocument }): boolean {
    const existing = this.store.knowledgeMapGet(input.ref);
    if (existing && existing.contentHash === input.document.contentHash && existing.uri === input.document.uri) {
      return false;
    }
    const previous = this.store.getKnowledgeJob(input.kind, input.ref, input.document.uri, "write");
    if (
      previous &&
      previous.contentHash === input.document.contentHash &&
      ["pending", "running", "done"].includes(previous.status)
    ) {
      return false;
    }
    const now = this.clock().toISOString();
    this.store.upsertKnowledgeJob({
      id: randomUUID(),
      kind: input.kind,
      ref: input.ref,
      uri: input.document.uri,
      op: "write",
      contentHash: input.document.contentHash,
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    });
    return true;
  }

  private resolveDocument(kind: string, ref: string): KnowledgeDocument | null {
    if (kind === "memory") {
      const memory = this.store.getMemory(ref);
      if (!memory || memory.status === "forgotten") return null;
      return memoryDocument(memory);
    }
    if (kind === "task") {
      const task = this.store.getTask(ref);
      if (!task || task.status !== "completed") return null;
      return taskDocument(task);
    }
    if (kind === "source") {
      const item = this.store.getSourceItem(ref);
      if (!item || !item.contentPath) return null;
      try {
        return sourceDocument(item, this.readFile(item.contentPath));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function memoryDocument(memory: MemoryRecord): KnowledgeDocument {
  const body = redactSecrets(memory.content);
  const content = [
    "---",
    `hearth_id: ${memory.id}`,
    `kind: ${memory.kind}`,
    `tier: ${memory.tier}`,
    `confidence: ${memory.confidence}`,
    `trust: ${memory.trust}`,
    `scope: ${memory.scope}`,
    `origin: ${memory.originClass}`,
    `updated_at: ${memory.updatedAt}`,
    "---",
    `# ${memory.kind} · ${memory.subjectKey}`,
    "",
    body
  ].join("\n");
  const bucket = memory.kind === "preference" ? "preferences" : memory.tier;
  return {
    uri: `viking://user/default/memories/${bucket}/${slug(memory.subjectKey, memory.kind)}-${hash8(memory.id)}.md`,
    content,
    tags: ["source=hearth", `hearth_kind=${memory.kind}`, `hearth_tier=${memory.tier}`],
    contentHash: sha256(content)
  };
}

export function taskDocument(task: TaskRecord): KnowledgeDocument {
  const content = redactSecrets([
    "---",
    `hearth_task_id: ${task.id}`,
    `status: ${task.status}`,
    `executor: ${task.executorId ?? "unknown"}`,
    `completed_at: ${task.updatedAt}`,
    "---",
    `# ${task.title}`,
    "",
    "## 目标",
    task.goal,
    "",
    "## 验收",
    ...(task.expectedOutputs && task.expectedOutputs.length > 0
      ? task.expectedOutputs.map((output) => `- ${output}`)
      : ["- 见任务记录"]),
    "",
    "## 结果",
    task.resultSummary?.trim() || "已完成",
    "",
    `产物目录：${task.outputDir}`
  ].join("\n"));
  return {
    uri: `viking://resources/hearth/tasks/${task.id}/task.md`,
    content,
    tags: ["source=hearth", "hearth_kind=task", `hearth_status=${task.status}`],
    contentHash: sha256(content)
  };
}

export function sourceDocument(item: SourceItem, text: string): KnowledgeDocument {
  const content = [
    "---",
    `hearth_source_id: ${item.sourceId}`,
    `hearth_item_id: ${item.id}`,
    `hearth_item_key: ${item.itemKey}`,
    `locator: ${item.locator}`,
    `content_hash: ${item.contentHash ?? "unknown"}`,
    `fetched_at: ${item.fetchedAt}`,
    "---",
    `# ${item.title ?? item.label}`,
    "",
    redactSecrets(text)
  ].join("\n");
  return {
    uri: `viking://resources/hearth/sources/${item.sourceId}/${hash8(item.itemKey)}.md`,
    content,
    tags: ["source=hearth", "hearth_kind=source", `hearth_source=${item.sourceId}`],
    contentHash: sha256(content)
  };
}

export function cronMatches(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  return parts.every((part, index) => fieldMatches(part, values[index] ?? -1));
}

function fieldMatches(field: string, value: number): boolean {
  for (const segment of field.split(",")) {
    if (segment === "*") return true;
    if (segment.startsWith("*/")) {
      const step = Number(segment.slice(2));
      if (Number.isFinite(step) && step > 0 && value % step === 0) return true;
      continue;
    }
    if (segment.includes("-")) {
      const bounds = segment.split("-").map(Number);
      const from = bounds[0];
      const to = bounds[1];
      if (from !== undefined && to !== undefined && value >= from && value <= to) return true;
      continue;
    }
    if (Number(segment) === value) return true;
  }
  return false;
}

function isMemoryWritable(memory: MemoryRecord, mode: "curated" | "all"): boolean {
  if (memory.status !== "active" || !memory.allowRecall) return false;
  if (memory.sensitivity === "secret") return false;
  if (memory.taint !== "clean") return false;
  if (memory.originClass === "untrusted") return false;
  if (isEvaluationMemory(memory.content) || isEvaluationMemory(memory.subjectKey)) return false;
  if (mode === "curated" && !["instructions", "curated"].includes(memory.tier)) return false;
  return true;
}

function slug(value: string, fallback: string): string {
  const text = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return text || fallback;
}

function hash8(value: string): string {
  return sha256(value).slice(0, 8);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

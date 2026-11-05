import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  ApprovalRecord,
  ArtifactRecord,
  EffectRecord,
  EventEnvelope,
  RunRecord,
  TaskRecord
} from "@hearth/core";

export type NewEvent = {
  type: string;
  taskId?: string | null;
  runId?: string | null;
  payload: unknown;
  createdAt?: string;
};

type DbRow = Record<string, SQLInputValue>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, template_id TEXT, title TEXT NOT NULL, goal TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deadline TEXT, inputs_json TEXT NOT NULL, network_hosts_json TEXT NOT NULL,
  output_dir TEXT NOT NULL, current_run_id TEXT, next_action TEXT, error_json TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
  thread_id TEXT, workspace TEXT NOT NULL, started_at TEXT, ended_at TEXT,
  failure_json TEXT, usage_json TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL,
  summary TEXT NOT NULL, target_json TEXT NOT NULL, preview_json TEXT NOT NULL,
  parameter_hash TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL,
  decided_at TEXT, effect_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS effects (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, approval_id TEXT NOT NULL, kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, target_json TEXT NOT NULL,
  receipt_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, relative_path TEXT NOT NULL,
  absolute_path TEXT NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task_idx ON events(task_id, seq);
CREATE INDEX IF NOT EXISTS runs_task_idx ON runs(task_id, created_at);
CREATE INDEX IF NOT EXISTS approvals_task_idx ON approvals(task_id, status);
CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts(task_id, created_at);
`;

export class HearthStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  appendEvent(event: NewEvent): EventEnvelope {
    const createdAt = event.createdAt ?? new Date().toISOString();
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(
        "INSERT INTO events (id, type, task_id, run_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, event.type, event.taskId ?? null, event.runId ?? null, JSON.stringify(event.payload), createdAt);
      const envelope: EventEnvelope = {
        seq: Number(result.lastInsertRowid), id, type: event.type,
        taskId: event.taskId ?? null, runId: event.runId ?? null, payload: event.payload, createdAt
      };
      this.applyEvent(envelope);
      this.db.exec("COMMIT");
      return envelope;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listEvents(afterSeq = 0, taskId?: string): EventEnvelope[] {
    const statement = taskId
      ? this.db.prepare("SELECT * FROM events WHERE seq > ? AND task_id = ? ORDER BY seq ASC")
      : this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq ASC");
    const rows = (taskId ? statement.all(afterSeq, taskId) : statement.all(afterSeq)) as DbRow[];
    return rows.map(rowToEvent);
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(): TaskRecord[] {
    return (this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as DbRow[]).map(rowToTask);
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(taskId: string): RunRecord[] {
    return (this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as DbRow[]).map(rowToRun);
  }

  getApproval(id: string): ApprovalRecord | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToApproval(row) : null;
  }

  listApprovals(taskId: string): ApprovalRecord[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as DbRow[]).map(rowToApproval);
  }

  getEffect(id: string): EffectRecord | null {
    const row = this.db.prepare("SELECT * FROM effects WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToEffect(row) : null;
  }

  listEffects(taskId: string): EffectRecord[] {
    return (this.db.prepare("SELECT * FROM effects WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as DbRow[]).map(rowToEffect);
  }

  getArtifact(id: string): ArtifactRecord | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToArtifact(row) : null;
  }

  listArtifacts(taskId: string): ArtifactRecord[] {
    return (this.db.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as DbRow[]).map(rowToArtifact);
  }

  listAllArtifacts(): ArtifactRecord[] {
    return (this.db.prepare("SELECT * FROM artifacts ORDER BY created_at DESC").all() as DbRow[]).map(rowToArtifact);
  }

  rebuildProjections(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM artifacts; DELETE FROM effects; DELETE FROM approvals; DELETE FROM runs; DELETE FROM tasks;");
      for (const event of this.listEvents()) this.applyEvent(event);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private applyEvent(event: EventEnvelope): void {
    switch (event.type) {
      case "task.created": return upsertTask(this.db, event.payload as TaskRecord);
      case "task.updated": return updateTask(this.db, event.taskId, event.payload as Record<string, unknown>);
      case "run.created": return insertRun(this.db, event.payload as RunRecord);
      case "run.updated": return updateRun(this.db, event.runId, event.payload as Record<string, unknown>);
      case "approval.created": return insertApproval(this.db, event.payload as ApprovalRecord);
      case "approval.updated": return updateApproval(this.db, event.payload as Record<string, unknown>);
      case "effect.created": return insertEffect(this.db, event.payload as EffectRecord);
      case "effect.updated": return updateEffect(this.db, event.payload as Record<string, unknown>);
      case "artifact.published": return insertArtifact(this.db, event.payload as ArtifactRecord);
      case "task.progress":
      case "approval.expired": return;
      default: throw new Error(`Unknown event type: ${event.type}`);
    }
  }
}

function upsertTask(db: DatabaseSync, task: TaskRecord): void {
  db.prepare(
    `INSERT INTO tasks (id, template_id, title, goal, status, created_at, updated_at, deadline, inputs_json, network_hosts_json, output_dir, current_run_id, next_action, error_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       template_id=excluded.template_id, title=excluded.title, goal=excluded.goal, status=excluded.status,
       updated_at=excluded.updated_at, deadline=excluded.deadline, inputs_json=excluded.inputs_json,
       network_hosts_json=excluded.network_hosts_json, output_dir=excluded.output_dir,
       current_run_id=excluded.current_run_id, next_action=excluded.next_action, error_json=excluded.error_json`
  ).run(
    task.id, task.templateId, task.title, task.goal, task.status, task.createdAt, task.updatedAt,
    task.deadline, JSON.stringify(task.inputs), JSON.stringify(task.networkHosts), task.outputDir,
    task.currentRunId, task.nextAction, task.error ? JSON.stringify(task.error) : null
  );
}

function updateTask(db: DatabaseSync, taskId: string | null, patch: Record<string, unknown>): void {
  if (!taskId) throw new Error("task.updated requires taskId");
  const columns: Record<string, string> = {
    title: "title", goal: "goal", status: "status", updatedAt: "updated_at",
    deadline: "deadline", currentRunId: "current_run_id", nextAction: "next_action"
  };
  for (const [key, column] of Object.entries(columns)) {
    if (key in patch) db.prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run((patch[key] as SQLInputValue) ?? null, taskId);
  }
  if ("error" in patch) {
    const error = patch.error as TaskRecord["error"];
    db.prepare("UPDATE tasks SET error_json = ? WHERE id = ?").run(error ? JSON.stringify(error) : null, taskId);
  }
}

function insertRun(db: DatabaseSync, run: RunRecord): void {
  db.prepare(
    `INSERT INTO runs (id, task_id, attempt, status, thread_id, workspace, started_at, ended_at, failure_json, usage_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    run.id, run.taskId, run.attempt, run.status, run.threadId, run.workspace,
    run.startedAt, run.endedAt, run.failure ? JSON.stringify(run.failure) : null,
    run.usage ? JSON.stringify(run.usage) : null, run.createdAt
  );
}

function updateRun(db: DatabaseSync, runId: string | null, patch: Record<string, unknown>): void {
  if (!runId) throw new Error("run.updated requires runId");
  const columns: Record<string, string> = {
    status: "status", threadId: "thread_id", startedAt: "started_at", endedAt: "ended_at"
  };
  for (const [key, column] of Object.entries(columns)) {
    if (key in patch) db.prepare(`UPDATE runs SET ${column} = ? WHERE id = ?`).run((patch[key] as SQLInputValue) ?? null, runId);
  }
  if ("failure" in patch) {
    const failure = patch.failure as RunRecord["failure"];
    db.prepare("UPDATE runs SET failure_json = ? WHERE id = ?").run(failure ? JSON.stringify(failure) : null, runId);
  }
  if ("usage" in patch) {
    const usage = patch.usage as RunRecord["usage"];
    db.prepare("UPDATE runs SET usage_json = ? WHERE id = ?").run(usage ? JSON.stringify(usage) : null, runId);
  }
}

function insertApproval(db: DatabaseSync, approval: ApprovalRecord): void {
  db.prepare(
    `INSERT INTO approvals (id, task_id, run_id, kind, summary, target_json, preview_json, parameter_hash, status, expires_at, decided_at, effect_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    approval.id, approval.taskId, approval.runId, approval.kind, approval.summary,
    JSON.stringify(approval.target), JSON.stringify(approval.preview), approval.parameterHash,
    approval.status, approval.expiresAt, approval.decidedAt, approval.effectId, approval.createdAt
  );
}

function updateApproval(db: DatabaseSync, patch: Record<string, unknown>): void {
  const id = String(patch.id);
  const columns: Record<string, string> = { status: "status", decidedAt: "decided_at", effectId: "effect_id" };
  for (const [key, column] of Object.entries(columns)) {
    if (key in patch) db.prepare(`UPDATE approvals SET ${column} = ? WHERE id = ?`).run((patch[key] as SQLInputValue) ?? null, id);
  }
}

function insertEffect(db: DatabaseSync, effect: EffectRecord): void {
  db.prepare(
    `INSERT INTO effects (id, task_id, approval_id, kind, idempotency_key, status, target_json, receipt_json, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    effect.id, effect.taskId, effect.approvalId, effect.kind, effect.idempotencyKey,
    effect.status, JSON.stringify(effect.target), effect.receipt ? JSON.stringify(effect.receipt) : null,
    effect.error, effect.createdAt, effect.updatedAt
  );
}

function updateEffect(db: DatabaseSync, patch: Record<string, unknown>): void {
  const id = String(patch.id);
  for (const [key, column] of Object.entries({ status: "status", error: "error", updatedAt: "updated_at" })) {
    if (key in patch) db.prepare(`UPDATE effects SET ${column} = ? WHERE id = ?`).run((patch[key] as SQLInputValue) ?? null, id);
  }
  if ("receipt" in patch) {
    const receipt = patch.receipt as EffectRecord["receipt"];
    db.prepare("UPDATE effects SET receipt_json = ? WHERE id = ?").run(receipt ? JSON.stringify(receipt) : null, id);
  }
}

function insertArtifact(db: DatabaseSync, artifact: ArtifactRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO artifacts (id, task_id, run_id, relative_path, absolute_path, mime_type, sha256, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    artifact.id, artifact.taskId, artifact.runId, artifact.relativePath, artifact.absolutePath,
    artifact.mimeType, artifact.sha256, artifact.bytes, artifact.createdAt
  );
}

function rowToEvent(row: DbRow): EventEnvelope {
  return {
    seq: Number(row.seq), id: String(row.id), type: String(row.type),
    taskId: row.task_id == null ? null : String(row.task_id),
    runId: row.run_id == null ? null : String(row.run_id),
    payload: JSON.parse(String(row.payload_json)), createdAt: String(row.created_at)
  };
}

function rowToTask(row: DbRow): TaskRecord {
  return {
    id: String(row.id), templateId: row.template_id == null ? null : String(row.template_id),
    title: String(row.title), goal: String(row.goal), status: String(row.status) as TaskRecord["status"],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    deadline: row.deadline == null ? null : String(row.deadline),
    inputs: JSON.parse(String(row.inputs_json)),
    networkHosts: JSON.parse(String(row.network_hosts_json)), outputDir: String(row.output_dir),
    currentRunId: row.current_run_id == null ? null : String(row.current_run_id),
    nextAction: row.next_action == null ? null : String(row.next_action),
    error: row.error_json == null ? null : JSON.parse(String(row.error_json))
  };
}

function rowToRun(row: DbRow): RunRecord {
  return {
    id: String(row.id), taskId: String(row.task_id), attempt: Number(row.attempt),
    status: String(row.status) as RunRecord["status"],
    threadId: row.thread_id == null ? null : String(row.thread_id),
    workspace: String(row.workspace),
    startedAt: row.started_at == null ? null : String(row.started_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
    failure: row.failure_json == null ? null : JSON.parse(String(row.failure_json)),
    usage: row.usage_json == null ? null : JSON.parse(String(row.usage_json)),
    createdAt: String(row.created_at)
  };
}

function rowToApproval(row: DbRow): ApprovalRecord {
  return {
    id: String(row.id), taskId: String(row.task_id), runId: String(row.run_id),
    kind: String(row.kind), summary: String(row.summary),
    target: JSON.parse(String(row.target_json)), preview: JSON.parse(String(row.preview_json)),
    parameterHash: String(row.parameter_hash), status: String(row.status) as ApprovalRecord["status"],
    expiresAt: String(row.expires_at),
    decidedAt: row.decided_at == null ? null : String(row.decided_at),
    effectId: row.effect_id == null ? null : String(row.effect_id), createdAt: String(row.created_at)
  };
}

function rowToEffect(row: DbRow): EffectRecord {
  return {
    id: String(row.id), taskId: String(row.task_id), approvalId: String(row.approval_id),
    kind: String(row.kind), idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as EffectRecord["status"],
    target: JSON.parse(String(row.target_json)),
    receipt: row.receipt_json == null ? null : JSON.parse(String(row.receipt_json)),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function rowToArtifact(row: DbRow): ArtifactRecord {
  return {
    id: String(row.id), taskId: String(row.task_id), runId: String(row.run_id),
    relativePath: String(row.relative_path), absolutePath: String(row.absolute_path),
    mimeType: String(row.mime_type), sha256: String(row.sha256), bytes: Number(row.bytes),
    createdAt: String(row.created_at)
  };
}

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  AppMeta,
  ApprovalRecord,
  ApprovalStatus,
  ArtifactRecord,
  BackupRecord,
  ChatMessageRecord,
  ConversationRecord,
  DesktopCommandRecord,
  DesktopFrameRecord,
  DesktopSessionRecord,
  DevicePairingRequest,
  DeviceRecord,
  EffectRecord,
  EffectStatus,
  EventEnvelope,
  MemoryConflict,
  MemoryForgetReceipt,
  MemoryRecall,
  MemoryRecord,
  MemorySettings,
  MemoryVersion,
  MethodCandidate,
  MethodEvaluation,
  MethodTrial,
  MaintenanceRun,
  OutboxDraft,
  ProactiveSettings,
  ProactiveSuggestion,
  RunCheckpointRecord,
  RunRecord,
  RunStatus,
  RunUsage,
  SourceConnection,
  SourceItem,
  SyncConflict,
  SyncPeer,
  TaskLease,
  TaskProposalRecord,
  TaskRecord,
  TaskStatus
} from "@hearth/core";
import { APPROVAL_STATUSES, EFFECT_STATUSES, RUN_STATUSES, TASK_STATUSES } from "@hearth/core";

export type NewEvent = {
  id?: string;
  type: string;
  taskId?: string | null;
  runId?: string | null;
  payload: unknown;
  createdAt?: string;
};

export interface PageOptions {
  limit: number;
  offset: number;
  taskId?: string;
  status?: string;
}

export interface RunAggregate {
  runs: number;
  lastDurationMs: number | null;
  lastUsage: RunUsage | null;
}

type DbRow = Record<string, SQLInputValue>;

export const CURRENT_SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  payload_json TEXT NOT NULL,
  origin_instance_id TEXT,
  origin_seq INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, template_id TEXT, title TEXT NOT NULL, goal TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deadline TEXT, inputs_json TEXT NOT NULL, network_hosts_json TEXT NOT NULL,
  output_dir TEXT NOT NULL, current_run_id TEXT, next_action TEXT, error_json TEXT,
  result_summary TEXT, conversation_id TEXT, executor_id TEXT, task_kind TEXT,
  expected_outputs_json TEXT, permissions_json TEXT
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, task_id TEXT, attachments_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
  thread_id TEXT, workspace TEXT NOT NULL, started_at TEXT, ended_at TEXT,
  failure_json TEXT, usage_json TEXT, lease_epoch INTEGER, created_at TEXT NOT NULL,
  executor_id TEXT, checkpoint_seq INTEGER, budget_json TEXT
);
CREATE TABLE IF NOT EXISTS task_proposals (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
  executor_id TEXT NOT NULL, task_kind TEXT NOT NULL, expected_outputs_json TEXT NOT NULL,
  permissions_json TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS run_checkpoints (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, usage_json TEXT,
  created_at TEXT NOT NULL, UNIQUE(run_id, seq)
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
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, provider TEXT NOT NULL, display_name TEXT NOT NULL,
  account TEXT, root_path TEXT, allowed_hosts_json TEXT NOT NULL, status TEXT NOT NULL,
  read_only INTEGER NOT NULL, item_count INTEGER NOT NULL, last_read_at TEXT,
  last_error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_items (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, item_key TEXT NOT NULL, label TEXT NOT NULL,
  locator TEXT NOT NULL, content_path TEXT, content_hash TEXT, bytes INTEGER NOT NULL,
  title TEXT, status TEXT NOT NULL, coverage_json TEXT NOT NULL, duplicate_of TEXT,
  error_json TEXT, fetched_at TEXT NOT NULL, UNIQUE(source_id, item_key)
);
CREATE TABLE IF NOT EXISTS outbox_drafts (
  id TEXT PRIMARY KEY, account TEXT NOT NULL, to_json TEXT NOT NULL, cc_json TEXT NOT NULL,
  bcc_json TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  attachments_json TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT, approval_id TEXT,
  effect_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  submitted_at TEXT, discarded_at TEXT
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, pairing_request_id TEXT NOT NULL, name TEXT NOT NULL,
  platform TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, capabilities_json TEXT NOT NULL,
  last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing_requests (
  id TEXT PRIMARY KEY, code TEXT NOT NULL, secret_hash TEXT NOT NULL,
  device_token_hash TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL,
  version TEXT NOT NULL, requested_apps_json TEXT NOT NULL,
  requested_capabilities_json TEXT NOT NULL, status TEXT NOT NULL, device_id TEXT,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_sessions (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, status TEXT NOT NULL,
  control_epoch INTEGER NOT NULL, current_frame_id TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminated_at TEXT
);
CREATE TABLE IF NOT EXISTS desktop_frames (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, session_id TEXT NOT NULL,
  mime_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, storage_path TEXT NOT NULL,
  active_app TEXT NOT NULL, window_title TEXT NOT NULL, captured_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_commands (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, session_id TEXT NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, frame_id TEXT, control_epoch INTEGER NOT NULL,
  payload_json TEXT NOT NULL, result_json TEXT, error TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proactive_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL, mode TEXT NOT NULL,
  daily_limit INTEGER NOT NULL, quiet_start TEXT NOT NULL, quiet_end TEXT NOT NULL,
  cooldown_minutes INTEGER NOT NULL, aggregate_window_minutes INTEGER NOT NULL,
  paused_until TEXT, triggers_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY, trigger_kind TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, why_now TEXT NOT NULL, suggested_action TEXT NOT NULL,
  expected_impact TEXT NOT NULL, estimated_cost TEXT NOT NULL, risk_level TEXT NOT NULL,
  requires_approval INTEGER NOT NULL, autonomy TEXT NOT NULL, status TEXT NOT NULL,
  priority INTEGER NOT NULL, source_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  notified_at TEXT, snooze_until TEXT, expires_at TEXT, task_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestion_events (
  id TEXT PRIMARY KEY, suggestion_id TEXT NOT NULL, action TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), auto_capture TEXT NOT NULL,
  max_items INTEGER NOT NULL, max_chars INTEGER NOT NULL, allow_sensitive INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, content TEXT NOT NULL,
  subject_key TEXT NOT NULL, scope TEXT NOT NULL, tags_json TEXT NOT NULL,
  source_json TEXT NOT NULL, confidence TEXT NOT NULL, sensitivity TEXT NOT NULL,
  allow_recall INTEGER NOT NULL, version INTEGER NOT NULL, supersedes_id TEXT,
  derived_from_id TEXT, valid_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_recalled_at TEXT, recall_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, version INTEGER NOT NULL,
  content TEXT NOT NULL, status TEXT NOT NULL, source_json TEXT NOT NULL,
  confidence TEXT NOT NULL, sensitivity TEXT NOT NULL, allow_recall INTEGER NOT NULL,
  scope TEXT NOT NULL, tags_json TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(memory_id, version)
);
CREATE TABLE IF NOT EXISTS memory_conflicts (
  id TEXT PRIMARY KEY, subject_key TEXT NOT NULL, memory_ids_json TEXT NOT NULL,
  status TEXT NOT NULL, resolution TEXT, note TEXT NOT NULL,
  created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS memory_recalls (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT,
  reason TEXT NOT NULL, score REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_forget_receipts (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, affected_memory_ids_json TEXT NOT NULL,
  reason TEXT NOT NULL, redacted_versions INTEGER NOT NULL, redacted_events INTEGER NOT NULL,
  targets_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS method_candidates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL, applicability TEXT NOT NULL,
  steps_json TEXT NOT NULL, source_task_ids_json TEXT NOT NULL, template_id TEXT,
  status TEXT NOT NULL, version INTEGER NOT NULL, previous_version_id TEXT,
  allowed_capabilities_json TEXT NOT NULL, guardrails_json TEXT NOT NULL,
  baseline_json TEXT NOT NULL, trial_json TEXT NOT NULL, evaluation_verdict TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, adopted_at TEXT, retired_at TEXT
);
CREATE TABLE IF NOT EXISTS method_evaluations (
  id TEXT PRIMARY KEY, method_id TEXT NOT NULL, method_version INTEGER NOT NULL,
  baseline_task_ids_json TEXT NOT NULL, trial_task_ids_json TEXT NOT NULL,
  baseline_json TEXT NOT NULL, trial_json TEXT NOT NULL, verdict TEXT NOT NULL,
  notes TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS method_trials (
  id TEXT PRIMARY KEY, method_id TEXT NOT NULL, method_version INTEGER NOT NULL,
  task_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_peers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, status TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, last_pull_seq INTEGER NOT NULL, last_pull_at TEXT,
  last_error TEXT, token_cipher TEXT, remote_instance_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  local_updated_at TEXT, remote_updated_at TEXT, local_payload_json TEXT NOT NULL,
  remote_payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS task_leases (
  task_id TEXT PRIMARY KEY, owner_instance_id TEXT NOT NULL, owner_device_id TEXT,
  epoch INTEGER NOT NULL, expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS maintenance_runs (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL,
  actions_json TEXT NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS backup_records (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task_idx ON events(task_id, seq);
CREATE INDEX IF NOT EXISTS runs_task_idx ON runs(task_id, created_at);
CREATE INDEX IF NOT EXISTS approvals_task_idx ON approvals(task_id, status);
CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts(task_id, created_at);
CREATE INDEX IF NOT EXISTS runs_created_idx ON runs(created_at);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, created_at);
CREATE INDEX IF NOT EXISTS effects_status_idx ON effects(status, created_at);
CREATE INDEX IF NOT EXISTS source_items_source_idx ON source_items(source_id, fetched_at);
CREATE INDEX IF NOT EXISTS outbox_drafts_status_idx ON outbox_drafts(status, created_at);
CREATE INDEX IF NOT EXISTS devices_status_idx ON devices(status, updated_at);
CREATE INDEX IF NOT EXISTS pairing_requests_status_idx ON pairing_requests(status, created_at);
CREATE INDEX IF NOT EXISTS desktop_sessions_device_idx ON desktop_sessions(device_id, created_at);
CREATE INDEX IF NOT EXISTS desktop_frames_session_idx ON desktop_frames(session_id, captured_at);
CREATE INDEX IF NOT EXISTS desktop_commands_device_idx ON desktop_commands(device_id, status, created_at);
CREATE INDEX IF NOT EXISTS desktop_commands_session_idx ON desktop_commands(session_id, created_at);
CREATE INDEX IF NOT EXISTS suggestions_status_idx ON suggestions(status, priority, last_seen_at);
CREATE INDEX IF NOT EXISTS suggestions_kind_idx ON suggestions(trigger_kind, last_seen_at);
CREATE INDEX IF NOT EXISTS memories_status_idx ON memories(status, kind, updated_at);
CREATE INDEX IF NOT EXISTS memories_subject_idx ON memories(subject_key, status);
CREATE INDEX IF NOT EXISTS memory_recalls_task_idx ON memory_recalls(task_id, created_at);
CREATE INDEX IF NOT EXISTS memory_forget_receipts_memory_idx ON memory_forget_receipts(memory_id, created_at);
CREATE INDEX IF NOT EXISTS method_candidates_status_idx ON method_candidates(status, updated_at);
CREATE INDEX IF NOT EXISTS method_evaluations_method_idx ON method_evaluations(method_id, created_at);
CREATE INDEX IF NOT EXISTS method_trials_method_idx ON method_trials(method_id, created_at);
CREATE INDEX IF NOT EXISTS sync_conflicts_status_idx ON sync_conflicts(status, created_at);
CREATE INDEX IF NOT EXISTS task_leases_expiry_idx ON task_leases(expires_at);
CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx ON chat_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS task_proposals_conversation_idx ON task_proposals(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS task_proposals_status_idx ON task_proposals(status, expires_at);
CREATE INDEX IF NOT EXISTS run_checkpoints_run_idx ON run_checkpoints(run_id, seq);
`;

export class HearthStore {
  readonly db: DatabaseSync;
  readonly instanceId: string;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrate();
    this.instanceId = this.ensureInstanceId();
  }

  private migrate(): void {
    ensureColumn(this.db, "events", "origin_instance_id", "TEXT");
    ensureColumn(this.db, "events", "origin_seq", "INTEGER");
    ensureColumn(this.db, "runs", "lease_epoch", "INTEGER");
    ensureColumn(this.db, "tasks", "result_summary", "TEXT");
    ensureColumn(this.db, "tasks", "conversation_id", "TEXT");
    ensureColumn(this.db, "tasks", "executor_id", "TEXT");
    ensureColumn(this.db, "tasks", "task_kind", "TEXT");
    ensureColumn(this.db, "tasks", "expected_outputs_json", "TEXT");
    ensureColumn(this.db, "tasks", "permissions_json", "TEXT");
    ensureColumn(this.db, "runs", "executor_id", "TEXT");
    ensureColumn(this.db, "runs", "checkpoint_seq", "INTEGER");
    ensureColumn(this.db, "runs", "budget_json", "TEXT");
    ensureColumn(this.db, "sync_peers", "token_cipher", "TEXT");
    ensureColumn(this.db, "sync_peers", "remote_instance_id", "TEXT");
    this.db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    this.setMeta("schemaVersion", String(CURRENT_SCHEMA_VERSION));
  }

  private ensureInstanceId(): string {
    const existing = this.getMeta("instanceId");
    if (existing) return existing;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.setMeta("instanceId", id, now);
    this.setMeta("createdAt", now, now);
    return id;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as DbRow | undefined;
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string, updatedAt = new Date().toISOString()): void {
    this.db.prepare(
      "INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    ).run(key, value, updatedAt);
  }

  getAppMeta(): AppMeta {
    const schemaVersion = Number(this.getMeta("schemaVersion") ?? 2);
    const createdAt = this.getMeta("createdAt") ?? new Date().toISOString();
    const updatedAt = this.getMeta("metaUpdatedAt") ?? createdAt;
    return { instanceId: this.instanceId, schemaVersion, createdAt, updatedAt };
  }

  close(): void {
    this.db.close();
  }

  appendEvent(event: NewEvent, origin?: { instanceId: string; seq: number | null }): EventEnvelope {
    const createdAt = event.createdAt ?? new Date().toISOString();
    const id = event.id ?? randomUUID();
    const originInstanceId = origin?.instanceId ?? this.instanceId;
    const originSeq = origin?.seq ?? null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(
        "INSERT INTO events (id, type, task_id, run_id, payload_json, origin_instance_id, origin_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(id, event.type, event.taskId ?? null, event.runId ?? null, JSON.stringify(event.payload), originInstanceId, originSeq, createdAt);
      const seq = Number(result.lastInsertRowid);
      if (originSeq === null) {
        this.db.prepare("UPDATE events SET origin_seq = ? WHERE seq = ?").run(seq, seq);
      }
      const envelope: EventEnvelope = {
        seq, id, type: event.type,
        taskId: event.taskId ?? null, runId: event.runId ?? null, payload: event.payload,
        originInstanceId, originSeq: originSeq ?? seq, createdAt
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

  getEventById(id: string): EventEnvelope | null {
    const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  getSyncPeer(id: string): SyncPeer | null {
    const row = this.db.prepare("SELECT * FROM sync_peers WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToSyncPeer(row) : null;
  }

  getSyncPeerByTokenHash(tokenHash: string): SyncPeer | null {
    const row = this.db.prepare("SELECT * FROM sync_peers WHERE token_hash = ?").get(tokenHash) as DbRow | undefined;
    return row ? rowToSyncPeer(row) : null;
  }

  getSyncPeerTokenCipher(id: string): string | null {
    const row = this.db.prepare("SELECT token_cipher FROM sync_peers WHERE id = ?").get(id) as DbRow | undefined;
    return row?.token_cipher == null ? null : String(row.token_cipher);
  }

  listSyncPeers(): SyncPeer[] {
    return (this.db.prepare("SELECT * FROM sync_peers ORDER BY created_at DESC").all() as DbRow[]).map(rowToSyncPeer);
  }

  getSyncConflict(id: string): SyncConflict | null {
    const row = this.db.prepare("SELECT * FROM sync_conflicts WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToSyncConflict(row) : null;
  }

  listSyncConflicts(status?: string): SyncConflict[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM sync_conflicts WHERE status = ? ORDER BY created_at DESC").all(status) as DbRow[]
      : this.db.prepare("SELECT * FROM sync_conflicts ORDER BY created_at DESC").all() as DbRow[];
    return rows.map(rowToSyncConflict);
  }

  getTaskLease(taskId: string): TaskLease | null {
    const row = this.db.prepare("SELECT * FROM task_leases WHERE task_id = ?").get(taskId) as DbRow | undefined;
    return row ? rowToTaskLease(row) : null;
  }

  listTaskLeases(): TaskLease[] {
    return (this.db.prepare("SELECT * FROM task_leases ORDER BY expires_at ASC").all() as DbRow[]).map(rowToTaskLease);
  }

  getBackupRecord(id: string): BackupRecord | null {
    const row = this.db.prepare("SELECT * FROM backup_records WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToBackupRecord(row) : null;
  }

  listBackupRecords(): BackupRecord[] {
    return (this.db.prepare("SELECT * FROM backup_records ORDER BY created_at DESC").all() as DbRow[])
      .map(rowToBackupRecord);
  }

  addBackupRecord(record: BackupRecord): BackupRecord {
    this.db.prepare(
      "INSERT INTO backup_records (id, kind, path, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(record.id, record.kind, record.path, record.bytes, record.sha256, record.createdAt);
    return record;
  }

  createMaintenanceRun(run: MaintenanceRun): MaintenanceRun {
    this.db.prepare(
      "INSERT INTO maintenance_runs (id, started_at, ended_at, status, actions_json, error) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(run.id, run.startedAt, run.endedAt, run.status, JSON.stringify(run.actions), run.error);
    return run;
  }

  finishMaintenanceRun(run: MaintenanceRun): MaintenanceRun {
    this.db.prepare(
      "UPDATE maintenance_runs SET ended_at = ?, status = ?, actions_json = ?, error = ? WHERE id = ?"
    ).run(run.endedAt, run.status, JSON.stringify(run.actions), run.error, run.id);
    return run;
  }

  getMaintenanceRun(id: string): MaintenanceRun | null {
    const row = this.db.prepare("SELECT * FROM maintenance_runs WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToMaintenanceRun(row) : null;
  }

  listMaintenanceRuns(limit = 20): MaintenanceRun[] {
    const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
    return (this.db.prepare("SELECT * FROM maintenance_runs ORDER BY started_at DESC LIMIT ?").all(bounded) as DbRow[])
      .map(rowToMaintenanceRun);
  }

  latestMaintenanceRun(): MaintenanceRun | null {
    const row = this.db.prepare("SELECT * FROM maintenance_runs ORDER BY started_at DESC LIMIT 1").get() as DbRow | undefined;
    return row ? rowToMaintenanceRun(row) : null;
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(): TaskRecord[] {
    return (this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as DbRow[]).map(rowToTask);
  }

  createConversation(title: string): ConversationRecord {
    const now = new Date().toISOString();
    const conversation: ConversationRecord = {
      id: randomUUID(), title: title.trim() || "新对话", createdAt: now, updatedAt: now
    };
    this.db.prepare(
      "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt);
    return conversation;
  }

  listConversations(): ConversationRecord[] {
    return (this.db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC").all() as DbRow[])
      .map(rowToConversation);
  }

  getConversation(id: string): ConversationRecord | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  renameConversation(id: string, title: string): ConversationRecord | null {
    const clean = title.trim().slice(0, 120);
    if (!clean) return this.getConversation(id);
    this.db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
      .run(clean, new Date().toISOString(), id);
    return this.getConversation(id);
  }

  deleteConversation(id: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM chat_messages WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listChatMessages(conversationId: string): ChatMessageRecord[] {
    return (this.db.prepare(
      "SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY rowid ASC"
    ).all(conversationId) as DbRow[]).map(rowToChatMessage);
  }

  createChatMessage(message: ChatMessageRecord): ChatMessageRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO chat_messages (id, conversation_id, role, content, task_id, attachments_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        message.id, message.conversationId, message.role, message.content,
        message.taskId, JSON.stringify(message.attachments), message.createdAt
      );
      this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(message.createdAt, message.conversationId);
      this.db.exec("COMMIT");
      return message;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(taskId: string): RunRecord[] {
    return (this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as DbRow[]).map(rowToRun);
  }

  getTaskProposal(id: string): TaskProposalRecord | null {
    const row = this.db.prepare("SELECT * FROM task_proposals WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToTaskProposal(row) : null;
  }

  listTaskProposals(conversationId?: string): TaskProposalRecord[] {
    const rows = conversationId
      ? this.db.prepare("SELECT * FROM task_proposals WHERE conversation_id = ? ORDER BY created_at DESC").all(conversationId)
      : this.db.prepare("SELECT * FROM task_proposals ORDER BY created_at DESC").all();
    return (rows as DbRow[]).map(rowToTaskProposal);
  }

  createTaskProposal(proposal: TaskProposalRecord): TaskProposalRecord {
    upsertTaskProposal(this.db, proposal);
    return proposal;
  }

  updateTaskProposal(id: string, patch: Partial<Pick<TaskProposalRecord, "status" | "decidedAt">>): TaskProposalRecord | null {
    const proposal = this.getTaskProposal(id);
    if (!proposal) return null;
    const next = { ...proposal, ...patch };
    upsertTaskProposal(this.db, next);
    return next;
  }

  createRunCheckpoint(checkpoint: RunCheckpointRecord): RunCheckpointRecord {
    insertRunCheckpoint(this.db, checkpoint);
    return checkpoint;
  }

  listRunCheckpoints(runId: string): RunCheckpointRecord[] {
    return (this.db.prepare("SELECT * FROM run_checkpoints WHERE run_id = ? ORDER BY seq ASC").all(runId) as DbRow[]).map(rowToRunCheckpoint);
  }

  latestRunCheckpoint(runId: string): RunCheckpointRecord | null {
    const row = this.db.prepare("SELECT * FROM run_checkpoints WHERE run_id = ? ORDER BY seq DESC LIMIT 1").get(runId) as DbRow | undefined;
    return row ? rowToRunCheckpoint(row) : null;
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

  listAllEffects(): EffectRecord[] {
    return (this.db.prepare("SELECT * FROM effects ORDER BY created_at ASC").all() as DbRow[]).map(rowToEffect);
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

  getSource(id: string): SourceConnection | null {
    const row = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToSource(row) : null;
  }

  listSources(): SourceConnection[] {
    return (this.db.prepare("SELECT * FROM sources ORDER BY created_at ASC").all() as DbRow[]).map(rowToSource);
  }

  getSourceItem(id: string): SourceItem | null {
    const row = this.db.prepare("SELECT * FROM source_items WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToSourceItem(row) : null;
  }

  listSourceItems(sourceId: string): SourceItem[] {
    return (this.db.prepare("SELECT * FROM source_items WHERE source_id = ? ORDER BY label ASC").all(sourceId) as DbRow[]).map(rowToSourceItem);
  }

  listReadySourceItems(limit = 100): SourceItem[] {
    return (this.db.prepare(
      `SELECT item.* FROM source_items item
       JOIN sources source ON source.id = item.source_id
       WHERE item.status = 'ready' AND item.content_path IS NOT NULL AND source.status <> 'disconnected'
       ORDER BY item.fetched_at DESC, item.label ASC
       LIMIT ?`
    ).all(limit) as DbRow[]).map(rowToSourceItem);
  }

  findSourceItem(sourceId: string, itemKey: string): SourceItem | null {
    const row = this.db.prepare("SELECT * FROM source_items WHERE source_id = ? AND item_key = ?").get(sourceId, itemKey) as DbRow | undefined;
    return row ? rowToSourceItem(row) : null;
  }

  findSourceItemByHash(contentHash: string, sourceId?: string): SourceItem | null {
    const row = sourceId
      ? this.db.prepare("SELECT * FROM source_items WHERE content_hash = ? AND source_id = ? ORDER BY fetched_at ASC LIMIT 1").get(contentHash, sourceId) as DbRow | undefined
      : this.db.prepare("SELECT * FROM source_items WHERE content_hash = ? ORDER BY fetched_at ASC LIMIT 1").get(contentHash) as DbRow | undefined;
    return row ? rowToSourceItem(row) : null;
  }

  getProactiveSettings(): ProactiveSettings | null {
    const row = this.db.prepare("SELECT * FROM proactive_settings WHERE id = 1").get() as DbRow | undefined;
    return row ? rowToProactiveSettings(row) : null;
  }

  getSuggestion(id: string): ProactiveSuggestion | null {
    const row = this.db.prepare("SELECT * FROM suggestions WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToSuggestion(row) : null;
  }

  findSuggestionByDedupeKey(dedupeKey: string): ProactiveSuggestion | null {
    const row = this.db.prepare("SELECT * FROM suggestions WHERE dedupe_key = ?").get(dedupeKey) as DbRow | undefined;
    return row ? rowToSuggestion(row) : null;
  }

  listSuggestions(opts: { status?: string; limit?: number } = {}): ProactiveSuggestion[] {
    const where = opts.status ? " WHERE status = ?" : "";
    const params: SQLInputValue[] = opts.status ? [opts.status] : [];
    const limit = opts.limit ?? 100;
    const rows = this.db.prepare(
      `SELECT * FROM suggestions${where} ORDER BY priority DESC, last_seen_at DESC LIMIT ?`
    ).all(...params, limit) as DbRow[];
    return rows.map(rowToSuggestion);
  }

  listSuggestionsNotifiedSince(iso: string): ProactiveSuggestion[] {
    const rows = this.db.prepare(
      "SELECT * FROM suggestions WHERE notified_at IS NOT NULL AND notified_at >= ? ORDER BY notified_at DESC"
    ).all(iso) as DbRow[];
    return rows.map(rowToSuggestion);
  }

  insertSuggestionEvent(event: {
    id: string;
    suggestionId: string;
    action: string;
    payload: unknown;
    createdAt: string;
  }): void {
    this.db.prepare(
      "INSERT INTO suggestion_events (id, suggestion_id, action, payload_json, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(event.id, event.suggestionId, event.action, JSON.stringify(event.payload), event.createdAt);
  }

  countSuggestionActionsSince(iso: string): { delivered: number; accepted: number; ignored: number; converted: number } {
    const rows = this.db.prepare(
      "SELECT action, COUNT(*) AS total FROM suggestion_events WHERE created_at >= ? GROUP BY action"
    ).all(iso) as DbRow[];
    const counts = { delivered: 0, accepted: 0, ignored: 0, converted: 0 };
    for (const row of rows) {
      const action = String(row.action);
      if (action in counts) counts[action as keyof typeof counts] = Number(row.total);
    }
    return counts;
  }

  getMemorySettings(): MemorySettings | null {
    const row = this.db.prepare("SELECT * FROM memory_settings WHERE id = 1").get() as DbRow | undefined;
    return row ? rowToMemorySettings(row) : null;
  }

  getMemory(id: string): MemoryRecord | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  listMemories(opts: { status?: string; kind?: string; limit?: number } = {}): MemoryRecord[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.status) { clauses.push("status = ?"); params.push(opts.status); }
    if (opts.kind) { clauses.push("kind = ?"); params.push(opts.kind); }
    const where = clauses.length > 0 ? " WHERE " + clauses.join(" AND ") : "";
    const rows = this.db.prepare(
      "SELECT * FROM memories" + where + " ORDER BY updated_at DESC LIMIT ?"
    ).all(...params, opts.limit ?? 500) as DbRow[];
    return rows.map(rowToMemory);
  }

  findActiveMemoriesBySubject(subjectKey: string): MemoryRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM memories WHERE subject_key = ? AND status IN (\"active\", \"conflict\") ORDER BY updated_at DESC"
    ).all(subjectKey) as DbRow[];
    return rows.map(rowToMemory);
  }

  listMemoryVersions(memoryId: string): MemoryVersion[] {
    const rows = this.db.prepare(
      "SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version DESC"
    ).all(memoryId) as DbRow[];
    return rows.map(rowToMemoryVersion);
  }

  getMemoryConflict(id: string): MemoryConflict | null {
    const row = this.db.prepare("SELECT * FROM memory_conflicts WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToMemoryConflict(row) : null;
  }

  listMemoryConflicts(status?: string): MemoryConflict[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM memory_conflicts WHERE status = ? ORDER BY created_at DESC").all(status) as DbRow[]
      : this.db.prepare("SELECT * FROM memory_conflicts ORDER BY created_at DESC").all() as DbRow[];
    return rows.map(rowToMemoryConflict);
  }

  listMemoryRecalls(memoryId?: string): MemoryRecall[] {
    const rows = memoryId
      ? this.db.prepare("SELECT * FROM memory_recalls WHERE memory_id = ? ORDER BY created_at DESC").all(memoryId) as DbRow[]
      : this.db.prepare("SELECT * FROM memory_recalls ORDER BY created_at DESC").all() as DbRow[];
    return rows.map(rowToMemoryRecall);
  }

  listMemoryForgetReceipts(memoryId?: string): MemoryForgetReceipt[] {
    const rows = memoryId
      ? this.db.prepare("SELECT * FROM memory_forget_receipts WHERE memory_id = ? ORDER BY created_at DESC").all(memoryId) as DbRow[]
      : this.db.prepare("SELECT * FROM memory_forget_receipts ORDER BY created_at DESC").all() as DbRow[];
    return rows.map(rowToMemoryForgetReceipt);
  }

  getMethodCandidate(id: string): MethodCandidate | null {
    const row = this.db.prepare("SELECT * FROM method_candidates WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToMethodCandidate(row) : null;
  }

  listMethodCandidates(status?: string): MethodCandidate[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM method_candidates WHERE status = ? ORDER BY updated_at DESC").all(status) as DbRow[]
      : this.db.prepare("SELECT * FROM method_candidates ORDER BY updated_at DESC").all() as DbRow[];
    return rows.map(rowToMethodCandidate);
  }

  listMethodEvaluations(methodId?: string): MethodEvaluation[] {
    const rows = methodId
      ? this.db.prepare("SELECT * FROM method_evaluations WHERE method_id = ? ORDER BY created_at DESC").all(methodId) as DbRow[]
      : this.db.prepare("SELECT * FROM method_evaluations ORDER BY created_at DESC").all() as DbRow[];
    return rows.map(rowToMethodEvaluation);
  }

  listMethodTrials(methodId?: string): MethodTrial[] {
    const rows = methodId
      ? this.db.prepare("SELECT * FROM method_trials WHERE method_id = ? ORDER BY created_at DESC").all(methodId) as DbRow[]
      : this.db.prepare("SELECT * FROM method_trials ORDER BY created_at DESC").all() as DbRow[];
    return rows.map(rowToMethodTrial);
  }

  scrubForgottenMemory(memoryId: string, tombstone: { content: string; subjectKey: string; scope: string }): { redactedVersions: number; redactedEvents: number } {
    const versionCount = Number(
      (this.db.prepare("SELECT COUNT(*) AS total FROM memory_versions WHERE memory_id = ?").get(memoryId) as DbRow).total
    );
    this.db.prepare(
      "UPDATE memory_versions SET content = ?, source_json = ?, tags_json = '[]', allow_recall = 0 WHERE memory_id = ?"
    ).run(tombstone.content, JSON.stringify({ type: "system", id: null, label: "[已遗忘]", excerpt: null }), memoryId);
    this.db.prepare(
      "UPDATE memory_conflicts SET subject_key = ? WHERE memory_ids_json LIKE ?"
    ).run(tombstone.subjectKey, "%" + memoryId + "%");
    this.db.prepare("UPDATE memory_recalls SET reason = '[记忆已遗忘]' WHERE memory_id = ?").run(memoryId);

    const rows = this.db.prepare("SELECT seq, type, payload_json FROM events WHERE type LIKE 'memory.%'").all() as DbRow[];
    let redactedEvents = 0;
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        continue;
      }
      if (!payloadReferencesMemory(payload, memoryId)) continue;
      const scrubbed = scrubMemoryEventPayload(String(row.type), payload, memoryId, tombstone);
      this.db.prepare("UPDATE events SET payload_json = ? WHERE seq = ?").run(JSON.stringify(scrubbed), Number(row.seq));
      redactedEvents += 1;
    }
    return { redactedVersions: versionCount, redactedEvents };
  }

  getOutboxDraft(id: string): OutboxDraft | null {
    const row = this.db.prepare("SELECT * FROM outbox_drafts WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToOutboxDraft(row) : null;
  }

  listOutboxDrafts(): OutboxDraft[] {
    return (this.db.prepare("SELECT * FROM outbox_drafts ORDER BY created_at DESC").all() as DbRow[]).map(rowToOutboxDraft);
  }

  getDevice(id: string): DeviceRecord | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToDevice(row) : null;
  }

  getDeviceByTokenHash(tokenHash: string): DeviceRecord | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE token_hash = ?").get(tokenHash) as DbRow | undefined;
    return row ? rowToDevice(row) : null;
  }

  listDevices(): DeviceRecord[] {
    return (this.db.prepare("SELECT * FROM devices ORDER BY created_at DESC").all() as DbRow[]).map(rowToDevice);
  }

  getPairingRequest(id: string): DevicePairingRequest | null {
    const row = this.db.prepare("SELECT * FROM pairing_requests WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToPairingRequest(row) : null;
  }

  listPairingRequests(): DevicePairingRequest[] {
    return (this.db.prepare("SELECT * FROM pairing_requests ORDER BY created_at DESC").all() as DbRow[]).map(rowToPairingRequest);
  }

  getDesktopSession(id: string): DesktopSessionRecord | null {
    const row = this.db.prepare("SELECT * FROM desktop_sessions WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToDesktopSession(row) : null;
  }

  listDesktopSessions(deviceId?: string): DesktopSessionRecord[] {
    const rows = deviceId
      ? this.db.prepare("SELECT * FROM desktop_sessions WHERE device_id = ? ORDER BY created_at DESC").all(deviceId)
      : this.db.prepare("SELECT * FROM desktop_sessions ORDER BY created_at DESC").all();
    return (rows as DbRow[]).map(rowToDesktopSession);
  }

  getDesktopFrame(id: string): DesktopFrameRecord | null {
    const row = this.db.prepare("SELECT * FROM desktop_frames WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToDesktopFrame(row) : null;
  }

  listDesktopFrames(sessionId: string, limit = 20): DesktopFrameRecord[] {
    return (this.db.prepare("SELECT * FROM desktop_frames WHERE session_id = ? ORDER BY captured_at DESC LIMIT ?")
      .all(sessionId, limit) as DbRow[]).map(rowToDesktopFrame);
  }

  getDesktopCommand(id: string): DesktopCommandRecord | null {
    const row = this.db.prepare("SELECT * FROM desktop_commands WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToDesktopCommand(row) : null;
  }

  listDesktopCommands(sessionId: string, limit = 50): DesktopCommandRecord[] {
    return (this.db.prepare("SELECT * FROM desktop_commands WHERE session_id = ? ORDER BY created_at ASC LIMIT ?")
      .all(sessionId, limit) as DbRow[]).map(rowToDesktopCommand);
  }

  nextQueuedDesktopCommand(deviceId: string): DesktopCommandRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM desktop_commands WHERE device_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1"
    ).get(deviceId) as DbRow | undefined;
    return row ? rowToDesktopCommand(row) : null;
  }

  listQueuedDesktopCommands(deviceId: string): DesktopCommandRecord[] {
    return (this.db.prepare(
      "SELECT * FROM desktop_commands WHERE device_id = ? AND status IN ('queued', 'claimed') ORDER BY created_at ASC"
    ).all(deviceId) as DbRow[]).map(rowToDesktopCommand);
  }


  listRunsPage(opts: PageOptions): { runs: RunRecord[]; total: number } {
    const { items, total } = this.page("runs", rowToRun, opts);
    return { runs: items, total };
  }

  listApprovalsPage(opts: PageOptions): { approvals: ApprovalRecord[]; total: number } {
    const { items, total } = this.page("approvals", rowToApproval, opts);
    return { approvals: items, total };
  }

  listEffectsPage(opts: PageOptions): { effects: EffectRecord[]; total: number } {
    const { items, total } = this.page("effects", rowToEffect, opts);
    return { effects: items, total };
  }

  listEventsWindow(opts: {
    limit: number;
    afterSeq?: number | undefined;
    beforeSeq?: number | undefined;
    taskId?: string | undefined;
    type?: string | undefined;
  }): EventEnvelope[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.afterSeq !== undefined) {
      where.push("seq > ?");
      params.push(opts.afterSeq);
    }
    if (opts.beforeSeq !== undefined) {
      where.push("seq < ?");
      params.push(opts.beforeSeq);
    }
    if (opts.taskId !== undefined) {
      where.push("task_id = ?");
      params.push(opts.taskId);
    }
    if (opts.type !== undefined) {
      where.push("type = ?");
      params.push(opts.type);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    // An `after` cursor tails the log forward; every other window is the newest
    // matching slice, read backwards and flipped so callers always render ascending seq.
    const forward = opts.afterSeq !== undefined && opts.beforeSeq === undefined;
    const rows = this.db
      .prepare(`SELECT * FROM events${clause} ORDER BY seq ${forward ? "ASC" : "DESC"} LIMIT ?`)
      .all(...params, opts.limit) as DbRow[];
    const events = rows.map(rowToEvent);
    return forward ? events : events.reverse();
  }

  countEvents(taskId?: string, type?: string): number {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (taskId !== undefined) {
      where.push("task_id = ?");
      params.push(taskId);
    }
    if (type !== undefined) {
      where.push("type = ?");
      params.push(type);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM events${clause}`).get(...params) as DbRow;
    return Number(row.total);
  }

  latestEventSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS latest FROM events").get() as DbRow;
    return Number(row.latest ?? 0);
  }

  countTasksByStatus(): Record<TaskStatus, number> {
    return this.countByStatus("tasks", TASK_STATUSES);
  }

  countRunsByStatus(): Record<RunStatus, number> {
    return this.countByStatus("runs", RUN_STATUSES);
  }

  countApprovalsByStatus(): Record<ApprovalStatus, number> {
    return this.countByStatus("approvals", APPROVAL_STATUSES);
  }

  countEffectsByStatus(): Record<EffectStatus, number> {
    return this.countByStatus("effects", EFFECT_STATUSES);
  }

  usageTotals(): RunUsage | null {
    const rows = this.db.prepare("SELECT usage_json FROM runs WHERE usage_json IS NOT NULL").all() as DbRow[];
    if (rows.length === 0) return null;
    const totals: RunUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0
    };
    for (const row of rows) {
      const usage = JSON.parse(String(row.usage_json)) as Partial<RunUsage>;
      for (const key of Object.keys(totals) as (keyof RunUsage)[]) {
        totals[key] += Number(usage[key] ?? 0);
      }
    }
    return totals;
  }

  runDurationTotals(): { ms: number; counted: number; uncounted: number } {
    const rows = this.db.prepare("SELECT started_at, ended_at FROM runs").all() as DbRow[];
    let ms = 0;
    let counted = 0;
    let uncounted = 0;
    for (const row of rows) {
      const duration = durationMs(row.started_at, row.ended_at);
      if (duration === null) uncounted += 1;
      else {
        ms += duration;
        counted += 1;
      }
    }
    return { ms, counted, uncounted };
  }

  artifactTotals(): { count: number; bytes: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(bytes), 0) AS bytes FROM artifacts").get() as DbRow;
    return { count: Number(row.total), bytes: Number(row.bytes) };
  }

  runAggregatesByTask(): Map<string, RunAggregate> {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY created_at ASC").all() as DbRow[];
    const aggregates = new Map<string, RunAggregate>();
    for (const row of rows) {
      const run = rowToRun(row);
      const current = aggregates.get(run.taskId) ?? { runs: 0, lastDurationMs: null, lastUsage: null };
      aggregates.set(run.taskId, {
        runs: current.runs + 1,
        lastDurationMs: durationMs(run.startedAt, run.endedAt),
        lastUsage: run.usage
      });
    }
    return aggregates;
  }

  artifactCountsByTask(): Map<string, number> {
    const rows = this.db.prepare("SELECT task_id, COUNT(*) AS total FROM artifacts GROUP BY task_id").all() as DbRow[];
    return new Map(rows.map((row) => [String(row.task_id), Number(row.total)]));
  }

  effectAggregatesByTask(): Map<string, { total: number; uncertain: number }> {
    const rows = this.db
      .prepare("SELECT task_id, COUNT(*) AS total, SUM(CASE WHEN status = 'uncertain' THEN 1 ELSE 0 END) AS uncertain FROM effects GROUP BY task_id")
      .all() as DbRow[];
    return new Map(rows.map((row) => [String(row.task_id), { total: Number(row.total), uncertain: Number(row.uncertain ?? 0) }]));
  }

  pendingApprovalByTask(): Map<string, string> {
    const rows = this.db.prepare("SELECT task_id, id FROM approvals WHERE status = 'pending' ORDER BY created_at ASC").all() as DbRow[];
    return new Map(rows.map((row) => [String(row.task_id), String(row.id)]));
  }

  rebuildProjections(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM backup_records; DELETE FROM maintenance_runs; DELETE FROM task_leases; DELETE FROM sync_conflicts; DELETE FROM sync_peers; DELETE FROM method_trials; DELETE FROM method_evaluations; DELETE FROM method_candidates; DELETE FROM memory_forget_receipts; DELETE FROM memory_recalls; DELETE FROM memory_conflicts; DELETE FROM memory_versions; DELETE FROM memories; DELETE FROM memory_settings; DELETE FROM suggestion_events; DELETE FROM suggestions; DELETE FROM proactive_settings; DELETE FROM desktop_commands; DELETE FROM desktop_frames; DELETE FROM desktop_sessions; DELETE FROM pairing_requests; DELETE FROM devices; DELETE FROM outbox_drafts; DELETE FROM source_items; DELETE FROM sources; DELETE FROM artifacts; DELETE FROM effects; DELETE FROM approvals; DELETE FROM runs; DELETE FROM tasks;");
      for (const event of this.listEvents()) this.applyEvent(event);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private page<T>(
    table: "runs" | "approvals" | "effects",
    map: (row: DbRow) => T,
    opts: PageOptions
  ): { items: T[]; total: number } {
    const where: string[] = [];
    const filters: SQLInputValue[] = [];
    if (opts.taskId !== undefined) {
      where.push("task_id = ?");
      filters.push(opts.taskId);
    }
    if (opts.status !== undefined) {
      where.push("status = ?");
      filters.push(opts.status);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM ${table}${clause}`).get(...filters) as DbRow).total
    );
    const rows = this.db
      .prepare(`SELECT * FROM ${table}${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...filters, opts.limit, opts.offset) as DbRow[];
    return { items: rows.map(map), total };
  }

  private countByStatus<K extends string>(table: "tasks" | "runs" | "approvals" | "effects", keys: readonly K[]): Record<K, number> {
    const counts = zeroCounts(keys);
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS total FROM ${table} GROUP BY status`).all() as DbRow[];
    for (const row of rows) bump(counts, String(row.status), Number(row.total));
    return counts;
  }

  private applyEvent(event: EventEnvelope): void {
    switch (event.type) {
      case "task.created": return upsertTask(this.db, event.payload as TaskRecord);
      case "task.updated": return updateTask(this.db, event.taskId, event.payload as Record<string, unknown>);
      case "task.proposal.created":
      case "task.proposal.updated": return upsertTaskProposal(this.db, event.payload as TaskProposalRecord);
      case "run.created": return insertRun(this.db, event.payload as RunRecord);
      case "run.updated": return updateRun(this.db, event.runId, event.payload as Record<string, unknown>);
      case "run.checkpoint.created": return insertRunCheckpoint(this.db, event.payload as RunCheckpointRecord);
      case "approval.created": return insertApproval(this.db, event.payload as ApprovalRecord);
      case "approval.updated": return updateApproval(this.db, event.payload as Record<string, unknown>);
      case "effect.created": return insertEffect(this.db, event.payload as EffectRecord);
      case "effect.updated": return updateEffect(this.db, event.payload as Record<string, unknown>);
      case "artifact.published": return insertArtifact(this.db, event.payload as ArtifactRecord);
      case "source.created": return upsertSource(this.db, event.payload as SourceConnection);
      case "source.updated": return updateSource(this.db, event.payload as Record<string, unknown>);
      case "source.item.updated": return upsertSourceItem(this.db, event.payload as SourceItem);
      case "source.cleared": return clearSource(this.db, String((event.payload as Record<string, unknown>).sourceId));
      case "proactive.settings.updated": return upsertProactiveSettings(this.db, event.payload as ProactiveSettings);
      case "suggestion.created":
      case "suggestion.updated": return upsertSuggestion(this.db, event.payload as ProactiveSuggestion);
      case "suggestion.event": {
        const payload = event.payload as Record<string, unknown>;
        return insertSuggestionEventRow(this.db, payload);
      }
      case "memory.settings.updated": return upsertMemorySettings(this.db, event.payload as MemorySettings);
      case "memory.created":
      case "memory.updated": return upsertMemory(this.db, event.payload as MemoryRecord);
      case "memory.version.recorded": return insertMemoryVersionRow(this.db, event.payload as MemoryVersion);
      case "memory.recalled": return insertMemoryRecallRow(this.db, event.payload as MemoryRecall);
      case "memory.forgotten": return insertMemoryForgetReceiptRow(this.db, event.payload as MemoryForgetReceipt);
      case "memory.conflict.created":
      case "memory.conflict.updated": return upsertMemoryConflict(this.db, event.payload as MemoryConflict);
      case "method.candidate.created":
      case "method.candidate.updated": return upsertMethodCandidate(this.db, event.payload as MethodCandidate);
      case "method.evaluation.recorded": return insertMethodEvaluationRow(this.db, event.payload as MethodEvaluation);
      case "method.trial.recorded": return insertMethodTrialRow(this.db, event.payload as MethodTrial);
      case "sync.peer.created":
      case "sync.peer.updated": return upsertSyncPeer(this.db, event.payload as SyncPeer & { tokenCipher?: string | null });
      case "sync.conflict.created":
      case "sync.conflict.updated": return upsertSyncConflict(this.db, event.payload as SyncConflict);
      case "task.lease.updated": return upsertTaskLease(this.db, event.payload as TaskLease);
      case "outbox.created": return upsertOutboxDraft(this.db, event.payload as OutboxDraft);
      case "outbox.updated": return updateOutboxDraft(this.db, event.payload as Record<string, unknown>);
      case "device.paired":
      case "device.updated": return upsertDevice(this.db, event.payload as DeviceRecord);
      case "device.pairing-requested":
      case "device.pairing-updated": return upsertPairingRequest(this.db, event.payload as DevicePairingRequest);
      case "desktop.session.created":
      case "desktop.session.updated": return upsertDesktopSession(this.db, event.payload as DesktopSessionRecord);
      case "desktop.frame.updated": return upsertDesktopFrame(this.db, event.payload as DesktopFrameRecord);
      case "desktop.command.created":
      case "desktop.command.updated": return upsertDesktopCommand(this.db, event.payload as DesktopCommandRecord);
      case "task.progress":
      case "approval.expired":
      case "security.kill-switch.updated":
      case "security.audit": return;
      default: throw new Error(`Unknown event type: ${event.type}`);
    }
  }
}

function upsertTask(db: DatabaseSync, task: TaskRecord): void {
  db.prepare(
    `INSERT INTO tasks (id, template_id, title, goal, status, created_at, updated_at, deadline, inputs_json, network_hosts_json, output_dir, current_run_id, next_action, error_json, result_summary, conversation_id, executor_id, task_kind, expected_outputs_json, permissions_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       template_id=excluded.template_id, title=excluded.title, goal=excluded.goal, status=excluded.status,
       updated_at=excluded.updated_at, deadline=excluded.deadline, inputs_json=excluded.inputs_json,
       network_hosts_json=excluded.network_hosts_json, output_dir=excluded.output_dir,
       current_run_id=excluded.current_run_id, next_action=excluded.next_action, error_json=excluded.error_json,
       result_summary=excluded.result_summary, conversation_id=excluded.conversation_id,
       executor_id=excluded.executor_id, task_kind=excluded.task_kind,
       expected_outputs_json=excluded.expected_outputs_json, permissions_json=excluded.permissions_json`
  ).run(
    task.id, task.templateId, task.title, task.goal, task.status, task.createdAt, task.updatedAt,
    task.deadline, JSON.stringify(task.inputs), JSON.stringify(task.networkHosts), task.outputDir,
    task.currentRunId, task.nextAction, task.error ? JSON.stringify(task.error) : null,
    task.resultSummary ?? null, task.conversationId ?? null,
    task.executorId ?? "codex", task.taskKind ?? "general",
    JSON.stringify(task.expectedOutputs ?? ["result.md"]),
    JSON.stringify(task.permissions ?? defaultTaskPermissions(task))
  );
}

function updateTask(db: DatabaseSync, taskId: string | null, patch: Record<string, unknown>): void {
  if (!taskId) throw new Error("task.updated requires taskId");
  const columns: Record<string, string> = {
    title: "title", goal: "goal", status: "status", updatedAt: "updated_at",
    deadline: "deadline", currentRunId: "current_run_id", nextAction: "next_action",
    resultSummary: "result_summary", conversationId: "conversation_id"
  };
  for (const [key, column] of Object.entries(columns)) {
    if (key in patch) db.prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run((patch[key] as SQLInputValue) ?? null, taskId);
  }
  if ("error" in patch) {
    const error = patch.error as TaskRecord["error"];
    db.prepare("UPDATE tasks SET error_json = ? WHERE id = ?").run(error ? JSON.stringify(error) : null, taskId);
  }
  if ("expectedOutputs" in patch) {
    db.prepare("UPDATE tasks SET expected_outputs_json = ? WHERE id = ?")
      .run(JSON.stringify(patch.expectedOutputs ?? []), taskId);
  }
  if ("permissions" in patch) {
    db.prepare("UPDATE tasks SET permissions_json = ? WHERE id = ?")
      .run(patch.permissions ? JSON.stringify(patch.permissions) : null, taskId);
  }
}

function insertRun(db: DatabaseSync, run: RunRecord): void {
  db.prepare(
    `INSERT INTO runs (id, task_id, attempt, status, thread_id, workspace, started_at, ended_at, failure_json, usage_json, lease_epoch, created_at, executor_id, checkpoint_seq, budget_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    run.id, run.taskId, run.attempt, run.status, run.threadId, run.workspace,
    run.startedAt, run.endedAt, run.failure ? JSON.stringify(run.failure) : null,
    run.usage ? JSON.stringify(run.usage) : null, run.leaseEpoch, run.createdAt,
    run.executorId ?? "codex", run.checkpointSeq ?? 0,
    run.budget ? JSON.stringify(run.budget) : null
  );
}

function updateRun(db: DatabaseSync, runId: string | null, patch: Record<string, unknown>): void {
  if (!runId) throw new Error("run.updated requires runId");
  const columns: Record<string, string> = {
    status: "status", threadId: "thread_id", startedAt: "started_at", endedAt: "ended_at",
    executorId: "executor_id", checkpointSeq: "checkpoint_seq"
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
  if ("budget" in patch) {
    const budget = patch.budget as RunRecord["budget"];
    db.prepare("UPDATE runs SET budget_json = ? WHERE id = ?").run(budget ? JSON.stringify(budget) : null, runId);
  }
}

function upsertTaskProposal(db: DatabaseSync, proposal: TaskProposalRecord): void {
  db.prepare(
    `INSERT INTO task_proposals (id, conversation_id, title, goal, executor_id, task_kind, expected_outputs_json, permissions_json, reason, status, expires_at, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, decided_at=excluded.decided_at`
  ).run(
    proposal.id, proposal.conversationId, proposal.title, proposal.goal, proposal.executorId,
    proposal.taskKind, JSON.stringify(proposal.expectedOutputs), JSON.stringify(proposal.permissions),
    proposal.reason, proposal.status, proposal.expiresAt, proposal.createdAt, proposal.decidedAt
  );
}

function insertRunCheckpoint(db: DatabaseSync, checkpoint: RunCheckpointRecord): void {
  db.prepare(
    `INSERT INTO run_checkpoints (id, run_id, task_id, seq, kind, path, sha256, usage_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, seq) DO UPDATE SET kind=excluded.kind, path=excluded.path, sha256=excluded.sha256, usage_json=excluded.usage_json`
  ).run(
    checkpoint.id, checkpoint.runId, checkpoint.taskId, checkpoint.seq, checkpoint.kind,
    checkpoint.path, checkpoint.sha256, checkpoint.usage ? JSON.stringify(checkpoint.usage) : null,
    checkpoint.createdAt
  );
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

function upsertSource(db: DatabaseSync, source: SourceConnection): void {
  db.prepare(
    `INSERT INTO sources (id, kind, provider, display_name, account, root_path, allowed_hosts_json, status, read_only, item_count, last_read_at, last_error_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       kind=excluded.kind, provider=excluded.provider, display_name=excluded.display_name,
       account=excluded.account, root_path=excluded.root_path, allowed_hosts_json=excluded.allowed_hosts_json,
       status=excluded.status, read_only=excluded.read_only, item_count=excluded.item_count,
       last_read_at=excluded.last_read_at, last_error_json=excluded.last_error_json, updated_at=excluded.updated_at`
  ).run(
    source.id, source.kind, source.provider, source.displayName, source.account, source.rootPath,
    JSON.stringify(source.allowedHosts), source.status, source.readOnly ? 1 : 0, source.itemCount,
    source.lastReadAt, source.lastError ? JSON.stringify(source.lastError) : null,
    source.createdAt, source.updatedAt
  );
}

function updateSource(db: DatabaseSync, patch: Record<string, unknown>): void {
  const id = String(patch.id);
  const columns: Record<string, string> = {
    displayName: "display_name", account: "account", rootPath: "root_path", status: "status",
    itemCount: "item_count", lastReadAt: "last_read_at", updatedAt: "updated_at"
  };
  for (const [key, column] of Object.entries(columns)) {
    if (key in patch) db.prepare(`UPDATE sources SET ${column} = ? WHERE id = ?`).run((patch[key] as SQLInputValue) ?? null, id);
  }
  if ("allowedHosts" in patch) {
    db.prepare("UPDATE sources SET allowed_hosts_json = ? WHERE id = ?").run(JSON.stringify(patch.allowedHosts ?? []), id);
  }
  if ("lastError" in patch) {
    const error = patch.lastError as SourceConnection["lastError"];
    db.prepare("UPDATE sources SET last_error_json = ? WHERE id = ?").run(error ? JSON.stringify(error) : null, id);
  }
}

function upsertSourceItem(db: DatabaseSync, item: SourceItem): void {
  db.prepare(
    `INSERT INTO source_items (id, source_id, item_key, label, locator, content_path, content_hash, bytes, title, status, coverage_json, duplicate_of, error_json, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, item_key) DO UPDATE SET
       label=excluded.label, locator=excluded.locator, content_path=excluded.content_path,
       content_hash=excluded.content_hash, bytes=excluded.bytes, title=excluded.title,
       status=excluded.status, coverage_json=excluded.coverage_json,
       duplicate_of=excluded.duplicate_of, error_json=excluded.error_json, fetched_at=excluded.fetched_at`
  ).run(
    item.id, item.sourceId, item.itemKey, item.label, item.locator, item.contentPath,
    item.contentHash, item.bytes, item.title, item.status, JSON.stringify(item.coverage),
    item.duplicateOf, item.error ? JSON.stringify(item.error) : null, item.fetchedAt
  );
}

function clearSource(db: DatabaseSync, sourceId: string): void {
  db.prepare("DELETE FROM source_items WHERE source_id = ?").run(sourceId);
}

function upsertOutboxDraft(db: DatabaseSync, draft: OutboxDraft): void {
  db.prepare(
    `INSERT INTO outbox_drafts (id, account, to_json, cc_json, bcc_json, subject, body, attachments_json, status, task_id, approval_id, effect_id, created_at, updated_at, submitted_at, discarded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       account=excluded.account, to_json=excluded.to_json, cc_json=excluded.cc_json,
       bcc_json=excluded.bcc_json, subject=excluded.subject, body=excluded.body,
       attachments_json=excluded.attachments_json, status=excluded.status, task_id=excluded.task_id,
       approval_id=excluded.approval_id, effect_id=excluded.effect_id, updated_at=excluded.updated_at,
       submitted_at=excluded.submitted_at, discarded_at=excluded.discarded_at`
  ).run(
    draft.id, draft.account, JSON.stringify(draft.to), JSON.stringify(draft.cc), JSON.stringify(draft.bcc),
    draft.subject, draft.body, JSON.stringify(draft.attachments), draft.status, draft.taskId,
    draft.approvalId, draft.effectId, draft.createdAt, draft.updatedAt, draft.submittedAt, draft.discardedAt
  );
}

function updateOutboxDraft(db: DatabaseSync, patch: Record<string, unknown>): void {
  const id = String(patch.id);
  const columns: Record<string, string> = {
    account: "account", subject: "subject", body: "body", status: "status", taskId: "task_id",
    approvalId: "approval_id", effectId: "effect_id", updatedAt: "updated_at",
    submittedAt: "submitted_at", discardedAt: "discarded_at"
  };
  for (const [key, column] of Object.entries(columns)) {
    if (key in patch) db.prepare(`UPDATE outbox_drafts SET ${column} = ? WHERE id = ?`).run((patch[key] as SQLInputValue) ?? null, id);
  }
  for (const key of ["to", "cc", "bcc", "attachments"] as const) {
    if (key in patch) {
      const column = key === "attachments" ? "attachments_json" : `${key}_json`;
      db.prepare(`UPDATE outbox_drafts SET ${column} = ? WHERE id = ?`).run(JSON.stringify(patch[key] ?? []), id);
    }
  }
}

function upsertDevice(db: DatabaseSync, device: DeviceRecord): void {
  db.prepare(
    `INSERT INTO devices (id, pairing_request_id, name, platform, version, status, token_hash, capabilities_json, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, platform=excluded.platform, version=excluded.version,
       status=excluded.status, token_hash=excluded.token_hash, capabilities_json=excluded.capabilities_json,
       last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at`
  ).run(
    device.id, device.pairingRequestId, device.name, device.platform, device.version,
    device.status, device.tokenHash, JSON.stringify(device.capabilities), device.lastSeenAt,
    device.createdAt, device.updatedAt
  );
}

function upsertPairingRequest(db: DatabaseSync, request: DevicePairingRequest): void {
  db.prepare(
    `INSERT INTO pairing_requests (id, code, secret_hash, device_token_hash, name, platform, version, requested_apps_json, requested_capabilities_json, status, device_id, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status=excluded.status, device_id=excluded.device_id, updated_at=excluded.updated_at`
  ).run(
    request.id, request.code, request.secretHash, request.deviceTokenHash, request.name,
    request.platform, request.version, JSON.stringify(request.requestedApps),
    JSON.stringify(request.requestedCapabilities), request.status, request.deviceId,
    request.expiresAt, request.createdAt, request.updatedAt
  );
}

function upsertDesktopSession(db: DatabaseSync, session: DesktopSessionRecord): void {
  db.prepare(
    `INSERT INTO desktop_sessions (id, device_id, status, control_epoch, current_frame_id, last_error, created_at, updated_at, terminated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status=excluded.status, control_epoch=excluded.control_epoch,
       current_frame_id=excluded.current_frame_id, last_error=excluded.last_error,
       updated_at=excluded.updated_at, terminated_at=excluded.terminated_at`
  ).run(
    session.id, session.deviceId, session.status, session.controlEpoch,
    session.currentFrameId, session.lastError, session.createdAt, session.updatedAt,
    session.terminatedAt
  );
}

function upsertDesktopFrame(db: DatabaseSync, frame: DesktopFrameRecord): void {
  db.prepare(
    `INSERT INTO desktop_frames (id, device_id, session_id, mime_type, width, height, sha256, bytes, storage_path, active_app, window_title, captured_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at`
  ).run(
    frame.id, frame.deviceId, frame.sessionId, frame.mimeType, frame.width, frame.height,
    frame.sha256, frame.bytes, frame.storagePath, frame.activeApp, frame.windowTitle,
    frame.capturedAt, frame.expiresAt
  );
}

function upsertDesktopCommand(db: DatabaseSync, command: DesktopCommandRecord): void {
  db.prepare(
    `INSERT INTO desktop_commands (id, device_id, session_id, kind, status, frame_id, control_epoch, payload_json, result_json, error, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status=excluded.status, result_json=excluded.result_json, error=excluded.error,
       updated_at=excluded.updated_at, completed_at=excluded.completed_at`
  ).run(
    command.id, command.deviceId, command.sessionId, command.kind, command.status,
    command.frameId, command.controlEpoch, JSON.stringify(command.payload),
    command.result ? JSON.stringify(command.result) : null, command.error,
    command.createdAt, command.updatedAt, command.completedAt
  );
}

function rowToEvent(row: DbRow): EventEnvelope {
  return {
    seq: Number(row.seq), id: String(row.id), type: String(row.type),
    taskId: row.task_id == null ? null : String(row.task_id),
    runId: row.run_id == null ? null : String(row.run_id),
    payload: JSON.parse(String(row.payload_json)),
    originInstanceId: row.origin_instance_id == null ? null : String(row.origin_instance_id),
    originSeq: row.origin_seq == null ? null : Number(row.origin_seq),
    createdAt: String(row.created_at)
  };
}

function rowToTask(row: DbRow): TaskRecord {
  const networkHosts: string[] = JSON.parse(String(row.network_hosts_json));
  return {
    id: String(row.id), templateId: row.template_id == null ? null : String(row.template_id),
    title: String(row.title), goal: String(row.goal), status: String(row.status) as TaskRecord["status"],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    deadline: row.deadline == null ? null : String(row.deadline),
    inputs: JSON.parse(String(row.inputs_json)),
    networkHosts, outputDir: String(row.output_dir),
    currentRunId: row.current_run_id == null ? null : String(row.current_run_id),
    nextAction: row.next_action == null ? null : String(row.next_action),
    error: row.error_json == null ? null : JSON.parse(String(row.error_json)),
    resultSummary: row.result_summary == null ? null : String(row.result_summary),
    conversationId: row.conversation_id == null ? null : String(row.conversation_id),
    executorId: (row.executor_id == null ? "codex" : String(row.executor_id)) as NonNullable<TaskRecord["executorId"]>,
    taskKind: (row.task_kind == null ? "general" : String(row.task_kind)) as NonNullable<TaskRecord["taskKind"]>,
    expectedOutputs: row.expected_outputs_json == null ? ["result.md"] : JSON.parse(String(row.expected_outputs_json)),
    permissions: row.permissions_json == null
      ? { readRoots: [], writeRoots: [], networkHosts, tools: [] }
      : JSON.parse(String(row.permissions_json))
  };
}

function rowToConversation(row: DbRow): ConversationRecord {
  return {
    id: String(row.id), title: String(row.title),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function rowToChatMessage(row: DbRow): ChatMessageRecord {
  return {
    id: String(row.id), conversationId: String(row.conversation_id),
    role: String(row.role) as ChatMessageRecord["role"], content: String(row.content),
    taskId: row.task_id == null ? null : String(row.task_id),
    attachments: JSON.parse(String(row.attachments_json)), createdAt: String(row.created_at)
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
    leaseEpoch: row.lease_epoch == null ? null : Number(row.lease_epoch),
    createdAt: String(row.created_at),
    executorId: (row.executor_id == null ? "codex" : String(row.executor_id)) as NonNullable<RunRecord["executorId"]>,
    checkpointSeq: row.checkpoint_seq == null ? 0 : Number(row.checkpoint_seq),
    ...(row.budget_json == null ? {} : { budget: JSON.parse(String(row.budget_json)) as NonNullable<RunRecord["budget"]> })
  };
}

function rowToTaskProposal(row: DbRow): TaskProposalRecord {
  return {
    id: String(row.id), conversationId: String(row.conversation_id),
    title: String(row.title), goal: String(row.goal),
    executorId: String(row.executor_id) as TaskProposalRecord["executorId"],
    taskKind: String(row.task_kind) as TaskProposalRecord["taskKind"],
    expectedOutputs: JSON.parse(String(row.expected_outputs_json)),
    permissions: JSON.parse(String(row.permissions_json)),
    reason: String(row.reason), status: String(row.status) as TaskProposalRecord["status"],
    expiresAt: String(row.expires_at), createdAt: String(row.created_at),
    decidedAt: row.decided_at == null ? null : String(row.decided_at)
  };
}

function rowToRunCheckpoint(row: DbRow): RunCheckpointRecord {
  return {
    id: String(row.id), runId: String(row.run_id), taskId: String(row.task_id),
    seq: Number(row.seq), kind: String(row.kind), path: String(row.path),
    sha256: String(row.sha256),
    usage: row.usage_json == null ? null : JSON.parse(String(row.usage_json)),
    createdAt: String(row.created_at)
  };
}

function defaultTaskPermissions(task: TaskRecord): NonNullable<TaskRecord["permissions"]> {
  return { readRoots: [], writeRoots: [], networkHosts: task.networkHosts, tools: [] };
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

function rowToSource(row: DbRow): SourceConnection {
  return {
    id: String(row.id), kind: String(row.kind) as SourceConnection["kind"],
    provider: String(row.provider), displayName: String(row.display_name),
    account: row.account == null ? null : String(row.account),
    rootPath: row.root_path == null ? null : String(row.root_path),
    allowedHosts: JSON.parse(String(row.allowed_hosts_json)),
    status: String(row.status) as SourceConnection["status"], readOnly: true,
    itemCount: Number(row.item_count),
    lastReadAt: row.last_read_at == null ? null : String(row.last_read_at),
    lastError: row.last_error_json == null ? null : JSON.parse(String(row.last_error_json)),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function rowToSourceItem(row: DbRow): SourceItem {
  return {
    id: String(row.id), sourceId: String(row.source_id), itemKey: String(row.item_key),
    label: String(row.label), locator: String(row.locator),
    contentPath: row.content_path == null ? null : String(row.content_path),
    contentHash: row.content_hash == null ? null : String(row.content_hash),
    bytes: Number(row.bytes), title: row.title == null ? null : String(row.title),
    status: String(row.status) as SourceItem["status"],
    coverage: JSON.parse(String(row.coverage_json)),
    duplicateOf: row.duplicate_of == null ? null : String(row.duplicate_of),
    error: row.error_json == null ? null : JSON.parse(String(row.error_json)),
    fetchedAt: String(row.fetched_at)
  };
}

function rowToOutboxDraft(row: DbRow): OutboxDraft {
  return {
    id: String(row.id), account: String(row.account),
    to: JSON.parse(String(row.to_json)), cc: JSON.parse(String(row.cc_json)),
    bcc: JSON.parse(String(row.bcc_json)), subject: String(row.subject), body: String(row.body),
    attachments: JSON.parse(String(row.attachments_json)),
    status: String(row.status) as OutboxDraft["status"],
    taskId: row.task_id == null ? null : String(row.task_id),
    approvalId: row.approval_id == null ? null : String(row.approval_id),
    effectId: row.effect_id == null ? null : String(row.effect_id),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    submittedAt: row.submitted_at == null ? null : String(row.submitted_at),
    discardedAt: row.discarded_at == null ? null : String(row.discarded_at)
  };
}

function rowToDevice(row: DbRow): DeviceRecord {
  return {
    id: String(row.id),
    pairingRequestId: String(row.pairing_request_id),
    name: String(row.name),
    platform: String(row.platform) as DeviceRecord["platform"],
    version: String(row.version),
    status: String(row.status) as DeviceRecord["status"],
    tokenHash: String(row.token_hash),
    capabilities: JSON.parse(String(row.capabilities_json)),
    lastSeenAt: row.last_seen_at == null ? null : String(row.last_seen_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToPairingRequest(row: DbRow): DevicePairingRequest {
  return {
    id: String(row.id),
    code: String(row.code),
    secretHash: String(row.secret_hash),
    deviceTokenHash: String(row.device_token_hash),
    name: String(row.name),
    platform: String(row.platform) as DevicePairingRequest["platform"],
    version: String(row.version),
    requestedApps: JSON.parse(String(row.requested_apps_json)),
    requestedCapabilities: JSON.parse(String(row.requested_capabilities_json)),
    status: String(row.status) as DevicePairingRequest["status"],
    deviceId: row.device_id == null ? null : String(row.device_id),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToDesktopSession(row: DbRow): DesktopSessionRecord {
  return {
    id: String(row.id), deviceId: String(row.device_id),
    status: String(row.status) as DesktopSessionRecord["status"],
    controlEpoch: Number(row.control_epoch),
    currentFrameId: row.current_frame_id == null ? null : String(row.current_frame_id),
    lastError: row.last_error == null ? null : String(row.last_error),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    terminatedAt: row.terminated_at == null ? null : String(row.terminated_at)
  };
}

function rowToDesktopFrame(row: DbRow): DesktopFrameRecord {
  return {
    id: String(row.id), deviceId: String(row.device_id), sessionId: String(row.session_id),
    mimeType: String(row.mime_type) as DesktopFrameRecord["mimeType"],
    width: Number(row.width), height: Number(row.height), sha256: String(row.sha256),
    bytes: Number(row.bytes), storagePath: String(row.storage_path),
    activeApp: String(row.active_app), windowTitle: String(row.window_title),
    capturedAt: String(row.captured_at), expiresAt: String(row.expires_at)
  };
}

function rowToDesktopCommand(row: DbRow): DesktopCommandRecord {
  return {
    id: String(row.id), deviceId: String(row.device_id), sessionId: String(row.session_id),
    kind: String(row.kind) as DesktopCommandRecord["kind"],
    status: String(row.status) as DesktopCommandRecord["status"],
    frameId: row.frame_id == null ? null : String(row.frame_id),
    controlEpoch: Number(row.control_epoch), payload: JSON.parse(String(row.payload_json)),
    result: row.result_json == null ? null : JSON.parse(String(row.result_json)),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at)
  };
}

function durationMs(startedAt: unknown, endedAt: unknown): number | null {
  if (typeof startedAt !== "string" || typeof endedAt !== "string") return null;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  const counts = {} as Record<K, number>;
  for (const key of keys) counts[key] = 0;
  return counts;
}

function bump<K extends string>(counts: Record<K, number>, key: string, by: number): void {
  if (Object.hasOwn(counts, key)) counts[key as K] += by;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as DbRow[];
  if (columns.some((row) => String(row.name) === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}


function rowToProactiveSettings(row: DbRow): ProactiveSettings {
  return {
    enabled: Number(row.enabled) === 1,
    mode: String(row.mode) as ProactiveSettings["mode"],
    dailyLimit: Number(row.daily_limit),
    quietStart: String(row.quiet_start),
    quietEnd: String(row.quiet_end),
    cooldownMinutes: Number(row.cooldown_minutes),
    aggregateWindowMinutes: Number(row.aggregate_window_minutes),
    pausedUntil: row.paused_until == null ? null : String(row.paused_until),
    triggers: JSON.parse(String(row.triggers_json)),
    updatedAt: String(row.updated_at)
  };
}

function upsertProactiveSettings(db: DatabaseSync, settings: ProactiveSettings): void {
  db.prepare(
    `INSERT INTO proactive_settings (id, enabled, mode, daily_limit, quiet_start, quiet_end, cooldown_minutes, aggregate_window_minutes, paused_until, triggers_json, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, mode=excluded.mode, daily_limit=excluded.daily_limit,
       quiet_start=excluded.quiet_start, quiet_end=excluded.quiet_end, cooldown_minutes=excluded.cooldown_minutes,
       aggregate_window_minutes=excluded.aggregate_window_minutes, paused_until=excluded.paused_until,
       triggers_json=excluded.triggers_json, updated_at=excluded.updated_at`
  ).run(
    settings.enabled ? 1 : 0, settings.mode, settings.dailyLimit, settings.quietStart, settings.quietEnd,
    settings.cooldownMinutes, settings.aggregateWindowMinutes, settings.pausedUntil,
    JSON.stringify(settings.triggers), settings.updatedAt
  );
}

function rowToSuggestion(row: DbRow): ProactiveSuggestion {
  return {
    id: String(row.id),
    triggerKind: String(row.trigger_kind) as ProactiveSuggestion["triggerKind"],
    dedupeKey: String(row.dedupe_key),
    title: String(row.title),
    whyNow: String(row.why_now),
    suggestedAction: String(row.suggested_action),
    expectedImpact: String(row.expected_impact),
    estimatedCost: String(row.estimated_cost),
    riskLevel: String(row.risk_level) as ProactiveSuggestion["riskLevel"],
    requiresApproval: Number(row.requires_approval) === 1,
    autonomy: String(row.autonomy) as ProactiveSuggestion["autonomy"],
    status: String(row.status) as ProactiveSuggestion["status"],
    priority: Number(row.priority),
    source: JSON.parse(String(row.source_json)),
    evidence: JSON.parse(String(row.evidence_json)),
    occurrenceCount: Number(row.occurrence_count),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    notifiedAt: row.notified_at == null ? null : String(row.notified_at),
    snoozeUntil: row.snooze_until == null ? null : String(row.snooze_until),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    taskId: row.task_id == null ? null : String(row.task_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function upsertSuggestion(db: DatabaseSync, suggestion: ProactiveSuggestion): void {
  db.prepare(
    `INSERT INTO suggestions (id, trigger_kind, dedupe_key, title, why_now, suggested_action, expected_impact,
       estimated_cost, risk_level, requires_approval, autonomy, status, priority, source_json, evidence_json,
       occurrence_count, first_seen_at, last_seen_at, notified_at, snooze_until, expires_at, task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET trigger_kind=excluded.trigger_kind, dedupe_key=excluded.dedupe_key,
       title=excluded.title, why_now=excluded.why_now, suggested_action=excluded.suggested_action,
       expected_impact=excluded.expected_impact, estimated_cost=excluded.estimated_cost, risk_level=excluded.risk_level,
       requires_approval=excluded.requires_approval, autonomy=excluded.autonomy, status=excluded.status,
       priority=excluded.priority, source_json=excluded.source_json, evidence_json=excluded.evidence_json,
       occurrence_count=excluded.occurrence_count, first_seen_at=excluded.first_seen_at, last_seen_at=excluded.last_seen_at,
       notified_at=excluded.notified_at, snooze_until=excluded.snooze_until, expires_at=excluded.expires_at,
       task_id=excluded.task_id, updated_at=excluded.updated_at`
  ).run(
    suggestion.id, suggestion.triggerKind, suggestion.dedupeKey, suggestion.title, suggestion.whyNow,
    suggestion.suggestedAction, suggestion.expectedImpact, suggestion.estimatedCost, suggestion.riskLevel,
    suggestion.requiresApproval ? 1 : 0, suggestion.autonomy, suggestion.status, suggestion.priority,
    JSON.stringify(suggestion.source), JSON.stringify(suggestion.evidence), suggestion.occurrenceCount,
    suggestion.firstSeenAt, suggestion.lastSeenAt, suggestion.notifiedAt, suggestion.snoozeUntil,
    suggestion.expiresAt, suggestion.taskId, suggestion.createdAt, suggestion.updatedAt
  );
}

function insertSuggestionEventRow(db: DatabaseSync, payload: Record<string, unknown>): void {
  db.prepare(
    "INSERT INTO suggestion_events (id, suggestion_id, action, payload_json, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(
    String(payload.id), String(payload.suggestionId), String(payload.action),
    JSON.stringify(payload), String(payload.createdAt)
  );
}

function rowToMemorySettings(row: DbRow): MemorySettings {
  return {
    autoCapture: String(row.auto_capture) as MemorySettings["autoCapture"],
    maxItems: Number(row.max_items),
    maxChars: Number(row.max_chars),
    allowSensitive: Number(row.allow_sensitive) === 1,
    updatedAt: String(row.updated_at)
  };
}

function upsertMemorySettings(db: DatabaseSync, settings: MemorySettings): void {
  db.prepare(
    "INSERT INTO memory_settings (id, auto_capture, max_items, max_chars, allow_sensitive, updated_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET auto_capture=excluded.auto_capture, max_items=excluded.max_items, max_chars=excluded.max_chars, allow_sensitive=excluded.allow_sensitive, updated_at=excluded.updated_at"
  ).run(settings.autoCapture, settings.maxItems, settings.maxChars, settings.allowSensitive ? 1 : 0, settings.updatedAt);
}

function rowToMemory(row: DbRow): MemoryRecord {
  return {
    id: String(row.id),
    kind: String(row.kind) as MemoryRecord["kind"],
    status: String(row.status) as MemoryRecord["status"],
    content: String(row.content),
    subjectKey: String(row.subject_key),
    scope: String(row.scope),
    tags: JSON.parse(String(row.tags_json)),
    source: JSON.parse(String(row.source_json)),
    confidence: String(row.confidence) as MemoryRecord["confidence"],
    sensitivity: String(row.sensitivity) as MemoryRecord["sensitivity"],
    allowRecall: Number(row.allow_recall) === 1,
    version: Number(row.version),
    supersedesId: row.supersedes_id == null ? null : String(row.supersedes_id),
    derivedFromId: row.derived_from_id == null ? null : String(row.derived_from_id),
    validUntil: row.valid_until == null ? null : String(row.valid_until),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastRecalledAt: row.last_recalled_at == null ? null : String(row.last_recalled_at),
    recallCount: Number(row.recall_count)
  };
}

function upsertMemory(db: DatabaseSync, memory: MemoryRecord): void {
  db.prepare(
    `INSERT INTO memories (id, kind, status, content, subject_key, scope, tags_json, source_json, confidence, sensitivity, allow_recall, version, supersedes_id, derived_from_id, valid_until, created_at, updated_at, last_recalled_at, recall_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, status=excluded.status, content=excluded.content,
       subject_key=excluded.subject_key, scope=excluded.scope, tags_json=excluded.tags_json, source_json=excluded.source_json,
       confidence=excluded.confidence, sensitivity=excluded.sensitivity, allow_recall=excluded.allow_recall,
       version=excluded.version, supersedes_id=excluded.supersedes_id, derived_from_id=excluded.derived_from_id,
       valid_until=excluded.valid_until, updated_at=excluded.updated_at, last_recalled_at=excluded.last_recalled_at,
       recall_count=excluded.recall_count`
  ).run(
    memory.id, memory.kind, memory.status, memory.content, memory.subjectKey, memory.scope,
    JSON.stringify(memory.tags), JSON.stringify(memory.source), memory.confidence, memory.sensitivity,
    memory.allowRecall ? 1 : 0, memory.version, memory.supersedesId, memory.derivedFromId,
    memory.validUntil, memory.createdAt, memory.updatedAt, memory.lastRecalledAt, memory.recallCount
  );
}

function rowToMemoryVersion(row: DbRow): MemoryVersion {
  return {
    id: String(row.id),
    memoryId: String(row.memory_id),
    version: Number(row.version),
    content: String(row.content),
    status: String(row.status) as MemoryVersion["status"],
    source: JSON.parse(String(row.source_json)),
    confidence: String(row.confidence) as MemoryVersion["confidence"],
    sensitivity: String(row.sensitivity) as MemoryVersion["sensitivity"],
    allowRecall: Number(row.allow_recall) === 1,
    scope: String(row.scope),
    tags: JSON.parse(String(row.tags_json)),
    reason: String(row.reason),
    createdAt: String(row.created_at)
  };
}

function insertMemoryVersionRow(db: DatabaseSync, version: MemoryVersion): void {
  db.prepare(
    "INSERT INTO memory_versions (id, memory_id, version, content, status, source_json, confidence, sensitivity, allow_recall, scope, tags_json, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    version.id, version.memoryId, version.version, version.content, version.status,
    JSON.stringify(version.source), version.confidence, version.sensitivity, version.allowRecall ? 1 : 0,
    version.scope, JSON.stringify(version.tags), version.reason, version.createdAt
  );
}

function rowToMemoryConflict(row: DbRow): MemoryConflict {
  return {
    id: String(row.id),
    subjectKey: String(row.subject_key),
    memoryIds: JSON.parse(String(row.memory_ids_json)),
    status: String(row.status) as MemoryConflict["status"],
    resolution: row.resolution == null ? null : String(row.resolution) as MemoryConflict["resolution"],
    note: String(row.note),
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at == null ? null : String(row.resolved_at)
  };
}

function upsertMemoryConflict(db: DatabaseSync, conflict: MemoryConflict): void {
  db.prepare(
    "INSERT INTO memory_conflicts (id, subject_key, memory_ids_json, status, resolution, note, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET subject_key=excluded.subject_key, memory_ids_json=excluded.memory_ids_json, status=excluded.status, resolution=excluded.resolution, note=excluded.note, resolved_at=excluded.resolved_at"
  ).run(conflict.id, conflict.subjectKey, JSON.stringify(conflict.memoryIds), conflict.status, conflict.resolution, conflict.note, conflict.createdAt, conflict.resolvedAt);
}

function rowToMemoryRecall(row: DbRow): MemoryRecall {
  return {
    id: String(row.id),
    memoryId: String(row.memory_id),
    taskId: String(row.task_id),
    runId: row.run_id == null ? null : String(row.run_id),
    reason: String(row.reason),
    score: Number(row.score),
    createdAt: String(row.created_at)
  };
}

function insertMemoryRecallRow(db: DatabaseSync, recall: MemoryRecall): void {
  db.prepare(
    "INSERT INTO memory_recalls (id, memory_id, task_id, run_id, reason, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(recall.id, recall.memoryId, recall.taskId, recall.runId, recall.reason, recall.score, recall.createdAt);
}

function rowToMemoryForgetReceipt(row: DbRow): MemoryForgetReceipt {
  return {
    id: String(row.id),
    memoryId: String(row.memory_id),
    affectedMemoryIds: JSON.parse(String(row.affected_memory_ids_json)),
    reason: String(row.reason),
    redactedVersions: Number(row.redacted_versions),
    redactedEvents: Number(row.redacted_events),
    targets: JSON.parse(String(row.targets_json)),
    createdAt: String(row.created_at)
  };
}

function insertMemoryForgetReceiptRow(db: DatabaseSync, receipt: MemoryForgetReceipt): void {
  db.prepare(
    "INSERT INTO memory_forget_receipts (id, memory_id, affected_memory_ids_json, reason, redacted_versions, redacted_events, targets_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    receipt.id, receipt.memoryId, JSON.stringify(receipt.affectedMemoryIds), receipt.reason,
    receipt.redactedVersions, receipt.redactedEvents, JSON.stringify(receipt.targets), receipt.createdAt
  );
}

function payloadReferencesMemory(value: unknown, memoryId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => payloadReferencesMemory(item, memoryId));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.id === memoryId || record.memoryId === memoryId) return true;
  if (Array.isArray(record.memoryIds) && record.memoryIds.includes(memoryId)) return true;
  return Object.values(record).some((item) => payloadReferencesMemory(item, memoryId));
}

function scrubMemoryEventPayload(
  type: string,
  value: unknown,
  memoryId: string,
  tombstone: { content: string; subjectKey: string; scope: string }
): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubMemoryEventPayload(type, item, memoryId, tombstone));
  if (!value || typeof value !== "object") return value;
  const next = { ...(value as Record<string, unknown>) };
  if (next.id === memoryId || next.memoryId === memoryId) {
    if ("content" in next) next.content = tombstone.content;
    if ("subjectKey" in next) next.subjectKey = tombstone.subjectKey;
    if ("scope" in next) next.scope = tombstone.scope;
    if ("tags" in next) next.tags = [];
    if ("allowRecall" in next) next.allowRecall = false;
    if ("validUntil" in next) next.validUntil = null;
    if ("source" in next) {
      const source = next.source && typeof next.source === "object" ? next.source as Record<string, unknown> : {};
      next.source = { type: typeof source.type === "string" ? source.type : "system", id: null, label: "[已遗忘]", excerpt: null };
    }
    if (type === "memory.recalled" && "reason" in next) next.reason = "[记忆已遗忘]";
  }
  if (Array.isArray(next.memoryIds) && next.memoryIds.includes(memoryId)) {
    if ("subjectKey" in next) next.subjectKey = tombstone.subjectKey;
    if ("note" in next) next.note = "包含已遗忘记忆，正文已脱敏。";
  }
  for (const [key, item] of Object.entries(next)) {
    next[key] = scrubMemoryEventPayload(type, item, memoryId, tombstone);
  }
  return next;
}

function rowToMethodCandidate(row: DbRow): MethodCandidate {
  return {
    id: String(row.id),
    name: String(row.name),
    summary: String(row.summary),
    applicability: String(row.applicability),
    steps: JSON.parse(String(row.steps_json)),
    sourceTaskIds: JSON.parse(String(row.source_task_ids_json)),
    templateId: row.template_id == null ? null : String(row.template_id),
    status: String(row.status) as MethodCandidate["status"],
    version: Number(row.version),
    previousVersionId: row.previous_version_id == null ? null : String(row.previous_version_id),
    allowedCapabilities: JSON.parse(String(row.allowed_capabilities_json)),
    guardrails: JSON.parse(String(row.guardrails_json)),
    baseline: JSON.parse(String(row.baseline_json)),
    trial: JSON.parse(String(row.trial_json)),
    evaluationVerdict: row.evaluation_verdict == null ? null : String(row.evaluation_verdict) as MethodCandidate["evaluationVerdict"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    adoptedAt: row.adopted_at == null ? null : String(row.adopted_at),
    retiredAt: row.retired_at == null ? null : String(row.retired_at)
  };
}

function upsertMethodCandidate(db: DatabaseSync, method: MethodCandidate): void {
  db.prepare(
    "INSERT INTO method_candidates (id, name, summary, applicability, steps_json, source_task_ids_json, template_id, status, version, previous_version_id, allowed_capabilities_json, guardrails_json, baseline_json, trial_json, evaluation_verdict, created_at, updated_at, adopted_at, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, summary=excluded.summary, applicability=excluded.applicability, steps_json=excluded.steps_json, source_task_ids_json=excluded.source_task_ids_json, template_id=excluded.template_id, status=excluded.status, version=excluded.version, previous_version_id=excluded.previous_version_id, allowed_capabilities_json=excluded.allowed_capabilities_json, guardrails_json=excluded.guardrails_json, baseline_json=excluded.baseline_json, trial_json=excluded.trial_json, evaluation_verdict=excluded.evaluation_verdict, updated_at=excluded.updated_at, adopted_at=excluded.adopted_at, retired_at=excluded.retired_at"
  ).run(
    method.id, method.name, method.summary, method.applicability, JSON.stringify(method.steps), JSON.stringify(method.sourceTaskIds),
    method.templateId, method.status, method.version, method.previousVersionId, JSON.stringify(method.allowedCapabilities),
    JSON.stringify(method.guardrails), JSON.stringify(method.baseline), JSON.stringify(method.trial), method.evaluationVerdict,
    method.createdAt, method.updatedAt, method.adoptedAt, method.retiredAt
  );
}

function rowToMethodEvaluation(row: DbRow): MethodEvaluation {
  return {
    id: String(row.id),
    methodId: String(row.method_id),
    methodVersion: Number(row.method_version),
    baselineTaskIds: JSON.parse(String(row.baseline_task_ids_json)),
    trialTaskIds: JSON.parse(String(row.trial_task_ids_json)),
    baseline: JSON.parse(String(row.baseline_json)),
    trial: JSON.parse(String(row.trial_json)),
    verdict: String(row.verdict) as MethodEvaluation["verdict"],
    notes: String(row.notes),
    createdAt: String(row.created_at)
  };
}

function insertMethodEvaluationRow(db: DatabaseSync, evaluation: MethodEvaluation): void {
  db.prepare(
    "INSERT INTO method_evaluations (id, method_id, method_version, baseline_task_ids_json, trial_task_ids_json, baseline_json, trial_json, verdict, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    evaluation.id, evaluation.methodId, evaluation.methodVersion, JSON.stringify(evaluation.baselineTaskIds),
    JSON.stringify(evaluation.trialTaskIds), JSON.stringify(evaluation.baseline), JSON.stringify(evaluation.trial),
    evaluation.verdict, evaluation.notes, evaluation.createdAt
  );
}

function rowToMethodTrial(row: DbRow): MethodTrial {
  return {
    id: String(row.id),
    methodId: String(row.method_id),
    methodVersion: Number(row.method_version),
    taskId: String(row.task_id),
    createdAt: String(row.created_at)
  };
}

function insertMethodTrialRow(db: DatabaseSync, trial: MethodTrial): void {
  db.prepare(
    "INSERT INTO method_trials (id, method_id, method_version, task_id, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(trial.id, trial.methodId, trial.methodVersion, trial.taskId, trial.createdAt);
}

function rowToSyncPeer(row: DbRow): SyncPeer {
  return {
    id: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    status: String(row.status) as SyncPeer["status"],
    tokenHash: String(row.token_hash),
    lastPullSeq: Number(row.last_pull_seq),
    lastPullAt: row.last_pull_at == null ? null : String(row.last_pull_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function upsertSyncPeer(db: DatabaseSync, peer: SyncPeer & { tokenCipher?: string | null; remoteInstanceId?: string | null }): void {
  db.prepare(
    "INSERT INTO sync_peers (id, name, base_url, status, token_hash, last_pull_seq, last_pull_at, last_error, token_cipher, remote_instance_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, status=excluded.status, token_hash=excluded.token_hash, last_pull_seq=excluded.last_pull_seq, last_pull_at=excluded.last_pull_at, last_error=excluded.last_error, token_cipher=COALESCE(excluded.token_cipher, sync_peers.token_cipher), remote_instance_id=COALESCE(excluded.remote_instance_id, sync_peers.remote_instance_id), updated_at=excluded.updated_at"
  ).run(
    peer.id, peer.name, peer.baseUrl, peer.status, peer.tokenHash, peer.lastPullSeq, peer.lastPullAt, peer.lastError,
    peer.tokenCipher ?? null, peer.remoteInstanceId ?? null, peer.createdAt, peer.updatedAt
  );
}

function rowToSyncConflict(row: DbRow): SyncConflict {
  return {
    id: String(row.id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    localUpdatedAt: row.local_updated_at == null ? null : String(row.local_updated_at),
    remoteUpdatedAt: row.remote_updated_at == null ? null : String(row.remote_updated_at),
    localPayload: JSON.parse(String(row.local_payload_json)),
    remotePayload: JSON.parse(String(row.remote_payload_json)),
    status: String(row.status) as SyncConflict["status"],
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at == null ? null : String(row.resolved_at)
  };
}

function upsertSyncConflict(db: DatabaseSync, conflict: SyncConflict): void {
  db.prepare(
    "INSERT INTO sync_conflicts (id, entity_type, entity_id, local_updated_at, remote_updated_at, local_payload_json, remote_payload_json, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, resolved_at=excluded.resolved_at"
  ).run(
    conflict.id, conflict.entityType, conflict.entityId, conflict.localUpdatedAt, conflict.remoteUpdatedAt,
    JSON.stringify(conflict.localPayload), JSON.stringify(conflict.remotePayload), conflict.status, conflict.createdAt, conflict.resolvedAt
  );
}

function rowToTaskLease(row: DbRow): TaskLease {
  return {
    taskId: String(row.task_id),
    ownerInstanceId: String(row.owner_instance_id),
    ownerDeviceId: row.owner_device_id == null ? null : String(row.owner_device_id),
    epoch: Number(row.epoch),
    expiresAt: String(row.expires_at),
    heartbeatAt: String(row.heartbeat_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToBackupRecord(row: DbRow): BackupRecord {
  return {
    id: String(row.id),
    kind: String(row.kind),
    path: String(row.path),
    bytes: Number(row.bytes),
    sha256: String(row.sha256),
    createdAt: String(row.created_at)
  };
}

function rowToMaintenanceRun(row: DbRow): MaintenanceRun {
  return {
    id: String(row.id),
    startedAt: String(row.started_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
    status: String(row.status) as MaintenanceRun["status"],
    actions: JSON.parse(String(row.actions_json)) as Record<string, number>,
    error: row.error == null ? null : String(row.error)
  };
}

function upsertTaskLease(db: DatabaseSync, lease: TaskLease): void {
  db.prepare(
    "INSERT INTO task_leases (task_id, owner_instance_id, owner_device_id, epoch, expires_at, heartbeat_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET owner_instance_id=excluded.owner_instance_id, owner_device_id=excluded.owner_device_id, epoch=excluded.epoch, expires_at=excluded.expires_at, heartbeat_at=excluded.heartbeat_at, updated_at=excluded.updated_at"
  ).run(
    lease.taskId, lease.ownerInstanceId, lease.ownerDeviceId, lease.epoch, lease.expiresAt,
    lease.heartbeatAt, lease.createdAt, lease.updatedAt
  );
}

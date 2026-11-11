import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  AppMeta,
  ApprovalRecord,
  ApprovalStatus,
  ArtifactRecord,
  AttentionFeedbackRecord,
  AttentionItem,
  BackgroundToolJob,
  BackupRecord,
  ChannelCursor,
  ChannelDeliveryRecord,
  ChatMessageRecord,
  ConversationRecord,
  ConversationSettings,
  ConversationSettingsPatch,
  ContextItem,
  ContextItemPage,
  ContextPack,
  ContextPackItem,
  ConnectionOutboxItem,
  ConnectionSession,
  ContextSettings,
  DesktopCommandRecord,
  DesktopFrameRecord,
  DesktopSessionRecord,
  DelegationJob,
  DecisionRecord,
  CommitmentRecord,
  DevicePairingRequest,
  DeviceRecord,
  EffectRecord,
  EffectStatus,
  EventEnvelope,
  ExecutorModelBinding,
  GoalContract,
  GoalCompletionReport,
  HandoffRecord,
  EntityAliasRecord,
  EntityRecord,
  EntityStateRecord,
  IntakeDecisionRecord,
  MemoryConflict,
  MemoryConsolidationRun,
  MemoryForgetReceipt,
  MemoryForgetTombstone,
  MemoryRecall,
  MemoryRecord,
  MemoryEntityLink,
  MemorySettings,
  MemoryVersion,
  MethodApplication,
  MethodCandidate,
  MethodEvaluation,
  MethodTrial,
  MaintenanceRun,
  LocalProject,
  OutboxDraft,
  ModelProfileRecord,
  ProactiveSettings,
  ProactiveSuggestion,
  HeartbeatRun,
  ReconcileItem,
  ReconcileStatus,
  RelationRecord,
  RunCheckpointRecord,
  RunRecord,
  RunStatus,
  RunUsage,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleRunStatus,
  SettingsMigrationRecord,
  SkillCuratorRun,
  SkillRecord,
  SkillUsageEvent,
  SkillVersion,
  StandingIntentRecord,
  SourceConnection,
  SourceItem,
  SyncConflict,
  SyncPeer,
  TaskLease,
  TaskContextState,
  TaskFollowUpRecord,
  TaskProposalRecord,
  TaskRecord,
  TaskEdge,
  TaskStatus,
  TrashKind,
  TrashItem,
  MentionRecord,
  PreparedActionRecord,
  ThreadSubscriptionRecord,
  WatchdogEvent
} from "@hearth/core";
import {
  APPROVAL_STATUSES,
  DEFAULT_CONTEXT_SETTINGS,
  EFFECT_STATUSES,
  RUN_STATUSES,
  TASK_STATUSES,
  defaultConversationSettings,
  mergeConversationSettings
} from "@hearth/core";

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

export const CURRENT_SCHEMA_VERSION = 31;

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
  id TEXT PRIMARY KEY, external_ref TEXT UNIQUE, request_hash TEXT,
  goal_id TEXT,
  template_id TEXT, title TEXT NOT NULL, goal TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deadline TEXT, inputs_json TEXT NOT NULL, network_hosts_json TEXT NOT NULL,
  output_dir TEXT NOT NULL, current_run_id TEXT, next_action TEXT, error_json TEXT,
  result_summary TEXT, conversation_id TEXT, executor_id TEXT, task_kind TEXT,
  expected_outputs_json TEXT, permissions_json TEXT, pending_input TEXT,
  method_id TEXT, method_version INTEGER, pinned_at TEXT, archived_at TEXT,
  budget_override_json TEXT, deleted_at TEXT, trash_batch_id TEXT
);
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, objective TEXT NOT NULL,
  constraints_json TEXT NOT NULL, forbidden_actions_json TEXT NOT NULL,
  authority_sources_json TEXT NOT NULL, success_criteria_json TEXT NOT NULL,
  evidence_requirements_json TEXT NOT NULL, budget_json TEXT NOT NULL,
  deadline TEXT, stop_conditions_json TEXT NOT NULL, review_policy TEXT NOT NULL,
  current_state TEXT NOT NULL, next_handoff TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS goal_completion_reports (
  goal_id TEXT NOT NULL, task_id TEXT NOT NULL, verdict TEXT NOT NULL, summary TEXT NOT NULL,
  criteria_json TEXT NOT NULL, evidence_refs_json TEXT NOT NULL, missing_evidence_json TEXT NOT NULL,
  forbidden_actions_json TEXT NOT NULL, checked_at TEXT NOT NULL,
  PRIMARY KEY (goal_id, task_id, checked_at)
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  settings_json TEXT, deleted_at TEXT, trash_batch_id TEXT
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, task_id TEXT, attachments_json TEXT NOT NULL,
  created_at TEXT NOT NULL, kind TEXT, task_status TEXT
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
  permissions_json TEXT NOT NULL, inputs_json TEXT, reason TEXT NOT NULL, status TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS task_follow_ups (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, conversation_id TEXT,
  content TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
  applied_run_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_checkpoints (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, usage_json TEXT,
  created_at TEXT NOT NULL, proof_json TEXT, UNIQUE(run_id, seq)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL,
  summary TEXT NOT NULL, target_json TEXT NOT NULL, preview_json TEXT NOT NULL,
  parameter_hash TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL,
  decided_at TEXT, effect_id TEXT, created_at TEXT NOT NULL,
  goal_id TEXT, action_digest TEXT, permission_mode TEXT, context TEXT,
  max_uses INTEGER, used_count INTEGER, approved_by TEXT, issued_at TEXT,
  revoked_at TEXT, action_json TEXT, rejection_count INTEGER
);
CREATE TABLE IF NOT EXISTS effects (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, approval_id TEXT NOT NULL, kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, target_json TEXT NOT NULL,
  receipt_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  goal_id TEXT, effect_type TEXT, replay_policy TEXT, action_digest TEXT,
  resolved_action_digest TEXT, attempt_count INTEGER, max_attempts INTEGER,
  lease_owner TEXT, lease_expires_at TEXT, available_at TEXT, provider TEXT,
  provider_ref TEXT, reconcile_ref TEXT, reconciled_at TEXT, target_key TEXT,
  suspend_reason TEXT
);
CREATE TABLE IF NOT EXISTS reconcile_queue (
  id TEXT PRIMARY KEY, effect_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL,
  goal_id TEXT, target_key TEXT, summary TEXT NOT NULL, status TEXT NOT NULL,
  reason TEXT NOT NULL, attempted_json TEXT NOT NULL, risk TEXT NOT NULL,
  suggested_actions_json TEXT NOT NULL, provider TEXT, check_count INTEGER NOT NULL,
  resolution_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT
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
  last_recalled_at TEXT, recall_count INTEGER NOT NULL,
  tier TEXT NOT NULL DEFAULT 'episodic', origin_class TEXT NOT NULL DEFAULT 'agent',
  source_kind TEXT NOT NULL DEFAULT 'system', source_ref TEXT NOT NULL DEFAULT '', session_id TEXT,
  trust TEXT NOT NULL DEFAULT 'medium', taint TEXT NOT NULL DEFAULT 'clean',
  importance REAL NOT NULL DEFAULT 0.5, retention TEXT NOT NULL DEFAULT '30d',
  supersession_key TEXT, content_hash TEXT NOT NULL DEFAULT '', last_verified_at TEXT, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, version INTEGER NOT NULL,
  content TEXT NOT NULL, status TEXT NOT NULL, source_json TEXT NOT NULL,
  confidence TEXT NOT NULL, sensitivity TEXT NOT NULL, allow_recall INTEGER NOT NULL,
  scope TEXT NOT NULL, tags_json TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'episodic', origin_class TEXT NOT NULL DEFAULT 'agent',
  source_kind TEXT NOT NULL DEFAULT 'system', source_ref TEXT NOT NULL DEFAULT '', session_id TEXT,
  trust TEXT NOT NULL DEFAULT 'medium', taint TEXT NOT NULL DEFAULT 'clean',
  importance REAL NOT NULL DEFAULT 0.5, retention TEXT NOT NULL DEFAULT '30d',
  supersession_key TEXT, content_hash TEXT NOT NULL DEFAULT '', last_verified_at TEXT, expires_at TEXT,
  UNIQUE(memory_id, version)
);
CREATE TABLE IF NOT EXISTS memory_conflicts (
  id TEXT PRIMARY KEY, subject_key TEXT NOT NULL, memory_ids_json TEXT NOT NULL,
  status TEXT NOT NULL, resolution TEXT, note TEXT NOT NULL,
  created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS memory_recalls (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT,
  lane TEXT NOT NULL DEFAULT 'on_demand', reason TEXT NOT NULL, score REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_forget_receipts (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, affected_memory_ids_json TEXT NOT NULL,
  reason TEXT NOT NULL, redacted_versions INTEGER NOT NULL, redacted_events INTEGER NOT NULL,
  targets_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_forget_tombstones (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, content_hash TEXT NOT NULL,
  subject_key TEXT NOT NULL, source_kind TEXT NOT NULL, source_ref TEXT NOT NULL,
  reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_consolidation_runs (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, dry_run INTEGER NOT NULL, scope TEXT,
  groups_json TEXT NOT NULL, sources_json TEXT NOT NULL, applied_memory_ids_json TEXT NOT NULL,
  skipped_json TEXT NOT NULL, error TEXT, report TEXT NOT NULL,
  started_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS context_items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT,
  task_id TEXT NOT NULL,
  run_id TEXT,
  executor_id TEXT,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  content_ref TEXT,
  sha256 TEXT,
  tokens INTEGER NOT NULL,
  sensitivity TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  parent_id TEXT,
  executor_event_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_context_state (
  task_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  completed_json TEXT NOT NULL,
  failed_json TEXT NOT NULL,
  artifacts_json TEXT NOT NULL,
  open_questions_json TEXT NOT NULL,
  last_failure_json TEXT,
  handoff_count INTEGER NOT NULL,
  summary_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  from_run_id TEXT NOT NULL,
  to_run_id TEXT,
  from_executor TEXT NOT NULL,
  to_executor TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  source_cursor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  diagnosis_json TEXT,
  packet_json TEXT,
  verification_json TEXT,
  artifact_ref TEXT,
  context_watermark_seq INTEGER NOT NULL,
  initiated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delegation_jobs (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL,
  parent_run_id TEXT,
  child_task_id TEXT,
  child_run_id TEXT,
  goal_slice TEXT NOT NULL,
  target_executor TEXT NOT NULL,
  context_pack_ref TEXT NOT NULL,
  context_pack_json TEXT NOT NULL,
  workspace_policy TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  tool_policy_json TEXT NOT NULL,
  network_policy_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  deadline TEXT,
  result_schema_ref TEXT,
  status TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL UNIQUE,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  result_json TEXT,
  verification_json TEXT,
  failure_json TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_deliveries (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  direction TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at TEXT,
  processed_at TEXT,
  effect_id TEXT,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(channel, external_id, direction)
);
CREATE TABLE IF NOT EXISTS channel_cursors (
  channel TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  cursor INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(channel, thread_key)
);
CREATE TABLE IF NOT EXISTS context_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  context_window_tokens INTEGER NOT NULL DEFAULT 128000,
  max_output_tokens INTEGER NOT NULL DEFAULT 8000,
  api_key_cipher TEXT,
  is_local INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS executor_model_bindings (
  executor_id TEXT PRIMARY KEY,
  profile_id TEXT,
  protocol_override TEXT,
  model_override TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings_migrations (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  backup_path TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS method_candidates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL, applicability TEXT NOT NULL,
  steps_json TEXT NOT NULL, source_task_ids_json TEXT NOT NULL, template_id TEXT,
  status TEXT NOT NULL, version INTEGER NOT NULL, generation INTEGER, fingerprint TEXT,
  previous_version_id TEXT,
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
CREATE TABLE IF NOT EXISTS method_applications (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
  method_id TEXT NOT NULL, method_version INTEGER NOT NULL,
  selection TEXT NOT NULL, prompt_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, method_id TEXT, method_version INTEGER, name TEXT NOT NULL, version TEXT NOT NULL,
  status TEXT NOT NULL, pinned INTEGER NOT NULL, path TEXT NOT NULL, content_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL, origin TEXT NOT NULL, source_task_ids_json TEXT NOT NULL,
  trial_task_ids_json TEXT NOT NULL DEFAULT '[]',
  previous_version_id TEXT, change_report TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, adopted_at TEXT, last_used_at TEXT, archived_at TEXT,
  archive_reason TEXT, previous_status TEXT
);
CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, version TEXT NOT NULL,
  manifest_json TEXT NOT NULL, content_hash TEXT NOT NULL, path TEXT NOT NULL,
  method_id TEXT, method_version INTEGER, change_report TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_usage_events (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, task_id TEXT, run_id TEXT,
  status TEXT NOT NULL, source TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_curator_runs (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, dry_run INTEGER NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, actions_json TEXT NOT NULL,
  backup_path TEXT, report TEXT NOT NULL, rolled_back_at TEXT
);
CREATE TABLE IF NOT EXISTS standing_intents (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, description TEXT NOT NULL,
  trigger_entries_json TEXT NOT NULL, scope_json TEXT NOT NULL, action TEXT NOT NULL,
  cooldown_seconds INTEGER NOT NULL, max_fires INTEGER NOT NULL, fire_count INTEGER NOT NULL,
  state TEXT NOT NULL, expires_at TEXT NOT NULL, last_fired_at TEXT, last_matched_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attention_items (
  id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  priority INTEGER NOT NULL, critical INTEGER NOT NULL, title TEXT NOT NULL,
  waiting_on TEXT NOT NULL, waiting_since TEXT NOT NULL, next_action TEXT NOT NULL,
  consequence TEXT NOT NULL, why_now TEXT NOT NULL, goal_id TEXT, task_id TEXT,
  intent_id TEXT, source TEXT NOT NULL, status TEXT NOT NULL, snooze_until TEXT,
  entity_id TEXT, evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  options_json TEXT NOT NULL DEFAULT '[]', impact REAL, urgency REAL, confidence REAL,
  reversibility TEXT, blast_radius TEXT, score REAL, aggregation_key TEXT,
  shadowed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS heartbeat_runs (
  id TEXT PRIMARY KEY, decision TEXT NOT NULL, trigger_kinds_json TEXT NOT NULL,
  attention_ids_json TEXT NOT NULL, reason TEXT NOT NULL, started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT NOT NULL,
  timezone TEXT NOT NULL, enabled INTEGER NOT NULL, conversation_id TEXT NOT NULL,
  executor_id TEXT NOT NULL, approval_mode TEXT NOT NULL, task_kind TEXT NOT NULL,
  next_run_at TEXT, last_run_at TEXT, last_task_id TEXT, last_status TEXT,
  catch_up_policy TEXT NOT NULL DEFAULT 'run_once', catch_up_max_runs INTEGER NOT NULL DEFAULT 3,
  priority INTEGER NOT NULL DEFAULT 5, failure_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT, delete_after_run INTEGER NOT NULL DEFAULT 0, paused_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, scheduled_for TEXT NOT NULL,
  task_id TEXT, effect_id TEXT, idempotency_key TEXT, attempt INTEGER NOT NULL DEFAULT 1,
  failure_class TEXT, receipt_json TEXT,
  status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(schedule_id, scheduled_for)
);
CREATE TABLE IF NOT EXISTS connection_sessions (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, user_id TEXT NOT NULL,
  generation INTEGER NOT NULL, cursor INTEGER, scopes_json TEXT NOT NULL,
  pending_scopes_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, last_error TEXT,
  connected_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_heartbeat_at TEXT NOT NULL,
  cursor_at TEXT NOT NULL, disconnected_at TEXT, disconnect_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(device_id, user_id)
);
CREATE TABLE IF NOT EXISTS connection_outbox (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, generation INTEGER NOT NULL,
  device_id TEXT NOT NULL, user_id TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
  effect_id TEXT, result_json TEXT, submitted_at TEXT, committed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(connection_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, canonical_name TEXT NOT NULL,
  status TEXT NOT NULL, sensitivity TEXT NOT NULL DEFAULT 'normal',
  confidence TEXT NOT NULL, merged_into TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entity_aliases (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, alias TEXT NOT NULL,
  normalized TEXT NOT NULL, source_kind TEXT NOT NULL, confidence TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE(entity_id, normalized)
);
CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY, from_entity_id TEXT NOT NULL, predicate TEXT NOT NULL,
  to_entity_id TEXT NOT NULL, confidence TEXT NOT NULL, valid_from TEXT, valid_to TEXT,
  recorded_at TEXT NOT NULL, evidence_refs_json TEXT NOT NULL, superseded_by TEXT
);
CREATE TABLE IF NOT EXISTS entity_states (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
  confidence TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT, recorded_at TEXT NOT NULL,
  source_ref TEXT, evidence_refs_json TEXT NOT NULL, superseded_by TEXT
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, subject_entity_id TEXT, goal_id TEXT, task_id TEXT,
  title TEXT NOT NULL, decision TEXT NOT NULL, rationale TEXT, alternatives_json TEXT NOT NULL,
  decided_by TEXT NOT NULL, decided_at TEXT NOT NULL, status TEXT NOT NULL,
  superseded_by TEXT, evidence_refs_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY, entity_id TEXT, counterparty_entity_id TEXT, goal_id TEXT, task_id TEXT,
  description TEXT NOT NULL, due_at TEXT, status TEXT NOT NULL, confidence TEXT NOT NULL,
  source_ref TEXT, evidence_refs_json TEXT NOT NULL, fulfilled_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mentions (
  id TEXT PRIMARY KEY, surface TEXT NOT NULL, normalized TEXT NOT NULL, entity_id TEXT,
  conversation_id TEXT, task_id TEXT, message_id TEXT, resolution TEXT NOT NULL,
  candidates_json TEXT NOT NULL, confidence REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
  goal_id TEXT, task_id TEXT, conversation_id TEXT, hash TEXT NOT NULL,
  budget_tokens INTEGER NOT NULL, used_tokens INTEGER NOT NULL, omitted_json TEXT NOT NULL,
  parent_pack_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS context_pack_items (
  pack_id TEXT NOT NULL, ref TEXT NOT NULL, lane TEXT NOT NULL, source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, confidence TEXT NOT NULL,
  source TEXT NOT NULL, valid_until TEXT, reason TEXT NOT NULL, score REAL NOT NULL,
  tokens INTEGER NOT NULL, expandable INTEGER NOT NULL, PRIMARY KEY (pack_id, ref)
);
CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id TEXT NOT NULL, entity_id TEXT NOT NULL, relation TEXT NOT NULL,
  PRIMARY KEY (memory_id, entity_id, relation)
);
CREATE TABLE IF NOT EXISTS task_edges (
  parent_task_id TEXT NOT NULL, child_task_id TEXT NOT NULL, kind TEXT NOT NULL,
  join_policy TEXT NOT NULL, required_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, PRIMARY KEY (parent_task_id, child_task_id)
);
CREATE TABLE IF NOT EXISTS prepared_actions (
  id TEXT PRIMARY KEY, task_id TEXT, goal_id TEXT, kind TEXT NOT NULL,
  action_digest TEXT NOT NULL, preview_json TEXT NOT NULL, status TEXT NOT NULL,
  expires_at TEXT, evidence_refs_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_subscriptions (
  id TEXT PRIMARY KEY, thread_key TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT,
  cursor TEXT, filter_json TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(thread_key, task_id)
);
CREATE TABLE IF NOT EXISTS background_tool_jobs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '',
  output_ref TEXT, exit_code INTEGER, stop_reason TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS watchdog_events (
  id TEXT PRIMARY KEY, task_id TEXT, run_id TEXT, reason TEXT NOT NULL, detail TEXT NOT NULL,
  action TEXT NOT NULL, evidence_refs_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attention_feedback (
  id TEXT PRIMARY KEY, attention_id TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
  time_of_day TEXT NOT NULL, channel TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intake_decisions (
  id TEXT PRIMARY KEY, source_ref TEXT NOT NULL, route TEXT NOT NULL, reason TEXT NOT NULL,
  confidence REAL NOT NULL, created_at TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS context_items_task_idx ON context_items(task_id, seq);
CREATE INDEX IF NOT EXISTS context_items_conversation_idx ON context_items(conversation_id, seq);
CREATE INDEX IF NOT EXISTS context_items_run_idx ON context_items(run_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS context_items_executor_event_idx ON context_items(run_id, executor_event_id) WHERE executor_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS handoffs_task_idx ON handoffs(task_id, created_at);
CREATE INDEX IF NOT EXISTS handoffs_generation_idx ON handoffs(task_id, generation);
CREATE INDEX IF NOT EXISTS delegation_jobs_parent_idx ON delegation_jobs(parent_task_id, created_at);
CREATE INDEX IF NOT EXISTS delegation_jobs_status_idx ON delegation_jobs(status, target_executor, created_at);
CREATE INDEX IF NOT EXISTS delegation_jobs_child_idx ON delegation_jobs(child_task_id);
CREATE INDEX IF NOT EXISTS channel_deliveries_thread_idx ON channel_deliveries(channel, thread_key, created_at);
CREATE INDEX IF NOT EXISTS channel_deliveries_status_idx ON channel_deliveries(status, updated_at);
CREATE INDEX IF NOT EXISTS memory_forget_receipts_memory_idx ON memory_forget_receipts(memory_id, created_at);
CREATE INDEX IF NOT EXISTS method_candidates_status_idx ON method_candidates(status, updated_at);
CREATE INDEX IF NOT EXISTS method_evaluations_method_idx ON method_evaluations(method_id, created_at);
CREATE INDEX IF NOT EXISTS method_trials_method_idx ON method_trials(method_id, created_at);
CREATE INDEX IF NOT EXISTS method_applications_task_idx ON method_applications(task_id, created_at);
CREATE INDEX IF NOT EXISTS method_applications_method_idx ON method_applications(method_id, method_version, created_at);
CREATE INDEX IF NOT EXISTS sync_conflicts_status_idx ON sync_conflicts(status, created_at);
CREATE INDEX IF NOT EXISTS task_leases_expiry_idx ON task_leases(expires_at);
CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx ON chat_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS task_proposals_conversation_idx ON task_proposals(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS task_proposals_status_idx ON task_proposals(status, expires_at);
CREATE INDEX IF NOT EXISTS task_follow_ups_task_idx ON task_follow_ups(task_id, created_at);
CREATE INDEX IF NOT EXISTS task_follow_ups_status_idx ON task_follow_ups(task_id, status, created_at);
CREATE INDEX IF NOT EXISTS run_checkpoints_run_idx ON run_checkpoints(run_id, seq);
CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx ON scheduled_jobs(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS scheduled_job_runs_schedule_idx ON scheduled_job_runs(schedule_id, scheduled_for);
CREATE INDEX IF NOT EXISTS connection_sessions_status_idx ON connection_sessions(status, updated_at);
CREATE INDEX IF NOT EXISTS connection_outbox_connection_idx ON connection_outbox(connection_id, generation, status, created_at);
CREATE INDEX IF NOT EXISTS entities_kind_name_idx ON entities(kind, canonical_name);
CREATE INDEX IF NOT EXISTS aliases_normalized_idx ON entity_aliases(normalized);
CREATE INDEX IF NOT EXISTS relations_from_idx ON relations(from_entity_id, predicate);
CREATE INDEX IF NOT EXISTS relations_to_idx ON relations(to_entity_id, predicate);
CREATE INDEX IF NOT EXISTS states_entity_key_idx ON entity_states(entity_id, key, valid_to);
CREATE INDEX IF NOT EXISTS commitments_status_due_idx ON commitments(status, due_at);
CREATE INDEX IF NOT EXISTS mentions_surface_idx ON mentions(normalized);
CREATE INDEX IF NOT EXISTS packs_scope_idx ON context_packs(scope_kind, scope_id, created_at);
CREATE INDEX IF NOT EXISTS context_pack_items_source_idx ON context_pack_items(source_kind, source_id);
CREATE INDEX IF NOT EXISTS task_edges_child_idx ON task_edges(child_task_id, parent_task_id);
CREATE INDEX IF NOT EXISTS prepared_actions_status_idx ON prepared_actions(status, expires_at);
CREATE INDEX IF NOT EXISTS thread_subscriptions_thread_idx ON thread_subscriptions(thread_key, status);
CREATE INDEX IF NOT EXISTS background_tool_jobs_status_idx ON background_tool_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS watchdog_events_created_idx ON watchdog_events(created_at);
CREATE INDEX IF NOT EXISTS attention_feedback_kind_idx ON attention_feedback(kind, time_of_day, created_at);
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

  getSkill(id: string): SkillRecord | null {
    const row = this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToSkill(row) : null;
  }

  getLocalProject(id: string): LocalProject | null {
    const row = this.db.prepare("SELECT * FROM local_projects WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToLocalProject(row) : null;
  }

  listLocalProjects(): LocalProject[] {
    return (this.db.prepare("SELECT * FROM local_projects ORDER BY created_at ASC").all() as DbRow[])
      .map(rowToLocalProject);
  }

  upsertLocalProject(project: LocalProject): LocalProject {
    this.db.prepare(
      `INSERT INTO local_projects (id, name, path, default_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, path=excluded.path,
         default_branch=excluded.default_branch, updated_at=excluded.updated_at`
    ).run(project.id, project.name, project.path, project.defaultBranch, project.createdAt, project.updatedAt);
    return project;
  }

  deleteLocalProject(id: string): void {
    this.db.prepare("DELETE FROM local_projects WHERE id = ?").run(id);
  }

  listSkills(status?: string): SkillRecord[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM skills WHERE status = ? ORDER BY pinned DESC, updated_at DESC").all(status) as DbRow[]
      : this.db.prepare("SELECT * FROM skills ORDER BY pinned DESC, updated_at DESC").all() as DbRow[];
    return rows.map(rowToSkill);
  }

  listSkillVersions(skillId?: string): SkillVersion[] {
    const rows = skillId
      ? this.db.prepare("SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY created_at DESC").all(skillId) as DbRow[]
      : this.db.prepare("SELECT * FROM skill_versions ORDER BY created_at DESC").all() as DbRow[];
    return rows.map(rowToSkillVersion);
  }

  listSkillUsage(skillId?: string, limit = 100): SkillUsageEvent[] {
    const rows = skillId
      ? this.db.prepare("SELECT * FROM skill_usage_events WHERE skill_id = ? ORDER BY created_at DESC LIMIT ?").all(skillId, limit) as DbRow[]
      : this.db.prepare("SELECT * FROM skill_usage_events ORDER BY created_at DESC LIMIT ?").all(limit) as DbRow[];
    return rows.map(rowToSkillUsage);
  }

  getSkillCuratorRun(id: string): SkillCuratorRun | null {
    const row = this.db.prepare("SELECT * FROM skill_curator_runs WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToSkillCuratorRun(row) : null;
  }

  listSkillCuratorRuns(limit = 50): SkillCuratorRun[] {
    const rows = this.db.prepare("SELECT * FROM skill_curator_runs ORDER BY started_at DESC LIMIT ?").all(limit) as DbRow[];
    return rows.map(rowToSkillCuratorRun);
  }

  upsertSkillCuratorRun(run: SkillCuratorRun): SkillCuratorRun {
    upsertSkillCuratorRunRow(this.db, run);
    return run;
  }

  latestEventCreatedAt(): string | null {
    const row = this.db.prepare("SELECT created_at FROM events ORDER BY seq DESC LIMIT 1").get() as DbRow | undefined;
    return row ? String(row.created_at) : null;
  }

  getStandingIntent(id: string): StandingIntentRecord | null {
    const row = this.db.prepare("SELECT * FROM standing_intents WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToStandingIntent(row) : null;
  }

  listStandingIntents(state?: string): StandingIntentRecord[] {
    const rows = state
      ? this.db.prepare("SELECT * FROM standing_intents WHERE state = ? ORDER BY created_at DESC").all(state) as DbRow[]
      : this.db.prepare("SELECT * FROM standing_intents ORDER BY created_at DESC").all() as DbRow[];
    return rows.map(rowToStandingIntent);
  }

  upsertStandingIntent(intent: StandingIntentRecord): StandingIntentRecord {
    upsertStandingIntentRow(this.db, intent);
    return intent;
  }

  getAttentionItem(id: string): AttentionItem | null {
    const row = this.db.prepare("SELECT * FROM attention_items WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToAttentionItem(row) : null;
  }

  findOpenAttentionByDedupe(dedupeKey: string): AttentionItem | null {
    const row = this.db.prepare("SELECT * FROM attention_items WHERE dedupe_key = ? AND status IN ('open','snoozed')").get(dedupeKey) as DbRow | undefined;
    return row ? rowToAttentionItem(row) : null;
  }

  listAttentionItems(opts: { status?: string; limit?: number } = {}): AttentionItem[] {
    const rows = opts.status
      ? this.db.prepare("SELECT * FROM attention_items WHERE status = ? ORDER BY priority ASC, waiting_since ASC LIMIT ?").all(opts.status, opts.limit ?? 200) as DbRow[]
      : this.db.prepare("SELECT * FROM attention_items ORDER BY priority ASC, waiting_since ASC LIMIT ?").all(opts.limit ?? 200) as DbRow[];
    return rows.map(rowToAttentionItem);
  }

  upsertAttentionItem(item: AttentionItem): AttentionItem {
    upsertAttentionItemRow(this.db, item);
    return item;
  }

  insertHeartbeatRun(run: HeartbeatRun): HeartbeatRun {
    upsertHeartbeatRunRow(this.db, run);
    return run;
  }

  listHeartbeatRuns(limit = 50): HeartbeatRun[] {
    const rows = this.db.prepare("SELECT * FROM heartbeat_runs ORDER BY started_at DESC LIMIT ?").all(limit) as DbRow[];
    return rows.map(rowToHeartbeatRun);
  }

  latestHeartbeatRun(): HeartbeatRun | null {
    return this.listHeartbeatRuns(1)[0] ?? null;
  }

  getEntity(id: string): EntityRecord | null {
    const row = this.db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  listEntities(opts: { kind?: string; status?: string; limit?: number } = {}): EntityRecord[] {
    const filters: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.kind) { filters.push("kind = ?"); params.push(opts.kind); }
    if (opts.status) { filters.push("status = ?"); params.push(opts.status); }
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM entities${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, opts.limit ?? 500) as DbRow[];
    return rows.map(rowToEntity);
  }

  findEntitiesByName(name: string, kind?: string): EntityRecord[] {
    const normalized = normalizeOntologyText(name);
    const rows = kind
      ? this.db.prepare("SELECT * FROM entities WHERE kind = ? AND lower(canonical_name) = ? ORDER BY updated_at DESC").all(kind, normalized) as DbRow[]
      : this.db.prepare("SELECT * FROM entities WHERE lower(canonical_name) = ? ORDER BY updated_at DESC").all(normalized) as DbRow[];
    return rows.map(rowToEntity);
  }

  findEntitiesByAlias(normalized: string, kind?: string): EntityRecord[] {
    const rows = kind
      ? this.db.prepare(`SELECT e.* FROM entities e JOIN entity_aliases a ON a.entity_id = e.id
          WHERE a.normalized = ? AND e.kind = ? AND e.status = 'active' ORDER BY a.created_at DESC`).all(normalized, kind) as DbRow[]
      : this.db.prepare(`SELECT e.* FROM entities e JOIN entity_aliases a ON a.entity_id = e.id
          WHERE a.normalized = ? AND e.status = 'active' ORDER BY a.created_at DESC`).all(normalized) as DbRow[];
    return rows.map(rowToEntity);
  }

  upsertEntity(entity: EntityRecord): EntityRecord {
    upsertEntityRow(this.db, entity);
    return entity;
  }

  getEntityAlias(id: string): EntityAliasRecord | null {
    const row = this.db.prepare("SELECT * FROM entity_aliases WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToEntityAlias(row) : null;
  }

  listEntityAliases(entityId?: string): EntityAliasRecord[] {
    const rows = entityId
      ? this.db.prepare("SELECT * FROM entity_aliases WHERE entity_id = ? ORDER BY created_at").all(entityId) as DbRow[]
      : this.db.prepare("SELECT * FROM entity_aliases ORDER BY created_at").all() as DbRow[];
    return rows.map(rowToEntityAlias);
  }

  upsertEntityAlias(alias: EntityAliasRecord): EntityAliasRecord {
    upsertEntityAliasRow(this.db, alias);
    return alias;
  }

  listRelations(opts: { fromEntityId?: string; toEntityId?: string; predicate?: string; activeOnly?: boolean; limit?: number } = {}): RelationRecord[] {
    const filters: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.fromEntityId) { filters.push("from_entity_id = ?"); params.push(opts.fromEntityId); }
    if (opts.toEntityId) { filters.push("to_entity_id = ?"); params.push(opts.toEntityId); }
    if (opts.predicate) { filters.push("predicate = ?"); params.push(opts.predicate); }
    if (opts.activeOnly) filters.push("valid_to IS NULL AND superseded_by IS NULL");
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM relations${where} ORDER BY recorded_at DESC LIMIT ?`)
      .all(...params, opts.limit ?? 500) as DbRow[];
    return rows.map(rowToRelation);
  }

  upsertRelation(relation: RelationRecord): RelationRecord {
    upsertRelationRow(this.db, relation);
    return relation;
  }

  getEntityState(id: string): EntityStateRecord | null {
    const row = this.db.prepare("SELECT * FROM entity_states WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToEntityState(row) : null;
  }

  listEntityStates(opts: { entityId?: string; key?: string; activeOnly?: boolean; limit?: number } = {}): EntityStateRecord[] {
    const filters: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.entityId) { filters.push("entity_id = ?"); params.push(opts.entityId); }
    if (opts.key) { filters.push("key = ?"); params.push(opts.key); }
    if (opts.activeOnly) filters.push("valid_to IS NULL AND superseded_by IS NULL");
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM entity_states${where} ORDER BY valid_from DESC LIMIT ?`)
      .all(...params, opts.limit ?? 500) as DbRow[];
    return rows.map(rowToEntityState);
  }

  upsertEntityState(state: EntityStateRecord): EntityStateRecord {
    upsertEntityStateRow(this.db, state);
    return state;
  }

  getDecision(id: string): DecisionRecord | null {
    const row = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToDecision(row) : null;
  }

  listDecisions(opts: { status?: string; goalId?: string; taskId?: string; subjectEntityId?: string; limit?: number } = {}): DecisionRecord[] {
    const filters: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.status) { filters.push("status = ?"); params.push(opts.status); }
    if (opts.goalId) { filters.push("goal_id = ?"); params.push(opts.goalId); }
    if (opts.taskId) { filters.push("task_id = ?"); params.push(opts.taskId); }
    if (opts.subjectEntityId) { filters.push("subject_entity_id = ?"); params.push(opts.subjectEntityId); }
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM decisions${where} ORDER BY decided_at DESC LIMIT ?`)
      .all(...params, opts.limit ?? 200) as DbRow[];
    return rows.map(rowToDecision);
  }

  upsertDecision(decision: DecisionRecord): DecisionRecord {
    upsertDecisionRow(this.db, decision);
    return decision;
  }

  getCommitment(id: string): CommitmentRecord | null {
    const row = this.db.prepare("SELECT * FROM commitments WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToCommitment(row) : null;
  }

  listCommitments(opts: { status?: string; dueBefore?: string; goalId?: string; taskId?: string; limit?: number } = {}): CommitmentRecord[] {
    const filters: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.status) { filters.push("status = ?"); params.push(opts.status); }
    if (opts.dueBefore) { filters.push("due_at IS NOT NULL AND due_at <= ?"); params.push(opts.dueBefore); }
    if (opts.goalId) { filters.push("goal_id = ?"); params.push(opts.goalId); }
    if (opts.taskId) { filters.push("task_id = ?"); params.push(opts.taskId); }
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM commitments${where} ORDER BY due_at IS NULL, due_at ASC LIMIT ?`)
      .all(...params, opts.limit ?? 200) as DbRow[];
    return rows.map(rowToCommitment);
  }

  upsertCommitment(commitment: CommitmentRecord): CommitmentRecord {
    upsertCommitmentRow(this.db, commitment);
    return commitment;
  }

  recordMention(mention: MentionRecord): MentionRecord {
    upsertMentionRow(this.db, mention);
    return mention;
  }

  listMentions(opts: { conversationId?: string; taskId?: string; normalized?: string; limit?: number } = {}): MentionRecord[] {
    const filters: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.conversationId) { filters.push("conversation_id = ?"); params.push(opts.conversationId); }
    if (opts.taskId) { filters.push("task_id = ?"); params.push(opts.taskId); }
    if (opts.normalized) { filters.push("normalized = ?"); params.push(opts.normalized); }
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM mentions${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, opts.limit ?? 500) as DbRow[];
    return rows.map(rowToMention);
  }

  saveContextPack(pack: ContextPack): ContextPack {
    upsertContextPackRow(this.db, pack);
    return pack;
  }

  getContextPack(id: string): ContextPack | null {
    const row = this.db.prepare("SELECT * FROM context_packs WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return null;
    return { ...rowToContextPack(row), items: this.listContextPackItems(id) };
  }

  findContextPackByHash(hash: string): ContextPack | null {
    const row = this.db.prepare("SELECT * FROM context_packs WHERE hash = ? ORDER BY created_at DESC LIMIT 1").get(hash) as DbRow | undefined;
    if (!row) return null;
    return { ...rowToContextPack(row), items: this.listContextPackItems(String(row.id)) };
  }

  listContextPacks(opts: { scopeKind?: string; scopeId?: string; limit?: number } = {}): ContextPack[] {
    const filters: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.scopeKind) { filters.push("scope_kind = ?"); params.push(opts.scopeKind); }
    if (opts.scopeId) { filters.push("scope_id = ?"); params.push(opts.scopeId); }
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM context_packs${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, opts.limit ?? 100) as DbRow[];
    return rows.map((row) => ({ ...rowToContextPack(row), items: this.listContextPackItems(String(row.id)) }));
  }

  listContextPackItems(packId: string): ContextPackItem[] {
    const rows = this.db.prepare("SELECT * FROM context_pack_items WHERE pack_id = ? ORDER BY lane, score DESC").all(packId) as DbRow[];
    return rows.map(rowToContextPackItem);
  }

  invalidateContextPacksForEvidence(evidenceRef: string): number {
    const packs = this.db.prepare("SELECT DISTINCT pack_id FROM context_pack_items WHERE source_id = ?").all(evidenceRef) as DbRow[];
    for (const row of packs) {
      this.db.prepare("UPDATE context_packs SET hash = ?, omitted_json = ? WHERE id = ?")
        .run(`${String(row.pack_id)}:invalidated:${Date.now()}`, JSON.stringify([`证据 ${evidenceRef} 已遗忘`]), String(row.pack_id));
    }
    return packs.length;
  }

  linkMemoryEntity(link: MemoryEntityLink): MemoryEntityLink {
    this.db.prepare("INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, relation) VALUES (?, ?, ?)")
      .run(link.memoryId, link.entityId, link.relation);
    return link;
  }

  listMemoryEntityLinks(opts: { memoryId?: string; entityId?: string } = {}): MemoryEntityLink[] {
    const rows = opts.memoryId
      ? this.db.prepare("SELECT * FROM memory_entities WHERE memory_id = ?").all(opts.memoryId) as DbRow[]
      : opts.entityId
        ? this.db.prepare("SELECT * FROM memory_entities WHERE entity_id = ?").all(opts.entityId) as DbRow[]
        : this.db.prepare("SELECT * FROM memory_entities").all() as DbRow[];
    return rows.map((row) => ({
      memoryId: String(row.memory_id),
      entityId: String(row.entity_id),
      relation: String(row.relation) as MemoryEntityLink["relation"]
    }));
  }

  upsertTaskEdge(edge: TaskEdge): TaskEdge {
    upsertTaskEdgeRow(this.db, edge);
    return edge;
  }

  listTaskEdges(opts: { parentTaskId?: string; childTaskId?: string } = {}): TaskEdge[] {
    const rows = opts.parentTaskId
      ? this.db.prepare("SELECT * FROM task_edges WHERE parent_task_id = ? ORDER BY created_at").all(opts.parentTaskId) as DbRow[]
      : opts.childTaskId
        ? this.db.prepare("SELECT * FROM task_edges WHERE child_task_id = ? ORDER BY created_at").all(opts.childTaskId) as DbRow[]
        : this.db.prepare("SELECT * FROM task_edges ORDER BY created_at").all() as DbRow[];
    return rows.map(rowToTaskEdge);
  }

  upsertPreparedAction(action: PreparedActionRecord): PreparedActionRecord {
    upsertPreparedActionRow(this.db, action);
    return action;
  }

  getPreparedAction(id: string): PreparedActionRecord | null {
    const row = this.db.prepare("SELECT * FROM prepared_actions WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToPreparedAction(row) : null;
  }

  listPreparedActions(opts: { taskId?: string; status?: string; limit?: number } = {}): PreparedActionRecord[] {
    const filters: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.taskId) { filters.push("task_id = ?"); params.push(opts.taskId); }
    if (opts.status) { filters.push("status = ?"); params.push(opts.status); }
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM prepared_actions${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, opts.limit ?? 100) as DbRow[];
    return rows.map(rowToPreparedAction);
  }

  upsertThreadSubscription(subscription: ThreadSubscriptionRecord): ThreadSubscriptionRecord {
    upsertThreadSubscriptionRow(this.db, subscription);
    return subscription;
  }

  listThreadSubscriptions(opts: { threadKey?: string; taskId?: string; status?: string } = {}): ThreadSubscriptionRecord[] {
    const filters: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.threadKey) { filters.push("thread_key = ?"); params.push(opts.threadKey); }
    if (opts.taskId) { filters.push("task_id = ?"); params.push(opts.taskId); }
    if (opts.status) { filters.push("status = ?"); params.push(opts.status); }
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM thread_subscriptions${where} ORDER BY updated_at DESC`).all(...params) as DbRow[];
    return rows.map(rowToThreadSubscription);
  }

  getBackgroundToolJob(id: string): BackgroundToolJob | null {
    const row = this.db.prepare("SELECT * FROM background_tool_jobs WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToBackgroundToolJob(row) : null;
  }

  listBackgroundToolJobs(opts: { taskId?: string; runId?: string; status?: string; limit?: number } = {}): BackgroundToolJob[] {
    const filters: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.taskId) { filters.push("task_id = ?"); params.push(opts.taskId); }
    if (opts.runId) { filters.push("run_id = ?"); params.push(opts.runId); }
    if (opts.status) { filters.push("status = ?"); params.push(opts.status); }
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM background_tool_jobs${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, opts.limit ?? 200) as DbRow[];
    return rows.map(rowToBackgroundToolJob);
  }

  upsertBackgroundToolJob(job: BackgroundToolJob): BackgroundToolJob {
    upsertBackgroundToolJobRow(this.db, job);
    return job;
  }

  recordWatchdogEvent(event: WatchdogEvent): WatchdogEvent {
    upsertWatchdogEventRow(this.db, event);
    return event;
  }

  listWatchdogEvents(opts: { taskId?: string; limit?: number } = {}): WatchdogEvent[] {
    const rows = opts.taskId
      ? this.db.prepare("SELECT * FROM watchdog_events WHERE task_id = ? ORDER BY created_at DESC LIMIT ?").all(opts.taskId, opts.limit ?? 200) as DbRow[]
      : this.db.prepare("SELECT * FROM watchdog_events ORDER BY created_at DESC LIMIT ?").all(opts.limit ?? 200) as DbRow[];
    return rows.map(rowToWatchdogEvent);
  }

  recordAttentionFeedback(feedback: AttentionFeedbackRecord): AttentionFeedbackRecord {
    this.db.prepare(`INSERT INTO attention_feedback
      (id, attention_id, kind, action, time_of_day, channel, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET action=excluded.action, time_of_day=excluded.time_of_day, channel=excluded.channel`)
      .run(feedback.id, feedback.attentionId, feedback.kind, feedback.action, feedback.timeOfDay, feedback.channel, feedback.createdAt);
    return feedback;
  }

  listAttentionFeedback(opts: { attentionId?: string; kind?: string; since?: string; limit?: number } = {}): AttentionFeedbackRecord[] {
    const filters: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.attentionId) { filters.push("attention_id = ?"); params.push(opts.attentionId); }
    if (opts.kind) { filters.push("kind = ?"); params.push(opts.kind); }
    if (opts.since) { filters.push("created_at >= ?"); params.push(opts.since); }
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM attention_feedback${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, opts.limit ?? 500) as DbRow[];
    return rows.map(rowToAttentionFeedback);
  }

  recordIntakeDecision(decision: IntakeDecisionRecord): IntakeDecisionRecord {
    this.db.prepare(`INSERT INTO intake_decisions (id, source_ref, route, reason, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET route=excluded.route, reason=excluded.reason,
      confidence=excluded.confidence`).run(decision.id, decision.sourceRef, decision.route, decision.reason, decision.confidence, decision.createdAt);
    return decision;
  }

  listIntakeDecisions(limit = 200): IntakeDecisionRecord[] {
    return (this.db.prepare("SELECT * FROM intake_decisions ORDER BY created_at DESC LIMIT ?").all(limit) as DbRow[]).map(rowToIntakeDecision);
  }

  forgetOntologyEvidence(evidenceRef: string, now = new Date().toISOString()): {
    relations: number; states: number; decisions: number; commitments: number; mentions: number; packs: number; entities: number;
  } {
    const affected = this.db.prepare("SELECT DISTINCT entity_id, id FROM entity_states WHERE evidence_refs_json LIKE ?").all(`%${evidenceRef}%`) as DbRow[];
    const relations = Number(this.db.prepare("UPDATE relations SET valid_to = ?, superseded_by = 'forgotten' WHERE evidence_refs_json LIKE ? AND valid_to IS NULL").run(now, `%${evidenceRef}%`).changes);
    const states = Number(this.db.prepare("UPDATE entity_states SET valid_to = ?, superseded_by = 'forgotten', confidence = 'stale' WHERE evidence_refs_json LIKE ? AND valid_to IS NULL").run(now, `%${evidenceRef}%`).changes);
    const decisions = Number(this.db.prepare("UPDATE decisions SET status = 'revoked' WHERE evidence_refs_json LIKE ? AND status = 'active'").run(`%${evidenceRef}%`).changes);
    const commitments = Number(this.db.prepare("UPDATE commitments SET status = 'cancelled', confidence = 'stale', updated_at = ? WHERE evidence_refs_json LIKE ? AND status = 'open'").run(now, `%${evidenceRef}%`).changes);
    const mentions = Number(this.db.prepare("UPDATE mentions SET entity_id = NULL, resolution = 'unresolved', candidates_json = '[]', confidence = 0 WHERE id IN (SELECT m.id FROM mentions m WHERE m.entity_id IN (SELECT DISTINCT entity_id FROM entity_states WHERE superseded_by = 'forgotten'))").run().changes);
    const entities = Number(this.db.prepare("UPDATE entities SET status = 'deleted', updated_at = ? WHERE id IN (SELECT DISTINCT entity_id FROM entity_states WHERE evidence_refs_json LIKE ?)").run(now, `%${evidenceRef}%`).changes);
    let packs = this.invalidateContextPacksForEvidence(evidenceRef);
    for (const row of affected) {
      packs += this.invalidateContextPacksForEvidence(String(row.id));
      packs += this.invalidateContextPacksForEvidence(String(row.entity_id));
    }
    return { relations, states, decisions, commitments, mentions, packs, entities };
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
    ensureColumn(this.db, "tasks", "pending_input", "TEXT");
    ensureColumn(this.db, "tasks", "method_id", "TEXT");
    ensureColumn(this.db, "tasks", "method_version", "INTEGER");
    ensureColumn(this.db, "tasks", "pinned_at", "TEXT");
    ensureColumn(this.db, "tasks", "archived_at", "TEXT");
    ensureColumn(this.db, "tasks", "goal_id", "TEXT");
    ensureColumn(this.db, "run_checkpoints", "proof_json", "TEXT");
    ensureColumn(this.db, "tasks", "external_ref", "TEXT");
    ensureColumn(this.db, "tasks", "request_hash", "TEXT");
    ensureColumn(this.db, "method_candidates", "generation", "INTEGER");
    ensureColumn(this.db, "method_candidates", "fingerprint", "TEXT");
    ensureColumn(this.db, "model_profiles", "context_window_tokens", "INTEGER NOT NULL DEFAULT 128000");
    ensureColumn(this.db, "model_profiles", "max_output_tokens", "INTEGER NOT NULL DEFAULT 8000");
    ensureColumn(this.db, "skills", "trial_task_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(this.db, "task_proposals", "inputs_json", "TEXT");
    ensureColumn(this.db, "runs", "executor_id", "TEXT");
    ensureColumn(this.db, "runs", "checkpoint_seq", "INTEGER");
    ensureColumn(this.db, "runs", "budget_json", "TEXT");
    ensureColumn(this.db, "runs", "parent_run_id", "TEXT");
    ensureColumn(this.db, "runs", "handoff_id", "TEXT");
    ensureColumn(this.db, "handoffs", "generation", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.db, "handoffs", "source_cursor", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.db, "handoffs", "verification_json", "TEXT");
    ensureColumn(this.db, "handoffs", "artifact_ref", "TEXT");
    ensureColumn(this.db, "sync_peers", "token_cipher", "TEXT");
    ensureColumn(this.db, "sync_peers", "remote_instance_id", "TEXT");
    ensureColumn(this.db, "conversations", "settings_json", "TEXT");
    ensureColumn(this.db, "conversations", "deleted_at", "TEXT");
    ensureColumn(this.db, "conversations", "trash_batch_id", "TEXT");
    ensureColumn(this.db, "tasks", "budget_override_json", "TEXT");
    ensureColumn(this.db, "tasks", "deleted_at", "TEXT");
    ensureColumn(this.db, "tasks", "trash_batch_id", "TEXT");
    ensureColumn(this.db, "chat_messages", "kind", "TEXT");
    ensureColumn(this.db, "chat_messages", "task_status", "TEXT");
    ensureColumn(this.db, "connection_sessions", "disconnect_reason", "TEXT");
    ensureColumn(this.db, "approvals", "goal_id", "TEXT");
    ensureColumn(this.db, "approvals", "action_digest", "TEXT");
    ensureColumn(this.db, "approvals", "permission_mode", "TEXT");
    ensureColumn(this.db, "approvals", "context", "TEXT");
    ensureColumn(this.db, "approvals", "max_uses", "INTEGER");
    ensureColumn(this.db, "approvals", "used_count", "INTEGER");
    ensureColumn(this.db, "approvals", "approved_by", "TEXT");
    ensureColumn(this.db, "approvals", "issued_at", "TEXT");
    ensureColumn(this.db, "approvals", "revoked_at", "TEXT");
    ensureColumn(this.db, "approvals", "action_json", "TEXT");
    ensureColumn(this.db, "approvals", "rejection_count", "INTEGER");
    ensureColumn(this.db, "effects", "goal_id", "TEXT");
    ensureColumn(this.db, "effects", "effect_type", "TEXT");
    ensureColumn(this.db, "effects", "replay_policy", "TEXT");
    ensureColumn(this.db, "effects", "action_digest", "TEXT");
    ensureColumn(this.db, "effects", "resolved_action_digest", "TEXT");
    ensureColumn(this.db, "effects", "attempt_count", "INTEGER");
    ensureColumn(this.db, "effects", "max_attempts", "INTEGER");
    ensureColumn(this.db, "effects", "lease_owner", "TEXT");
    ensureColumn(this.db, "effects", "lease_expires_at", "TEXT");
    ensureColumn(this.db, "effects", "available_at", "TEXT");
    ensureColumn(this.db, "effects", "provider", "TEXT");
    ensureColumn(this.db, "effects", "provider_ref", "TEXT");
    ensureColumn(this.db, "effects", "reconcile_ref", "TEXT");
    ensureColumn(this.db, "effects", "reconciled_at", "TEXT");
    ensureColumn(this.db, "effects", "target_key", "TEXT");
    ensureColumn(this.db, "effects", "suspend_reason", "TEXT");
    ensureColumn(this.db, "scheduled_jobs", "catch_up_policy", "TEXT NOT NULL DEFAULT 'run_once'");
    ensureColumn(this.db, "scheduled_jobs", "catch_up_max_runs", "INTEGER NOT NULL DEFAULT 3");
    ensureColumn(this.db, "scheduled_jobs", "priority", "INTEGER NOT NULL DEFAULT 5");
    ensureColumn(this.db, "scheduled_jobs", "failure_count", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.db, "scheduled_jobs", "cooldown_until", "TEXT");
    ensureColumn(this.db, "scheduled_jobs", "delete_after_run", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.db, "scheduled_jobs", "paused_reason", "TEXT");
    ensureColumn(this.db, "scheduled_job_runs", "effect_id", "TEXT");
    ensureColumn(this.db, "scheduled_job_runs", "idempotency_key", "TEXT");
    ensureColumn(this.db, "scheduled_job_runs", "attempt", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(this.db, "scheduled_job_runs", "failure_class", "TEXT");
    ensureColumn(this.db, "scheduled_job_runs", "receipt_json", "TEXT");
    ensureColumn(this.db, "memory_recalls", "lane", "TEXT NOT NULL DEFAULT 'on_demand'");
    ensureColumn(this.db, "attention_items", "entity_id", "TEXT");
    ensureColumn(this.db, "attention_items", "evidence_refs_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(this.db, "attention_items", "options_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(this.db, "attention_items", "impact", "REAL");
    ensureColumn(this.db, "attention_items", "urgency", "REAL");
    ensureColumn(this.db, "attention_items", "confidence", "REAL");
    ensureColumn(this.db, "attention_items", "reversibility", "TEXT");
    ensureColumn(this.db, "attention_items", "blast_radius", "TEXT");
    ensureColumn(this.db, "attention_items", "score", "REAL");
    ensureColumn(this.db, "attention_items", "aggregation_key", "TEXT");
    ensureColumn(this.db, "attention_items", "shadowed", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.db, "context_packs", "parent_pack_id", "TEXT");
    for (const table of ["memories", "memory_versions"] as const) {
      ensureColumn(this.db, table, "tier", "TEXT NOT NULL DEFAULT 'episodic'");
      ensureColumn(this.db, table, "origin_class", "TEXT NOT NULL DEFAULT 'agent'");
      ensureColumn(this.db, table, "source_kind", "TEXT NOT NULL DEFAULT 'system'");
      ensureColumn(this.db, table, "source_ref", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(this.db, table, "session_id", "TEXT");
      ensureColumn(this.db, table, "trust", "TEXT NOT NULL DEFAULT 'medium'");
      ensureColumn(this.db, table, "taint", "TEXT NOT NULL DEFAULT 'clean'");
      ensureColumn(this.db, table, "importance", "REAL NOT NULL DEFAULT 0.5");
      ensureColumn(this.db, table, "retention", "TEXT NOT NULL DEFAULT '30d'");
      ensureColumn(this.db, table, "supersession_key", "TEXT");
      ensureColumn(this.db, table, "content_hash", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(this.db, table, "last_verified_at", "TEXT");
      ensureColumn(this.db, table, "expires_at", "TEXT");
    }
    this.db.exec(`
      DELETE FROM chat_messages
      WHERE kind = 'task_status'
        AND rowid NOT IN (
          SELECT MAX(rowid) FROM chat_messages
          WHERE kind = 'task_status'
          GROUP BY conversation_id, task_id
        );
      CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_task_status_idx
        ON chat_messages(conversation_id, task_id)
        WHERE kind = 'task_status' AND task_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS model_profiles_provider_idx ON model_profiles(provider_id, updated_at);
      CREATE INDEX IF NOT EXISTS settings_migrations_status_idx ON settings_migrations(status, updated_at);
      CREATE INDEX IF NOT EXISTS method_candidates_fingerprint_idx ON method_candidates(fingerprint);
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_external_ref_idx
        ON tasks(external_ref) WHERE external_ref IS NOT NULL;
      CREATE INDEX IF NOT EXISTS approvals_action_digest_idx ON approvals(action_digest);
      CREATE INDEX IF NOT EXISTS effects_target_status_idx ON effects(target_key, status, created_at);
      CREATE INDEX IF NOT EXISTS effects_available_idx ON effects(status, available_at);
      CREATE INDEX IF NOT EXISTS reconcile_queue_status_idx ON reconcile_queue(status, created_at);
      CREATE INDEX IF NOT EXISTS reconcile_queue_task_idx ON reconcile_queue(task_id, status);
      CREATE INDEX IF NOT EXISTS goals_state_idx ON goals(current_state, updated_at);
      CREATE INDEX IF NOT EXISTS tasks_goal_idx ON tasks(goal_id, created_at);
      CREATE INDEX IF NOT EXISTS goal_completion_reports_goal_idx ON goal_completion_reports(goal_id, checked_at);
      CREATE INDEX IF NOT EXISTS memories_lane_idx ON memories(status, tier, trust, taint, updated_at);
      CREATE INDEX IF NOT EXISTS memories_expiry_idx ON memories(expires_at, status);
      CREATE INDEX IF NOT EXISTS memory_consolidation_runs_status_idx ON memory_consolidation_runs(status, started_at);
      CREATE INDEX IF NOT EXISTS memory_forget_tombstones_hash_idx ON memory_forget_tombstones(content_hash);
      CREATE INDEX IF NOT EXISTS memory_forget_tombstones_memory_idx ON memory_forget_tombstones(memory_id);
      CREATE INDEX IF NOT EXISTS skills_status_idx ON skills(status, pinned, updated_at);
      CREATE INDEX IF NOT EXISTS skill_versions_skill_idx ON skill_versions(skill_id, created_at);
      CREATE INDEX IF NOT EXISTS skill_usage_skill_idx ON skill_usage_events(skill_id, created_at);
      CREATE INDEX IF NOT EXISTS skill_usage_task_idx ON skill_usage_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS skill_curator_runs_started_idx ON skill_curator_runs(started_at);
      CREATE INDEX IF NOT EXISTS standing_intents_state_idx ON standing_intents(state, updated_at);
      CREATE INDEX IF NOT EXISTS attention_items_status_idx ON attention_items(status, priority, waiting_since);
      CREATE INDEX IF NOT EXISTS attention_items_goal_idx ON attention_items(goal_id, status);
      CREATE INDEX IF NOT EXISTS heartbeat_runs_started_idx ON heartbeat_runs(started_at);
    `);
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

  getAppSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as DbRow | undefined;
    return row ? String(row.value) : null;
  }

  setAppSetting(key: string, value: string, updatedAt = new Date().toISOString()): void {
    this.db.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    ).run(key, value, updatedAt);
  }

  deleteAppSetting(key: string): void {
    this.db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
  }

  listModelProfiles(): ModelProfileRecord[] {
    return (this.db.prepare("SELECT * FROM model_profiles ORDER BY created_at ASC").all() as DbRow[]).map(rowToModelProfile);
  }

  getModelProfile(id: string): ModelProfileRecord | null {
    const row = this.db.prepare("SELECT * FROM model_profiles WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToModelProfile(row) : null;
  }

  upsertModelProfile(profile: ModelProfileRecord): ModelProfileRecord {
    this.db.prepare(
      `INSERT INTO model_profiles (id, name, provider_id, provider_name, protocol, base_url, model, context_window_tokens, max_output_tokens, api_key_cipher, is_local, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider_id=excluded.provider_id, provider_name=excluded.provider_name,
         protocol=excluded.protocol, base_url=excluded.base_url, model=excluded.model,
         context_window_tokens=excluded.context_window_tokens, max_output_tokens=excluded.max_output_tokens,
         api_key_cipher=excluded.api_key_cipher, is_local=excluded.is_local, updated_at=excluded.updated_at`
    ).run(
      profile.id, profile.name, profile.providerId, profile.providerName, profile.protocol,
      profile.baseUrl, profile.model, profile.contextWindowTokens, profile.maxOutputTokens, profile.apiKeyCipher, profile.isLocal ? 1 : 0,
      profile.createdAt, profile.updatedAt
    );
    return profile;
  }

  deleteModelProfile(id: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE executor_model_bindings SET profile_id = NULL, updated_at = ? WHERE profile_id = ?")
        .run(new Date().toISOString(), id);
      this.db.prepare("DELETE FROM model_profiles WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listExecutorModelBindings(): ExecutorModelBinding[] {
    return (this.db.prepare("SELECT * FROM executor_model_bindings ORDER BY executor_id ASC").all() as DbRow[])
      .map(rowToExecutorModelBinding);
  }

  getExecutorModelBinding(executorId: string): ExecutorModelBinding | null {
    const row = this.db.prepare("SELECT * FROM executor_model_bindings WHERE executor_id = ?").get(executorId) as DbRow | undefined;
    return row ? rowToExecutorModelBinding(row) : null;
  }

  setExecutorModelBinding(binding: ExecutorModelBinding): ExecutorModelBinding {
    const updatedAt = binding.updatedAt ?? new Date().toISOString();
    this.db.prepare(
      `INSERT INTO executor_model_bindings (executor_id, profile_id, protocol_override, model_override, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(executor_id) DO UPDATE SET profile_id=excluded.profile_id, protocol_override=excluded.protocol_override,
         model_override=excluded.model_override, updated_at=excluded.updated_at`
    ).run(binding.executorId, binding.profileId, binding.protocolOverride, binding.modelOverride, updatedAt);
    return { ...binding, updatedAt };
  }

  deleteExecutorModelBinding(executorId: string): void {
    this.db.prepare("DELETE FROM executor_model_bindings WHERE executor_id = ?").run(executorId);
  }

  getSettingsMigration(id: string): SettingsMigrationRecord | null {
    const row = this.db.prepare("SELECT * FROM settings_migrations WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToSettingsMigration(row) : null;
  }

  listSettingsMigrations(): SettingsMigrationRecord[] {
    return (this.db.prepare("SELECT * FROM settings_migrations ORDER BY created_at ASC").all() as DbRow[])
      .map(rowToSettingsMigration);
  }

  upsertSettingsMigration(record: SettingsMigrationRecord): SettingsMigrationRecord {
    this.db.prepare(
      `INSERT INTO settings_migrations (id, source_path, backup_path, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET source_path=excluded.source_path, backup_path=excluded.backup_path,
         status=excluded.status, error=excluded.error, updated_at=excluded.updated_at`
    ).run(
      record.id, record.sourcePath, record.backupPath, record.status, record.error,
      record.createdAt, record.updatedAt
    );
    return record;
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
    return this.appendEvents([event], origin)[0]!;
  }

  appendEvents(events: NewEvent[], origin?: { instanceId: string; seq: number | null }): EventEnvelope[] {
    if (events.length === 0) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const envelopes: EventEnvelope[] = [];
      for (const event of events) {
        const createdAt = event.createdAt ?? new Date().toISOString();
        const id = event.id ?? randomUUID();
        const originInstanceId = origin?.instanceId ?? this.instanceId;
        const originSeq = origin?.seq ?? null;
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
        envelopes.push(envelope);
      }
      this.db.exec("COMMIT");
      return envelopes;
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

  getConnectionSession(id: string): ConnectionSession | null {
    const row = this.db.prepare("SELECT * FROM connection_sessions WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToConnectionSession(row) : null;
  }

  getConnectionSessionByDevice(deviceId: string, userId: string): ConnectionSession | null {
    const row = this.db.prepare("SELECT * FROM connection_sessions WHERE device_id = ? AND user_id = ?").get(deviceId, userId) as DbRow | undefined;
    return row ? rowToConnectionSession(row) : null;
  }

  listConnectionSessions(): ConnectionSession[] {
    return (this.db.prepare("SELECT * FROM connection_sessions ORDER BY updated_at DESC").all() as DbRow[]).map(rowToConnectionSession);
  }

  getConnectionOutboxItem(id: string): ConnectionOutboxItem | null {
    const row = this.db.prepare("SELECT * FROM connection_outbox WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToConnectionOutboxItem(row) : null;
  }

  getConnectionOutboxByIdempotencyKey(connectionId: string, idempotencyKey: string): ConnectionOutboxItem | null {
    const row = this.db.prepare("SELECT * FROM connection_outbox WHERE connection_id = ? AND idempotency_key = ?").get(connectionId, idempotencyKey) as DbRow | undefined;
    return row ? rowToConnectionOutboxItem(row) : null;
  }

  listConnectionOutbox(connectionId: string, status?: string): ConnectionOutboxItem[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM connection_outbox WHERE connection_id = ? AND status = ? ORDER BY created_at ASC").all(connectionId, status) as DbRow[]
      : this.db.prepare("SELECT * FROM connection_outbox WHERE connection_id = ? ORDER BY created_at ASC").all(connectionId) as DbRow[];
    return rows.map(rowToConnectionOutboxItem);
  }

  eventTimestampAtOrBefore(seq: number): string | null {
    const row = this.db.prepare("SELECT created_at FROM events WHERE seq <= ? ORDER BY seq DESC LIMIT 1").get(seq) as DbRow | undefined;
    return row?.created_at == null ? null : String(row.created_at);
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

  getTask(id: string, options: { includeDeleted?: boolean } = {}): TaskRecord | null {
    const row = this.db.prepare(
      options.includeDeleted
        ? "SELECT * FROM tasks WHERE id = ?"
        : "SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL"
    ).get(id) as DbRow | undefined;
    return row ? rowToTask(row) : null;
  }

  getTaskByExternalRef(externalRef: string, options: { includeDeleted?: boolean } = {}): TaskRecord | null {
    const row = this.db.prepare(
      options.includeDeleted
        ? "SELECT * FROM tasks WHERE external_ref = ?"
        : "SELECT * FROM tasks WHERE external_ref = ? AND deleted_at IS NULL"
    ).get(externalRef) as DbRow | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(options: { includeDeleted?: boolean } = {}): TaskRecord[] {
    return (this.db.prepare(
      options.includeDeleted
        ? "SELECT * FROM tasks ORDER BY created_at DESC"
        : "SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at DESC"
    ).all() as DbRow[]).map(rowToTask);
  }

  getGoal(goalId: string): GoalContract | null {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as DbRow | undefined;
    return row ? rowToGoal(row) : null;
  }

  listGoals(): GoalContract[] {
    return (this.db.prepare("SELECT * FROM goals ORDER BY updated_at DESC").all() as DbRow[]).map(rowToGoal);
  }

  latestGoalCompletionReport(goalId: string): GoalCompletionReport | null {
    const row = this.db.prepare("SELECT * FROM goal_completion_reports WHERE goal_id = ? ORDER BY checked_at DESC LIMIT 1")
      .get(goalId) as DbRow | undefined;
    return row ? rowToGoalCompletionReport(row) : null;
  }

  listGoalCompletionReports(goalId: string): GoalCompletionReport[] {
    return (this.db.prepare("SELECT * FROM goal_completion_reports WHERE goal_id = ? ORDER BY checked_at DESC")
      .all(goalId) as DbRow[]).map(rowToGoalCompletionReport);
  }

  createConversation(title: string, settings: ConversationSettings = defaultConversationSettings()): ConversationRecord {
    const now = new Date().toISOString();
    const conversation: ConversationRecord = {
      id: randomUUID(), title: title.trim() || "新对话", createdAt: now, updatedAt: now,
      settings: mergeConversationSettings(defaultConversationSettings(), settings)
    };
    this.db.prepare(
      "INSERT INTO conversations (id, title, created_at, updated_at, settings_json) VALUES (?, ?, ?, ?, ?)"
    ).run(
      conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt,
      JSON.stringify(conversation.settings)
    );
    return conversation;
  }

  listConversations(options: { includeDeleted?: boolean } = {}): ConversationRecord[] {
    return (this.db.prepare(
      options.includeDeleted
        ? "SELECT * FROM conversations ORDER BY updated_at DESC"
        : "SELECT * FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC"
    ).all() as DbRow[])
      .map(rowToConversation);
  }

  getConversation(id: string, options: { includeDeleted?: boolean } = {}): ConversationRecord | null {
    const row = this.db.prepare(
      options.includeDeleted
        ? "SELECT * FROM conversations WHERE id = ?"
        : "SELECT * FROM conversations WHERE id = ? AND deleted_at IS NULL"
    ).get(id) as DbRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  renameConversation(id: string, title: string): ConversationRecord | null {
    const clean = title.trim().slice(0, 120);
    if (!clean) return this.getConversation(id);
    this.db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
      .run(clean, new Date().toISOString(), id);
    return this.getConversation(id);
  }

  updateConversationSettings(id: string, patch: ConversationSettingsPatch): ConversationRecord | null {
    const current = this.getConversation(id);
    if (!current) return null;
    const settings = mergeConversationSettings(current.settings, patch);
    this.db.prepare("UPDATE conversations SET settings_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(settings), new Date().toISOString(), id);
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

  softDeleteConversation(id: string): { batchId: string; deletedAt: string; taskIds: string[] } | null {
    const conversation = this.getConversation(id);
    if (!conversation) return null;
    const batchId = randomUUID();
    const deletedAt = new Date().toISOString();
    const taskIds = (this.db.prepare(
      "SELECT id FROM tasks WHERE conversation_id = ? AND deleted_at IS NULL"
    ).all(id) as DbRow[]).map((row) => String(row.id));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "UPDATE conversations SET deleted_at = ?, trash_batch_id = ?, updated_at = ? WHERE id = ?"
      ).run(deletedAt, batchId, deletedAt, id);
      this.db.prepare(
        "UPDATE tasks SET deleted_at = ?, trash_batch_id = ?, updated_at = ? WHERE conversation_id = ? AND deleted_at IS NULL"
      ).run(deletedAt, batchId, deletedAt, id);
      this.db.exec("COMMIT");
      return { batchId, deletedAt, taskIds };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  softDeleteTask(id: string): { batchId: string; deletedAt: string } | null {
    const task = this.getTask(id);
    if (!task) return null;
    const batchId = randomUUID();
    const deletedAt = new Date().toISOString();
    this.db.prepare(
      "UPDATE tasks SET deleted_at = ?, trash_batch_id = ?, updated_at = ? WHERE id = ?"
    ).run(deletedAt, batchId, deletedAt, id);
    return { batchId, deletedAt };
  }

  restoreConversation(id: string): { conversation: ConversationRecord; taskIds: string[] } | null {
    const deleted = this.getConversation(id, { includeDeleted: true });
    if (!deleted || !deleted.deletedAt) return null;
    const restoredAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "UPDATE conversations SET deleted_at = NULL, trash_batch_id = NULL, updated_at = ? WHERE id = ?"
      ).run(restoredAt, id);
      const taskIds = (this.db.prepare(
        "SELECT id FROM tasks WHERE conversation_id = ? AND deleted_at IS NOT NULL"
      ).all(id) as DbRow[]).map((row) => String(row.id));
      this.db.prepare(
        "UPDATE tasks SET deleted_at = NULL, trash_batch_id = NULL, updated_at = ? WHERE conversation_id = ? AND deleted_at IS NOT NULL"
      ).run(restoredAt, id);
      this.db.exec("COMMIT");
      return { conversation: this.getConversation(id)!, taskIds };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  restoreTask(id: string): { task: TaskRecord; conversationId: string | null } | null {
    const deleted = this.getTask(id, { includeDeleted: true });
    if (!deleted || !deleted.deletedAt) return null;
    const restoredAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "UPDATE tasks SET deleted_at = NULL, trash_batch_id = NULL, updated_at = ? WHERE id = ?"
      ).run(restoredAt, id);
      if (deleted.conversationId) {
        this.db.prepare(
          "UPDATE conversations SET deleted_at = NULL, trash_batch_id = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL"
        ).run(restoredAt, deleted.conversationId);
      }
      this.db.exec("COMMIT");
      return { task: this.getTask(id)!, conversationId: deleted.conversationId ?? null };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listTrash(kind: TrashKind | "all" = "all", olderThanDays: number | null = null): TrashItem[] {
    const cutoff = olderThanDays === null
      ? null
      : new Date(Date.now() - Math.max(1, olderThanDays) * 24 * 60 * 60_000).toISOString();
    const items: TrashItem[] = [];
    if (kind === "all" || kind === "conversation") {
      for (const conversation of this.listConversations({ includeDeleted: true })) {
        if (!conversation.deletedAt) continue;
        if (cutoff && conversation.deletedAt >= cutoff) continue;
        items.push({
          kind: "conversation",
          id: conversation.id,
          title: conversation.title,
          deletedAt: conversation.deletedAt,
          trashBatchId: conversation.trashBatchId ?? null,
          status: null,
          conversationId: conversation.id
        });
      }
    }
    if (kind === "all" || kind === "task") {
      for (const task of this.listTasks({ includeDeleted: true })) {
        if (!task.deletedAt) continue;
        if (cutoff && task.deletedAt >= cutoff) continue;
        items.push({
          kind: "task",
          id: task.id,
          title: task.title,
          deletedAt: task.deletedAt,
          trashBatchId: task.trashBatchId ?? null,
          status: task.status,
          conversationId: task.conversationId ?? null
        });
      }
    }
    return items.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
  }

  purgeTask(id: string): boolean {
    const task = this.getTask(id, { includeDeleted: true });
    if (!task || !task.deletedAt) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.purgeTaskRecord(id);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  purgeConversation(id: string): string[] {
    const conversation = this.getConversation(id, { includeDeleted: true });
    if (!conversation || !conversation.deletedAt) return [];
    const taskIds = (this.db.prepare("SELECT id FROM tasks WHERE conversation_id = ?").all(id) as DbRow[])
      .map((row) => String(row.id));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const taskId of taskIds) this.purgeTaskRecord(taskId);
      this.deleteRowsByColumn("conversation_id", id);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      this.db.exec("COMMIT");
      return taskIds;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listAllChatMessages(): ChatMessageRecord[] {
    return (this.db.prepare("SELECT * FROM chat_messages ORDER BY rowid ASC").all() as DbRow[])
      .map(rowToChatMessage);
  }

  listChatMessagesByTaskId(taskId: string): ChatMessageRecord[] {
    return (this.db.prepare("SELECT * FROM chat_messages WHERE task_id = ? ORDER BY rowid ASC").all(taskId) as DbRow[])
      .map(rowToChatMessage);
  }

  listAttachmentIdsInUse(): string[] {
    const ids = new Set<string>();
    for (const message of this.listAllChatMessages()) {
      for (const attachment of message.attachments) ids.add(attachment.id);
    }
    return [...ids];
  }

  private purgeTaskRecord(id: string): void {
    this.deleteRowsByColumn("task_id", id);
    this.db.prepare("DELETE FROM task_edges WHERE parent_task_id = ? OR child_task_id = ?").run(id, id);
    this.db.prepare("UPDATE scheduled_jobs SET last_task_id = NULL WHERE last_task_id = ?").run(id);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  private deleteRowsByColumn(column: string, value: string): void {
    const tables = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as DbRow[];
    for (const table of tables) {
      const name = String(table.name);
      const columns = this.db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all() as DbRow[];
      if (!columns.some((item) => String(item.name) === column)) continue;
      this.db.prepare(`DELETE FROM "${name.replaceAll('"', '""')}" WHERE "${column}" = ?`).run(value);
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
        `INSERT INTO chat_messages (id, conversation_id, role, content, task_id, attachments_json, created_at, kind, task_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        message.id, message.conversationId, message.role, message.content,
        message.taskId, JSON.stringify(message.attachments), message.createdAt,
        message.kind ?? "text", message.taskStatus ?? null
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

  upsertTaskStatusMessage(message: ChatMessageRecord): { message: ChatMessageRecord; created: boolean } {
    if (message.kind !== "task_status" || !message.taskId) return { message: this.createChatMessage(message), created: true };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(
        "SELECT * FROM chat_messages WHERE conversation_id = ? AND task_id = ? AND kind = 'task_status' ORDER BY rowid ASC LIMIT 1"
      ).get(message.conversationId, message.taskId) as DbRow | undefined;
      if (existing) {
        this.db.prepare(
          "UPDATE chat_messages SET content = ?, attachments_json = ?, created_at = ?, task_status = ? WHERE id = ?"
        ).run(message.content, JSON.stringify(message.attachments), message.createdAt, message.taskStatus ?? null, String(existing.id));
        this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(message.createdAt, message.conversationId);
        this.db.exec("COMMIT");
        return {
          message: {
            ...message,
            id: String(existing.id)
          },
          created: false
        };
      }
      this.db.prepare(
        `INSERT INTO chat_messages (id, conversation_id, role, content, task_id, attachments_json, created_at, kind, task_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        message.id, message.conversationId, message.role, message.content,
        message.taskId, JSON.stringify(message.attachments), message.createdAt,
        message.kind, message.taskStatus ?? null
      );
      this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(message.createdAt, message.conversationId);
      this.db.exec("COMMIT");
      return { message, created: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createSchedule(schedule: ScheduleRecord): ScheduleRecord {
    this.db.prepare(
      `INSERT INTO scheduled_jobs (id, name, prompt, cron, timezone, enabled, conversation_id, executor_id,
         approval_mode, task_kind, next_run_at, last_run_at, last_task_id, last_status,
         catch_up_policy, catch_up_max_runs, priority, failure_count, cooldown_until, delete_after_run,
         paused_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      schedule.id, schedule.name, schedule.prompt, schedule.cron, schedule.timezone,
      schedule.enabled ? 1 : 0, schedule.conversationId, schedule.executorId, schedule.approvalMode,
      schedule.taskKind, schedule.nextRunAt, schedule.lastRunAt, schedule.lastTaskId, schedule.lastStatus,
      schedule.catchUpPolicy, schedule.catchUpMaxRuns, schedule.priority, schedule.failureCount,
      schedule.cooldownUntil, schedule.deleteAfterRun ? 1 : 0, schedule.pausedReason,
      schedule.createdAt, schedule.updatedAt
    );
    return schedule;
  }

  listSchedules(): ScheduleRecord[] {
    return (this.db.prepare("SELECT * FROM scheduled_jobs ORDER BY created_at DESC").all() as DbRow[]).map(rowToSchedule);
  }

  getSchedule(id: string): ScheduleRecord | null {
    const row = this.db.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  updateSchedule(id: string, patch: Partial<Omit<ScheduleRecord, "id" | "createdAt">>): ScheduleRecord | null {
    const current = this.getSchedule(id);
    if (!current) return null;
    const next: ScheduleRecord = { ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    this.db.prepare(
      `UPDATE scheduled_jobs SET name = ?, prompt = ?, cron = ?, timezone = ?, enabled = ?, conversation_id = ?,
         executor_id = ?, approval_mode = ?, task_kind = ?, next_run_at = ?, last_run_at = ?, last_task_id = ?,
         last_status = ?, catch_up_policy = ?, catch_up_max_runs = ?, priority = ?, failure_count = ?,
         cooldown_until = ?, delete_after_run = ?, paused_reason = ?, updated_at = ? WHERE id = ?`
    ).run(
      next.name, next.prompt, next.cron, next.timezone, next.enabled ? 1 : 0, next.conversationId,
      next.executorId, next.approvalMode, next.taskKind, next.nextRunAt, next.lastRunAt, next.lastTaskId,
      next.lastStatus, next.catchUpPolicy, next.catchUpMaxRuns, next.priority, next.failureCount,
      next.cooldownUntil, next.deleteAfterRun ? 1 : 0, next.pausedReason, next.updatedAt, id
    );
    return this.getSchedule(id);
  }

  deleteSchedule(id: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM scheduled_job_runs WHERE schedule_id = ?").run(id);
      const result = this.db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(id);
      this.db.exec("COMMIT");
      return Number(result.changes) > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createScheduleRun(run: ScheduleRunRecord): ScheduleRunRecord | null {
    const existing = this.db.prepare(
      "SELECT * FROM scheduled_job_runs WHERE schedule_id = ? AND scheduled_for = ?"
    ).get(run.scheduleId, run.scheduledFor) as DbRow | undefined;
    if (existing) return null;
    this.db.prepare(
      `INSERT INTO scheduled_job_runs (id, schedule_id, scheduled_for, task_id, effect_id, idempotency_key,
         attempt, failure_class, receipt_json, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      run.id, run.scheduleId, run.scheduledFor, run.taskId, run.effectId, run.idempotencyKey,
      run.attempt, run.failureClass, run.receipt ? JSON.stringify(run.receipt) : null,
      run.status, run.error, run.createdAt, run.updatedAt
    );
    return run;
  }

  updateScheduleRun(
    id: string,
    patch: Partial<Pick<ScheduleRunRecord,
      "taskId" | "effectId" | "idempotencyKey" | "attempt" | "failureClass" | "receipt" | "status" | "error">>
  ): ScheduleRunRecord | null {
    const current = this.getScheduleRun(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare(
      `UPDATE scheduled_job_runs SET task_id = ?, effect_id = ?, idempotency_key = ?, attempt = ?,
         failure_class = ?, receipt_json = ?, status = ?, error = ?, updated_at = ? WHERE id = ?`
    ).run(
      next.taskId, next.effectId, next.idempotencyKey, next.attempt, next.failureClass,
      next.receipt ? JSON.stringify(next.receipt) : null, next.status, next.error, next.updatedAt, id
    );
    return next;
  }

  getScheduleRun(id: string): ScheduleRunRecord | null {
    const row = this.db.prepare("SELECT * FROM scheduled_job_runs WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToScheduleRun(row) : null;
  }

  listScheduleRuns(scheduleId: string, limit = 50): ScheduleRunRecord[] {
    return (this.db.prepare(
      "SELECT * FROM scheduled_job_runs WHERE schedule_id = ? ORDER BY scheduled_for DESC LIMIT ?"
    ).all(scheduleId, limit) as DbRow[]).map(rowToScheduleRun);
  }

  listScheduleRunByTask(taskId: string): ScheduleRunRecord | null {
    const row = this.db.prepare("SELECT * FROM scheduled_job_runs WHERE task_id = ? LIMIT 1").get(taskId) as DbRow | undefined;
    return row ? rowToScheduleRun(row) : null;
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

  getTaskFollowUp(id: string): TaskFollowUpRecord | null {
    const row = this.db.prepare("SELECT * FROM task_follow_ups WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToTaskFollowUp(row) : null;
  }

  listTaskFollowUps(taskId: string, status?: string): TaskFollowUpRecord[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM task_follow_ups WHERE task_id = ? AND status = ? ORDER BY created_at ASC").all(taskId, status)
      : this.db.prepare("SELECT * FROM task_follow_ups WHERE task_id = ? ORDER BY created_at ASC").all(taskId);
    return (rows as DbRow[]).map(rowToTaskFollowUp);
  }

  createTaskFollowUp(record: TaskFollowUpRecord): TaskFollowUpRecord {
    upsertTaskFollowUp(this.db, record);
    return record;
  }

  updateTaskFollowUp(id: string, patch: Partial<Pick<TaskFollowUpRecord, "content" | "status" | "appliedRunId" | "error" | "updatedAt">>): TaskFollowUpRecord | null {
    const current = this.getTaskFollowUp(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    upsertTaskFollowUp(this.db, next);
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

  appendContextItem(item: ContextItem): ContextItem {
    if (item.executorEventId != null && item.runId != null) {
      const existing = this.db.prepare(
        "SELECT * FROM context_items WHERE run_id = ? AND executor_event_id = ?"
      ).get(item.runId, item.executorEventId) as DbRow | undefined;
      if (existing) return rowToContextItem(existing);
    }
    const result = this.db.prepare(
      `INSERT INTO context_items
       (id, conversation_id, task_id, run_id, executor_id, kind, role, content,
        content_ref, sha256, tokens, sensitivity, provenance_json, parent_id,
        executor_event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      item.id,
      item.conversationId,
      item.taskId,
      item.runId,
      item.executorId,
      item.kind,
      item.role,
      item.content,
      item.contentRef,
      item.sha256,
      item.tokens,
      item.sensitivity,
      JSON.stringify(item.provenance),
      item.parentId,
      item.executorEventId,
      item.createdAt
    );
    const row = this.db.prepare("SELECT * FROM context_items WHERE seq = ?").get(Number(result.lastInsertRowid)) as DbRow | undefined;
    if (!row) throw new Error("context item insert failed");
    return rowToContextItem(row);
  }

  listContextItems(taskId: string, opts: { limit?: number; beforeSeq?: number | null } = {}): ContextItemPage {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const beforeSeq = opts.beforeSeq ?? null;
    const rows = (beforeSeq == null
      ? this.db.prepare("SELECT * FROM context_items WHERE task_id = ? ORDER BY seq DESC LIMIT ?").all(taskId, limit)
      : this.db.prepare("SELECT * FROM context_items WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(taskId, beforeSeq, limit)) as DbRow[];
    const items = rows.map(rowToContextItem);
    return {
      items,
      total: this.countContextItems(taskId),
      nextBefore: items.length === limit ? items[items.length - 1]?.seq ?? null : null
    };
  }

  countContextItems(taskId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM context_items WHERE task_id = ?").get(taskId) as DbRow | undefined;
    return row ? Number(row.total) : 0;
  }

  listContextTaskActivity(): Array<{ taskId: string; latestCreatedAt: string }> {
    const rows = this.db.prepare(
      "SELECT task_id, MAX(created_at) AS latest_created_at FROM context_items GROUP BY task_id"
    ).all() as DbRow[];
    return rows.map((row) => ({ taskId: String(row.task_id), latestCreatedAt: String(row.latest_created_at) }));
  }

  getTaskContextState(taskId: string): TaskContextState | null {
    const row = this.db.prepare("SELECT * FROM task_context_state WHERE task_id = ?").get(taskId) as DbRow | undefined;
    return row ? rowToTaskContextState(row) : null;
  }

  upsertTaskContextState(state: TaskContextState): TaskContextState {
    this.db.prepare(
      `INSERT INTO task_context_state
       (task_id, summary, plan_json, completed_json, failed_json, artifacts_json,
        open_questions_json, last_failure_json, handoff_count, summary_seq, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         summary=excluded.summary,
         plan_json=excluded.plan_json,
         completed_json=excluded.completed_json,
         failed_json=excluded.failed_json,
         artifacts_json=excluded.artifacts_json,
         open_questions_json=excluded.open_questions_json,
         last_failure_json=excluded.last_failure_json,
         handoff_count=excluded.handoff_count,
         summary_seq=excluded.summary_seq,
         updated_at=excluded.updated_at`
    ).run(
      state.taskId,
      state.summary,
      JSON.stringify(state.plan),
      JSON.stringify(state.completed),
      JSON.stringify(state.failed),
      JSON.stringify(state.artifacts),
      JSON.stringify(state.openQuestions),
      state.lastFailure ? JSON.stringify(state.lastFailure) : null,
      state.handoffCount,
      state.summarySeq,
      state.updatedAt
    );
    return state;
  }

  createHandoff(handoff: HandoffRecord): HandoffRecord {
    this.db.prepare(
      `INSERT INTO handoffs
       (id, task_id, from_run_id, to_run_id, from_executor, to_executor, generation,
        source_cursor, status, reason_code, diagnosis_json, packet_json, verification_json,
        artifact_ref, context_watermark_seq, initiated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      handoff.id,
      handoff.taskId,
      handoff.fromRunId,
      handoff.toRunId,
      handoff.fromExecutor,
      handoff.toExecutor,
      handoff.generation,
      handoff.sourceCursor,
      handoff.status,
      handoff.reasonCode,
      handoff.diagnosis ? JSON.stringify(handoff.diagnosis) : null,
      handoff.packet ? JSON.stringify(handoff.packet) : null,
      handoff.verification ? JSON.stringify(handoff.verification) : null,
      handoff.artifactRef,
      handoff.contextWatermarkSeq,
      handoff.initiatedBy,
      handoff.createdAt,
      handoff.updatedAt
    );
    return handoff;
  }

  updateHandoff(id: string, patch: Partial<Pick<HandoffRecord, "toRunId" | "status" | "diagnosis" | "packet" | "verification" | "artifactRef" | "updatedAt">>): HandoffRecord | null {
    const current = this.getHandoff(id);
    if (!current) return null;
    const next: HandoffRecord = { ...current, ...patch };
    this.db.prepare(
      `UPDATE handoffs SET to_run_id = ?, status = ?, diagnosis_json = ?, packet_json = ?,
       verification_json = ?, artifact_ref = ?, updated_at = ? WHERE id = ?`
    ).run(
      next.toRunId,
      next.status,
      next.diagnosis ? JSON.stringify(next.diagnosis) : null,
      next.packet ? JSON.stringify(next.packet) : null,
      next.verification ? JSON.stringify(next.verification) : null,
      next.artifactRef,
      next.updatedAt,
      id
    );
    return next;
  }

  getHandoff(id: string): HandoffRecord | null {
    const row = this.db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToHandoff(row) : null;
  }

  listHandoffs(taskId: string): HandoffRecord[] {
    return (this.db.prepare("SELECT * FROM handoffs WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as DbRow[]).map(rowToHandoff);
  }

  createDelegationJob(job: DelegationJob): DelegationJob {
    this.db.prepare(
      `INSERT INTO delegation_jobs
       (id, parent_task_id, parent_run_id, child_task_id, child_run_id, goal_slice,
        target_executor, context_pack_ref, context_pack_json, workspace_policy,
        permissions_json, tool_policy_json, network_policy_json, budget_json, deadline,
        result_schema_ref, status, depth, idempotency_key, lease_owner, lease_expires_at,
        attempt, result_json, verification_json, failure_json, cancel_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         parent_task_id = excluded.parent_task_id,
         parent_run_id = excluded.parent_run_id,
         child_task_id = excluded.child_task_id,
         child_run_id = excluded.child_run_id,
         goal_slice = excluded.goal_slice,
         target_executor = excluded.target_executor,
         context_pack_ref = excluded.context_pack_ref,
         context_pack_json = excluded.context_pack_json,
         workspace_policy = excluded.workspace_policy,
         permissions_json = excluded.permissions_json,
         tool_policy_json = excluded.tool_policy_json,
         network_policy_json = excluded.network_policy_json,
         budget_json = excluded.budget_json,
         deadline = excluded.deadline,
         result_schema_ref = excluded.result_schema_ref,
         status = excluded.status,
         depth = excluded.depth,
         idempotency_key = excluded.idempotency_key,
         lease_owner = excluded.lease_owner,
         lease_expires_at = excluded.lease_expires_at,
         attempt = excluded.attempt,
         result_json = excluded.result_json,
         verification_json = excluded.verification_json,
         failure_json = excluded.failure_json,
         cancel_reason = excluded.cancel_reason,
         updated_at = excluded.updated_at`
    ).run(
      job.id,
      job.parentTaskId,
      job.parentRunId,
      job.childTaskId,
      job.childRunId,
      job.goalSlice,
      job.targetExecutor,
      job.contextPackRef,
      JSON.stringify(job.contextPack),
      job.workspacePolicy,
      JSON.stringify(job.permissions),
      JSON.stringify(job.toolPolicy),
      JSON.stringify(job.networkPolicy),
      JSON.stringify(job.budget),
      job.deadline,
      job.resultSchemaRef,
      job.status,
      job.depth,
      job.idempotencyKey,
      job.lease?.owner ?? null,
      job.lease?.expiresAt ?? null,
      job.attempt,
      job.result ? JSON.stringify(job.result) : null,
      job.verification ? JSON.stringify(job.verification) : null,
      job.failure ? JSON.stringify(job.failure) : null,
      job.cancelReason,
      job.createdAt,
      job.updatedAt
    );
    return job;
  }

  updateDelegationJob(id: string, patch: Partial<Omit<DelegationJob, "id" | "createdAt">>): DelegationJob | null {
    const current = this.getDelegationJob(id);
    if (!current) return null;
    const next: DelegationJob = { ...current, ...patch, id: current.id, createdAt: current.createdAt };
    this.db.prepare(
      `UPDATE delegation_jobs SET parent_task_id = ?, parent_run_id = ?, child_task_id = ?,
       child_run_id = ?, goal_slice = ?, target_executor = ?, context_pack_ref = ?,
       context_pack_json = ?, workspace_policy = ?, permissions_json = ?, tool_policy_json = ?,
       network_policy_json = ?, budget_json = ?, deadline = ?, result_schema_ref = ?, status = ?,
       depth = ?, idempotency_key = ?, lease_owner = ?, lease_expires_at = ?, attempt = ?,
       result_json = ?, verification_json = ?, failure_json = ?, cancel_reason = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      next.parentTaskId,
      next.parentRunId,
      next.childTaskId,
      next.childRunId,
      next.goalSlice,
      next.targetExecutor,
      next.contextPackRef,
      JSON.stringify(next.contextPack),
      next.workspacePolicy,
      JSON.stringify(next.permissions),
      JSON.stringify(next.toolPolicy),
      JSON.stringify(next.networkPolicy),
      JSON.stringify(next.budget),
      next.deadline,
      next.resultSchemaRef,
      next.status,
      next.depth,
      next.idempotencyKey,
      next.lease?.owner ?? null,
      next.lease?.expiresAt ?? null,
      next.attempt,
      next.result ? JSON.stringify(next.result) : null,
      next.verification ? JSON.stringify(next.verification) : null,
      next.failure ? JSON.stringify(next.failure) : null,
      next.cancelReason,
      next.updatedAt,
      id
    );
    return next;
  }

  getDelegationJob(id: string): DelegationJob | null {
    const row = this.db.prepare("SELECT * FROM delegation_jobs WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToDelegationJob(row) : null;
  }

  getDelegationJobByIdempotencyKey(idempotencyKey: string): DelegationJob | null {
    const row = this.db.prepare("SELECT * FROM delegation_jobs WHERE idempotency_key = ?").get(idempotencyKey) as DbRow | undefined;
    return row ? rowToDelegationJob(row) : null;
  }

  getDelegationJobByChildTask(childTaskId: string): DelegationJob | null {
    const row = this.db.prepare("SELECT * FROM delegation_jobs WHERE child_task_id = ?").get(childTaskId) as DbRow | undefined;
    return row ? rowToDelegationJob(row) : null;
  }

  listDelegationJobs(parentTaskId: string): DelegationJob[] {
    return (this.db.prepare("SELECT * FROM delegation_jobs WHERE parent_task_id = ? ORDER BY created_at ASC").all(parentTaskId) as DbRow[]).map(rowToDelegationJob);
  }

  listActiveDelegationJobs(): DelegationJob[] {
    return (this.db.prepare(
      "SELECT * FROM delegation_jobs WHERE status IN ('queued','leased','running','awaiting_verification') ORDER BY created_at ASC"
    ).all() as DbRow[]).map(rowToDelegationJob);
  }

  listDelegationJobsByStatus(status: string): DelegationJob[] {
    return (this.db.prepare("SELECT * FROM delegation_jobs WHERE status = ? ORDER BY created_at ASC").all(status) as DbRow[]).map(rowToDelegationJob);
  }

  getChannelDelivery(channel: string, externalId: string, direction: string): ChannelDeliveryRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM channel_deliveries WHERE channel = ? AND external_id = ? AND direction = ?"
    ).get(channel, externalId, direction) as DbRow | undefined;
    return row ? rowToChannelDelivery(row) : null;
  }

  createChannelDelivery(delivery: ChannelDeliveryRecord): ChannelDeliveryRecord {
    this.db.prepare(
      `INSERT INTO channel_deliveries
       (id, channel, external_id, thread_key, direction, idempotency_key, generation, status,
        payload_json, attempt_count, last_error, last_attempt_at, processed_at, effect_id,
        receipt_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      delivery.id,
      delivery.channel,
      delivery.externalId,
      delivery.threadKey,
      delivery.direction,
      delivery.idempotencyKey,
      delivery.generation,
      delivery.status,
      JSON.stringify(delivery.payload),
      delivery.attemptCount,
      delivery.lastError,
      delivery.lastAttemptAt,
      delivery.processedAt,
      delivery.effectId,
      delivery.receipt ? JSON.stringify(delivery.receipt) : null,
      delivery.createdAt,
      delivery.updatedAt
    );
    return delivery;
  }

  updateChannelDelivery(id: string, patch: Partial<Omit<ChannelDeliveryRecord, "id" | "createdAt">>): ChannelDeliveryRecord | null {
    const current = this.getChannelDeliveryById(id);
    if (!current) return null;
    const next: ChannelDeliveryRecord = { ...current, ...patch, id: current.id, createdAt: current.createdAt };
    this.db.prepare(
      `UPDATE channel_deliveries SET channel = ?, external_id = ?, thread_key = ?, direction = ?,
       idempotency_key = ?, generation = ?, status = ?, payload_json = ?, attempt_count = ?,
       last_error = ?, last_attempt_at = ?, processed_at = ?, effect_id = ?, receipt_json = ?,
       updated_at = ? WHERE id = ?`
    ).run(
      next.channel,
      next.externalId,
      next.threadKey,
      next.direction,
      next.idempotencyKey,
      next.generation,
      next.status,
      JSON.stringify(next.payload),
      next.attemptCount,
      next.lastError,
      next.lastAttemptAt,
      next.processedAt,
      next.effectId,
      next.receipt ? JSON.stringify(next.receipt) : null,
      next.updatedAt,
      id
    );
    return next;
  }

  getChannelDeliveryById(id: string): ChannelDeliveryRecord | null {
    const row = this.db.prepare("SELECT * FROM channel_deliveries WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToChannelDelivery(row) : null;
  }

  listChannelDeliveries(channel: string, threadKey?: string): ChannelDeliveryRecord[] {
    const rows = threadKey
      ? this.db.prepare("SELECT * FROM channel_deliveries WHERE channel = ? AND thread_key = ? ORDER BY created_at ASC").all(channel, threadKey)
      : this.db.prepare("SELECT * FROM channel_deliveries WHERE channel = ? ORDER BY created_at ASC").all(channel);
    return (rows as DbRow[]).map(rowToChannelDelivery);
  }

  getChannelCursor(channel: string, threadKey: string): ChannelCursor | null {
    const row = this.db.prepare(
      "SELECT * FROM channel_cursors WHERE channel = ? AND thread_key = ?"
    ).get(channel, threadKey) as DbRow | undefined;
    return row ? rowToChannelCursor(row) : null;
  }

  setChannelCursor(cursor: ChannelCursor): ChannelCursor {
    this.db.prepare(
      `INSERT INTO channel_cursors (channel, thread_key, generation, cursor, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel, thread_key) DO UPDATE SET
         generation = excluded.generation, cursor = excluded.cursor, updated_at = excluded.updated_at`
    ).run(cursor.channel, cursor.threadKey, cursor.generation, cursor.cursor, cursor.updatedAt);
    return cursor;
  }

  getContextSettings(): ContextSettings {
    const row = this.db.prepare("SELECT * FROM context_settings WHERE id = 1").get() as DbRow | undefined;
    if (!row) return { ...DEFAULT_CONTEXT_SETTINGS };
    try {
      return { ...DEFAULT_CONTEXT_SETTINGS, ...JSON.parse(String(row.settings_json)), updatedAt: String(row.updated_at) };
    } catch {
      return { ...DEFAULT_CONTEXT_SETTINGS };
    }
  }

  setContextSettings(settings: ContextSettings): ContextSettings {
    const updatedAt = settings.updatedAt ?? new Date().toISOString();
    const next = { ...settings, updatedAt };
    this.db.prepare(
      "INSERT INTO context_settings (id, settings_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at"
    ).run(JSON.stringify(next), updatedAt);
    return next;
  }

  deleteTaskContext(taskId: string): { deletedItems: number; deletedHandoffs: number } {
    const result = this.db.prepare("DELETE FROM context_items WHERE task_id = ?").run(taskId);
    const handoffs = this.db.prepare("DELETE FROM handoffs WHERE task_id = ?").run(taskId);
    this.db.prepare("DELETE FROM task_context_state WHERE task_id = ?").run(taskId);
    return { deletedItems: Number(result.changes), deletedHandoffs: Number(handoffs.changes) };
  }

  listContextContentRefs(taskId: string): string[] {
    const rows = this.db.prepare("SELECT DISTINCT content_ref FROM context_items WHERE task_id = ? AND content_ref IS NOT NULL").all(taskId) as DbRow[];
    return rows.map((row) => String(row.content_ref));
  }

  countContextContentRef(contentRef: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM context_items WHERE content_ref = ?").get(contentRef) as DbRow | undefined;
    return row ? Number(row.total) : 0;
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

  getReconcileItem(id: string): ReconcileItem | null {
    const row = this.db.prepare("SELECT * FROM reconcile_queue WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToReconcileItem(row) : null;
  }

  getReconcileItemByEffect(effectId: string): ReconcileItem | null {
    const row = this.db.prepare("SELECT * FROM reconcile_queue WHERE effect_id = ?").get(effectId) as DbRow | undefined;
    return row ? rowToReconcileItem(row) : null;
  }

  listReconcileItems(status?: ReconcileStatus): ReconcileItem[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM reconcile_queue WHERE status = ? ORDER BY created_at ASC").all(status) as DbRow[]
      : this.db.prepare("SELECT * FROM reconcile_queue ORDER BY created_at ASC").all() as DbRow[];
    return rows.map(rowToReconcileItem);
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

  getMemoryConsolidationRun(id: string): MemoryConsolidationRun | null {
    const row = this.db.prepare("SELECT * FROM memory_consolidation_runs WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToMemoryConsolidationRun(row) : null;
  }

  listMemoryConsolidationRuns(limit = 50): MemoryConsolidationRun[] {
    const rows = this.db.prepare(
      "SELECT * FROM memory_consolidation_runs ORDER BY started_at DESC LIMIT ?"
    ).all(limit) as DbRow[];
    return rows.map(rowToMemoryConsolidationRun);
  }

  getMemoryForgetTombstone(contentHash: string): MemoryForgetTombstone | null {
    const row = this.db.prepare(
      "SELECT * FROM memory_forget_tombstones WHERE content_hash = ? ORDER BY created_at DESC LIMIT 1"
    ).get(contentHash) as DbRow | undefined;
    return row ? rowToMemoryForgetTombstone(row) : null;
  }

  listMemoryForgetTombstones(memoryId?: string): MemoryForgetTombstone[] {
    const rows = memoryId
      ? this.db.prepare("SELECT * FROM memory_forget_tombstones WHERE memory_id = ? ORDER BY created_at DESC").all(memoryId) as DbRow[]
      : this.db.prepare("SELECT * FROM memory_forget_tombstones ORDER BY created_at DESC").all() as DbRow[];
    return rows.map(rowToMemoryForgetTombstone);
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

  insertMethodApplication(application: MethodApplication): MethodApplication {
    this.db.prepare(
      `INSERT INTO method_applications
       (id, task_id, run_id, method_id, method_version, selection, prompt_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      application.id,
      application.taskId,
      application.runId,
      application.methodId,
      application.methodVersion,
      application.selection,
      application.promptSha256,
      application.createdAt
    );
    return application;
  }

  listMethodApplications(filter: { taskId?: string; methodId?: string; methodVersion?: number; limit?: number } = {}): MethodApplication[] {
    const where: string[] = [];
    const values: SQLInputValue[] = [];
    if (filter.taskId !== undefined) {
      where.push("task_id = ?");
      values.push(filter.taskId);
    }
    if (filter.methodId !== undefined) {
      where.push("method_id = ?");
      values.push(filter.methodId);
    }
    if (filter.methodVersion !== undefined) {
      where.push("method_version = ?");
      values.push(filter.methodVersion);
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 500, 1000));
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT * FROM method_applications${clause} ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(...values, limit) as DbRow[];
    return rows.map(rowToMethodApplication);
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

  scrubConsolidationRuns(memories: Array<{ memoryId: string; content: string }>): number {
    if (memories.length === 0) return 0;
    const byId = new Map(memories.map((memory) => [memory.memoryId, memory.content]));
    const rows = this.db.prepare("SELECT * FROM memory_consolidation_runs").all() as DbRow[];
    let redacted = 0;
    for (const row of rows) {
      const groups = JSON.parse(String(row.groups_json)) as Array<Record<string, unknown>>;
      const sources = JSON.parse(String(row.sources_json)) as Array<Record<string, unknown>>;
      let changed = false;
      for (const source of sources) {
        const memoryId = typeof source.memoryId === "string" ? source.memoryId : null;
        if (!memoryId || !byId.has(memoryId)) continue;
        source.content = "[已遗忘]";
        source.sourceLabel = "[已遗忘]";
        changed = true;
      }
      for (const group of groups) {
        const ids = Array.isArray(group.sourceMemoryIds) ? group.sourceMemoryIds : [];
        if (!ids.some((id) => typeof id === "string" && byId.has(id))) continue;
        group.proposedContent = "[包含已遗忘记忆，正文已脱敏]";
        if (Array.isArray(group.conflicts)) group.conflicts = ["[包含已遗忘记忆]"];
        changed = true;
      }
      if (!changed) continue;
      let report = String(row.report);
      for (const content of byId.values()) report = report.split(content).join("[已遗忘]");
      this.db.prepare(
        "UPDATE memory_consolidation_runs SET groups_json = ?, sources_json = ?, report = ? WHERE id = ?"
      ).run(JSON.stringify(groups), JSON.stringify(sources), report, String(row.id));
      redacted += 1;
    }
    return redacted;
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

  latestDataEventSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS latest FROM events WHERE type NOT LIKE 'connection.%'").get() as DbRow;
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
      this.db.exec("DELETE FROM connection_outbox; DELETE FROM connection_sessions; DELETE FROM backup_records; DELETE FROM maintenance_runs; DELETE FROM task_leases; DELETE FROM sync_conflicts; DELETE FROM sync_peers; DELETE FROM heartbeat_runs; DELETE FROM attention_items; DELETE FROM standing_intents; DELETE FROM skill_curator_runs; DELETE FROM skill_usage_events; DELETE FROM skill_versions; DELETE FROM skills; DELETE FROM method_trials; DELETE FROM method_evaluations; DELETE FROM method_candidates; DELETE FROM memory_consolidation_runs; DELETE FROM memory_forget_tombstones; DELETE FROM memory_forget_receipts; DELETE FROM memory_recalls; DELETE FROM memory_conflicts; DELETE FROM memory_versions; DELETE FROM memories; DELETE FROM memory_settings; DELETE FROM suggestion_events; DELETE FROM suggestions; DELETE FROM proactive_settings; DELETE FROM desktop_commands; DELETE FROM desktop_frames; DELETE FROM desktop_sessions; DELETE FROM pairing_requests; DELETE FROM devices; DELETE FROM outbox_drafts; DELETE FROM source_items; DELETE FROM sources; DELETE FROM artifacts; DELETE FROM effects; DELETE FROM approvals; DELETE FROM runs; DELETE FROM tasks;");
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
      case "goal.created":
      case "goal.updated": return upsertGoal(this.db, event.payload as GoalContract);
      case "goal.completion.recorded": return insertGoalCompletionReport(this.db, event.payload as GoalCompletionReport);
      case "task.proposal.created":
      case "task.proposal.updated": return upsertTaskProposal(this.db, event.payload as TaskProposalRecord);
      case "task.follow-up.created":
      case "task.follow-up.updated": return upsertTaskFollowUp(this.db, event.payload as TaskFollowUpRecord);
      case "run.created": return insertRun(this.db, event.payload as RunRecord);
      case "run.updated": return updateRun(this.db, event.runId, event.payload as Record<string, unknown>);
      case "run.checkpoint.created": return insertRunCheckpoint(this.db, event.payload as RunCheckpointRecord);
      case "approval.created": return insertApproval(this.db, event.payload as ApprovalRecord);
      case "approval.updated": return updateApproval(this.db, event.payload as Record<string, unknown>);
      case "effect.created": return insertEffect(this.db, event.payload as EffectRecord);
      case "effect.updated": return updateEffect(this.db, event.payload as Record<string, unknown>);
      case "reconcile.opened":
      case "reconcile.updated":
      case "reconcile.resolved": return upsertReconcileItem(this.db, event.payload as ReconcileItem);
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
      case "memory.forgotten": {
        const receipt = event.payload as MemoryForgetReceipt;
        insertMemoryForgetReceiptRow(this.db, receipt);
        for (const tombstone of receipt.tombstones ?? []) insertMemoryForgetTombstoneRow(this.db, tombstone);
        return;
      }
      case "memory.consolidation.updated": return upsertMemoryConsolidationRun(this.db, event.payload as MemoryConsolidationRun);
      case "memory.conflict.created":
      case "memory.conflict.updated": return upsertMemoryConflict(this.db, event.payload as MemoryConflict);
      case "method.candidate.created":
      case "method.candidate.updated": return upsertMethodCandidate(this.db, event.payload as MethodCandidate);
      case "method.evaluation.recorded": return insertMethodEvaluationRow(this.db, event.payload as MethodEvaluation);
      case "method.trial.recorded": return insertMethodTrialRow(this.db, event.payload as MethodTrial);
      case "skill.updated": return upsertSkillRow(this.db, event.payload as SkillRecord);
      case "skill.version.recorded": return insertSkillVersionRow(this.db, event.payload as SkillVersion);
      case "skill.usage.recorded": return insertSkillUsageRow(this.db, event.payload as SkillUsageEvent);
      case "skill.curator.updated": return upsertSkillCuratorRunRow(this.db, event.payload as SkillCuratorRun);
      case "standing-intent.updated": return upsertStandingIntentRow(this.db, event.payload as StandingIntentRecord);
      case "attention.updated": return upsertAttentionItemRow(this.db, event.payload as AttentionItem);
      case "attention.feedback.recorded": {
        const feedback = event.payload as AttentionFeedbackRecord;
        this.db.prepare(`INSERT INTO attention_feedback
          (id, attention_id, kind, action, time_of_day, channel, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET action=excluded.action, time_of_day=excluded.time_of_day, channel=excluded.channel`)
          .run(feedback.id, feedback.attentionId, feedback.kind, feedback.action, feedback.timeOfDay, feedback.channel, feedback.createdAt);
        return;
      }
      case "heartbeat.recorded": return upsertHeartbeatRunRow(this.db, event.payload as HeartbeatRun);
      case "entity.created":
      case "entity.updated": return upsertEntityRow(this.db, event.payload as EntityRecord);
      case "entity.alias.upserted": return upsertEntityAliasRow(this.db, event.payload as EntityAliasRecord);
      case "relation.upserted": return upsertRelationRow(this.db, event.payload as RelationRecord);
      case "entity.state.upserted": return upsertEntityStateRow(this.db, event.payload as EntityStateRecord);
      case "decision.upserted": return upsertDecisionRow(this.db, event.payload as DecisionRecord);
      case "commitment.upserted": return upsertCommitmentRow(this.db, event.payload as CommitmentRecord);
      case "mention.recorded": return upsertMentionRow(this.db, event.payload as MentionRecord);
      case "context.pack.created": return upsertContextPackRow(this.db, event.payload as ContextPack);
      case "memory.entity.linked": {
        const link = event.payload as MemoryEntityLink;
        this.db.prepare("INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, relation) VALUES (?, ?, ?)")
          .run(link.memoryId, link.entityId, link.relation);
        return;
      }
      case "task.edge.upserted": return upsertTaskEdgeRow(this.db, event.payload as TaskEdge);
      case "prepared-action.updated": return upsertPreparedActionRow(this.db, event.payload as PreparedActionRecord);
      case "thread-subscription.updated": return upsertThreadSubscriptionRow(this.db, event.payload as ThreadSubscriptionRecord);
      case "tool.job.updated": return upsertBackgroundToolJobRow(this.db, event.payload as BackgroundToolJob);
      case "watchdog.recorded": return upsertWatchdogEventRow(this.db, event.payload as WatchdogEvent);
      case "intake.recorded": {
        const decision = event.payload as IntakeDecisionRecord;
        this.db.prepare(`INSERT INTO intake_decisions (id, source_ref, route, reason, confidence, created_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET route=excluded.route, reason=excluded.reason,
          confidence=excluded.confidence`).run(decision.id, decision.sourceRef, decision.route, decision.reason, decision.confidence, decision.createdAt);
        return;
      }
      case "sync.peer.created":
      case "sync.peer.updated": return upsertSyncPeer(this.db, event.payload as SyncPeer & { tokenCipher?: string | null });
      case "sync.conflict.created":
      case "sync.conflict.updated": return upsertSyncConflict(this.db, event.payload as SyncConflict);
      case "task.lease.updated": return upsertTaskLease(this.db, event.payload as TaskLease);
      case "connection.updated": return upsertConnectionSession(this.db, event.payload as ConnectionSession);
      case "connection.outbox.updated": return upsertConnectionOutboxItem(this.db, event.payload as ConnectionOutboxItem);
      case "delegation.created":
      case "delegation.leased":
      case "delegation.started":
      case "delegation.result.submitted":
      case "delegation.verified":
      case "delegation.rejected":
      case "delegation.failed":
      case "delegation.cancelled":
      case "delegation.retried":
      case "delegation.requeued":
      case "delegation.orphaned": {
        this.createDelegationJob(event.payload as DelegationJob);
        return;
      }
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
      case "schedule.created":
      case "schedule.updated":
      case "schedule.run.created":
      case "schedule.run.updated":
      case "task.progress":
      case "task.budget.exhausted":
      case "task.budget.extended":
      case "approval.expired":
      case "approval.auto_approved":
      case "approval.rejected":
      case "approval.policy_denied":
      case "approval.revalidation_failed":
      case "approval.escalation_required":
      case "chat.message.created":
      case "chat.message.updated":
      case "context.item.appended":
      case "context.summary.updated":
      case "context.settings.updated":
      case "context.task.deleted":
      case "execution.diagnosed":
      case "execution.handoff.prepared":
      case "execution.handoff.started":
      case "execution.handoff.completed":
      case "execution.handoff.failed":
      case "security.kill-switch.updated":
      case "security.audit": return;
      default: throw new Error(`Unknown event type: ${event.type}`);
    }
  }
}

function upsertTask(db: DatabaseSync, task: TaskRecord): void {
  db.prepare(
    `INSERT INTO tasks (id, external_ref, request_hash, template_id, title, goal, status, created_at, updated_at, deadline, inputs_json, network_hosts_json, output_dir, current_run_id, next_action, error_json, result_summary, conversation_id, executor_id, task_kind, expected_outputs_json, permissions_json, pending_input, method_id, method_version, pinned_at, archived_at, goal_id, budget_override_json, deleted_at, trash_batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       external_ref=excluded.external_ref, request_hash=excluded.request_hash,
       template_id=excluded.template_id, title=excluded.title, goal=excluded.goal, status=excluded.status,
       updated_at=excluded.updated_at, deadline=excluded.deadline, inputs_json=excluded.inputs_json,
       network_hosts_json=excluded.network_hosts_json, output_dir=excluded.output_dir,
       current_run_id=excluded.current_run_id, next_action=excluded.next_action, error_json=excluded.error_json,
       result_summary=excluded.result_summary, conversation_id=excluded.conversation_id,
       executor_id=excluded.executor_id, task_kind=excluded.task_kind,
       expected_outputs_json=excluded.expected_outputs_json, permissions_json=excluded.permissions_json,
       pending_input=excluded.pending_input, method_id=excluded.method_id, method_version=excluded.method_version,
        pinned_at=excluded.pinned_at, archived_at=excluded.archived_at, goal_id=excluded.goal_id,
        budget_override_json=excluded.budget_override_json, deleted_at=excluded.deleted_at,
        trash_batch_id=excluded.trash_batch_id`
  ).run(
    task.id, task.externalRef ?? null, task.requestHash ?? null,
    task.templateId, task.title, task.goal, task.status, task.createdAt, task.updatedAt,
    task.deadline, JSON.stringify(task.inputs), JSON.stringify(task.networkHosts), task.outputDir,
    task.currentRunId, task.nextAction, task.error ? JSON.stringify(task.error) : null,
    task.resultSummary ?? null, task.conversationId ?? null,
    task.executorId ?? "codex", task.taskKind ?? "general",
    JSON.stringify(task.expectedOutputs ?? ["result.md"]),
    task.permissions ? JSON.stringify(task.permissions) : null,
    task.pendingInput ?? null,
    task.methodId ?? null, task.methodVersion ?? null,
    task.pinnedAt ?? null, task.archivedAt ?? null, task.goalId ?? null,
    task.budgetOverride ? JSON.stringify(task.budgetOverride) : null,
    task.deletedAt ?? null, task.trashBatchId ?? null
  );
}

function upsertGoal(db: DatabaseSync, goal: GoalContract): void {
  db.prepare(
    `INSERT INTO goals (id, title, objective, constraints_json, forbidden_actions_json, authority_sources_json, success_criteria_json, evidence_requirements_json, budget_json, deadline, stop_conditions_json, review_policy, current_state, next_handoff, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, objective=excluded.objective, constraints_json=excluded.constraints_json,
       forbidden_actions_json=excluded.forbidden_actions_json, authority_sources_json=excluded.authority_sources_json,
       success_criteria_json=excluded.success_criteria_json, evidence_requirements_json=excluded.evidence_requirements_json,
       budget_json=excluded.budget_json, deadline=excluded.deadline, stop_conditions_json=excluded.stop_conditions_json,
       review_policy=excluded.review_policy, current_state=excluded.current_state, next_handoff=excluded.next_handoff,
       updated_at=excluded.updated_at`
  ).run(
    goal.goalId, goal.title, goal.objective, JSON.stringify(goal.constraints),
    JSON.stringify(goal.forbiddenActions), JSON.stringify(goal.authoritySources),
    JSON.stringify(goal.successCriteria), JSON.stringify(goal.evidenceRequirements),
    JSON.stringify(goal.budget), goal.deadline ?? null, JSON.stringify(goal.stopConditions),
    goal.reviewPolicy, goal.currentState, goal.nextHandoff ?? null, goal.createdAt, goal.updatedAt
  );
}

function insertGoalCompletionReport(db: DatabaseSync, report: GoalCompletionReport): void {
  db.prepare(
    `INSERT INTO goal_completion_reports (goal_id, task_id, verdict, summary, criteria_json, evidence_refs_json, missing_evidence_json, forbidden_actions_json, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(goal_id, task_id, checked_at) DO UPDATE SET
       verdict=excluded.verdict, summary=excluded.summary, criteria_json=excluded.criteria_json,
       evidence_refs_json=excluded.evidence_refs_json, missing_evidence_json=excluded.missing_evidence_json,
       forbidden_actions_json=excluded.forbidden_actions_json`
  ).run(
    report.goalId, report.taskId, report.verdict, report.summary,
    JSON.stringify(report.criteria), JSON.stringify(report.evidenceRefs),
    JSON.stringify(report.missingEvidence), JSON.stringify(report.forbiddenActions), report.checkedAt
  );
}

function updateTask(db: DatabaseSync, taskId: string | null, patch: Record<string, unknown>): void {
  if (!taskId) throw new Error("task.updated requires taskId");
  const columns: Record<string, string> = {
    title: "title", goal: "goal", status: "status", updatedAt: "updated_at",
    deadline: "deadline", currentRunId: "current_run_id", nextAction: "next_action",
    resultSummary: "result_summary", conversationId: "conversation_id",
    pendingInput: "pending_input", executorId: "executor_id", taskKind: "task_kind",
    methodId: "method_id", methodVersion: "method_version",
    pinnedAt: "pinned_at", archivedAt: "archived_at", goalId: "goal_id",
    deletedAt: "deleted_at", trashBatchId: "trash_batch_id"
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
  if ("budgetOverride" in patch) {
    db.prepare("UPDATE tasks SET budget_override_json = ? WHERE id = ?")
      .run(patch.budgetOverride ? JSON.stringify(patch.budgetOverride) : null, taskId);
  }
}

function insertRun(db: DatabaseSync, run: RunRecord): void {
  db.prepare(
    `INSERT INTO runs (id, task_id, attempt, status, thread_id, workspace, started_at, ended_at, failure_json, usage_json, lease_epoch, created_at, executor_id, checkpoint_seq, budget_json, parent_run_id, handoff_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    run.id, run.taskId, run.attempt, run.status, run.threadId, run.workspace,
    run.startedAt, run.endedAt, run.failure ? JSON.stringify(run.failure) : null,
    run.usage ? JSON.stringify(run.usage) : null, run.leaseEpoch, run.createdAt,
    run.executorId ?? "codex", run.checkpointSeq ?? 0,
    run.budget ? JSON.stringify(run.budget) : null,
    run.parentRunId ?? null,
    run.handoffId ?? null
  );
}

function updateRun(db: DatabaseSync, runId: string | null, patch: Record<string, unknown>): void {
  if (!runId) throw new Error("run.updated requires runId");
  const columns: Record<string, string> = {
    status: "status", threadId: "thread_id", startedAt: "started_at", endedAt: "ended_at",
    executorId: "executor_id", checkpointSeq: "checkpoint_seq",
    parentRunId: "parent_run_id", handoffId: "handoff_id"
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
    `INSERT INTO task_proposals (id, conversation_id, title, goal, executor_id, task_kind, expected_outputs_json, permissions_json, inputs_json, reason, status, expires_at, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, decided_at=excluded.decided_at`
  ).run(
    proposal.id, proposal.conversationId, proposal.title, proposal.goal, proposal.executorId,
    proposal.taskKind, JSON.stringify(proposal.expectedOutputs), JSON.stringify(proposal.permissions),
    JSON.stringify(proposal.inputs),
    proposal.reason, proposal.status, proposal.expiresAt, proposal.createdAt, proposal.decidedAt
  );
}

function upsertTaskFollowUp(db: DatabaseSync, followUp: TaskFollowUpRecord): void {
  db.prepare(
    `INSERT INTO task_follow_ups (id, task_id, conversation_id, content, mode, status, applied_run_id, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content=excluded.content, mode=excluded.mode, status=excluded.status,
       applied_run_id=excluded.applied_run_id, error=excluded.error, updated_at=excluded.updated_at`
  ).run(
    followUp.id, followUp.taskId, followUp.conversationId, followUp.content, followUp.mode,
    followUp.status, followUp.appliedRunId, followUp.error, followUp.createdAt, followUp.updatedAt
  );
}

function insertRunCheckpoint(db: DatabaseSync, checkpoint: RunCheckpointRecord): void {
  db.prepare(
    `INSERT INTO run_checkpoints (id, run_id, task_id, seq, kind, path, sha256, usage_json, created_at, proof_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, seq) DO UPDATE SET kind=excluded.kind, path=excluded.path, sha256=excluded.sha256, usage_json=excluded.usage_json, proof_json=excluded.proof_json`
  ).run(
    checkpoint.id, checkpoint.runId, checkpoint.taskId, checkpoint.seq, checkpoint.kind,
    checkpoint.path, checkpoint.sha256, checkpoint.usage ? JSON.stringify(checkpoint.usage) : null,
    checkpoint.createdAt, checkpoint.proof ? JSON.stringify(checkpoint.proof) : null
  );
}

function insertApproval(db: DatabaseSync, approval: ApprovalRecord): void {
  db.prepare(
    `INSERT INTO approvals (id, task_id, run_id, kind, summary, target_json, preview_json, parameter_hash, status, expires_at, decided_at, effect_id, created_at,
       goal_id, action_digest, permission_mode, context, max_uses, used_count, approved_by, issued_at, revoked_at, action_json, rejection_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    approval.id, approval.taskId, approval.runId, approval.kind, approval.summary,
    JSON.stringify(approval.target), JSON.stringify(approval.preview), approval.parameterHash,
    approval.status, approval.expiresAt, approval.decidedAt, approval.effectId, approval.createdAt,
    approval.goalId ?? null, approval.actionDigest ?? null, approval.permissionMode ?? null,
    approval.context ?? null, approval.maxUses ?? 1, approval.usedCount ?? 0,
    approval.approvedBy ?? null, approval.issuedAt ?? approval.createdAt, approval.revokedAt ?? null,
    approval.action ? JSON.stringify(approval.action) : null, approval.rejectionCount ?? 0
  );
}

function updateApproval(db: DatabaseSync, patch: Record<string, unknown>): void {
  const id = String(patch.id);
  const columns: Record<string, string> = {
    status: "status",
    decidedAt: "decided_at",
    effectId: "effect_id",
    goalId: "goal_id",
    actionDigest: "action_digest",
    permissionMode: "permission_mode",
    context: "context",
    maxUses: "max_uses",
    usedCount: "used_count",
    approvedBy: "approved_by",
    issuedAt: "issued_at",
    revokedAt: "revoked_at",
    rejectionCount: "rejection_count"
  };
  for (const [key, column] of Object.entries(columns)) {
    if (key in patch) db.prepare(`UPDATE approvals SET ${column} = ? WHERE id = ?`).run((patch[key] as SQLInputValue) ?? null, id);
  }
  if ("action" in patch) {
    const action = patch.action as ApprovalRecord["action"];
    db.prepare("UPDATE approvals SET action_json = ? WHERE id = ?").run(action ? JSON.stringify(action) : null, id);
  }
}

function insertEffect(db: DatabaseSync, effect: EffectRecord): void {
  db.prepare(
    `INSERT INTO effects (id, task_id, approval_id, kind, idempotency_key, status, target_json, receipt_json, error, created_at, updated_at,
       goal_id, effect_type, replay_policy, action_digest, resolved_action_digest, attempt_count, max_attempts,
       lease_owner, lease_expires_at, available_at, provider, provider_ref, reconcile_ref, reconciled_at, target_key, suspend_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    effect.id, effect.taskId, effect.approvalId, effect.kind, effect.idempotencyKey,
    effect.status, JSON.stringify(effect.target), effect.receipt ? JSON.stringify(effect.receipt) : null,
    effect.error, effect.createdAt, effect.updatedAt,
    effect.goalId ?? null, effect.effectType ?? effect.kind, effect.replayPolicy ?? "never_replay",
    effect.actionDigest ?? null, effect.resolvedActionDigest ?? null,
    effect.attemptCount ?? 0, effect.maxAttempts ?? 1,
    effect.leaseOwner ?? null, effect.leaseExpiresAt ?? null,
    effect.availableAt ?? effect.createdAt, effect.provider ?? null, effect.providerRef ?? null,
    effect.reconcileRef ?? null, effect.reconciledAt ?? null, effect.targetKey ?? null,
    effect.suspendReason ?? null
  );
}

function updateEffect(db: DatabaseSync, patch: Record<string, unknown>): void {
  const id = String(patch.id);
  const columns: Record<string, string> = {
    status: "status",
    error: "error",
    updatedAt: "updated_at",
    goalId: "goal_id",
    effectType: "effect_type",
    replayPolicy: "replay_policy",
    actionDigest: "action_digest",
    resolvedActionDigest: "resolved_action_digest",
    attemptCount: "attempt_count",
    maxAttempts: "max_attempts",
    leaseOwner: "lease_owner",
    leaseExpiresAt: "lease_expires_at",
    availableAt: "available_at",
    provider: "provider",
    providerRef: "provider_ref",
    reconcileRef: "reconcile_ref",
    reconciledAt: "reconciled_at",
    targetKey: "target_key",
    suspendReason: "suspend_reason"
  };
  for (const [key, column] of Object.entries(columns)) {
    if (key in patch) db.prepare(`UPDATE effects SET ${column} = ? WHERE id = ?`).run((patch[key] as SQLInputValue) ?? null, id);
  }
  if ("receipt" in patch) {
    const receipt = patch.receipt as EffectRecord["receipt"];
    db.prepare("UPDATE effects SET receipt_json = ? WHERE id = ?").run(receipt ? JSON.stringify(receipt) : null, id);
  }
}

function upsertReconcileItem(db: DatabaseSync, item: ReconcileItem): void {
  db.prepare(
    `INSERT INTO reconcile_queue (id, effect_id, task_id, goal_id, target_key, summary, status, reason,
       attempted_json, risk, suggested_actions_json, provider, check_count, resolution_note, created_at, updated_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status=excluded.status, reason=excluded.reason, attempted_json=excluded.attempted_json,
       risk=excluded.risk, suggested_actions_json=excluded.suggested_actions_json,
       provider=excluded.provider, check_count=excluded.check_count,
       resolution_note=excluded.resolution_note, updated_at=excluded.updated_at,
       resolved_at=excluded.resolved_at`
  ).run(
    item.id, item.effectId, item.taskId, item.goalId, item.targetKey, item.summary,
    item.status, item.reason, JSON.stringify(item.attempted), item.risk,
    JSON.stringify(item.suggestedActions), item.provider, item.checkCount,
    item.resolutionNote, item.createdAt, item.updatedAt, item.resolvedAt
  );
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
    displayName: "display_name", account: "account", provider: "provider", rootPath: "root_path", status: "status",
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

function rowToSkill(row: DbRow): SkillRecord {
  return {
    id: String(row.id),
    methodId: row.method_id == null ? null : String(row.method_id),
    methodVersion: row.method_version == null ? null : Number(row.method_version),
    name: String(row.name),
    version: String(row.version),
    status: String(row.status) as SkillRecord["status"],
    pinned: Number(row.pinned) === 1,
    path: String(row.path),
    contentHash: String(row.content_hash),
    manifest: JSON.parse(String(row.manifest_json)),
    origin: String(row.origin) as SkillRecord["origin"],
    sourceTaskIds: JSON.parse(String(row.source_task_ids_json)),
    trialTaskIds: JSON.parse(String(row.trial_task_ids_json ?? "[]")),
    previousVersionId: row.previous_version_id == null ? null : String(row.previous_version_id),
    changeReport: String(row.change_report),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    adoptedAt: row.adopted_at == null ? null : String(row.adopted_at),
    lastUsedAt: row.last_used_at == null ? null : String(row.last_used_at),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
    archiveReason: row.archive_reason == null ? null : String(row.archive_reason),
    previousStatus: row.previous_status == null ? null : String(row.previous_status) as SkillRecord["previousStatus"]
  };
}

function upsertSkillRow(db: DatabaseSync, skill: SkillRecord): void {
  db.prepare(
    `INSERT INTO skills
     (id, method_id, method_version, name, version, status, pinned, path, content_hash, manifest_json, origin,
      source_task_ids_json, trial_task_ids_json, previous_version_id, change_report, created_at, updated_at, adopted_at,
      last_used_at, archived_at, archive_reason, previous_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET method_id=excluded.method_id, method_version=excluded.method_version, name=excluded.name,
      version=excluded.version, status=excluded.status, pinned=excluded.pinned, path=excluded.path,
      content_hash=excluded.content_hash, manifest_json=excluded.manifest_json, origin=excluded.origin,
      source_task_ids_json=excluded.source_task_ids_json, trial_task_ids_json=excluded.trial_task_ids_json,
      previous_version_id=excluded.previous_version_id,
      change_report=excluded.change_report, updated_at=excluded.updated_at, adopted_at=excluded.adopted_at,
      last_used_at=excluded.last_used_at, archived_at=excluded.archived_at,
      archive_reason=excluded.archive_reason, previous_status=excluded.previous_status`
  ).run(
    skill.id, skill.methodId, skill.methodVersion, skill.name, skill.version, skill.status, skill.pinned ? 1 : 0,
    skill.path, skill.contentHash, JSON.stringify(skill.manifest), skill.origin,
    JSON.stringify(skill.sourceTaskIds), JSON.stringify(skill.trialTaskIds), skill.previousVersionId, skill.changeReport,
    skill.createdAt, skill.updatedAt, skill.adoptedAt, skill.lastUsedAt, skill.archivedAt,
    skill.archiveReason, skill.previousStatus
  );
}

function rowToSkillVersion(row: DbRow): SkillVersion {
  return {
    id: String(row.id),
    skillId: String(row.skill_id),
    version: String(row.version),
    manifest: JSON.parse(String(row.manifest_json)),
    contentHash: String(row.content_hash),
    path: String(row.path),
    methodId: row.method_id == null ? null : String(row.method_id),
    methodVersion: row.method_version == null ? null : Number(row.method_version),
    changeReport: String(row.change_report),
    createdAt: String(row.created_at)
  };
}

function insertSkillVersionRow(db: DatabaseSync, version: SkillVersion): void {
  db.prepare(
    `INSERT INTO skill_versions
     (id, skill_id, version, manifest_json, content_hash, path, method_id, method_version, change_report, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET manifest_json=excluded.manifest_json,
      content_hash=excluded.content_hash, path=excluded.path, change_report=excluded.change_report`
  ).run(
    version.id, version.skillId, version.version, JSON.stringify(version.manifest),
    version.contentHash, version.path, version.methodId, version.methodVersion,
    version.changeReport, version.createdAt
  );
}

function rowToSkillUsage(row: DbRow): SkillUsageEvent {
  return {
    id: String(row.id),
    skillId: String(row.skill_id),
    taskId: row.task_id == null ? null : String(row.task_id),
    runId: row.run_id == null ? null : String(row.run_id),
    status: String(row.status) as SkillUsageEvent["status"],
    source: String(row.source) as SkillUsageEvent["source"],
    note: String(row.note),
    createdAt: String(row.created_at)
  };
}

function insertSkillUsageRow(db: DatabaseSync, usage: SkillUsageEvent): void {
  db.prepare(
    `INSERT INTO skill_usage_events (id, skill_id, task_id, run_id, status, source, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, source=excluded.source, note=excluded.note`
  ).run(usage.id, usage.skillId, usage.taskId, usage.runId, usage.status, usage.source, usage.note, usage.createdAt);
}

function rowToSkillCuratorRun(row: DbRow): SkillCuratorRun {
  return {
    id: String(row.id),
    status: String(row.status) as SkillCuratorRun["status"],
    dryRun: Number(row.dry_run) === 1,
    startedAt: String(row.started_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
    actions: JSON.parse(String(row.actions_json)),
    backupPath: row.backup_path == null ? null : String(row.backup_path),
    report: String(row.report),
    rolledBackAt: row.rolled_back_at == null ? null : String(row.rolled_back_at)
  };
}

function upsertSkillCuratorRunRow(db: DatabaseSync, run: SkillCuratorRun): void {
  db.prepare(
    `INSERT INTO skill_curator_runs (id, status, dry_run, started_at, ended_at, actions_json, backup_path, report, rolled_back_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, dry_run=excluded.dry_run, ended_at=excluded.ended_at,
       actions_json=excluded.actions_json, backup_path=excluded.backup_path, report=excluded.report,
       rolled_back_at=excluded.rolled_back_at`
  ).run(
    run.id, run.status, run.dryRun ? 1 : 0, run.startedAt, run.endedAt,
    JSON.stringify(run.actions), run.backupPath, run.report, run.rolledBackAt
  );
}

function rowToStandingIntent(row: DbRow): StandingIntentRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    description: String(row.description),
    triggerEntries: JSON.parse(String(row.trigger_entries_json)) as StandingIntentRecord["triggerEntries"],
    scope: JSON.parse(String(row.scope_json)) as StandingIntentRecord["scope"],
    action: String(row.action) as StandingIntentRecord["action"],
    cooldownSeconds: Number(row.cooldown_seconds),
    maxFires: Number(row.max_fires),
    fireCount: Number(row.fire_count),
    state: String(row.state) as StandingIntentRecord["state"],
    expiresAt: String(row.expires_at),
    lastFiredAt: row.last_fired_at == null ? null : String(row.last_fired_at),
    lastMatchedAt: row.last_matched_at == null ? null : String(row.last_matched_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function upsertStandingIntentRow(db: DatabaseSync, intent: StandingIntentRecord): void {
  db.prepare(
    `INSERT INTO standing_intents
     (id, owner_id, description, trigger_entries_json, scope_json, action, cooldown_seconds,
      max_fires, fire_count, state, expires_at, last_fired_at, last_matched_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, description=excluded.description,
       trigger_entries_json=excluded.trigger_entries_json, scope_json=excluded.scope_json,
       action=excluded.action, cooldown_seconds=excluded.cooldown_seconds, max_fires=excluded.max_fires,
       fire_count=excluded.fire_count, state=excluded.state, expires_at=excluded.expires_at,
       last_fired_at=excluded.last_fired_at, last_matched_at=excluded.last_matched_at,
       updated_at=excluded.updated_at`
  ).run(
    intent.id, intent.ownerId, intent.description, JSON.stringify(intent.triggerEntries),
    JSON.stringify(intent.scope), intent.action, intent.cooldownSeconds, intent.maxFires,
    intent.fireCount, intent.state, intent.expiresAt, intent.lastFiredAt, intent.lastMatchedAt,
    intent.createdAt, intent.updatedAt
  );
}

function normalizeOntologyText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function rowToEntity(row: DbRow): EntityRecord {
  return {
    id: String(row.id), kind: String(row.kind) as EntityRecord["kind"],
    canonicalName: String(row.canonical_name), status: String(row.status) as EntityRecord["status"],
    sensitivity: String(row.sensitivity) as EntityRecord["sensitivity"],
    confidence: String(row.confidence) as EntityRecord["confidence"],
    mergedInto: row.merged_into == null ? null : String(row.merged_into),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function upsertEntityRow(db: DatabaseSync, entity: EntityRecord): void {
  db.prepare(`INSERT INTO entities
    (id, kind, canonical_name, status, sensitivity, confidence, merged_into, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, canonical_name=excluded.canonical_name,
      status=excluded.status, sensitivity=excluded.sensitivity, confidence=excluded.confidence,
      merged_into=excluded.merged_into, updated_at=excluded.updated_at`)
    .run(entity.id, entity.kind, entity.canonicalName, entity.status, entity.sensitivity,
      entity.confidence, entity.mergedInto, entity.createdAt, entity.updatedAt);
}

function rowToEntityAlias(row: DbRow): EntityAliasRecord {
  return {
    id: String(row.id), entityId: String(row.entity_id), alias: String(row.alias),
    normalized: String(row.normalized), sourceKind: String(row.source_kind),
    confidence: String(row.confidence) as EntityAliasRecord["confidence"], createdAt: String(row.created_at)
  };
}

function upsertEntityAliasRow(db: DatabaseSync, alias: EntityAliasRecord): void {
  db.prepare(`INSERT INTO entity_aliases
    (id, entity_id, alias, normalized, source_kind, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_id, normalized) DO UPDATE SET alias=excluded.alias,
      source_kind=excluded.source_kind, confidence=excluded.confidence`)
    .run(alias.id, alias.entityId, alias.alias, alias.normalized, alias.sourceKind, alias.confidence, alias.createdAt);
}

function rowToRelation(row: DbRow): RelationRecord {
  return {
    id: String(row.id), fromEntityId: String(row.from_entity_id), predicate: String(row.predicate),
    toEntityId: String(row.to_entity_id), confidence: String(row.confidence) as RelationRecord["confidence"],
    validFrom: row.valid_from == null ? null : String(row.valid_from),
    validTo: row.valid_to == null ? null : String(row.valid_to), recordedAt: String(row.recorded_at),
    evidenceRefs: JSON.parse(String(row.evidence_refs_json)) as string[],
    supersededBy: row.superseded_by == null ? null : String(row.superseded_by)
  };
}

function upsertRelationRow(db: DatabaseSync, relation: RelationRecord): void {
  db.prepare(`INSERT INTO relations
    (id, from_entity_id, predicate, to_entity_id, confidence, valid_from, valid_to, recorded_at, evidence_refs_json, superseded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET confidence=excluded.confidence, valid_from=excluded.valid_from,
      valid_to=excluded.valid_to, evidence_refs_json=excluded.evidence_refs_json, superseded_by=excluded.superseded_by`)
    .run(relation.id, relation.fromEntityId, relation.predicate, relation.toEntityId, relation.confidence,
      relation.validFrom, relation.validTo, relation.recordedAt, JSON.stringify(relation.evidenceRefs), relation.supersededBy);
}

function rowToEntityState(row: DbRow): EntityStateRecord {
  return {
    id: String(row.id), entityId: String(row.entity_id), key: String(row.key),
    value: JSON.parse(String(row.value_json)) as unknown,
    confidence: String(row.confidence) as EntityStateRecord["confidence"],
    validFrom: String(row.valid_from), validTo: row.valid_to == null ? null : String(row.valid_to),
    recordedAt: String(row.recorded_at), sourceRef: row.source_ref == null ? null : String(row.source_ref),
    evidenceRefs: JSON.parse(String(row.evidence_refs_json)) as string[],
    supersededBy: row.superseded_by == null ? null : String(row.superseded_by)
  };
}

function upsertEntityStateRow(db: DatabaseSync, state: EntityStateRecord): void {
  db.prepare(`INSERT INTO entity_states
    (id, entity_id, key, value_json, confidence, valid_from, valid_to, recorded_at, source_ref, evidence_refs_json, superseded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json, confidence=excluded.confidence,
      valid_from=excluded.valid_from, valid_to=excluded.valid_to, source_ref=excluded.source_ref,
      evidence_refs_json=excluded.evidence_refs_json, superseded_by=excluded.superseded_by`)
    .run(state.id, state.entityId, state.key, JSON.stringify(state.value), state.confidence,
      state.validFrom, state.validTo, state.recordedAt, state.sourceRef, JSON.stringify(state.evidenceRefs), state.supersededBy);
}

function rowToDecision(row: DbRow): DecisionRecord {
  return {
    id: String(row.id), subjectEntityId: row.subject_entity_id == null ? null : String(row.subject_entity_id),
    goalId: row.goal_id == null ? null : String(row.goal_id), taskId: row.task_id == null ? null : String(row.task_id),
    title: String(row.title), decision: String(row.decision), rationale: row.rationale == null ? null : String(row.rationale),
    alternatives: JSON.parse(String(row.alternatives_json)) as string[],
    decidedBy: String(row.decided_by) as DecisionRecord["decidedBy"], decidedAt: String(row.decided_at),
    status: String(row.status) as DecisionRecord["status"],
    supersededBy: row.superseded_by == null ? null : String(row.superseded_by),
    evidenceRefs: JSON.parse(String(row.evidence_refs_json)) as string[]
  };
}

function upsertDecisionRow(db: DatabaseSync, decision: DecisionRecord): void {
  db.prepare(`INSERT INTO decisions
    (id, subject_entity_id, goal_id, task_id, title, decision, rationale, alternatives_json, decided_by, decided_at, status, superseded_by, evidence_refs_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET subject_entity_id=excluded.subject_entity_id, goal_id=excluded.goal_id,
      task_id=excluded.task_id, title=excluded.title, decision=excluded.decision, rationale=excluded.rationale,
      alternatives_json=excluded.alternatives_json, status=excluded.status, superseded_by=excluded.superseded_by,
      evidence_refs_json=excluded.evidence_refs_json`)
    .run(decision.id, decision.subjectEntityId, decision.goalId, decision.taskId, decision.title, decision.decision,
      decision.rationale, JSON.stringify(decision.alternatives), decision.decidedBy, decision.decidedAt,
      decision.status, decision.supersededBy, JSON.stringify(decision.evidenceRefs));
}

function rowToCommitment(row: DbRow): CommitmentRecord {
  return {
    id: String(row.id), entityId: row.entity_id == null ? null : String(row.entity_id),
    counterpartyEntityId: row.counterparty_entity_id == null ? null : String(row.counterparty_entity_id),
    goalId: row.goal_id == null ? null : String(row.goal_id), taskId: row.task_id == null ? null : String(row.task_id),
    description: String(row.description), dueAt: row.due_at == null ? null : String(row.due_at),
    status: String(row.status) as CommitmentRecord["status"], confidence: String(row.confidence) as CommitmentRecord["confidence"],
    sourceRef: row.source_ref == null ? null : String(row.source_ref),
    evidenceRefs: JSON.parse(String(row.evidence_refs_json)) as string[],
    fulfilledAt: row.fulfilled_at == null ? null : String(row.fulfilled_at),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function upsertCommitmentRow(db: DatabaseSync, commitment: CommitmentRecord): void {
  db.prepare(`INSERT INTO commitments
    (id, entity_id, counterparty_entity_id, goal_id, task_id, description, due_at, status, confidence,
     source_ref, evidence_refs_json, fulfilled_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET entity_id=excluded.entity_id, counterparty_entity_id=excluded.counterparty_entity_id,
      goal_id=excluded.goal_id, task_id=excluded.task_id, description=excluded.description, due_at=excluded.due_at,
      status=excluded.status, confidence=excluded.confidence, source_ref=excluded.source_ref,
      evidence_refs_json=excluded.evidence_refs_json, fulfilled_at=excluded.fulfilled_at, updated_at=excluded.updated_at`)
    .run(commitment.id, commitment.entityId, commitment.counterpartyEntityId, commitment.goalId, commitment.taskId,
      commitment.description, commitment.dueAt, commitment.status, commitment.confidence, commitment.sourceRef,
      JSON.stringify(commitment.evidenceRefs), commitment.fulfilledAt, commitment.createdAt, commitment.updatedAt);
}

function rowToMention(row: DbRow): MentionRecord {
  return {
    id: String(row.id), surface: String(row.surface), normalized: String(row.normalized),
    entityId: row.entity_id == null ? null : String(row.entity_id),
    conversationId: row.conversation_id == null ? null : String(row.conversation_id),
    taskId: row.task_id == null ? null : String(row.task_id), messageId: row.message_id == null ? null : String(row.message_id),
    resolution: String(row.resolution) as MentionRecord["resolution"],
    candidates: JSON.parse(String(row.candidates_json)) as MentionRecord["candidates"],
    confidence: Number(row.confidence), createdAt: String(row.created_at)
  };
}

function upsertMentionRow(db: DatabaseSync, mention: MentionRecord): void {
  db.prepare(`INSERT INTO mentions
    (id, surface, normalized, entity_id, conversation_id, task_id, message_id, resolution, candidates_json, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET entity_id=excluded.entity_id, resolution=excluded.resolution,
      candidates_json=excluded.candidates_json, confidence=excluded.confidence`)
    .run(mention.id, mention.surface, mention.normalized, mention.entityId, mention.conversationId,
      mention.taskId, mention.messageId, mention.resolution, JSON.stringify(mention.candidates), mention.confidence, mention.createdAt);
}

function rowToContextPack(row: DbRow): Omit<ContextPack, "items"> {
  return {
    id: String(row.id), scopeKind: String(row.scope_kind) as ContextPack["scopeKind"],
    scopeId: String(row.scope_id), goalId: row.goal_id == null ? null : String(row.goal_id),
    taskId: row.task_id == null ? null : String(row.task_id),
    conversationId: row.conversation_id == null ? null : String(row.conversation_id),
    hash: String(row.hash), budgetTokens: Number(row.budget_tokens), usedTokens: Number(row.used_tokens),
    omitted: JSON.parse(String(row.omitted_json)) as string[],
    parentPackId: row.parent_pack_id == null ? null : String(row.parent_pack_id),
    createdAt: String(row.created_at)
  };
}

function rowToContextPackItem(row: DbRow): ContextPackItem {
  return {
    packId: String(row.pack_id), ref: String(row.ref), lane: String(row.lane) as ContextPackItem["lane"],
    sourceKind: String(row.source_kind), sourceId: String(row.source_id), title: String(row.title),
    summary: String(row.summary), confidence: String(row.confidence) as ContextPackItem["confidence"],
    source: String(row.source), validUntil: row.valid_until == null ? null : String(row.valid_until),
    reason: String(row.reason), score: Number(row.score), tokens: Number(row.tokens),
    expandable: Number(row.expandable) === 1
  };
}

function upsertContextPackRow(db: DatabaseSync, pack: ContextPack): void {
  db.prepare(`INSERT INTO context_packs
    (id, scope_kind, scope_id, goal_id, task_id, conversation_id, hash, budget_tokens, used_tokens, omitted_json, parent_pack_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET hash=excluded.hash, budget_tokens=excluded.budget_tokens,
      used_tokens=excluded.used_tokens, omitted_json=excluded.omitted_json`)
    .run(pack.id, pack.scopeKind, pack.scopeId, pack.goalId, pack.taskId, pack.conversationId,
      pack.hash, pack.budgetTokens, pack.usedTokens, JSON.stringify(pack.omitted), pack.parentPackId, pack.createdAt);
  db.prepare("DELETE FROM context_pack_items WHERE pack_id = ?").run(pack.id);
  const insert = db.prepare(`INSERT INTO context_pack_items
    (pack_id, ref, lane, source_kind, source_id, title, summary, confidence, source, valid_until, reason, score, tokens, expandable)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const item of pack.items) {
    insert.run(item.packId, item.ref, item.lane, item.sourceKind, item.sourceId, item.title, item.summary,
      item.confidence, item.source, item.validUntil, item.reason, item.score, item.tokens, item.expandable ? 1 : 0);
  }
}

function rowToTaskEdge(row: DbRow): TaskEdge {
  return {
    parentTaskId: String(row.parent_task_id), childTaskId: String(row.child_task_id),
    kind: String(row.kind) as TaskEdge["kind"], joinPolicy: String(row.join_policy) as TaskEdge["joinPolicy"],
    requiredCount: Number(row.required_count), createdAt: String(row.created_at)
  };
}

function upsertTaskEdgeRow(db: DatabaseSync, edge: TaskEdge): void {
  db.prepare(`INSERT INTO task_edges
    (parent_task_id, child_task_id, kind, join_policy, required_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(parent_task_id, child_task_id) DO UPDATE SET kind=excluded.kind,
      join_policy=excluded.join_policy, required_count=excluded.required_count`)
    .run(edge.parentTaskId, edge.childTaskId, edge.kind, edge.joinPolicy, edge.requiredCount, edge.createdAt);
}

function rowToPreparedAction(row: DbRow): PreparedActionRecord {
  return {
    id: String(row.id), taskId: row.task_id == null ? null : String(row.task_id),
    goalId: row.goal_id == null ? null : String(row.goal_id), kind: String(row.kind) as PreparedActionRecord["kind"],
    actionDigest: String(row.action_digest), preview: JSON.parse(String(row.preview_json)) as Record<string, unknown>,
    status: String(row.status) as PreparedActionRecord["status"],
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    evidenceRefs: JSON.parse(String(row.evidence_refs_json)) as string[],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function upsertPreparedActionRow(db: DatabaseSync, action: PreparedActionRecord): void {
  db.prepare(`INSERT INTO prepared_actions
    (id, task_id, goal_id, kind, action_digest, preview_json, status, expires_at, evidence_refs_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET preview_json=excluded.preview_json, status=excluded.status,
      expires_at=excluded.expires_at, evidence_refs_json=excluded.evidence_refs_json, updated_at=excluded.updated_at`)
    .run(action.id, action.taskId, action.goalId, action.kind, action.actionDigest, JSON.stringify(action.preview),
      action.status, action.expiresAt, JSON.stringify(action.evidenceRefs), action.createdAt, action.updatedAt);
}

function rowToThreadSubscription(row: DbRow): ThreadSubscriptionRecord {
  return {
    id: String(row.id), threadKey: String(row.thread_key), taskId: String(row.task_id),
    runId: row.run_id == null ? null : String(row.run_id), cursor: row.cursor == null ? null : String(row.cursor),
    filter: JSON.parse(String(row.filter_json)) as Record<string, unknown>,
    status: String(row.status) as ThreadSubscriptionRecord["status"],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function upsertThreadSubscriptionRow(db: DatabaseSync, subscription: ThreadSubscriptionRecord): void {
  db.prepare(`INSERT INTO thread_subscriptions
    (id, thread_key, task_id, run_id, cursor, filter_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_key, task_id) DO UPDATE SET run_id=excluded.run_id, cursor=excluded.cursor,
      filter_json=excluded.filter_json, status=excluded.status, updated_at=excluded.updated_at`)
    .run(subscription.id, subscription.threadKey, subscription.taskId, subscription.runId, subscription.cursor,
      JSON.stringify(subscription.filter), subscription.status, subscription.createdAt, subscription.updatedAt);
}

function rowToBackgroundToolJob(row: DbRow): BackgroundToolJob {
  return {
    id: String(row.id), taskId: String(row.task_id), runId: row.run_id == null ? null : String(row.run_id),
    toolName: String(row.tool_name), args: JSON.parse(String(row.args_json)) as Record<string, unknown>,
    status: String(row.status) as BackgroundToolJob["status"], output: String(row.output),
    outputRef: row.output_ref == null ? null : String(row.output_ref),
    exitCode: row.exit_code == null ? null : Number(row.exit_code), stopReason: row.stop_reason == null ? null : String(row.stop_reason),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), finishedAt: row.finished_at == null ? null : String(row.finished_at)
  };
}

function upsertBackgroundToolJobRow(db: DatabaseSync, job: BackgroundToolJob): void {
  db.prepare(`INSERT INTO background_tool_jobs
    (id, task_id, run_id, tool_name, args_json, status, output, output_ref, exit_code, stop_reason, created_at, updated_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, output=excluded.output, output_ref=excluded.output_ref,
      exit_code=excluded.exit_code, stop_reason=excluded.stop_reason, updated_at=excluded.updated_at, finished_at=excluded.finished_at`)
    .run(job.id, job.taskId, job.runId, job.toolName, JSON.stringify(job.args), job.status, job.output,
      job.outputRef, job.exitCode, job.stopReason, job.createdAt, job.updatedAt, job.finishedAt);
}

function rowToWatchdogEvent(row: DbRow): WatchdogEvent {
  return {
    id: String(row.id), taskId: row.task_id == null ? null : String(row.task_id),
    runId: row.run_id == null ? null : String(row.run_id), reason: String(row.reason), detail: String(row.detail),
    action: String(row.action) as WatchdogEvent["action"],
    evidenceRefs: JSON.parse(String(row.evidence_refs_json)) as string[], createdAt: String(row.created_at)
  };
}

function upsertWatchdogEventRow(db: DatabaseSync, event: WatchdogEvent): void {
  db.prepare(`INSERT INTO watchdog_events (id, task_id, run_id, reason, detail, action, evidence_refs_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET detail=excluded.detail, action=excluded.action`)
    .run(event.id, event.taskId, event.runId, event.reason, event.detail, event.action, JSON.stringify(event.evidenceRefs), event.createdAt);
}

function rowToAttentionFeedback(row: DbRow): AttentionFeedbackRecord {
  return {
    id: String(row.id), attentionId: String(row.attention_id), kind: String(row.kind),
    action: String(row.action) as AttentionFeedbackRecord["action"], timeOfDay: String(row.time_of_day),
    channel: String(row.channel), createdAt: String(row.created_at)
  };
}

function rowToIntakeDecision(row: DbRow): IntakeDecisionRecord {
  return {
    id: String(row.id), sourceRef: String(row.source_ref), route: String(row.route) as IntakeDecisionRecord["route"],
    reason: String(row.reason), confidence: Number(row.confidence), createdAt: String(row.created_at)
  };
}

function rowToAttentionItem(row: DbRow): AttentionItem {
  return {
    id: String(row.id),
    dedupeKey: String(row.dedupe_key),
    kind: String(row.kind) as AttentionItem["kind"],
    priority: Number(row.priority),
    critical: Number(row.critical) === 1,
    title: String(row.title),
    waitingOn: String(row.waiting_on) as AttentionItem["waitingOn"],
    waitingSince: String(row.waiting_since),
    nextAction: String(row.next_action),
    consequence: String(row.consequence),
    whyNow: String(row.why_now),
    goalId: row.goal_id == null ? null : String(row.goal_id),
    taskId: row.task_id == null ? null : String(row.task_id),
    intentId: row.intent_id == null ? null : String(row.intent_id),
    source: String(row.source),
    status: String(row.status) as AttentionItem["status"],
    snoozeUntil: row.snooze_until == null ? null : String(row.snooze_until),
    entityId: row.entity_id == null ? null : String(row.entity_id),
    evidenceRefs: row.evidence_refs_json == null ? [] : JSON.parse(String(row.evidence_refs_json)) as string[],
    options: row.options_json == null ? [] : JSON.parse(String(row.options_json)) as NonNullable<AttentionItem["options"]>,
    ...(row.impact == null ? {} : { impact: Number(row.impact) }),
    ...(row.urgency == null ? {} : { urgency: Number(row.urgency) }),
    ...(row.confidence == null ? {} : { confidence: Number(row.confidence) }),
    ...(row.reversibility == null ? {} : { reversibility: String(row.reversibility) as NonNullable<AttentionItem["reversibility"]> }),
    ...(row.blast_radius == null ? {} : { blastRadius: String(row.blast_radius) as NonNullable<AttentionItem["blastRadius"]> }),
    ...(row.score == null ? {} : { score: Number(row.score) }),
    aggregationKey: row.aggregation_key == null ? null : String(row.aggregation_key),
    shadowed: Number(row.shadowed ?? 0) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function upsertAttentionItemRow(db: DatabaseSync, item: AttentionItem): void {
  db.prepare(
    `INSERT INTO attention_items
     (id, dedupe_key, kind, priority, critical, title, waiting_on, waiting_since, next_action,
      consequence, why_now, goal_id, task_id, intent_id, source, status, snooze_until,
      entity_id, evidence_refs_json, options_json, impact, urgency, confidence, reversibility,
      blast_radius, score, aggregation_key, shadowed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET dedupe_key=excluded.dedupe_key, kind=excluded.kind,
       priority=excluded.priority, critical=excluded.critical, title=excluded.title,
       waiting_on=excluded.waiting_on, waiting_since=excluded.waiting_since,
       next_action=excluded.next_action, consequence=excluded.consequence, why_now=excluded.why_now,
       goal_id=excluded.goal_id, task_id=excluded.task_id, intent_id=excluded.intent_id,
       source=excluded.source, status=excluded.status, snooze_until=excluded.snooze_until,
       entity_id=excluded.entity_id, evidence_refs_json=excluded.evidence_refs_json,
       options_json=excluded.options_json, impact=excluded.impact, urgency=excluded.urgency,
       confidence=excluded.confidence, reversibility=excluded.reversibility,
       blast_radius=excluded.blast_radius, score=excluded.score,
       aggregation_key=excluded.aggregation_key, shadowed=excluded.shadowed,
       updated_at=excluded.updated_at`
  ).run(
    item.id, item.dedupeKey, item.kind, item.priority, item.critical ? 1 : 0, item.title,
    item.waitingOn, item.waitingSince, item.nextAction, item.consequence, item.whyNow,
    item.goalId, item.taskId, item.intentId, item.source, item.status, item.snoozeUntil,
    item.entityId ?? null, JSON.stringify(item.evidenceRefs ?? []), JSON.stringify(item.options ?? []),
    item.impact ?? null, item.urgency ?? null, item.confidence ?? null, item.reversibility ?? null,
    item.blastRadius ?? null, item.score ?? null, item.aggregationKey ?? null, item.shadowed ? 1 : 0,
    item.createdAt, item.updatedAt
  );
}

function rowToHeartbeatRun(row: DbRow): HeartbeatRun {
  return {
    id: String(row.id),
    decision: String(row.decision) as HeartbeatRun["decision"],
    triggerKinds: JSON.parse(String(row.trigger_kinds_json)) as string[],
    attentionIds: JSON.parse(String(row.attention_ids_json)) as string[],
    reason: String(row.reason),
    startedAt: String(row.started_at),
    endedAt: String(row.ended_at)
  };
}

function upsertHeartbeatRunRow(db: DatabaseSync, run: HeartbeatRun): void {
  db.prepare(
    `INSERT INTO heartbeat_runs
     (id, decision, trigger_kinds_json, attention_ids_json, reason, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET decision=excluded.decision,
       trigger_kinds_json=excluded.trigger_kinds_json, attention_ids_json=excluded.attention_ids_json,
       reason=excluded.reason, ended_at=excluded.ended_at`
  ).run(
    run.id, run.decision, JSON.stringify(run.triggerKinds), JSON.stringify(run.attentionIds),
    run.reason, run.startedAt, run.endedAt
  );
}

function rowToTask(row: DbRow): TaskRecord {
  const networkHosts: string[] = JSON.parse(String(row.network_hosts_json));
  const permissions = normalizeTaskPermissions(row.permissions_json);
  return {
    id: String(row.id),
    goalId: row.goal_id == null ? null : String(row.goal_id),
    externalRef: row.external_ref == null ? null : String(row.external_ref),
    requestHash: row.request_hash == null ? null : String(row.request_hash),
    templateId: row.template_id == null ? null : String(row.template_id),
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
    ...(permissions ? { permissions } : {}),
    pendingInput: row.pending_input == null ? null : String(row.pending_input),
    methodId: row.method_id == null ? null : String(row.method_id),
    methodVersion: row.method_version == null ? null : Number(row.method_version),
    pinnedAt: row.pinned_at == null ? null : String(row.pinned_at),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
    budgetOverride: row.budget_override_json == null ? null : JSON.parse(String(row.budget_override_json)),
    deletedAt: row.deleted_at == null ? null : String(row.deleted_at),
    trashBatchId: row.trash_batch_id == null ? null : String(row.trash_batch_id)
  };
}

function rowToGoal(row: DbRow): GoalContract {
  return {
    goalId: String(row.id),
    title: String(row.title),
    objective: String(row.objective),
    constraints: JSON.parse(String(row.constraints_json)),
    forbiddenActions: JSON.parse(String(row.forbidden_actions_json)),
    authoritySources: JSON.parse(String(row.authority_sources_json)),
    successCriteria: JSON.parse(String(row.success_criteria_json)),
    evidenceRequirements: JSON.parse(String(row.evidence_requirements_json)),
    budget: JSON.parse(String(row.budget_json)),
    ...(row.deadline == null ? {} : { deadline: String(row.deadline) }),
    stopConditions: JSON.parse(String(row.stop_conditions_json)),
    reviewPolicy: String(row.review_policy) as GoalContract["reviewPolicy"],
    currentState: String(row.current_state) as GoalContract["currentState"],
    ...(row.next_handoff == null ? {} : { nextHandoff: String(row.next_handoff) }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToGoalCompletionReport(row: DbRow): GoalCompletionReport {
  return {
    goalId: String(row.goal_id),
    taskId: String(row.task_id),
    verdict: String(row.verdict) as GoalCompletionReport["verdict"],
    summary: String(row.summary),
    criteria: JSON.parse(String(row.criteria_json)),
    evidenceRefs: JSON.parse(String(row.evidence_refs_json)),
    missingEvidence: JSON.parse(String(row.missing_evidence_json)),
    forbiddenActions: JSON.parse(String(row.forbidden_actions_json)),
    checkedAt: String(row.checked_at)
  };
}

function rowToConversation(row: DbRow): ConversationRecord {
  return {
    id: String(row.id), title: String(row.title),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    settings: row.settings_json == null
      ? defaultConversationSettings()
      : mergeConversationSettings(defaultConversationSettings(), JSON.parse(String(row.settings_json))),
    deletedAt: row.deleted_at == null ? null : String(row.deleted_at),
    trashBatchId: row.trash_batch_id == null ? null : String(row.trash_batch_id)
  };
}

function rowToSchedule(row: DbRow): ScheduleRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    prompt: String(row.prompt),
    cron: String(row.cron),
    timezone: String(row.timezone),
    enabled: Number(row.enabled) === 1,
    conversationId: String(row.conversation_id),
    executorId: String(row.executor_id) as ScheduleRecord["executorId"],
    approvalMode: String(row.approval_mode) as ScheduleRecord["approvalMode"],
    taskKind: String(row.task_kind) as ScheduleRecord["taskKind"],
    nextRunAt: row.next_run_at == null ? null : String(row.next_run_at),
    lastRunAt: row.last_run_at == null ? null : String(row.last_run_at),
    lastTaskId: row.last_task_id == null ? null : String(row.last_task_id),
    lastStatus: row.last_status == null ? null : String(row.last_status) as ScheduleRunStatus,
    catchUpPolicy: String(row.catch_up_policy ?? "run_once") as ScheduleRecord["catchUpPolicy"],
    catchUpMaxRuns: row.catch_up_max_runs == null ? 3 : Number(row.catch_up_max_runs),
    priority: row.priority == null ? 5 : Number(row.priority),
    failureCount: row.failure_count == null ? 0 : Number(row.failure_count),
    cooldownUntil: row.cooldown_until == null ? null : String(row.cooldown_until),
    deleteAfterRun: Number(row.delete_after_run ?? 0) === 1,
    pausedReason: row.paused_reason == null ? null : String(row.paused_reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToScheduleRun(row: DbRow): ScheduleRunRecord {
  return {
    id: String(row.id),
    scheduleId: String(row.schedule_id),
    scheduledFor: String(row.scheduled_for),
    taskId: row.task_id == null ? null : String(row.task_id),
    effectId: row.effect_id == null ? null : String(row.effect_id),
    idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
    attempt: row.attempt == null ? 1 : Number(row.attempt),
    failureClass: row.failure_class == null ? null : String(row.failure_class) as ScheduleRunRecord["failureClass"],
    receipt: row.receipt_json == null ? null : JSON.parse(String(row.receipt_json)),
    status: String(row.status) as ScheduleRunStatus,
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToChatMessage(row: DbRow): ChatMessageRecord {
  return {
    id: String(row.id), conversationId: String(row.conversation_id),
    role: String(row.role) as ChatMessageRecord["role"], content: String(row.content),
    taskId: row.task_id == null ? null : String(row.task_id),
    attachments: JSON.parse(String(row.attachments_json)), createdAt: String(row.created_at),
    kind: row.kind === "task_status" ? "task_status" : "text",
    taskStatus: row.task_status == null ? null : String(row.task_status) as Exclude<ChatMessageRecord["taskStatus"], undefined>
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
    ...(row.budget_json == null ? {} : { budget: JSON.parse(String(row.budget_json)) as NonNullable<RunRecord["budget"]> }),
    parentRunId: row.parent_run_id == null ? null : String(row.parent_run_id),
    handoffId: row.handoff_id == null ? null : String(row.handoff_id)
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
    inputs: row.inputs_json == null ? [] : JSON.parse(String(row.inputs_json)),
    reason: String(row.reason), status: String(row.status) as TaskProposalRecord["status"],
    expiresAt: String(row.expires_at), createdAt: String(row.created_at),
    decidedAt: row.decided_at == null ? null : String(row.decided_at)
  };
}

function rowToTaskFollowUp(row: DbRow): TaskFollowUpRecord {
  return {
    id: String(row.id), taskId: String(row.task_id),
    conversationId: row.conversation_id == null ? null : String(row.conversation_id),
    content: String(row.content), mode: String(row.mode) as TaskFollowUpRecord["mode"],
    status: String(row.status) as TaskFollowUpRecord["status"],
    appliedRunId: row.applied_run_id == null ? null : String(row.applied_run_id),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function rowToRunCheckpoint(row: DbRow): RunCheckpointRecord {
  return {
    id: String(row.id), runId: String(row.run_id), taskId: String(row.task_id),
    seq: Number(row.seq), kind: String(row.kind), path: String(row.path),
    sha256: String(row.sha256),
    usage: row.usage_json == null ? null : JSON.parse(String(row.usage_json)),
    createdAt: String(row.created_at),
    ...(row.proof_json == null ? {} : { proof: JSON.parse(String(row.proof_json)) })
  };
}

function rowToContextItem(row: DbRow): ContextItem {
  return {
    seq: Number(row.seq),
    id: String(row.id),
    conversationId: row.conversation_id == null ? null : String(row.conversation_id),
    taskId: String(row.task_id),
    runId: row.run_id == null ? null : String(row.run_id),
    executorId: row.executor_id == null ? null : String(row.executor_id) as ContextItem["executorId"],
    kind: String(row.kind) as ContextItem["kind"],
    role: String(row.role) as ContextItem["role"],
    content: String(row.content),
    contentRef: row.content_ref == null ? null : String(row.content_ref),
    sha256: row.sha256 == null ? null : String(row.sha256),
    tokens: Number(row.tokens),
    sensitivity: String(row.sensitivity) as ContextItem["sensitivity"],
    provenance: JSON.parse(String(row.provenance_json)),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    executorEventId: row.executor_event_id == null ? null : String(row.executor_event_id),
    createdAt: String(row.created_at)
  };
}

function rowToTaskContextState(row: DbRow): TaskContextState {
  return {
    taskId: String(row.task_id),
    summary: String(row.summary),
    plan: JSON.parse(String(row.plan_json)),
    completed: JSON.parse(String(row.completed_json)),
    failed: JSON.parse(String(row.failed_json)),
    artifacts: JSON.parse(String(row.artifacts_json)),
    openQuestions: JSON.parse(String(row.open_questions_json)),
    lastFailure: row.last_failure_json == null ? null : JSON.parse(String(row.last_failure_json)),
    handoffCount: Number(row.handoff_count),
    summarySeq: Number(row.summary_seq),
    updatedAt: String(row.updated_at)
  };
}

function rowToHandoff(row: DbRow): HandoffRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    fromRunId: String(row.from_run_id),
    toRunId: row.to_run_id == null ? null : String(row.to_run_id),
    fromExecutor: String(row.from_executor) as HandoffRecord["fromExecutor"],
    toExecutor: String(row.to_executor) as HandoffRecord["toExecutor"],
    generation: Number(row.generation ?? 0),
    sourceCursor: Number(row.source_cursor ?? 0),
    status: String(row.status) as HandoffRecord["status"],
    reasonCode: String(row.reason_code) as HandoffRecord["reasonCode"],
    diagnosis: row.diagnosis_json == null ? null : JSON.parse(String(row.diagnosis_json)),
    packet: row.packet_json == null ? null : JSON.parse(String(row.packet_json)),
    verification: row.verification_json == null ? null : JSON.parse(String(row.verification_json)),
    artifactRef: row.artifact_ref == null ? null : String(row.artifact_ref),
    contextWatermarkSeq: Number(row.context_watermark_seq),
    initiatedBy: String(row.initiated_by) as HandoffRecord["initiatedBy"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToDelegationJob(row: DbRow): DelegationJob {
  return {
    id: String(row.id),
    parentTaskId: String(row.parent_task_id),
    parentRunId: row.parent_run_id == null ? null : String(row.parent_run_id),
    childTaskId: row.child_task_id == null ? null : String(row.child_task_id),
    childRunId: row.child_run_id == null ? null : String(row.child_run_id),
    goalSlice: String(row.goal_slice),
    targetExecutor: String(row.target_executor) as DelegationJob["targetExecutor"],
    contextPackRef: String(row.context_pack_ref),
    contextPack: JSON.parse(String(row.context_pack_json)),
    workspacePolicy: String(row.workspace_policy) as DelegationJob["workspacePolicy"],
    permissions: JSON.parse(String(row.permissions_json)),
    toolPolicy: JSON.parse(String(row.tool_policy_json)),
    networkPolicy: JSON.parse(String(row.network_policy_json)),
    budget: JSON.parse(String(row.budget_json)),
    deadline: row.deadline == null ? null : String(row.deadline),
    resultSchemaRef: row.result_schema_ref == null ? null : String(row.result_schema_ref),
    status: String(row.status) as DelegationJob["status"],
    depth: Number(row.depth),
    idempotencyKey: String(row.idempotency_key),
    lease: row.lease_owner == null || row.lease_expires_at == null
      ? null
      : { owner: String(row.lease_owner), expiresAt: String(row.lease_expires_at) },
    attempt: Number(row.attempt),
    result: row.result_json == null ? null : JSON.parse(String(row.result_json)),
    verification: row.verification_json == null ? null : JSON.parse(String(row.verification_json)),
    failure: row.failure_json == null ? null : JSON.parse(String(row.failure_json)),
    cancelReason: row.cancel_reason == null ? null : String(row.cancel_reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToChannelDelivery(row: DbRow): ChannelDeliveryRecord {
  return {
    id: String(row.id),
    channel: String(row.channel),
    externalId: String(row.external_id),
    threadKey: String(row.thread_key),
    direction: String(row.direction) as ChannelDeliveryRecord["direction"],
    idempotencyKey: String(row.idempotency_key),
    generation: Number(row.generation),
    status: String(row.status) as ChannelDeliveryRecord["status"],
    payload: JSON.parse(String(row.payload_json)),
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error == null ? null : String(row.last_error),
    lastAttemptAt: row.last_attempt_at == null ? null : String(row.last_attempt_at),
    processedAt: row.processed_at == null ? null : String(row.processed_at),
    effectId: row.effect_id == null ? null : String(row.effect_id),
    receipt: row.receipt_json == null ? null : JSON.parse(String(row.receipt_json)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToChannelCursor(row: DbRow): ChannelCursor {
  return {
    channel: String(row.channel),
    threadKey: String(row.thread_key),
    generation: Number(row.generation),
    cursor: Number(row.cursor),
    updatedAt: String(row.updated_at)
  };
}

function normalizeTaskPermissions(raw: unknown): TaskRecord["permissions"] {
  if (raw == null) return undefined;
  const parsed = JSON.parse(String(raw)) as NonNullable<TaskRecord["permissions"]>;
  const hasRoots = parsed.readRoots.length > 0 || parsed.writeRoots.length > 0;
  if (!hasRoots && parsed.tools.length === 0) return undefined;
  return parsed;
}

function rowToApproval(row: DbRow): ApprovalRecord {
  return {
    id: String(row.id), taskId: String(row.task_id), runId: String(row.run_id),
    kind: String(row.kind), summary: String(row.summary),
    target: JSON.parse(String(row.target_json)), preview: JSON.parse(String(row.preview_json)),
    parameterHash: String(row.parameter_hash), status: String(row.status) as ApprovalRecord["status"],
    expiresAt: String(row.expires_at),
    decidedAt: row.decided_at == null ? null : String(row.decided_at),
    effectId: row.effect_id == null ? null : String(row.effect_id), createdAt: String(row.created_at),
    goalId: row.goal_id == null ? null : String(row.goal_id),
    actionDigest: row.action_digest == null ? null : String(row.action_digest),
    permissionMode: row.permission_mode == null ? null : String(row.permission_mode) as NonNullable<ApprovalRecord["permissionMode"]>,
    context: row.context == null ? "interactive" : String(row.context) as NonNullable<ApprovalRecord["context"]>,
    maxUses: row.max_uses == null ? 1 : Number(row.max_uses),
    usedCount: row.used_count == null ? 0 : Number(row.used_count),
    approvedBy: row.approved_by == null ? null : String(row.approved_by) as NonNullable<ApprovalRecord["approvedBy"]>,
    issuedAt: row.issued_at == null ? String(row.created_at) : String(row.issued_at),
    revokedAt: row.revoked_at == null ? null : String(row.revoked_at),
    action: row.action_json == null ? null : JSON.parse(String(row.action_json)) as Record<string, unknown>,
    rejectionCount: row.rejection_count == null ? 0 : Number(row.rejection_count)
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
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    goalId: row.goal_id == null ? null : String(row.goal_id),
    effectType: row.effect_type == null ? String(row.kind) : String(row.effect_type),
    replayPolicy: row.replay_policy == null ? "never_replay" : String(row.replay_policy) as NonNullable<EffectRecord["replayPolicy"]>,
    actionDigest: row.action_digest == null ? null : String(row.action_digest),
    resolvedActionDigest: row.resolved_action_digest == null ? null : String(row.resolved_action_digest),
    attemptCount: row.attempt_count == null ? 0 : Number(row.attempt_count),
    maxAttempts: row.max_attempts == null ? 1 : Number(row.max_attempts),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leaseExpiresAt: row.lease_expires_at == null ? null : String(row.lease_expires_at),
    availableAt: row.available_at == null ? String(row.created_at) : String(row.available_at),
    provider: row.provider == null ? null : String(row.provider),
    providerRef: row.provider_ref == null ? null : String(row.provider_ref),
    reconcileRef: row.reconcile_ref == null ? null : String(row.reconcile_ref),
    reconciledAt: row.reconciled_at == null ? null : String(row.reconciled_at),
    targetKey: row.target_key == null ? null : String(row.target_key),
    suspendReason: row.suspend_reason == null ? null : String(row.suspend_reason)
  };
}

function rowToReconcileItem(row: DbRow): ReconcileItem {
  return {
    id: String(row.id),
    effectId: String(row.effect_id),
    taskId: String(row.task_id),
    goalId: row.goal_id == null ? null : String(row.goal_id),
    targetKey: row.target_key == null ? null : String(row.target_key),
    summary: String(row.summary),
    status: String(row.status) as ReconcileItem["status"],
    reason: String(row.reason),
    attempted: JSON.parse(String(row.attempted_json)),
    risk: String(row.risk) as ReconcileItem["risk"],
    suggestedActions: JSON.parse(String(row.suggested_actions_json)),
    provider: row.provider == null ? null : String(row.provider),
    checkCount: Number(row.check_count),
    resolutionNote: row.resolution_note == null ? null : String(row.resolution_note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    resolvedAt: row.resolved_at == null ? null : String(row.resolved_at)
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
  const content = String(row.content);
  const source = JSON.parse(String(row.source_json)) as MemoryRecord["source"];
  return {
    id: String(row.id),
    kind: String(row.kind) as MemoryRecord["kind"],
    status: String(row.status) as MemoryRecord["status"],
    content,
    subjectKey: String(row.subject_key),
    scope: String(row.scope),
    tags: JSON.parse(String(row.tags_json)),
    source,
    confidence: String(row.confidence) as MemoryRecord["confidence"],
    sensitivity: String(row.sensitivity) as MemoryRecord["sensitivity"],
    tier: String(row.tier ?? "episodic") as MemoryRecord["tier"],
    originClass: String(row.origin_class ?? "agent") as MemoryRecord["originClass"],
    sourceKind: String(row.source_kind ?? source.type),
    sourceRef: String(row.source_ref ?? source.id ?? source.label),
    sessionId: row.session_id == null ? null : String(row.session_id),
    trust: String(row.trust ?? "medium") as MemoryRecord["trust"],
    taint: String(row.taint ?? "clean") as MemoryRecord["taint"],
    importance: Number(row.importance ?? 0.5),
    retention: String(row.retention ?? "30d") as MemoryRecord["retention"],
    supersessionKey: row.supersession_key == null ? null : String(row.supersession_key),
    contentHash: String(row.content_hash ?? "") || memoryContentHash(content),
    lastVerifiedAt: row.last_verified_at == null ? null : String(row.last_verified_at),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
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
    `INSERT INTO memories (id, kind, status, content, subject_key, scope, tags_json, source_json, confidence, sensitivity, allow_recall, version, supersedes_id, derived_from_id, valid_until, created_at, updated_at, last_recalled_at, recall_count, tier, origin_class, source_kind, source_ref, session_id, trust, taint, importance, retention, supersession_key, content_hash, last_verified_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, status=excluded.status, content=excluded.content,
       subject_key=excluded.subject_key, scope=excluded.scope, tags_json=excluded.tags_json, source_json=excluded.source_json,
       confidence=excluded.confidence, sensitivity=excluded.sensitivity, allow_recall=excluded.allow_recall,
       version=excluded.version, supersedes_id=excluded.supersedes_id, derived_from_id=excluded.derived_from_id,
       valid_until=excluded.valid_until, updated_at=excluded.updated_at, last_recalled_at=excluded.last_recalled_at,
       recall_count=excluded.recall_count, tier=excluded.tier, origin_class=excluded.origin_class,
       source_kind=excluded.source_kind, source_ref=excluded.source_ref, session_id=excluded.session_id,
       trust=excluded.trust, taint=excluded.taint, importance=excluded.importance, retention=excluded.retention,
       supersession_key=excluded.supersession_key, content_hash=excluded.content_hash,
       last_verified_at=excluded.last_verified_at, expires_at=excluded.expires_at`
  ).run(
    memory.id, memory.kind, memory.status, memory.content, memory.subjectKey, memory.scope,
    JSON.stringify(memory.tags), JSON.stringify(memory.source), memory.confidence, memory.sensitivity,
    memory.allowRecall ? 1 : 0, memory.version, memory.supersedesId, memory.derivedFromId,
    memory.validUntil, memory.createdAt, memory.updatedAt, memory.lastRecalledAt, memory.recallCount,
    memory.tier, memory.originClass, memory.sourceKind, memory.sourceRef, memory.sessionId,
    memory.trust, memory.taint, memory.importance, memory.retention, memory.supersessionKey,
    memory.contentHash, memory.lastVerifiedAt, memory.expiresAt
  );
}

function rowToMemoryVersion(row: DbRow): MemoryVersion {
  const content = String(row.content);
  const source = JSON.parse(String(row.source_json)) as MemoryVersion["source"];
  return {
    id: String(row.id),
    memoryId: String(row.memory_id),
    version: Number(row.version),
    content,
    status: String(row.status) as MemoryVersion["status"],
    source,
    confidence: String(row.confidence) as MemoryVersion["confidence"],
    sensitivity: String(row.sensitivity) as MemoryVersion["sensitivity"],
    tier: String(row.tier ?? "episodic") as MemoryVersion["tier"],
    originClass: String(row.origin_class ?? "agent") as MemoryVersion["originClass"],
    sourceKind: String(row.source_kind ?? source.type),
    sourceRef: String(row.source_ref ?? source.id ?? source.label),
    sessionId: row.session_id == null ? null : String(row.session_id),
    trust: String(row.trust ?? "medium") as MemoryVersion["trust"],
    taint: String(row.taint ?? "clean") as MemoryVersion["taint"],
    importance: Number(row.importance ?? 0.5),
    retention: String(row.retention ?? "30d") as MemoryVersion["retention"],
    supersessionKey: row.supersession_key == null ? null : String(row.supersession_key),
    contentHash: String(row.content_hash ?? "") || memoryContentHash(content),
    lastVerifiedAt: row.last_verified_at == null ? null : String(row.last_verified_at),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    allowRecall: Number(row.allow_recall) === 1,
    scope: String(row.scope),
    tags: JSON.parse(String(row.tags_json)),
    reason: String(row.reason),
    createdAt: String(row.created_at)
  };
}

function insertMemoryVersionRow(db: DatabaseSync, version: MemoryVersion): void {
  db.prepare(
    "INSERT INTO memory_versions (id, memory_id, version, content, status, source_json, confidence, sensitivity, allow_recall, scope, tags_json, reason, created_at, tier, origin_class, source_kind, source_ref, session_id, trust, taint, importance, retention, supersession_key, content_hash, last_verified_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    version.id, version.memoryId, version.version, version.content, version.status,
    JSON.stringify(version.source), version.confidence, version.sensitivity, version.allowRecall ? 1 : 0,
    version.scope, JSON.stringify(version.tags), version.reason, version.createdAt,
    version.tier, version.originClass, version.sourceKind, version.sourceRef, version.sessionId,
    version.trust, version.taint, version.importance, version.retention, version.supersessionKey,
    version.contentHash, version.lastVerifiedAt, version.expiresAt
  );
}

function memoryContentHash(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
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
    lane: String(row.lane ?? "on_demand") as MemoryRecall["lane"],
    reason: String(row.reason),
    score: Number(row.score),
    createdAt: String(row.created_at)
  };
}

function insertMemoryRecallRow(db: DatabaseSync, recall: MemoryRecall): void {
  db.prepare(
    "INSERT INTO memory_recalls (id, memory_id, task_id, run_id, lane, reason, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(recall.id, recall.memoryId, recall.taskId, recall.runId, recall.lane, recall.reason, recall.score, recall.createdAt);
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

function rowToMemoryForgetTombstone(row: DbRow): MemoryForgetTombstone {
  return {
    id: String(row.id),
    memoryId: String(row.memory_id),
    contentHash: String(row.content_hash),
    subjectKey: String(row.subject_key),
    sourceKind: String(row.source_kind),
    sourceRef: String(row.source_ref),
    reason: String(row.reason),
    createdAt: String(row.created_at)
  };
}

function insertMemoryForgetTombstoneRow(db: DatabaseSync, tombstone: MemoryForgetTombstone): void {
  db.prepare(
    "INSERT OR IGNORE INTO memory_forget_tombstones (id, memory_id, content_hash, subject_key, source_kind, source_ref, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    tombstone.id, tombstone.memoryId, tombstone.contentHash, tombstone.subjectKey,
    tombstone.sourceKind, tombstone.sourceRef, tombstone.reason, tombstone.createdAt
  );
}

function rowToMemoryConsolidationRun(row: DbRow): MemoryConsolidationRun {
  return {
    id: String(row.id),
    status: String(row.status) as MemoryConsolidationRun["status"],
    dryRun: Number(row.dry_run) === 1,
    scope: row.scope == null ? null : String(row.scope),
    groups: JSON.parse(String(row.groups_json)),
    sources: JSON.parse(String(row.sources_json)),
    appliedMemoryIds: JSON.parse(String(row.applied_memory_ids_json)),
    skipped: JSON.parse(String(row.skipped_json)),
    error: row.error == null ? null : String(row.error),
    report: String(row.report),
    startedAt: String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at)
  };
}

function upsertMemoryConsolidationRun(db: DatabaseSync, run: MemoryConsolidationRun): void {
  db.prepare(
    `INSERT INTO memory_consolidation_runs (id, status, dry_run, scope, groups_json, sources_json, applied_memory_ids_json, skipped_json, error, report, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, dry_run=excluded.dry_run, scope=excluded.scope,
       groups_json=excluded.groups_json, sources_json=excluded.sources_json,
       applied_memory_ids_json=excluded.applied_memory_ids_json, skipped_json=excluded.skipped_json,
       error=excluded.error, report=excluded.report, completed_at=excluded.completed_at`
  ).run(
    run.id, run.status, run.dryRun ? 1 : 0, run.scope, JSON.stringify(run.groups),
    JSON.stringify(run.sources), JSON.stringify(run.appliedMemoryIds), JSON.stringify(run.skipped),
    run.error, run.report, run.startedAt, run.completedAt
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
  if (Array.isArray(next.sourceMemoryIds) && next.sourceMemoryIds.includes(memoryId)) {
    if ("proposedContent" in next) next.proposedContent = "[包含已遗忘记忆，正文已脱敏]";
    if ("conflicts" in next) next.conflicts = ["[包含已遗忘记忆]"];
    if ("report" in next) next.report = "[包含已遗忘记忆，报告已脱敏]";
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
    generation: row.generation == null ? null : Number(row.generation),
    fingerprint: row.fingerprint == null ? null : String(row.fingerprint),
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
    "INSERT INTO method_candidates (id, name, summary, applicability, steps_json, source_task_ids_json, template_id, status, version, generation, fingerprint, previous_version_id, allowed_capabilities_json, guardrails_json, baseline_json, trial_json, evaluation_verdict, created_at, updated_at, adopted_at, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, summary=excluded.summary, applicability=excluded.applicability, steps_json=excluded.steps_json, source_task_ids_json=excluded.source_task_ids_json, template_id=excluded.template_id, status=excluded.status, version=excluded.version, generation=excluded.generation, fingerprint=excluded.fingerprint, previous_version_id=excluded.previous_version_id, allowed_capabilities_json=excluded.allowed_capabilities_json, guardrails_json=excluded.guardrails_json, baseline_json=excluded.baseline_json, trial_json=excluded.trial_json, evaluation_verdict=excluded.evaluation_verdict, updated_at=excluded.updated_at, adopted_at=excluded.adopted_at, retired_at=excluded.retired_at"
  ).run(
    method.id, method.name, method.summary, method.applicability, JSON.stringify(method.steps), JSON.stringify(method.sourceTaskIds),
    method.templateId, method.status, method.version, method.generation ?? null, method.fingerprint ?? null, method.previousVersionId, JSON.stringify(method.allowedCapabilities),
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

function rowToMethodApplication(row: DbRow): MethodApplication {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    methodId: String(row.method_id),
    methodVersion: Number(row.method_version),
    selection: String(row.selection) as MethodApplication["selection"],
    promptSha256: String(row.prompt_sha256),
    createdAt: String(row.created_at)
  };
}

function rowToLocalProject(row: DbRow): LocalProject {
  return {
    id: String(row.id),
    name: String(row.name),
    path: String(row.path),
    defaultBranch: String(row.default_branch),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToModelProfile(row: DbRow): ModelProfileRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    providerId: String(row.provider_id),
    providerName: String(row.provider_name),
    protocol: String(row.protocol) as ModelProfileRecord["protocol"],
    baseUrl: String(row.base_url),
    model: String(row.model),
    contextWindowTokens: Number(row.context_window_tokens ?? 128000),
    maxOutputTokens: Number(row.max_output_tokens ?? 8000),
    apiKeyCipher: row.api_key_cipher == null ? null : String(row.api_key_cipher),
    isLocal: Number(row.is_local) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToExecutorModelBinding(row: DbRow): ExecutorModelBinding {
  return {
    executorId: String(row.executor_id) as ExecutorModelBinding["executorId"],
    profileId: row.profile_id == null ? null : String(row.profile_id),
    protocolOverride: row.protocol_override == null ? null : String(row.protocol_override) as ExecutorModelBinding["protocolOverride"],
    modelOverride: row.model_override == null ? null : String(row.model_override),
    updatedAt: String(row.updated_at)
  };
}

function rowToSettingsMigration(row: DbRow): SettingsMigrationRecord {
  return {
    id: String(row.id),
    sourcePath: String(row.source_path),
    backupPath: row.backup_path == null ? null : String(row.backup_path),
    status: String(row.status) as SettingsMigrationRecord["status"],
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
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

function rowToConnectionSession(row: DbRow): ConnectionSession {
  return {
    id: String(row.id),
    deviceId: String(row.device_id),
    userId: String(row.user_id),
    generation: Number(row.generation),
    cursor: row.cursor == null ? null : Number(row.cursor),
    scopes: JSON.parse(String(row.scopes_json)),
    pendingScopes: row.pending_scopes_json == null ? [] : JSON.parse(String(row.pending_scopes_json)),
    status: String(row.status) as ConnectionSession["status"],
    lastError: row.last_error == null ? null : String(row.last_error),
    connectedAt: String(row.connected_at),
    expiresAt: String(row.expires_at),
    lastHeartbeatAt: String(row.last_heartbeat_at),
    cursorAt: String(row.cursor_at),
    disconnectedAt: row.disconnected_at == null ? null : String(row.disconnected_at),
    disconnectReason: row.disconnect_reason == null ? null : String(row.disconnect_reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function upsertConnectionSession(db: DatabaseSync, session: ConnectionSession): void {
  db.prepare(
    `INSERT INTO connection_sessions (id, device_id, user_id, generation, cursor, scopes_json, pending_scopes_json, status, last_error, connected_at, expires_at, last_heartbeat_at, cursor_at, disconnected_at, disconnect_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       device_id=excluded.device_id, user_id=excluded.user_id, generation=excluded.generation,
       cursor=excluded.cursor, scopes_json=excluded.scopes_json, pending_scopes_json=excluded.pending_scopes_json,
       status=excluded.status, last_error=excluded.last_error, connected_at=excluded.connected_at,
       expires_at=excluded.expires_at, last_heartbeat_at=excluded.last_heartbeat_at, cursor_at=excluded.cursor_at,
       disconnected_at=excluded.disconnected_at, disconnect_reason=excluded.disconnect_reason, updated_at=excluded.updated_at`
  ).run(
    session.id, session.deviceId, session.userId, session.generation, session.cursor,
    JSON.stringify(session.scopes), JSON.stringify(session.pendingScopes), session.status, session.lastError,
    session.connectedAt, session.expiresAt, session.lastHeartbeatAt, session.cursorAt,
    session.disconnectedAt, session.disconnectReason, session.createdAt, session.updatedAt
  );
}

function rowToConnectionOutboxItem(row: DbRow): ConnectionOutboxItem {
  return {
    id: String(row.id),
    connectionId: String(row.connection_id),
    generation: Number(row.generation),
    deviceId: String(row.device_id),
    userId: String(row.user_id),
    scope: String(row.scope),
    kind: String(row.kind),
    idempotencyKey: String(row.idempotency_key),
    payload: JSON.parse(String(row.payload_json)),
    status: String(row.status) as ConnectionOutboxItem["status"],
    error: row.error == null ? null : String(row.error),
    effectId: row.effect_id == null ? null : String(row.effect_id),
    result: row.result_json == null ? null : JSON.parse(String(row.result_json)),
    submittedAt: row.submitted_at == null ? null : String(row.submitted_at),
    committedAt: row.committed_at == null ? null : String(row.committed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function upsertConnectionOutboxItem(db: DatabaseSync, item: ConnectionOutboxItem): void {
  db.prepare(
    `INSERT INTO connection_outbox (id, connection_id, generation, device_id, user_id, scope, kind, idempotency_key, payload_json, status, error, effect_id, result_json, submitted_at, committed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       generation=excluded.generation, status=excluded.status, error=excluded.error, effect_id=excluded.effect_id,
       result_json=excluded.result_json, submitted_at=excluded.submitted_at, committed_at=excluded.committed_at,
       updated_at=excluded.updated_at`
  ).run(
    item.id, item.connectionId, item.generation, item.deviceId, item.userId, item.scope, item.kind,
    item.idempotencyKey, JSON.stringify(item.payload), item.status, item.error, item.effectId,
    item.result == null ? null : JSON.stringify(item.result), item.submittedAt, item.committedAt,
    item.createdAt, item.updatedAt
  );
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

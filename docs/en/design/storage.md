---
title: 'Storage and Context Architecture'
description: 'Hearth SQLite, content blobs, executor directories, the unified model registry, and context handoff boundaries.'
outline: [2]
---

# Storage and Context Architecture

<p class="lead">Hearth separates rebuildable facts, body content, and working directories. SQLite is the single state index and event ledger; the filesystem holds large bodies, workspaces, and installed runtimes. Context, model bindings, and executor handoffs all recover from the same records.</p>

## Core Constraints

| Constraint | Meaning |
|---|---|
| One write authority | One server process writes SQLite; interfaces, notifications, and reports read projections instead of creating a second source of truth |
| Record before display | Tasks, runs, context, model bindings, and migration results are stored first and then pushed to the browser over SSE |
| Indexes separate from bodies | The database stores metadata, summaries, hashes, and references; large text goes to content blobs and deliverables stay in task workspaces |
| Every run is traceable | A context item carries `task_id`, `run_id`, `executor_id`, `provenance_json`, and a stable `executor_event_id` |
| Executors do not hold long-lived credentials | Model keys are encrypted with AES-256-GCM in the database; an executor gets decrypted configuration only for its run |

The current database schema version is **11**. At startup, `packages/eventlog/src/database.ts` runs table creation and incremental migrations in order, then writes `PRAGMA user_version` and `app_meta.schemaVersion`.

## The `.hearth` Directory

The default data directory is `.hearth/` under the repository root and can be overridden with `HEARTH_DATA_DIR`.

| Path | Contents | Included in a database backup |
|---|---|---|
| `.hearth/hearth.sqlite` | Events, tasks, runs, approvals, effects, context indexes, model profiles, settings, and migrations | Yes |
| `.hearth/master.key` | Local encryption master key for model API keys and similar sensitive fields | Yes, encrypted again under the backup passphrase |
| `.hearth/context/blobs/` | Context bodies above the inline threshold, named by content SHA-256 | No |
| `.hearth/workspaces/tasks/<taskId>/` | A task workspace, inputs, outputs, and `.hearth` checkpoints | No |
| `.hearth/artifacts/` | Managed deliverables and manifests | No |
| `.hearth/sources/` | Fetched or imported source bodies | No |
| `.hearth/attachments/` | Chat attachments | No |
| `.hearth/outbox/` | Local outbox drafts and receipt files | No |
| `.hearth/executors/codex/` | Codex `config.toml` generated from the unified binding, plus its runtime directory | No |
| `.hearth/executors/deepseek-harness/` | DeepSeek Harness provider patch and session runtime directory | No |
| `.hearth/executors/<id>/` | Managed installations and runtime directories for other external executors | No |
| `.hearth/backups/` | AES-256-GCM encrypted database backup archives | - |
| `.hearth/backups/legacy-dev/` | Original copies retained during the first JSON settings migration | - |
| `.hearth/device-frames/` | Desktop observation frame cache | No |
| `.hearth/git-cache/` | Repository preparation cache | No |

`model-settings.json` and `executor-settings.json` are retained only as legacy migration sources and are no longer written by Settings. A successful migration does not delete the originals, preserving audit and rollback value.

## SQLite Domains

| Domain | Main tables | Purpose |
|---|---|---|
| Event ledger | `events` | Append-only fact stream that drives SSE, sync, and projection rebuilds |
| Tasks and runs | `tasks`, `runs`, `run_checkpoints`, `task_proposals` | Task state machine, attempts, budgets, and recovery points |
| Conversations | `conversations`, `chat_messages` | Chat messages and upsertable `task_status` cards |
| Approvals and effects | `approvals`, `effects`, `outbox_drafts` | One-time authority, idempotent execution, and external receipts |
| Artifacts and sources | `artifacts`, `sources`, `source_items` | Deliverable indexes, source body indexes, and fetch records |
| Context | `context_items`, `task_context_state`, `context_settings`, `handoffs` | Execution trail, task summary, context policy, and handoff records |
| Model management | `model_profiles`, `executor_model_bindings`, `app_settings` | Unified model profiles, executor bindings, and chat model selection |
| Settings migration | `settings_migrations` | Legacy JSON source, backup path, status, and error |
| Memory and methods | `memories`, `memory_*`, `method_*`, `method_applications` | Correctable memory, recall audit, method evolution, and per-run injection evidence |
| Multi-device and security | `devices`, `pairing_requests`, `sync_*`, `task_leases`, `security_*` | Pairing, sync, leases, revocation, and fencing |
| Operations | `maintenance_runs`, `backup_records`, `scheduled_jobs` | Maintenance, backups, and periodic jobs |

Method applications are append-only local audit records; they are not replayed as events or synchronized across devices. `tasks.method_id/method_version` pins an explicit binding, while `method_applications` records the method version, selection mode, and prompt hash actually injected in each run. `method_candidates.generation` identifies the adoption generation and `fingerprint` deduplicates deterministic candidate creation.

## Unified Model Registry

Models are no longer stored in an executor-specific JSON file. The registry has two layers:

1. **Model profile `model_profiles`**: display name, provider, protocol, base URL, model name, and encrypted API key.
2. **Executor binding `executor_model_bindings`**: chooses a profile for each executor and permits constrained protocol or model overrides.

`app_settings.model.chatProfileId` stores the current Hearth chat model. It serves chat, failure diagnosis, and the native executor. An external executor uses its own binding only when that binding is valid.

The server enforces protocol compatibility:

| Executor | Allowed protocols |
|---|---|
| `native` | `openai-chat`, `openai-responses`, `anthropic-messages`, `gemini` |
| `codex` | `openai-responses` only |
| `deepseek-harness` | `openai-chat`, `openai-responses`, `anthropic-messages` |
| `hermes`, `qoder`, `workbuddy`, `kimi` | `openai-chat`, `openai-responses`, `anthropic-messages` |

The Codex binding generates a dedicated `.hearth/executors/codex/config.toml` with `wire_api = "responses"` and injects the key through the process environment. Local addresses (`localhost`, `127.0.0.1`, private ranges, and `.local`) are excluded from the unified registry so a local model is not mistaken for a cloud profile.

## Context Lifecycle

Context is a task-level record shared by every executor; it does not depend on a CLI's private session.

1. **Capture**: the native runtime, Codex, DeepSeek Harness, and external CLIs normalize messages, tool calls, tool results, checkpoints, and notices into `ContextItem` records.
2. **Deduplicate**: `executor_event_id` is unique within a run, so repeated notifications do not duplicate rows.
3. **Inline or blob**: when a body exceeds `maxInlineBytes`, Hearth writes `.hearth/context/blobs/<sha256>.txt`; the database keeps `content_ref`, `sha256`, and a truncated inline excerpt.
4. **Summarize**: after items pass `summarizeAfterTokens`, `task_context_state` is refreshed with the goal, plan, completed work, failures, artifacts, and open questions.
5. **Project**: when an executor starts or takes over, Hearth generates a context projection bounded by `projectionTokenBudget` instead of sending the full history to the CLI.
6. **Handoff**: `handoffs` stores the diagnosis, packet, source and target runs, and `context_watermark_seq`; the takeover executor continues from the same watermark so late results cannot overwrite newer state.
7. **Delete**: deleting task context removes `context_items`, `task_context_state`, and blobs with no remaining references; content still referenced by another task is retained.

Context modes are `off`, `shadow`, and `on`. `shadow` records without injecting and is useful for validating capture quality; `on` projects context into execution and handoff. Defaults are two handoffs, one retry per executor, and 30-day retention.

## Startup Migration

The server handles legacy settings in this order:

1. Read `.hearth/model-settings.json` and `.hearth/executor-settings.json`.
2. Copy the originals into `.hearth/backups/legacy-dev/` with a time or migration identifier.
3. Write `model_profiles`, `executor_model_bindings`, and `app_settings` in a transaction.
4. Record `legacy-model-settings-v1` and `legacy-executor-settings-v1` in `settings_migrations` with source, backup, status, and error.
5. If any step fails, roll back database writes while retaining the backup and failure record; the server does not start in a half-migrated state.

Migration is idempotent: completed IDs are not imported twice, and an existing profile with the same provider, URL, model, and protocol is reused instead of duplicated.

## Backup and Restore Boundaries

A database backup contains the SQLite snapshot, schema version, table counts, and the local `master.key`, all encrypted with AES-256-GCM under a key derived from the user passphrase. Restore verifies that the source schema is not newer than the current version, the payload hash matches, and the candidate database passes `PRAGMA integrity_check` before replacing the live database.

The backup **does not include** context blobs, task workspaces, artifact bodies, source bodies, attachments, or outbox files. For a complete migration, copy these paths as well:

```text
.hearth/context/blobs/
.hearth/workspaces/
.hearth/artifacts/
.hearth/sources/
.hearth/attachments/
.hearth/outbox/
```

## Operational Checks

The Data section in Settings shows the database path, schema version, executor directories, context blob directory, migration records, and legacy JSON sources. When diagnosing a problem, inspect:

- `settings_migrations`: whether legacy settings imported successfully and why they failed.
- `model_profiles` and `executor_model_bindings`: whether an executor has a protocol-compatible profile with a key.
- `context_items` and `task_context_state`: whether the task captured its execution trail and advanced its summary watermark.
- `handoffs`: whether the target, diagnosis, and context watermark agree.
- `backup_records`: whether the latest backup succeeded and restore passed integrity checks.

Database records are authoritative. Do not hand-edit `model-settings.json` or `executor-settings.json` to change runtime configuration.

---
title: "Phase 2–6 capability status"
description: "Implemented, verified, and deliberately open capabilities by phase, without treating a page as a closed loop."
outline: [2, 3]
---

# Phase 2–6 capability status

<p class="lead">This page records only what the current code and real runs can prove. Status values are "code loop implemented", "partial", and "not implemented"; they are not interchangeable.</p>

Baseline checked on 2026-11-07. `npm test` passes 40 files and 199 tests; `npm run typecheck`, `npm run build`, and `npm run docs:build` pass.

## Agent runtime closure

- **Implemented:** `native` and `codex` executors are peers. Executor identity is written into runs and manifests. General tasks default to native; explicit coding/repository tasks use Codex. Failures never silently switch.
- **Implemented:** Four model protocols (OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini) normalized into streaming text and tool calls; providers are selectable or custom.
- **Implemented:** `@hearth/agent-runtime` is a single-agent tool loop with read, search, write, edit, patch, shell, fetch, ask-user, and finish tools; task-scoped read/write roots, network hosts, and tool allowlists.
- **Implemented:** Turn, tool-call, token, and duration budgets; checkpoints on every model turn and tool step; resume from waiting-for-input with the user's answer; retry missing artifacts with prior agent context, at most twice.
- **Implemented:** Tasks that need network access or engineering workspace permissions first produce a chat proposal; the task is created only after confirmation. General tasks dispatch directly.
- **UI result:** Task pages show executor, phase, tokens, duration, and result. Detail pages show the user-facing summary and declared artifacts first; intermediate JSON, command logs, and checkpoints are collapsed.

This is a code-and-test closure, not proof of long-running acceptance in a real user environment.

## Phase 2

| Sub-stage | Status | Implemented | Deliberately open |
|---|---|---|---|
| 2.1 Read-only sources | Partial | Local files, knowledge bases, public web sources; domain allowlist; source status, read time, errors, incremental reads, dedupe, disconnect, reconnect, clear | Email and calendar show "not configured"; no credentials, reads, or permission verification |
| 2.2 Documents, tables, and web material | Basic loop implemented | TXT, Markdown, CSV, JSON, HTML, PDF, DOCX, XLSX extraction; page, paragraph, worksheet, range, and gap records; web snapshots and source items | Complex layouts, scanned OCR, per-page citation targeting, and spreadsheet formula fidelity |
| 2.3 Drafting, approval, and external writes | Partial | Editable, savable, discardable drafts; one-time, short-lived approval; approved effects write to the local outbox with receipts; reject/expiry updates draft state | Writes only local `.hearth/outbox` files; no mail server, calendar, or other external systems |
| 2.4 Everyday content acceptance | Not done | Automated tests and isolated-instance coverage of sources, extraction, and outbox | No 10–15 real everyday tasks with time, accuracy, recovery, and user willingness records |

The local outbox is not a fake success: the UI states that it writes locally and does not send. It must not be called "sent" before a real mail account is connected.

## Phase 3

| Sub-stage | Status | Implemented | Deliberately open |
|---|---|---|---|
| 3.1 Connect and inspect a desktop device | Partial | Six-digit pairing, device token, pairing and capability approvals separated; observation, control, and UI automation authorized separately; app allowlist; online state and revocation | No tray or always-on "under control" indicator; Windows same-machine helper only |
| 3.2 Observe and take over | Partial | Screenshot bound to the session; pause, resume, takeover, hand-back, terminate; takeover cancels pending input and advances the control epoch; user-idle check; frames expire after two minutes | Sensitive-area masking, long recording, and full desktop snapshots |
| 3.3 Tiered desktop actions | Partial | Target-app binding and pre-action focus check; clicks, short text, Enter/Tab/Escape/Ctrl+S; UIA invoke/setvalue allowlist; UWP host windows mapped through the UIA child process; command status and results; structured rejection | High-risk preview and confirmation, isolated desktop, snapshots, compensation, real UIA setvalue acceptance |
| 3.4 Desktop acceptance | Not done | Isolated-port pairing, capability approval, observation, pause, resume, takeover, hand-back, and pro-mode expansion verified | No 5+ real desktop tasks with success rate, takeover count, and failure drills |

The Windows helper focuses the server-approved target app before observing or typing; it is not a background no-focus input channel. For UWP apps hosted by `ApplicationFrameHost`, it reads the UIA subtree and allows focus/observation only when a child process maps to the approved app, for example `CalculatorApp` to `calculator`. If the owner cannot be determined, it rejects instead of silently treating the host window as the target. A real UIA invoke was verified in Calculator: invoking "2" returned `InvokePattern` and changed the reading from `7` to `72`. The same chain completed "observe → UIA action → automatic observe" on an isolated paired device with command results and screenshots returned.

## Phase 4

| Sub-stage | Status | Implemented | Deliberately open |
|---|---|---|---|
| 4.1 Triggers and proactive suggestions | Code loop implemented | Six triggers: task enters a 24-hour due window, task fails or becomes recoverable, external result uncertain, approval waiting over two hours, new source item within 24 hours, queue backlog or long-running task; suggestions include source, why now, proposed action, impact, cost, risk, approval need, and priority; dedupe by event key with occurrence counts | Email and calendar triggers are disabled placeholders; proactive mode never executes high-risk actions directly |
| 4.2 Proactive inbox | Code loop implemented | Priority inbox; accept, ignore, snooze, convert to task; accept and convert are separate; accept only records a decision, convert only creates a queued task without approving or replaying effects; ignored events are not rephrased and repushed | No multi-device or mobile inbox; no notification channel distribution, only the local web inbox |
| 4.3 Mobile view, approval, takeover | Not implemented | None | No mobile PWA, pairing, push, mobile approval, or remote takeover; the only entry is the same-machine web control plane |
| 4.4 Attention budget and acceptance | Partial | Daily cap 0–50, quiet hours, cooldown, aggregation window, temporary pause and resume; budget snapshot shows used/limit, quiet/paused state, and next allowed time; last seven days record delivered, accepted, ignored, converted, and completed; the "needs you" page collects pending approvals | No 5–10 real proactive tasks proving at most one interruption per task; no push delivery stats or long-term user-feel record |

The key boundary in phase four is "a suggestion is not an execution". `accept` only changes suggestion state; only `convert` creates a new queued task, which then follows the normal executor, approval, and effect-ledger rules. A high-risk action does not bypass approval because it came from a proactive suggestion.

## Phase 5

| Sub-stage | Status | Implemented | Deliberately open |
|---|---|---|---|
| 5.1 Visible memory | Code loop implemented | Memory enters as a candidate and participates in recall only after confirmation; records type, subject key, scope, tags, source, confidence, sensitivity, validity, and version; recall scores task relevance and records reason and usage audit; injected context carries `trusted="false"` and a "cannot expand authority" boundary; recall item and character budgets | Auto-capture is off by default and only captures "experience" from terminal tasks; no automatic user-fact extraction from email, web, or arbitrary documents |
| 5.2 Correct, forget, export | Code loop implemented | Correction creates a new version and keeps history; same-subject conflicts are not silently overwritten and require left/right/merge; forgetting tombstones the current record and redacts historical versions, related events, and recall-audit matches; export omits forgotten bodies; sensitive memory is not recalled by default and `secret` memory is never recalled | Cross-device forgetting relies only on sync filtering and local copy boundaries; no remote erasure of previously exported files |
| 5.3 Summarize and evaluate reusable methods | Code loop implemented | Candidate generated from terminal task traces; permissions are the intersection of source task capabilities and cannot expand; baseline/trial records success, duration, tokens, and approvals; evaluation distinguishes improved, flat, regressed, and insufficient; only candidates with improvement evidence and trial samples can be promoted; reject and rollback keep reasons and audit | "Trial" only reads existing terminal traces and does not re-execute a task, so it is not a live shadow executor; no long-term production comparison |
| 5.4 Memory and evolution acceptance | Not done | API, service, and page-loop tests cover create, confirm, recall, correct, conflict, forget, export, trial, promote, and rollback | No real-user wrong-memory drill, wrong-method drill, before/after success/time/cost comparison, or full propose–evaluate–trial–adopt–rollback production acceptance |

The shared boundary is "candidate first, confirmation second; evidence first, promotion second". Candidate methods never go live automatically, and memory content cannot act as an instruction that expands tools, network, or approval authority.

## Phase 6

| Sub-stage | Status | Implemented | Deliberately open |
|---|---|---|---|
| 6.1 Multi-device sync and switching | Partial | Each instance has an `instanceId`; peer token shown once, with hash and encrypted copy stored server-side; incremental pull by event sequence with dedupe; imported events rebuild projections; newer local task/memory/method state is not silently overwritten; conflicts keep both sides and require local/remote choice; sync UI shows peers, cursors, errors, and conflicts | Only filtered event projections sync; approvals, sources, outbox, devices, desktop, security, sync events, and sensitive/secret memory are not copied; artifact bodies, workspaces, and absolute paths are not synced; no real two-device switch or offline recovery acceptance |
| 6.2 Device revocation and safe migration | Partial | Task leases carry TTL, owner, and epoch; expired leases can be taken over by another instance with an epoch advance; old-owner commits and results are rejected; device capabilities can be revoked, tokens rotated, devices re-paired; sync peers can rotate or revoke; global kill switch blocks approvals and scheduler restart with an audit record; security page shows state and audit | No dedicated cross-device artifact/workspace migration; no real lost-device drill proving a revoked device cannot approve, take over, or read; clearing the global stop does not auto-restart the executor |
| 6.3 Backup, restore, and upgrade | Partial | `*.hearth-backup` archive; scrypt (N=32768, r=8, p=1), AES-256-GCM, passphrase at least 12 characters; archive contains SQLite snapshot, required settings/audit/event metadata, and encrypted local `master.key`; restore writes temporary SQLite, checks `user_version`, schema, and `integrity_check`, rebuilds projections, copies in a transaction, rolls back on failure; preserves current `instanceId`, `createdAt`, and global stop state; clears old leases, pairings, and desktop session temporaries; old `/api/backup` returns `410` | Excludes artifact bodies, task workspaces, source bodies, outbox attachments, screenshots/desktop temporaries, and external service data, so it is not a complete portable backup; no app version upgrade pipeline or failed-upgrade rollback; incompatible schema is rejected but has no real cross-version fixture drill |
| 6.4 Long-running operation and v1.0 acceptance | Partial | Health snapshot includes uptime, memory, disk, schema, task counts, scheduler, approvals, kill switch, and last maintenance; maintenance clears expired approvals, recovers interrupted tasks, deletes expired leases/desktop commands/screenshots/pairings/temporaries without deleting tasks, memory, or artifacts; automatic maintenance every six hours after startup plus manual trigger; failure records failure and marks health degraded; diagnostics export includes health, maintenance, counts, and event types without paths, keys, or environment secrets; operations page shows health, maintenance, and backup boundaries | No multi-week continuous run, resource-drift data, real v1.0 install/upgrade/migration/exit acceptance, or full task-type regression matrix |

The phase-six backup boundary must stay visible: a recoverable database is not a portable artifact archive. After restore, tasks may reappear while artifact bodies, workspaces, or external attachments still need separate backup and verification.

## Current UI boundary

The chat-first primary navigation currently exposes only **Chat, Tasks, Devices, and Settings**. Memory, methods, proactive inbox, sync, security, and operations already have server APIs, projections, and page components, but are not all wired back into the primary navigation. Read "the capability exists" in this page as one of:

- **Directly usable in the UI:** chat, tasks, task detail, devices, settings.
- **API and page components exist:** memory, methods, proactive inbox, sync, security, operations, outbox, sources.
- **Not implemented:** mobile PWA, push, remote takeover, real email/calendar accounts.

## Borrowed patterns and trade-offs

- **OpenClaw:** pairing and capability approval are separate; commands are declared per device and authorized individually; an observation frame is the only basis for an action; takeover cancels pending input and advances the control epoch; unsupported actions are rejected. Hearth adopts these boundaries.
- **Hermes:** explicit capability lists, pre-action target verification, and session isolation. Hearth adopts app allowlists, target verification, and control epochs; it does not use background no-focus input because the current Windows layer cannot reliably prove focus stays in the approved window.
- **OpenClaw proactive service:** suggestions and execution are separate, and suggested actions return to the normal approval chain. Hearth adopts this and does not make proactive suggestions an auto-executor.
- **Hermes health checks:** expose drivers, permissions, runtime state, and last maintenance. Hearth adopts this with health snapshots, maintenance records, and redacted diagnostics.
- **DeerFlow:** task decomposition, method candidates, and evaluation layers are design references only. Hearth does not integrate DeerFlow or its multi-agent runtime.
- **LoopX:** only small-loop commits, state evidence, and acceptance boundaries are used as delivery method; LoopX is not a runtime dependency.

## Real acceptance still missing

1. Read-only email and calendar accounts, real test accounts, and real send receipts.
2. 10–15 everyday content tasks and at least 5 desktop tasks with complete acceptance records.
3. Sensitive-area masking, isolated desktop, snapshots, compensation, and high-risk actions.
4. Real UIA setvalue acceptance and failure drills for window loss, permission changes, and user takeover.
5. Phase-four mobile entry (PWA, pairing, push, remote approval, takeover) and 5–10 real proactive interruption tests.
6. Phase-five wrong-memory/wrong-method drills, full export verification, and before/after production comparison.
7. Phase-six real two-device sync, offline recovery, lost-device revocation, token rotation, backup restore, and migration verification.
8. Multi-week continuous operation, resource/state drift checks, upgrade rollback pipeline, and v1.0 acceptance.

These gaps are deliberately left open; they are not replaced with simulated data or a UI that only looks complete.

---
title: "Phase 2–6 Delivery Status"
description: "Verified capabilities, evidence, local substitutes, and deliberately unfinished work."
outline: [2, 3]
---

# Phase 2–6 Delivery Status

Checked on 2026-11-06. This page records only what the current code and real runs can prove; a page existing is not treated as a completed loop.

## Phase result

- **Phase 2: partially complete.** Local files, knowledge bases, public web, document and spreadsheet extraction, task source references, and the draft → approval → local outbox write → receipt loop are usable. Email and calendar accounts, real sending, and external system writes are not implemented, so Phase 2 is not accepted as a whole.
- **Phase 3: partially complete.** A same-machine Windows device can pair, approve capabilities individually, observe, pause, resume, take over, hand back, terminate, and run low-risk click, type, key, and UI Automation actions against an explicitly approved target app. Sensitive-area masking, isolated desktops, high-risk actions, snapshots, and compensation are not implemented, so Phase 3 is not accepted as a whole.
- **Phase 4: partially complete.** Proactive suggestions, the proactive inbox, accept/ignore/snooze/convert actions, the attention budget, and pause controls form a code loop. Mobile web, phone pairing, push, and remote takeover are not implemented, so Phase 4 is not complete.
- **Phase 5: partially complete.** Memory candidates, recall, correction, conflicts, forget propagation, and export, plus method generation, trial evidence, evaluation, promotion, rejection, and rollback, form a code loop. Real long-term memory use, production before/after method comparisons, and full 5.4 acceptance are still missing.
- **Phase 6: partially complete.** Incremental event sync, peer authentication, conflict handling, task leases with epoch fencing, device revocation and token rotation, the kill switch, encrypted database backup and restore, health checks, maintenance, and redacted diagnostics form a code loop. Real two-device switching, a lost-device drill, complete migration, weeks of continuous operation, and v1.0 release acceptance are still missing.

## Agent runtime loop

- **Implemented:** `native` and `codex` executors are peers; executor identity is recorded in runs and artifact manifests. General tasks default to native, explicit code/engineering tasks use Codex, and failures do not silently switch executors.
- **Implemented:** Four model protocols (OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini) with normalized streaming text and tool calls; providers can be selected or customized in settings.
- **Implemented:** A `@hearth/agent-runtime` single-agent tool loop covering read, search, write, edit, patch, shell, web fetch, ask-user, and finish tools, with task-scoped roots, hosts, and tool allowlists.
- **Implemented:** Turn, tool-call, token, and duration budgets; checkpoints after model turns and tool steps; recovery with user follow-up; and up to two repair rounds with prior agent context when declared deliverables are missing.
- **Implemented:** Tasks requiring network access or engineering workspace writes create a chat proposal and enter the queue only after confirmation. Ordinary general tasks dispatch directly.
- **UI contract:** The task list shows executor, phase, tokens, duration, and result. Details show the final summary and declared artifacts first; intermediate JSON, command logs, and checkpoints remain folded technical details.

This is a code-and-test loop, not evidence of long-running acceptance with real users.

## Phase 2 capabilities

| Step | Status | Implemented | Deliberately unfinished |
|---|---|---|---|
| 2.1 Read-only sources | Partial | Local file, knowledge, and public web sources; host allowlists; source status, read time, errors, incremental reads, deduplication, disconnect, reconnect, and clear | Email and calendar only show “needs configuration”; no credentials, reads, or permission verification |
| 2.2 Documents, tables, and web material | Basic loop complete | TXT, Markdown, CSV, JSON, HTML, PDF, DOCX, and XLSX extraction; page, paragraph, sheet, range, and gap metadata; web snapshots and source items can be reviewed | Complex layouts, OCR for scans, page-level citation navigation, and spreadsheet formula fidelity are not implemented |
| 2.3 Draft, approval, and external write | Partial | Editable, savable, and discardable drafts; one-time short-lived approval; approved effects write to the local outbox with a receipt; rejection and expiry update the draft | Only writes local `.hearth/outbox` files and does not contact mail servers; calendar and other external writes are absent |
| 2.4 Everyday-content acceptance | Not complete | Automated tests and isolated-instance checks cover local sources, extraction, and the outbox loop | No 10–15 real everyday tasks, time, accuracy, recovery, or willingness-to-reuse acceptance |

The local outbox is not presented as a fake success: the UI states that it only writes locally and does not send to recipients. It must not be described as sent before a real mail account is connected.

## Phase 3 capabilities

| Step | Status | Implemented | Deliberately unfinished |
|---|---|---|---|
| 3.1 Connect and inspect a device | Partial | Six-digit pairing code, device token, pairing approval separate from capability approval, per-capability grants, app allowlist, online state, and device revocation | No tray or always-visible global “auto control” indicator; Windows same-machine helper only |
| 3.2 Observe and take over | Partial | Session-bound screenshots; pause, resume, takeover, hand back, and terminate; takeover cancels queued input and advances the control epoch; user-idle check; two-minute screenshot expiry | Sensitive-area masking, long recordings, and complete desktop snapshots are absent |
| 3.3 Tiered desktop actions | Partial | Target-app binding and focus revalidation; click, short text, Enter/Tab/Escape/Ctrl+S; allowlisted UIA invoke/setvalue; UWP host windows mapped to an approved app through their UIA child process; command status and result records; structured rejection | High-risk preview and confirmation, isolated desktop, snapshots, compensation, and real UIA setvalue acceptance are not complete |
| 3.4 Desktop acceptance | Not complete | Isolated-port checks cover pairing, capability approval, observation, pause, resume, takeover, hand back, and the pro view | No five real desktop tasks, success-rate, takeover-count, and failure-drill acceptance |

The Windows helper currently focuses the server-approved target app before capture or input; it does not claim reliable background input. For UWP apps hosted by `ApplicationFrameHost`, the helper reads the window's UIA subtree and permits focus or capture only when a child process can be resolved to the approved app. For example, `CalculatorApp` maps to the approved name `calculator`. If ownership is ambiguous or the child process cannot be read, the helper fails closed instead of treating the host window as the target. Real UIA invocation was verified in Calculator: invoking “2” returned `InvokePattern` and changed the display from `7` to `72`. The same path also completed observe → UIA action → automatic observation through an isolated paired device, with both command results and frame uploads succeeding.

## Phase 4 capabilities

| Step | Status | Implemented | Deliberately unfinished |
|---|---|---|---|
| 4.1 Triggers and proactive suggestions | Code loop complete | Six trigger families: a task entering the 24-hour deadline window, a failed or recoverable task, an uncertain external effect, an approval pending for more than two hours, new source items in the last 24 hours, and queue backlog or long-running tasks; suggestions include source, why-now, suggested action, expected impact, estimated cost, risk, approval requirement, and priority; one deduplicated row accumulates repeated occurrences | Email and calendar triggers are disabled placeholders without account reads; proactive mode only produces suggestions and does not execute high-risk actions |
| 4.2 Proactive inbox | Code loop complete | A dedicated priority-ordered inbox supports accept, ignore, snooze, and convert-to-task; accept and convert are separate, where accept only records the decision and convert only creates a queued task without approving approvals or replaying external effects; an ignored event is not rephrased and pushed again | No multi-device or mobile inbox; no notification-channel delivery, only the local web inbox |
| 4.3 Phone viewing, approval, and takeover | Not implemented | None | No phone PWA, phone pairing, push, mobile approval, or remote takeover; the current entrance is the same-machine web control plane only |
| 4.4 Attention budget and proactive acceptance | Partial | Daily limit 0–50, quiet hours, cooldown, aggregation window, temporary pause and resume; the budget snapshot shows used-today, limit, quiet/paused state, and next-allowed time; the last seven days count deliveries, accepts, ignores, conversions, and completed tasks; the “Needs You” page collects pending approvals | No 5–10 real proactive tasks proving at most one interruption per task on average; no push delivery metrics or long-term user-feel record |

The key Phase 4 boundary is that a suggestion is not an execution. `accept` only changes the suggestion state. Only `convert` creates a new queued task, and that task still follows the normal executor, approval, and effect-ledger rules. A high-risk action does not bypass approval because it arrived as a proactive suggestion.

## Phase 5 capabilities

| Step | Status | Implemented | Deliberately unfinished |
|---|---|---|---|
| 5.1 Visible memory | Code loop complete | Memory first enters candidate state and participates in recall only after confirmation; records include kind, subject key, scope, tags, source, confidence, sensitivity, validity, and version; recall scores task relevance and records reasons and usage audits; injected context is marked `trusted="false"` and cannot expand authority; recall has item and character budgets | Auto-capture is off by default and only captures an “experience” memory from a terminal task; no automatic extraction of user facts from email, web pages, or arbitrary documents |
| 5.2 Correct, forget, and export | Code loop complete | Corrections create a new version and retain history; a same-subject conflict is not silently overwritten and requires left, right, or merge resolution; forgetting turns the current record into a tombstone and redacts historical versions, related events, and matching terms in recall audits; export excludes forgotten content; sensitive memory is not recalled by default and `secret` memory is never recalled | Cross-device forgetting relies on sync filtering and the local-replica boundary; there is no remote erasure of old copies already exported outside Hearth |
| 5.3 Summarize and evaluate reusable methods | Code loop complete | Candidates are generated from terminal task traces; capabilities are the intersection of source-task capabilities and cannot expand; baseline/trial metrics record success rate, duration, tokens, and approvals; evaluation distinguishes improved, flat, regressed, and insufficient; only candidates with improvement evidence and trial samples can be promoted; rejection and rollback retain reasons and audit | A “trial” only rereads existing terminal traces as evidence and does not execute a task again for evaluation, so it is not a live shadow executor; no long-term production comparison of an adopted method |
| 5.4 Memory and evolution acceptance | Not complete | API, service, and page-loop tests cover create, confirm, recall, correct, conflict, forget, export, trial, promote, and rollback | No real-user wrong-memory or wrong-method drills, no before/after success-rate, human-time, and cost comparison, and no full production “propose—evaluate—trial—adopt—revert” acceptance |

The shared boundary is “candidate before confirmation; evidence before promotion.” A candidate method does not go live automatically, and memory content cannot act as an instruction that directly expands tools, network, or approval authority.

## Phase 6 capabilities

| Step | Status | Implemented | Deliberately unfinished |
|---|---|---|---|
| 6.1 Multi-device sync and switching | Partial | Each instance has its own `instanceId`; a sync peer token is shown once and stored as a hash plus an encrypted copy; event pages are pulled incrementally by sequence and deduplicated; imported events can rebuild projections; newer local task, memory, or method state is not silently overwritten, and conflicts preserve both sides for a local/remote choice; the sync UI shows peers, cursors, errors, and conflicts | Only filtered event projections are synchronized; approvals, sources, outbox, devices, desktop, security, sync events, and sensitive/secret memories are not copied; artifact bodies, workspaces, and local absolute paths are not synchronized; no two-real-device switch or offline recovery acceptance |
| 6.2 Device revocation and safe migration | Partial | Task leases carry a TTL, owner, and epoch; after expiry another instance can take over and advance the epoch, and the old owner's commits and results are rejected; device capabilities can be revoked, device tokens rotated, and devices re-paired; sync peers can rotate tokens or be revoked; the global kill switch blocks approvals and scheduler restart and records a security audit; the security page shows state and audits | No dedicated cross-device artifact/workspace migration; no real lost-device drill proving a revoked old device cannot approve, take over, or read; clearing the global stop does not auto-restart the executor and requires an explicit user start |
| 6.3 Backup, restore, and upgrade | Partial | Creates a `*.hearth-backup` encrypted archive; the passphrase is derived with scrypt (N=32768, r=8, p=1), encrypted with AES-256-GCM, minimum 12 characters; the archive contains a SQLite snapshot, required settings/audit/event metadata, and the encrypted local `master.key`; restore writes a temporary SQLite database, checks `user_version`, schema, and `integrity_check`, rebuilds projections, then copies in a transaction with rollback on failure; preserves the current `instanceId`, `createdAt`, and global-stop state while clearing old leases, pairings, and desktop-session temporary records; legacy `/api/backup` returns `410` and requires encrypted backup | Excludes artifact bodies, task workspaces, source bodies, outbox attachments, screenshots/desktop temporary files, and external service data, so it is not a complete migratable backup; no application-version upgrade pipeline or failed-upgrade rollback release flow; incompatible schemas are rejected, but no real cross-version fixture drill exists |
| 6.4 Long-running operation and v1.0 acceptance | Partial | Health includes uptime, memory, disk, schema, task counts, scheduler, approvals, kill switch, and the latest maintenance run; maintenance expires stale approvals, recovers interrupted tasks, removes expired leases/desktop commands/screenshots/pairings and temporary files, and does not delete tasks, memories, or artifacts; maintenance runs automatically every six hours after startup and can be triggered manually; a failed maintenance run is recorded and marks health degraded; diagnostics export health, maintenance, counts, and event types without paths, keys, or environment secrets; the operations page shows health, maintenance, and backup boundaries | No multi-week continuous run, resource-drift data, real v1.0 install/upgrade/migration/exit acceptance, or complete all-task-type regression matrix |

The backup boundary must remain visible in the UI: a recoverable database is not a migrated set of artifact files. After restore, tasks may return, but artifact bodies, task workspaces, or external attachments still require separate backup and verification.

## Borrowed patterns and tradeoffs

- **OpenClaw:** pairing is separate from capability approval; commands are declared per device and approved individually; an observation frame is the basis for actions; takeover cancels queued input and advances the control epoch; unsupported actions fail closed. Hearth adopts these boundaries.
- **Hermes:** explicit capability manifests, target revalidation before execution, and session isolation. Hearth adopts app allowlists and target/epoch checks. It does not claim background focus-free input because the current Windows layer cannot reliably prove input still lands in the approved window.
- **OpenClaw proactive-service pattern:** suggestions are separate from execution, and a suggested action returns to the normal approval chain. Hearth adopts this and has not turned proactive suggestions into an auto-executor.
- **Hermes health-check pattern:** expose drivers, permissions, runtime state, and the latest maintenance result explicitly. Hearth uses health snapshots, maintenance records, and redacted diagnostics for this boundary.
- **DeerFlow:** task decomposition, method candidates, and layered evaluation are design references only. Hearth does not integrate DeerFlow or adopt its multi-agent runtime.
- **LoopX:** only small-loop commits, status evidence, and acceptance boundaries are used as delivery-method references; LoopX is not a runtime dependency.

## Verification evidence

On 2026-11-06, `npm test` on the current branch passed all 40 test files and 198 tests; `npm run typecheck` and `npm run build` also pass. These checks cover service, API, model-protocol, native tool-loop, budget, permission, checkpoint, and proposal-confirmation code loops but do not replace real-user, real-device, or long-running acceptance.

## Remaining real acceptance

1. Read-only email and calendar accounts, real test accounts, and real send receipts.
2. Acceptance records for 10–15 everyday content tasks and at least five desktop tasks.
3. Sensitive-area masking, isolated desktops, snapshots, compensation, and high-risk actions.
4. Real UIA setvalue acceptance and failure drills for lost windows, permission changes, and user takeover.
5. Phase 4 phone entry (PWA, pairing, push, remote approval, and takeover), plus interruption acceptance across 5–10 real proactive tasks.
6. Phase 5 wrong-memory/wrong-method drills, complete export verification, and real production comparisons before and after method adoption.
7. Phase 6 real two-device sync, offline recovery, lost-device revocation, token rotation, backup restore, and migration verification.
8. At least several weeks of continuous operation, resource and state-drift checks, an upgrade/rollback pipeline, and overall v1.0 acceptance.

These gaps are intentionally left open rather than replaced with simulated data or UI that only looks complete.

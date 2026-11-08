---
title: 'Day05 · First run, entrances, and mail closure'
outline: false
---

2026-11-08 was the day Hearth turned existing capabilities into entrances. 40 commits touched 91 files (+9,076/−329): the morning closed gaps in model profiles, routing, chat startup, and executor readiness, then fixed behaviour with a repeatable browser E2E; later, methods advanced to an auditable schema-11 application, and first run, proactive reminders, memory recall, the Feishu long connection, and SMTP/IMAP mail were wired into real interfaces. The suite grew from 54 test files and 296 tests on Day04 to 61 files and 381 tests.

The theme was not another page. It was making existing closures reachable for a new user, answerable from a phone approval, and verifiable with a real mail account. Every step kept the same boundary: notifications only make a person aware; approval still goes through one approval and effect ledger; without a real account, delivery and receipts are never fabricated.

## Early morning: fix the loop, then pin acceptance

| Area | Result |
|---|---|
| Model profiles and keys | Clear the chat-profile pointer before deleting a profile; write an empty API-key cipher when the key is cleared so the old secret cannot revive; registry validation failures return 4xx instead of 500 |
| Readiness | `native`, Codex, and DeepSeek Harness derive readiness from the model binding used at execution time, and the UI, router, and scheduler share one health result |
| Chat startup | New chats load server defaults before enabling the composer; stale or deleted conversations recover; Enter during IME composition no longer sends a message |
| Settings persistence | Blank executor commands or paths count as unconfigured, so saving no longer fails or erases stored values; approval and routing settings load before saving; sidebar readiness and executor labels match runtime state |
| Scheduler recovery | Queued tasks stay recoverable when an executor is unavailable, and scheduling errors are contained so an unavailable executor cannot crash the server |
| Browser E2E | A repeatable E2E runs in an isolated data directory and covers first run, live chat, tasks, conversation switching and recovery, model-key masking/clearing, executor settings, narrow viewports, and console errors; offline mode skips scenarios that need a live model |

## Skills: methods become auditable execution input

| Area | Result |
|---|---|
| Schema 11 | Adds a `method_applications` audit table, task method pins, and candidate generation/fingerprint columns; a migration test preserves tasks, runs, and checkpoints from older databases |
| Method context | Method guidance renders as bounded, untrusted blocks; pinned and template methods resolve deterministically; an application is recorded only when the block actually enters the prompt |
| Execution injection | Selected methods flow into task, cross-executor handoff, and repair prompts; no application record is written when the block is absent, so audit and execution cannot disagree |
| Evidence gate | Baseline and trial samples pair by template, and at least two baseline plus two trial tasks are required before a verdict can improve; a trial must match the per-run application and version and must not already belong to another method |
| Generations and rollback | Adopted methods promote into numbered generations that supersede earlier ones; rolling back a newer generation restores the previous one instead of leaving a single mutable state |
| Candidates and auto-learn | Ordered tools, decisions, and artifacts are extracted from the context ledger; candidates merge by fingerprint with one source task; a method-learning switch lets terminal tasks best-effort generate candidates and record trial evidence |
| Skills surface | The methods page is presented as "Skills", navigation is restored, and generation, auto-learn settings, trial-task creation, paired evaluation, application audit, and generation rollback are exposed |

## Late morning: first run, reminders, and memory

| Area | Result |
|---|---|
| First-run API | Adds first-run state and readiness checks; onboarding is required only when no state exists and no chat model is configured, with separate completed, skipped, and reset states |
| Four-step wizard | `/welcome` connects provider selection, connection test, executor check, memory and proactive preferences, and entry into chat; saving a model creates the profile, sets the chat model, and binds the native executor in one step |
| Navigation and reminders | Primary navigation exposes "Needs you", "Memory", "Skills", and "Mail"; a notification centre turns pending approvals and proactive suggestions into readable reminders, with in-app toasts and optional browser desktop notifications while the page is open |
| Proactive scan | The service scans once after startup and every five minutes afterwards; task, approval, effect, and source changes trigger a debounced scan after two seconds, still subject to enablement, proactive level, daily cap, quiet hours, cooldown, and dedupe |
| Delivery semantics | A suggestion emits `delivered` only when it is actually delivered; nothing is promised after the page closes, and without a channel the system falls back to in-app "Needs you"; Feishu messages and desktop notifications never change authority |
| Memory recall | Direct chat recalls relevant memories per conversation and reports the count through an SSE `memory` event; recall failure never blocks the answer; capture happens only at terminal task states so intermediate states are not written repeatedly |

## Feishu and real mail

| Area | Result |
|---|---|
| Feishu long connection | A self-built-app long-connection gateway with tenant-token caching, event parsing, image/file download, reconnect, open_id allowlist, and connection status; no public callback URL is required |
| Tasks and approvals | Task state and one-time approval summaries go to mapped conversations; `/approve` and `/reject` accept only allowlisted open_ids and match approval prefixes among tasks in the current conversation; rejection produces no external effect |
| Feishu settings | Settings gains App ID/Secret (encrypted), allowlist, Feishu/Lark domain, enablement, and connection status |
| Mail accounts | SMTP/IMAP host, port, TLS, account, and password are stored locally; passwords are AES-256-GCM encrypted and a blank edit preserves the old one; connection test, update, and delete are supported |
| SMTP send | Choosing an SMTP account on an outbox draft creates a one-time `email.smtp-send` approval with a preview of sender, recipients, cc/bcc, subject, body, and the no-recall impact; the TTL is ten minutes and the effect ledger sends after approval and stores `receipt.json` |
| Idempotency and uncertainty | Sending reuses the approval parameter hash, effect idempotency key, deterministic Message-ID, and local receipt; a `sending.json` placeholder is written first, and a directory without a receipt becomes an uncertain state rather than a blind resend |
| IMAP sync | Opens INBOX read-only and reads the latest 20–50 messages without marking them read; Message-ID deduplicates into Sources and bodies enter the source content directory; sync defaults to 15 minutes and can be disabled per account |
| Mail workspace | Accounts, inbox, and compose views; the inbox reads synced source items, compose only creates a draft, and the approval card shows a mail preview; this version has no attachment picker UI |

## Documentation and delivery status

The English and Chinese READMEs, delivery status, and the control, effects, and experience design pages now record first run, the proactive loop, the Feishu long connection, and real mail. Delivery status updates the verification baseline to 61 test files and 381 tests and keeps real accounts, bounce semantics, and attachment UI explicitly unaccepted. This log also updates the site home, navigation, sidebar, documentation map, and the implementation link in delivery status.

## Verification baseline

| Check | Result |
|---|---|
| Tests | `npm test` passed 61 test files and 381 tests; during the first parallel run the onboarding API case once hit the 5-second timeout, while both the single test and the full rerun passed |
| Types | `npm run typecheck` passed |
| Web build | `npm run build` passed |
| Docs build | `npm run docs:build` passed |
| Browser E2E | Offline `npm run test:e2e` passed 13 checks; scenarios needing a live model or executor were skipped by design among the 16 cases |
| Data migration | SQLite schema advanced to 11; the migration test passes without losing tasks, runs, or checkpoints |
| Real tasks | Stage-one acceptance still stands: 15 tasks ran, 13 passed; the T07/T08 boundaries are unchanged |
| Evidence rule | Code closure was not written up as real acceptance; notification delivery, a Feishu tenant, and mail receipts were not described as accepted |

> This log records implementation and internal verification, not a v1.0 release. Real accounts, real devices, long-running operation, and failure drills for phases 2–6 remain governed by [delivery status](/en/delivery/status).

## Commits

### 2026-11-08 (40 commits)

| Commit | Author | Changes |
|---|---|---|
| `2826b28` | JasonBuildAI | Cleared the chat-profile pointer before deleting a model profile and wrote an empty API-key cipher on update so the old secret cannot revive; 4 files (+60/−2). |
| `58d5831` | JasonBuildAI | Mapped model-registry validation failures to 4xx so `PUT /api/model-settings` no longer leaks a 500; 2 files (+34/−2). |
| `74c7f2a` | JasonBuildAI | Kept method questions in chat, sent attachment messages to a task executor, and honoured per-message settings on existing conversations without persisting them; 4 files (+136/−4). |
| `0e6f982` | JasonBuildAI | Derived `native`, Codex, and DeepSeek Harness readiness from the binding used at execution time so the UI, router, and scheduler agree; 5 files (+153/−13). |
| `b92fcee` | JasonBuildAI | Treated blank executor commands or paths as unconfigured so saving no longer fails or erases values, and served new-chat defaults from the server; 4 files (+55/−4). |
| `3294a00` | JasonBuildAI | Loaded server defaults before enabling the composer, recovered stale or deleted conversations, and ignored Enter during IME composition; 2 files (+60/−29). |
| `c0e6883` | JasonBuildAI | Loaded approval and routing settings before saving executors, omitted blank fields, derived sidebar state from executor health, and added the DeepSeek Harness label; 6 files (+38/−8). |
| `9c8a630` | JasonBuildAI | Kept queued tasks recoverable when an executor is unavailable and contained scheduling errors so an unavailable executor cannot crash the server; 4 files (+37/−5). |
| `907d036` | JasonBuildAI | Added a chat-routing test for a bound Codex executor so readiness no longer causes a reroute; 1 file (+39). |
| `149e7c9` | JasonBuildAI | Added a repeatable browser E2E in an isolated data directory covering live chat, tasks, settings, conversation recovery, model-key masking/clearing, readiness, and narrow viewports; refreshed the documented baseline; 6 files (+533/−6). |
| `d484a40` | JasonBuildAI | Disabled global executor detection in offline E2E and skipped task scenarios without a live model or executor so offline runs stay deterministic; 1 file (+5/−4). |
| `70757bf` | JasonBuildAI | Added shared types for method applications, adoption generations, task method pins, and the method context kind; 3 files (+28/−2). |
| `a6a4717` | JasonBuildAI | Added schema 11 with a method-application audit table, task method pins, and candidate generation/fingerprint columns, plus an older-database migration test; 3 files (+130/−12). |
| `d4de771` | JasonBuildAI | Allowed an explicit method pin at task creation and added a task method assignment API with template and status validation; 5 files (+112/−2). |
| `3c59aae` | JasonBuildAI | Rendered method guidance as bounded untrusted blocks, resolved pinned or template methods deterministically, and recorded an application only when included; 4 files (+172/−2). |
| `0cc5d10` | JasonBuildAI | Injected selected methods into task, cross-executor handoff, and repair prompts, and skipped application records when the block was absent; 7 files (+161/−15). |
| `9bbe8b1` | JasonBuildAI | Rejected trial evidence unless it matched the per-run method application and version and the task had not been trialed by another method; 3 files (+62/−2). |
| `739ea83` | JasonBuildAI | Paired baseline and trial samples by template, recorded trial and prompt evidence, and required two baseline plus two trial tasks before a verdict could improve; 4 files (+125/−25). |
| `8889a95` | JasonBuildAI | Promoted adopted methods into numbered generations that supersede earlier ones and restored the previous generation when a newer one was rolled back; 2 files (+80/−9). |
| `4ac17b4` | JasonBuildAI | Extracted ordered tools, decisions, and artifacts from the context ledger, merged candidates by fingerprint, and kept a single source task; 2 files (+79/−19). |
| `08b016c` | JasonBuildAI | Persisted the method-learning switch in app settings and exposed it through the method snapshot and settings APIs; 3 files (+70/−2). |
| `20d7110` | JasonBuildAI | Best-effort generated candidates for completed or failed tasks without a bound method, recorded trial evidence for pinned methods, and added an `autoLearn` scheduler switch; 3 files (+52). |
| `b736389` | JasonBuildAI | Restored methods navigation and exposed generation, auto-learn settings, trial-task creation, paired evaluation, application audit, and generation rollback; 6 files (+150/−35). |
| `fa30e12` | JasonBuildAI | Documented task pins, per-run applications, adoption generations, and the constrained 2+2 evolution flow in the Chinese and English design docs; 4 files (+12/−4). |
| `0e1a034` | JasonBuildAI | Added first-run state and readiness APIs; onboarding is required only when no state exists and no chat model is configured, with completed, skipped, and reset states; 4 files (+261). |
| `97ed0e9` | JasonBuildAI | Added the four-step `/welcome` wizard: provider and connection test, executor check, memory and proactive preferences, and entry into chat; saving a model binds the native executor; 9 files (+956/−18). |
| `3e71086` | JasonBuildAI | Exposed "Needs you", "Memory", "Skills", and "Mail" in primary navigation and wired proactive and connection settings into settings; 3 files (+51/−2). |
| `9445f61` | JasonBuildAI | Presented methods as "Skills" in the UI while keeping the auditable method model underneath; 2 files (+16/−16). |
| `9eae68a` | JasonBuildAI | Scanned once at startup and every five minutes afterwards, debounced scans for task/approval/effect/source changes after two seconds, and kept the existing frequency and quiet-hour limits; 4 files (+112/−5). |
| `9890560` | JasonBuildAI | Added an in-app notification centre that turns pending approvals and proactive suggestions into readable reminders, with optional browser desktop notifications while the page is open and no promise after it closes; 8 files (+393/−3). |
| `668aa3f` | JasonBuildAI | Recalled memories per conversation during direct chat, reported the count through an SSE `memory` event, and let recall failure fall through without blocking the answer; 8 files (+193/−8). |
| `0beb552` | JasonBuildAI | Captured experience memory only at terminal task states, avoiding repeated writes from intermediate states; 2 files (+26/−5). |
| `7b6b934` | JasonBuildAI | Added a Feishu/Lark long-connection gateway with tenant-token caching, message parsing, image/file download, reconnect, allowlist, and status, plus 269 lines of gateway tests; 8 files (+1,314). |
| `ac778a9` | JasonBuildAI | Sent task state and one-time approval summaries to mapped conversations; `/approve` and `/reject` accept only allowlisted open_ids and match approval prefixes within the current conversation; 3 files (+261/−3). |
| `3f663ab` | JasonBuildAI | Added Feishu connection settings: encrypted App ID/Secret, open_id allowlist, Feishu/Lark domain, enablement, and status; 5 files (+335/−3). |
| `522eabc` | JasonBuildAI | Added mail-account storage and APIs for SMTP/IMAP host, port, TLS, account, and encrypted password, with connection test, update, and delete; 5 files (+1,113). |
| `d4e7a8f` | JasonBuildAI | Turned an SMTP-account outbox draft into a one-time send approval; the effect ledger sends after approval and stores a receipt, with an idempotency key, deterministic Message-ID, and an uncertain state instead of a blind resend; 8 files (+382/−52). |
| `77a00db` | JasonBuildAI | Synced the latest 20–50 INBOX messages read-only without marking them read and deduplicated them into Sources by Message-ID; sync defaults to 15 minutes and can be disabled per account; 6 files (+253/−4). |
| `d0bf9ee` | JasonBuildAI | Added the mail workspace with accounts, inbox, and compose views, supporting sync, synced-mail preview, draft creation, and an approval card with mail preview and no-recall notice; 8 files (+955/−12). |
| `e949650` | JasonBuildAI | Documented first run, the proactive loop, Feishu, and real mail in the English and Chinese READMEs, delivery status, and design docs, and updated the baseline to 61 files and 381 tests; 10 files (+114/−34). |

## Boundaries and next step

- Mail still writes to the local outbox by default; only an SMTP account enables a real-send approval. Real accounts, bounce and spam semantics, OAuth2, and the attachment picker UI are not manually accepted; IMAP reads only the latest 20–50 messages and never marks them read.
- The Feishu long connection provides text messages and one-time approval commands, but it is not a mobile PWA, system push, or complete remote takeover. A real tenant, rate limits, reconnect behaviour, and a card-button option remain unaccepted, and nothing is pushed after the page closes.
- Method auto-learning and 2+2 evidence now reach scheduling and audit, but long-term production comparisons, wrong-method drills, and candidate-quality data are still missing; generating a candidate is not the same as proving a method improved.
- First run checks only models, executors, memory, and the proactive service; backup, safety, and data migration are not covered. A failed onboarding query or a non-root route does not force the wizard, which is a deliberate recovery path.
- Proactive scans run every five minutes and react to domain events, but there is no system-level push after the page closes; notifications are reminders, and approval still goes through the same one-time approval chain.
- The first-run API test is sensitive to startup latency and once hit a five-second timeout under parallel load; reruns passed, but the timeout margin still needs adjustment.
- Real acceptance for phases 2–6 is unchanged: real mail/calendar, a Feishu tenant, the phone entrance, high-risk desktop actions, memory production comparisons, two-device switching, and weeks of continuous operation remain open.
- The next stage continues closing real evidence along the [delivery route](/en/delivery/) rather than adding entrances that only prove a page exists.
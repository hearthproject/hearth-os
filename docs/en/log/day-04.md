---
title: 'Day04 · Runtime and executor convergence'
outline: false
---

On 2026-11-06 Hearth grew from the stage-one MVP into a full local Agent OS. That day 102 commits touched 432 files (+35,228/−4,327), moving the chat-first interface, native agent runtime, four model protocols, sources and document extraction, local outbox, Windows desktop helper, proactive service, memory, method evolution, incremental sync, leases, kill switch, encrypted backup, health maintenance, and redacted diagnostics into running code with automated tests.

On 2026-11-07, Day04 continued by converging the executor layer onto one path: 42 commits touched 165 files (+28,030/−1,845), adding a shared seven-executor registry, a SQLite model registry, a task-level context ledger with executor handoff, failure diagnosis and routing fallback, and a settings page reorganised into executors, models, context, and data. Qoder, WorkBuddy, Kimi, and DeepSeek Harness joined the unified adapter layer, and the transitional ZCode integration was removed.

The two days did not treat "the page exists" as closure: server, API, projection, executor boundary, and tests landed together. The suite grew from 51 tests to 54 test files and 296 tests; `npm run typecheck`, `npm run build`, and `npm run docs:build` all passed. Phases 2–6 still count as partial, not because code is missing, but because real accounts, real devices, and long-running acceptance are still outstanding.

## What shipped on 2026-11-06

| Area | Result |
|---|---|
| Chat-first interface | Rebuilt the web app around conversation, with tasks, proposals, approvals, and artifacts organised around the thread |
| Native agent runtime | Single-agent tool loop, four budget classes, tool permissions, checkpoints, wait-for-input and resume, and recovery of missing artifacts |
| Four model protocols | OpenAI Chat, OpenAI Responses, Anthropic Messages, and Gemini unified as streaming agent turns |
| Two executors | `native` and `codex` sit side by side; executor identity is written into the run manifest and failures never switch silently |
| Sources and documents | Local files, knowledge base, web pages, and TXT/Markdown/CSV/JSON/HTML/PDF/DOCX/XLSX extraction with source entries |
| Local outbox | Drafts, one-time approval, write to the local outbox after approval, and stored receipts |
| Windows desktop | Six-digit pairing, per-capability approval, observation, pause/takeover/hand-back, low-risk input, UIA invoke, and UWP window attribution |
| Proactive service | Six trigger classes, a proactive inbox, accept/ignore/snooze/convert-to-task, and an attention budget |
| Memory and methods | Memory candidates, recall, correction, conflict, forgetting, and export; method candidates, trial evidence, evaluation, promotion, rejection, and rollback |
| Multi-device and safety | Incremental event sync, peer authentication, task leases with epoch fencing, device revocation, token rotation, and a global kill switch |
| Backup and operations | AES-256-GCM encrypted backup, rollback restore, health snapshots, periodic maintenance, and redacted diagnostics |

## Executor and context convergence on 2026-11-07

| Area | Result |
|---|---|
| Seven-executor registry | `native`, `codex`, and `deepseek-harness` are first-class; `hermes`, `qoder`, `workbuddy`, and `kimi` are external; all share launch resolution, health probes, managed installs, model bindings, context collection, and one settings surface |
| Unified model registry | `model_profiles` and `executor_model_bindings` live in SQLite; legacy `model-settings.json` / `executor-settings.json` are imported at startup with backups under `.hearth/backups/legacy-dev/`; API keys are AES-256-GCM encrypted and masked in the UI |
| Protocol constraints | Codex is fixed to OpenAI Responses; local addresses stay out of unified model management; non-native executors must bind a model explicitly; the server enforces executor/protocol compatibility |
| Context ledger | Every executor writes messages, tool calls, results, checkpoints, and notices to `context_items`; `executor_event_id` deduplicates, large bodies go to `.hearth/context/blobs/`, and task summaries live in `task_context_state` |
| Failure diagnosis and handoff | Rules first separate executor faults from non-executor faults; the current Hearth chat model diagnoses; full-permission low-risk runs switch automatically, while approval mode only asks whether to switch; at most two handoffs by default, each carrying `context_watermark_seq` |
| Routing and selection | One executor picker replaces the chat toggles; the conversation-level choice outranks the global default; unavailable or incapable choices fall back to the task-matched executor; task-like requests honour the explicit selection without a router model |
| Settings and data | Settings is reorganised into executors, models, context, and data; model registry and storage information are exposed over APIs; SQLite schema advances to 10; Codex uses the configured home and injected environment, and health checks report the managed binding without rewriting config |
| Executor adapters | DeepSeek Harness runs through its official SDK/JSON-RPC; Hermes moves to the unified external adapter and resumes the previous CLI session; Qoder, WorkBuddy, and Kimi adapters are added; ZCode is removed |
| Documentation and UI | New storage and context architecture guide in both languages, updated executor docs and README; the app shell fits the viewport, settings readability improves, and chat streams model reasoning separately from the answer |

## Verification baseline

| Check | Result |
|---|---|
| Tests | `npm test` passed 54 test files and 296 tests |
| Types | `npm run typecheck` passed |
| Web build | `npm run build` passed |
| Docs build | `npm run docs:build` passed |
| Real tasks | Stage-one acceptance still stands: 15 tasks ran, 13 passed; the T07/T08 boundaries are unchanged |
| Evidence rule | Code closure was not written up as real acceptance; external comments and desktop actions were not described as completed |

> This log records implementation and internal verification, not a v1.0 release. Real accounts, real devices, long-running operation, and failure drills for phases 2–6 remain governed by [delivery status](/en/delivery/status).

## Commits

### 2026-11-06 (102 commits, selected)

| Commit | Author | Changes |
|---|---|---|
| `a0544fd` | JasonBuildAI | Added the Simple Pro read model to prepare aggregated task, approval, and artifact views for the chat-first interface; 8 files (+729/−21). |
| `b748d02` | JasonBuildAI | Converged the interface on the Simple Pro structure and removed the older complex control-plane layout; 32 files (+2,970/−1,360). |
| `3aca641` | JasonBuildAI | Rebuilt the web app as a chat-first interface organised around conversation, tasks, proposals, and approvals; 9 files (+1,288/−357). |
| `8d28901` | JasonBuildAI | Added the source registry store, recording source type, status, read time, and errors; 3 files (+198/−1). |
| `cec6d41` | JasonBuildAI | Added source-reading APIs for local files, knowledge base, and web sources, with incremental refresh; 5 files (+735/−2). |
| `b408eb3` | JasonBuildAI | Added document extraction for TXT, Markdown, CSV, JSON, HTML, PDF, DOCX, and XLSX, including page, sheet, and range records; 6 files (+3,461/−74). |
| `d458bd3` | JasonBuildAI | Added a source picker to the new-task flow so ready source entries can be attached to a task; 4 files (+180/−6). |
| `ae5bf0f` | JasonBuildAI | Added the outbox draft projection, showing drafts, submission status, and receipts; 3 files (+152/−2). |
| `b820dca` | JasonBuildAI | Added outbox draft APIs for editing, saving, discarding, and submitting for approval; 6 files (+551/−1). |
| `f1558a9` | JasonBuildAI | Wrote approved drafts to the local outbox with stored receipts, and synchronised draft state on rejection or expiry; 4 files (+408/−4). |
| `5b6e50f` | JasonBuildAI | Added the Windows desktop helper with window observation, focus, click, text input, keys, and UIA actions; 1 file (+358). |
| `34877a0` | JasonBuildAI | Bound observation frames to the target application and rejected silently treating the host window as the approved app; 3 files (+92/−15). |
| `97d0f07` | JasonBuildAI | Resolved UWP host windows to their UIA child process and mapped them to the approved app, such as CalculatorApp to calculator; 1 file (+109/−17). |
| `119b67f` | JasonBuildAI | Recorded UWP and UIA isolation verification, including calculator invoke and the observe → act → auto-observe chain; 2 files (+6/−6). |
| `11a1e60` | JasonBuildAI | Added the proactive trigger engine covering deadline windows, failure or recoverability, uncertain results, pending approval, new sources, and queue backlog; 5 files (+1,144/−1). |
| `66ee76c` | JasonBuildAI | Added the proactive inbox and attention budget with accept, ignore, snooze, and convert-to-task; 8 files (+624/−1). |
| `21d1592` | JasonBuildAI | Added memory core and recall, recording provenance, confidence, sensitivity, version, and recall audits; 7 files (+1,170/−3). |
| `ac92758` | JasonBuildAI | Added memory browse, correction, conflict, and forgetting; forgetting redacts historical versions and recall audits; 6 files (+599/−1). |
| `11b0307` | JasonBuildAI | Added memory-poisoning boundary tests so memory cannot act as an instruction that widens permissions; 1 file (+21). |
| `b6b3f63` | JasonBuildAI | Added the method evaluation engine, recording baseline and trial success rate, duration, tokens, and approval count; 5 files (+788). |
| `0e3a35f` | JasonBuildAI | Added method evolution browsing with candidate generation, evaluation, promotion, rejection, and rollback; 6 files (+493/−1). |
| `724e784` | JasonBuildAI | Added incremental event sync and peer authentication, pulling by sequence, deduplicating, and rebuilding projections; 7 files (+816/−5). |
| `24c2ea4` | JasonBuildAI | Put task execution under TTL, owner, and epoch leases; expired takeover advances the epoch and stale-owner writes are rejected; 7 files (+391/−7). |
| `e70b0d3` | JasonBuildAI | Added the global kill switch, device revocation, token rotation, and safety audit; 14 files (+678/−22). |
| `44f58b9` | JasonBuildAI | Added AES-256-GCM encrypted backup and rollback restore, validating schema, user_version, and integrity_check; 16 files (+1,160/−22). |
| `b3cffeb` | JasonBuildAI | Added runtime health snapshots, periodic maintenance, and redacted diagnostics, marking degraded when maintenance fails; 15 files (+974/−29). |
| `42d8827` | JasonBuildAI | Recorded phase 4–6 delivery status, separating implemented, verified, and still-open items; 13 files (+124/−12). |
| `32f0b0d` | JasonBuildAI | Unified four model protocols: OpenAI Chat, OpenAI Responses, Anthropic Messages, and Gemini; 5 files (+665/−74). |
| `581bc44` | JasonBuildAI | Let chat answer material questions first instead of dispatching every input directly as a task; 3 files (+61/−19). |
| `e4eefbb` | JasonBuildAI | Added the single-agent loop with budgets and checkpoints; 5 files (+396). |
| `99392ea` | JasonBuildAI | Added permission-bound built-in tools for read/write, search, shell, web, asking the user, and completion; 2 files (+589). |
| `9a37e78` | JasonBuildAI | Added executor, permission, budget, and checkpoint contracts; 1 file (+58). |
| `375ff8d` | JasonBuildAI | Added the executor registry so native and codex are peers; 1 file (+33). |
| `bbbbfab` | JasonBuildAI | Added the native agent executor adapter connecting the runtime to the scheduler; 3 files (+168). |
| `5f5009a` | JasonBuildAI | Required tasks needing network or engineering-workspace permission to produce a chat proposal before dispatch; 2 files (+79/−5). |
| `6b4295d` | JasonBuildAI | Collected answers inline when a task waits for input, then resumed execution; 2 files (+53/−4). |
| `c776d2c` | JasonBuildAI | Recorded the native runtime closure, explaining executor, protocol, tools, budgets, and recovery boundaries; 2 files (+24/−2). |
| `b5a785f` | JasonBuildAI | Derived health expectations from the current schema version to stop test drift after upgrades; 2 files (+4/−4). |

### 2026-11-07 (42 commits)

| Commit | Author | Changes |
|---|---|---|
| `e5b27b6` | JasonBuildAI | Streamed model reasoning separately from answer text so thinking does not leak into the deliverable; 6 files (+209/−40). |
| `6142c20` | JasonBuildAI | Rebuilt the README and documentation site for Day04, including the homepage, delivery route, and capability status; 99 files (+2,890/−1,970). |
| `f1cfe5d` | JasonBuildAI | Restored the original site structure and updated delivery content, rebuilding stage and sub-stage pages; 97 files (+2,131/−2,434). |
| `e6ac426` | JasonBuildAI | Added the unified context ledger and executor handoff across collection, projection, summaries, metrics, diagnosis, and `handoffs`; 65 files (+9,461/−528). |
| `5457227` | JasonBuildAI | Added the shared seven-executor registry with executor identity, tier, and capabilities in shared types; 19 files (+304/−101). |
| `24902d5` | JasonBuildAI | Added generic launch resolution and health probes across user paths, managed installs, global installs, and `PATH`; 6 files (+744/−19). |
| `c793b26` | JasonBuildAI | Added managed executor install jobs with status, logs, and errors; 6 files (+438/−3). |
| `65a35bd` | JasonBuildAI | Added Qoder, WorkBuddy, ZCode, and Kimi adapters reusing local logins and streaming events; 5 files (+987/−31). |
| `9a524ac` | JasonBuildAI | Made routing honour the preferred executor instead of always overriding it with the task-matched one; 3 files (+71/−2). |
| `af1f02a` | JasonBuildAI | Unified executor installation, health, paths, concurrency, and model bindings in settings; 5 files (+593/−140). |
| `4e05832` | JasonBuildAI | Replaced the chat executor toggles with a single picker; 3 files (+95/−59). |
| `3be7808` | JasonBuildAI | Fell back to the task-matched executor when the selected one is unavailable or lacks capability; 3 files (+49/−3). |
| `1460c4e` | JasonBuildAI | Documented the unified executor registry and the extension constraints; 3 files (+75/−3). |
| `0205c88` | JasonBuildAI | Removed the ZCode integration, its settings, adapters, and tests; 21 files (+29/−246). |
| `da9f006` | JasonBuildAI | Moved executor model bindings and task status into SQLite; 13 files (+797/−28). |
| `d89cddc` | JasonBuildAI | Added the DeepSeek Harness SDK/JSON-RPC adapter with native tools, session resume, and full event streams; 10 files (+11,294/−803). |
| `24882cc` | JasonBuildAI | Made the Codex executor honour the configured `CODEX_HOME` and injected environment instead of assuming the default directory; 3 files (+11/−3). |
| `35986e6` | JasonBuildAI | Wired the SQLite model registry into server routes and settings APIs; 6 files (+251/−25). |
| `f79aff1` | JasonBuildAI | Imported legacy JSON settings into SQLite at startup, backing them up under `.hearth/backups/legacy-dev/` and recording the migration; 7 files (+435/−26). |
| `5067f3d` | JasonBuildAI | Routed Hermes through the unified external executor adapter while keeping launch and event parsing; 5 files (+126/−94). |
| `e6376fc` | JasonBuildAI | Detected DeepSeek through SDK runtime markers and ignored non-result attempt events; 3 files (+41/−4). |
| `d72d5cf` | JasonBuildAI | Required non-native executors to bind a model explicitly instead of inheriting the chat model; 1 file (+2/−4). |
| `67109b7` | JasonBuildAI | Resumed the previous Hermes CLI session to reduce repeated context; 3 files (+43/−10). |
| `b7c9031` | JasonBuildAI | Added executor failure diagnosis and cross-executor handoff with fallback order, diagnosis summaries, and handoff bundles; 4 files (+282/−50). |
| `819f1e2` | JasonBuildAI | Added constraint tests enforcing Codex Responses and keeping local models out of unified management; 1 file (+64). |
| `e66948a` | JasonBuildAI | Exposed model registry and storage APIs to the web settings page; 2 files (+63). |
| `44aaa70` | JasonBuildAI | Reorganised settings into executors, models, context, and data; 2 files (+1,009/−380). |
| `7fe45dc` | JasonBuildAI | Added the Chinese storage and context architecture guide covering SQLite, blobs, the model registry, and handoff; 1 file (+134). |
| `3fe318d` | JasonBuildAI | Added the English storage and context architecture guide; 1 file (+134). |
| `d37d298` | JasonBuildAI | Documented executor tiers, model bindings, handoff, and shared context in Chinese; 1 file (+61/−16). |
| `d372405` | JasonBuildAI | Mirrored the tier, model binding, and handoff guidance in English; 1 file (+61/−16). |
| `5ad480a` | JasonBuildAI | Linked the storage architecture from the design indexes; 3 files (+6/−2). |
| `b6f39e7` | JasonBuildAI | Described executor tiers, the model registry, and SQLite storage in the README; 1 file (+16/−9). |
| `8126587` | JasonBuildAI | Aligned the Chinese README overview with executors and storage; 1 file (+28/−5). |
| `2ef7837` | JasonBuildAI | Refreshed the design module map in the appendix; 2 files (+8/−8). |
| `cab8c8d` | JasonBuildAI | Refreshed the verified test count in the README; 2 files (+4/−4). |
| `09d0a7c` | JasonBuildAI | Fitted the app shell to the viewport and fixed scrolling and layout in narrow windows; 2 files (+37/−11). |
| `f0ec945` | JasonBuildAI | Improved settings readability with spacing, grouping, and type hierarchy; 1 file (+90). |
| `cadbbf7` | JasonBuildAI | Honoured the conversation-selected executor for task-like requests; 4 files (+131/−8). |
| `e198a27` | JasonBuildAI | Derived executor readiness from runtime health in the web UI; 2 files (+64/−11). |
| `bb4e18b` | JasonBuildAI | Kept task routing deterministic when no router model is configured; 2 files (+14/−2). |
| `872e847` | JasonBuildAI | Made Codex health report the managed binding without rewriting the config file; 1 file (+8/−7). |

## Boundaries and next step

- The phase 2–6 code closures run, but real mail/calendar accounts, high-risk desktop actions, the phone entry point, memory production comparisons, two-device switching, and long-running operation are not yet accepted.
- All seven executors are registered and covered by automated tests, but real Qoder, WorkBuddy, and Kimi logins, long-running DeepSeek Harness operation, cross-executor consistency, and handoff drills are not yet accepted.
- The unified model registry and context ledger now live in SQLite (schema 10), and legacy settings migrate with backups; capacity, retention, and cross-device context sync still lack long-running data.
- Handoff defaults to at most two attempts and one retry per executor; diagnosis accuracy and automatic-switch safety under real faults still need comparison data.
- The chat-first primary navigation only exposes chat, tasks, devices, and settings; memory, methods, sync, safety, and operations have APIs and page components that are not yet wired back into primary navigation.
- The next stage does not add more pages. It closes real evidence item by item along the [delivery route](/en/delivery/).

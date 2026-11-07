---
title: 'Day04 · The runtime takes shape'
outline: false
---

On 2026-11-06 Hearth grew from the stage-one MVP into a full local Agent OS. That day 102 commits touched 432 files (+35,228/−4,327), moving the chat-first interface, native agent runtime, four model protocols, sources and document extraction, local outbox, Windows desktop helper, proactive service, memory, method evolution, incremental sync, leases, kill switch, encrypted backup, health maintenance, and redacted diagnostics into running code with automated tests.

The day did not treat "the page exists" as closure: server, API, projection, executor boundary, and tests landed together. The suite grew from 51 tests to 40 test files and 198 tests; `npm run typecheck`, `npm run build`, and `npm run docs:build` all passed. Phases 2–6 still count as partial, not because code is missing, but because real accounts, real devices, and long-running acceptance are still outstanding.

## What shipped

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

## Verification baseline

| Check | Result |
|---|---|
| Tests | `npm test` passed 40 test files and 198 tests |
| Types | `npm run typecheck` passed |
| Web build | `npm run build` passed |
| Docs build | `npm run docs:build` passed |
| Real tasks | Stage-one acceptance still stands: 15 tasks ran, 13 passed; the T07/T08 boundaries are unchanged |
| Evidence rule | Code closure was not written up as real acceptance; external comments and desktop actions were not described as completed |

> This log records implementation and internal verification, not a v1.0 release. Real accounts, real devices, long-running operation, and failure drills for phases 2–6 remain governed by [delivery status](/en/delivery/status).

## Commits

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

## Boundaries and next step

- The phase 2–6 code closures run, but real mail/calendar accounts, high-risk desktop actions, the phone entry point, memory production comparisons, two-device switching, and long-running operation are not yet accepted.
- The chat-first primary navigation only exposes chat, tasks, devices, and settings; memory, methods, sync, safety, and operations have APIs and page components that are not yet wired back into primary navigation.
- The next stage does not add more pages. It closes real evidence item by item along the [delivery route](/en/delivery/).

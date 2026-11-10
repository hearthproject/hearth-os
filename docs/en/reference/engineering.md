---
title: 'Engineering'
description: 'Hearth engineering principles, technology stack, runtime shape, data organization, testing, and release constraints.'
outline: [2]
---

# Engineering

<p class="lead">The design section defines product boundaries; engineering defines how those boundaries become a runnable, verifiable, recoverable system. These choices are defaults, not dogma, but task correctness, authority, and recovery are not traded away for convenience.</p>

## Engineering Principles and Runtime Shape

- **Modular monolith first.** Do not introduce microservices early. Keep control, tasks, execution, memory, and entrances in one deployable system, with boundaries maintained by interfaces and tests.
- **Deliver vertical slices.** Every phase includes interface, persistent state, real execution, verification, and recovery. A backend-only capability is not done.
- **Record facts first.** Task state, approvals, artifacts, and receipts are written locally before interfaces, notifications, and reports are rebuilt.
- **One write authority per state.** The early system uses one process, one writer, and a local database so two executors cannot advance the same work at once.
- **Execution must recover.** Long work saves checkpoints and execution records so it survives restarts, sleep, network loss, and executor crashes.
- **External actions are approved.** Sends, writes, deletes, publishes, and payments use preview, authorization, idempotency, and receipts; executors cannot bypass them.
- **Adapters stay isolated.** Codex, connectors, browsers, desktop operation, and isolation environments enter through one capability boundary.
- **Local-first and portable.** Personal data stays local by default; cloud services are replaceable; users can export, back up, and restore.
- **Versions and rollback.** Data structures, executors, methods, and configuration are versioned, and a failed upgrade returns to the last stable version.
- **Observable without intrusion.** Every task has a trace, cost, and failure category. The interface shows what users need; detailed records remain in a local audit view.

| Layer | Default | Reason |
|---|---|---|
| Primary language | TypeScript | Service, command line, web, and adapters share concepts and validation |
| Service runtime | Node.js 22.13+ | Fits high-I/O orchestration and event delivery; document work uses built-in `node:sqlite` |
| Resident service | One modular-monolith process | Reduces early operational cost and protocol drift |
| Local storage | SQLite in WAL mode | Enough for single-user, local-first, single-writer use with simple backup |
| Data validation | Versioned data structures | External input, records, and actions still need runtime validation |
| Web | React and Vite | Fits task cards, approvals, artifacts, and live state; the PWA shell and mobile navigation exist, while phone pairing, system push, and remote takeover are not accepted |
| Live updates | Server-sent event push | Simpler than a two-way persistent connection for state changes |
| Browser automation | Not built in | Web sources use `fetch` + `cheerio`; sites that need a signed-in session or interaction stay inside the executor workspace |
| Documents and data | Server-side TypeScript | `pdfjs-dist`, `mammoth`, and `exceljs` extract PDF, DOCX, and XLSX in-process |
| Isolation | One workspace per task | Today isolation is the task workspace plus restricted tool permissions; containers and high-risk isolation rooms remain unfinished work in [Phase 3](/en/delivery/stage-3) |

TypeScript is the language; Node.js is the runtime. The former constrains development-time types, while the latter provides files, networking, processes, and timers. External input and persisted data still need runtime validation. The primary language does not change the real safety boundaries of isolation, approval, recovery, and authority.

The early system has one resident service writing the main database. Command line, web, mobile, and executors connect through task queues or controlled interfaces and do not write the database directly. Executors can be replaced while tasks, authority, and receipts remain in the main system. Document extraction runs inside the server process; browser workers and device agents join as controlled capabilities when needed, not as a second business protocol.

Local data should be understandable, backupable, and portable. The main record stores tasks and events. Artifacts are stored separately and verified by content. Workspaces are created and cleaned by task. Configuration stores rules and connections. Credentials contain only encrypted material or short-lived references. Logs and backups are kept separately. Sensitive directories use minimal permissions, backups are encrypted, and device sync sends only necessary state and artifact references.

## Data, Testing, and Release

The repository is organized by entrances, core capability, executors, tests, and evaluation rather than by page or arbitrary team boundary.

| Area | Responsibility |
|---|---|
| Service, web, command line, device node | Entrances, task cards, approvals, artifacts, notifications, and takeover |
| Core state | Tasks, work units, execution records, checkpoints, recovery, and failure classes |
| Fact records | Append-only records, projections, migrations, replay, and audit |
| Control and authority | Triggers, autonomy levels, authorization scope, risk, and anomaly stops |
| Context and cost | Minimal context, model selection, budget, cache, and cost attribution |
| Executors | General reasoning, Codex, connectors, browser, desktop, documents, and human takeover |
| Safety and external action | Workspaces, network, short-lived credentials, preview, idempotency, and receipts |
| Memory and evolution | Memory write, retrieval, correction, forgetting, method candidates, canary, and rollback |
| Tests and evaluation | Unit, contract, integration, end-to-end, fault injection, security, soak, and real task sets |

Tasks, work units, and execution records stay separate. A task expresses the result the user wants; a work unit expresses a small authorized piece of work; an execution record expresses one real attempt. Only one effective executor advances a work unit at a time. Reassignment must prevent an old executor's late result from overwriting new state and must not duplicate external actions.

Fact records are append-only. Each record carries a version, relationships, and triggering reason. Task state, inbox, artifacts, and cost are projections. Upgrades remain compatible with old data, and replay cannot produce external effects. Large content lives in artifacts; records contain only references.

Tests and evaluations are different. A test is a deterministic pass/fail gate run on every commit. An evaluation is a statistical quality measurement that needs real task sets, baselines, and repeated comparison. Both matter, but they cannot be mixed into one check that only looks at an average score.

Tests cover at least nine areas: unit logic, executor and connector contracts, real-storage integration, browser vertical paths, fault injection, record replay, security denial paths, performance and soak, and real-task evaluation. Phase 1 can use simulated execution to exercise the interface and state first, then accept the MVP with real tasks.

Every small stage ships implementation, browser acceptance paths, failure paths, and regression tests together. Every bug fix has a regression test. Every record schema has migration and old-data compatibility tests. Every external action has idempotency and duplicate-delivery tests. Every new permission has denial-path tests. Every executor or connector has timeout, cancellation, and failure-classification tests.

Continuous integration has three tiers: unit, contract, integration, and simulated execution before merge, targeting ten minutes; daily fault injection, security, performance, external-service smoke tests, and soak tests; and full tests, migration, install, backup/restore, and phase exit acceptance before release.

Releases version data structures, executor protocols, and user-visible configuration. Upgrade makes a backup first, then verifies that old records, artifacts, memory, and authority remain readable; failure can roll back. Executor versions, method versions, and configuration are pinned. Real user data, credentials, and machine-specific paths never enter the test repository.

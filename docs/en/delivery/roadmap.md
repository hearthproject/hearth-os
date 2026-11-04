---
title: 'Phased Product Roadmap'
description: 'Hearth Stage 0–6 product roadmap: stage goals, scope, exit criteria, learning objectives, and explicit deferrals.'
outline: [2, 3]
---

<p class="eyebrow">PRODUCT ROADMAP</p>

# Phased Product Roadmap

<p class="lead">Capability gates for Stage 0–6: what each stage delivers, when it counts as complete, and which unmet conditions block entry into the next stage.</p>

## How to Read This Document

- Stage is a capability level, not a date or schedule.
- The MVP is an early exit from Stage 1, not a product of Stage 6.
- Every stage must simultaneously have a user-visible interface, persistent state, verification evidence, and a recovery path.
- A stage is complete only when all exit conditions are met; you can stay, trial, and roll back, but cannot skip steps.

---

## Phased Product Roadmap: From Prototype to Personal Agent OS

### Guiding Principles

- Advance by capability gates, not by calendar commitments;
- Each stage can deliver value independently;
- Within Stage 1, a daily-usable MVP must appear as early as possible, rather than waiting until Stage 6 for a product to take shape;
- Every stage must deliver, at the same time, a user-visible interface, persistent state, verification evidence, and a recovery path;
- Frontend and backend progress together in vertical slices; “finish the backend first, then add the interface” is not allowed;
- Prove reliability before expanding coverage;
- Codex is the first external Executor, but not the only source of capability;
- Do not build a general-purpose Sandbox, model inference engine, or full Agent framework in-house early on;
- Every stage has both product gates and learning gates;
- Before any automation capability can produce real side effects, it must first pass safety and recovery tests.

### Stage Overview

| Stage | Product Form Delivered to Users | Core Capabilities | Explicitly Out of Scope | Main Risks |
|---|---|---|---|---|
| Stage 0 | Clickable end-to-end product prototype | Product wedge, task set, protocols, interactions, evaluation, and security baseline | Real execution, real side effects | Goal drift, prototype and implementation diverging |
| Stage 1 | Locally usable personal task workbench; MVP appears early | Recoverable kernel, Codex, Web task cards, approvals, artifacts, recovery | Real automated email sending, GUI, proactive loops, multi-device | State recovery, duplicate side effects, integration instability |
| Stage 2 | Personal Operator capable of handling daily content work | Real tasks across email/calendar/documents/web/data, Context Compiler, Memory v0 | Desktop GUI, full proactivity, self-evolution | Permissions, platform limits, context cost |
| Stage 3 | Computer Operator capable of operating the desktop | agentd, GUI, takeover, desktop isolation, and high-risk approvals | Long-term multi-device sync, unevaluated evolution | Fragility, verification, irreversible operations |
| Stage 4 | Low-interruption Proactive Personal Agent | Trigger, proactive loops, attention budget, mobile PWA, device pairing | Full multi-device execution, automatic skill promotion | Notification fatigue, privilege escalation, mobile security |
| Stage 5 | Agent that accumulates personal context and safely improves its methods | Memory OS, Evolution OS, skill evaluation/promotion/rollback | Enterprise multi-tenancy, public marketplace | Memory contamination, skill drift, evaluation bias |
| Stage 6 | Multi-device, portable, long-running Personal Agent OS v1.0 | Sync, offline queues, device revocation, backup migration, long-term operations | Unbounded unattended high-risk automation | Sync conflicts, device security, operations |

Stages are not a date-driven waterfall but a set of capability dependencies. You can stay, trial, and roll back at each stage; at any stage, the product should remain fully usable within its current scope.

**Where the MVP Sits:** The MVP is an early product exit from Stage 1, positioned before the full Stage 1 gate. It does not include email, calendar, GUI, proactivity, full memory, or multi-device support, but it must include real execution, persistent Task state, Web task cards, Artifacts, approval drills, and failure recovery. See 25.3 for the specific definition.

### Stage 0: Definition, Prototype, and Baseline

Development module: [Stage 0 · Definition & Prototype](/en/delivery/stage-0)

**Goal:** Before entering real implementation, pin down the product, interactions, protocols, and acceptance criteria. Stage 0 is not a pure documentation phase; it must produce a clickable end-to-end product prototype.

Deliverables:

- A one-page product definition and non-goals;
- Target users and a list of 20–30 real tasks;
- A coverage matrix for eight task categories;
- The first product wedge: prioritize one high-frequency, low-external-risk task family for the MVP;
- A clickable Web prototype: Today, task cards, new task, Needs You, artifacts, failure/recovery, and approval states;
- The projection fields and primary actions corresponding to each UI state;
- schema v0 for Event, Task, Run, Executor, Approval, and Receipt;
- Threat model and risk classification;
- Evaluation task set and validator v0;
- Build vs Integrate ADR;
- Repository, CI, coding standards, and versioning strategy.

Exit criteria:

- Can explain in one sentence what Hearth is not;
- Every core entity has invariants;
- At least 12 tasks have executable acceptance criteria;
- High-risk actions have a clear approval path;
- In the prototype, users can complete the sequence “create Task → see status → approve → view Artifact → view recovery path”;
- Every state in the prototype maps to a real data contract, not just an animation for demonstration;
- It has been decided that Stage 1 will not build a Sandbox kernel in-house.

### Stage 1: Durable Personal Kernel and MVP

Development module: [Stage 1 · Durable Kernel & MVP](/en/delivery/stage-1)

**Goal:** Prove that a personal Agent can complete real tasks while running locally as a persistent service and remaining interruptible, recoverable, approvable, and auditable, and that a minimum daily-usable product can take shape as early as possible.

**MVP Completion Threshold:** Stage 1 does not wait for all kernel details to be finished before showing a product. First complete a real vertical slice in one narrow task family to meet the MVP gate in 25.3; then continue filling in side-effect safety, a second task family, and fault injection to complete all of Stage 1.

Scope:

- `hearthd` single-process persistent service;
- SQLite WAL Event Log, projections, and migration;
- Task / Ticket / Run / Assignment / Lease;
- outbox, idempotency keys, Receipt;
- Codex Executor: code, tests, Issue/PR, research, documentation, and multi-file workspaces;
- workspace lifecycle, read-only evidence, file diff;
- Policy, Mandate, Approval v0;
- Web as the primary entry point: task creation, task cards, details/timeline, approvals, artifacts, failure and recovery;
- CLI as an automation and diagnostics entry point, not a replacement for the product interface; mobile PWA is deferred to Stage 4;
- Artifact and validator v0;
- Basic Token logging and budgeting;
- Crash recovery and fault injection tests.

First batch of real tasks:

1. From Issue to code changes, tests, and PR drafts;
2. Organize three source materials into a comparison table and report;
3. Read a set of documents and generate a weekly report draft and citation list;
4. File organization and reproducible transformations;
5. External side effects that require approval (using a test Effect or a local test service).

Exit criteria:

- The MVP can be used daily in a browser for one narrow task family;
- After `kill -9`, it can recover to a continuable state;
- Zero duplicate external side effects under 200 fault injections;
- Codex tasks have structured artifacts and verification;
- No task is “completed” based solely on natural language;
- Task cards clearly show status, artifacts, and next steps;
- Creation, cancellation, retry, approval, artifact viewing, and recovery can all be completed through the Web;
- At least 10 real tasks pass manual acceptance;
- There is a baseline for Tokens and human minutes.

Learning gates:

- Understand the Event Log, single writer, lease, fencing token, and recovery;
- Understand Codex's capability boundaries and workspace isolation;
- Understand the differences between Approval, outbox, and Receipt;
- Produce the first failure classification and routing data.

### Stage 2: Personal Operator

Development module: [Stage 2 · Personal Operator](/en/delivery/stage-2)

**Goal:** Expand from “can do file tasks” to “can do most everyday digital content work.”

Scope:

- Email Connector: read-only sync, threads, contacts, attachments, drafts, send pending approval;
- Calendar Connector: read-only, conflict checking, writes pending approval;
- Docs/Drive Connector: read, versions, export, sharing pending approval;
- Browser Executor: research, downloads, forms without APIs;
- Document/Data Executor: PDF, Office, spreadsheets, OCR, conversion, reconciliation;
- Context Compiler and Token Governor v1;
- Memory v0: Episodic + Semantic, with provenance, budgets, and basic forgetting;
- Task templates and the first batch of reusable workflows;
- More complete notifications and Artifact center.

Exit criteria:

- The email "read—understand—draft—approve—send—receipt" loop is usable;
- Calendar conflict checking and writes pending approval are usable;
- Document conversion results are verifiable;
- Web research has sources and citations;
- Manual minutes for common tasks drop significantly;
- No cross-account or cross-project data crosstalk;
- On failure, the system can recover or explicitly hand off to a human.

### Stage 3: Computer Operator

Development module: [Stage 3 · Computer Operator](/en/delivery/stage-3)

**Goal:** Cover desktop software without APIs and cross-application workflows.

Scope:

- Device agentd and desktop capability registration;
- GUI Executor: accessibility tree, screenshots, keyboard and mouse, file selection;
- Isolated virtual desktop;
- Real-time browser/desktop takeover;
- Approval for high-risk desktop actions;
- Desktop task verification and recovery;
- Application allowlists, window scopes, and system security boundaries.

Exit criteria:

- At least 5 real desktop tasks can be completed and verified;
- The takeover flow is usable, and users can pause, operate, and hand back control;
- GUI failures do not leave half-completed high-risk states;
- Desktop operations do not read password vaults or exceed system settings permissions;
- Tokens and manual minutes are within acceptable ranges.

### Stage 4: Proactive Personal Agent

Development module: [Stage 4 · Proactive Personal Agent](/en/delivery/stage-4)

**Goal:** Enable Hearth to work proactively within limited authorization while keeping interruptions low.

Scope:

- Triggers for email, calendar, files, web, and task dependencies;
- Proactive loops and background batch processing;
- Attention budgets, quiet hours, aggregated notifications;
- Mobile PWA: view, approve, take over, initiate, notify;
- Device pairing, secure tunnels, push notification redaction;
- A1/A2 autonomy levels;
- Mature Task cards and a "Needs You" inbox;
- Toggles for proactive mode and controlled evaluation.

Exit criteria:

- Proactive tasks are genuinely useful and do not create notification fatigue;
- Interruptions per Task ≤ 1;
- High-risk actions still require approval;
- Mobile can complete key approvals and takeovers;
- Users can pause, revoke, and downgrade proactive mode at any time;
- No unbounded background loops or budget overruns.

### Stage 5: Memory OS and Evolution OS

Development module: [Stage 5 · Memory & Evolution](/en/delivery/stage-5)

**Goal:** Enable the system to truly accumulate personal context and safely improve its methods.

Scope:

- Full implementation of the five memory types;
- Memory writes, conflicts, retrieval, budgets, forgetting, sync;
- Memory browser and a "why was this recalled" view;
- Trajectory mining, skill candidates, versions, and evaluation sets;
- Shadow → Canary → Promote → Rollback;
- Skill permission constraints;
- Manual PR changes to the core Runtime;
- At least one complete skill promotion case.

Exit criteria:

- Memory can be corrected, forgotten, and exported;
- Memory injection accuracy meets the target;
- Skill promotion has controlled evaluation;
- No permission expansion or security regression;
- Rollback is usable;
- Users can understand why the system did what it did.

### Stage 6: Personal Agent OS

Development module: [Stage 6 · Multi-device & Operations](/en/delivery/stage-6)

**Goal:** Multi-device, long-running, migratable, and self-hostable.

Scope:

- Multi-device agentd;
- Event sync, cursor, lease, fencing;
- Device capability routing and offline queues;
- Device loss revocation;
- Remote execution and encrypted transport;
- Backup, restore, migration, and upgrade;
- Long-running monitoring;
- Resource scheduling and quotas;
- Optional remote Sandbox.

Exit criteria:

- One logical Agent, consistent across multiple devices;
- Device switching does not lose Tasks or duplicate side effects;
- Offline recovery rate meets the target;
- After migration, events, memory, and skills are verifiable;
- Device revocation is immediately reliable;
- Long-running operation has no memory leaks or state drift.

### Learning Goal Mapping

| Learning Goal | Primary Focus | Stage | Verifiable Deliverable |
|---|---|---|---|
| Maka / Pi Runtime | Native Runtime, session tree, steering, compaction | 1–2 | Replayable session and context compaction tests |
| DeerFlow complete Harness | Ticket/Run, state machine, middleware, recovery | 1 | Run lifecycle and fault injection |
| OpenSandbox / OpenBot isolation | Execution Gateway, Sandbox Provider, takeover, receipt | 1–3 | Attack matrix and takeover demo |
| OpenClaw autonomous control | Gateway, channels, devices, attention, autonomy | 2–4 | Source→Trigger→Run→Receipt loop |
| Hermes memory and evolution | Memory budgets, constraints, skill lifecycle, evaluation | 5 | Memory evaluation and skill promotion/rollback cases |
| OpenMuse / OpenDots autonomy | Durable job, checkpoint, low-interruption Task cards | 1–4 | Crash recovery and mobile Task card demo |
| Codex Executor | Long chains, multi-file, research, documents, code | 1 | Task packages, structured output, and acceptance reports |

### Explicitly Deferred

The Stage 0–1 MVP does not do:

- Build proprietary containers/VMs/kernels;
- Build proprietary foundation models or inference engines;
- Build a public Agent marketplace;
- Enterprise IAM, multi-tenancy, billing;
- A full desktop Office replacement;
- Unbounded automatic payments, contracting, and public publishing;
- Integrate all channels from the start;
- Self-evolution without evaluation;
- Complex multi-device sync;
- Native iOS/Android apps;
- A "fake MVP" with only a CLI or API and no browser product path;
- Defer the entire frontend to later stages in order to rush underlying progress.

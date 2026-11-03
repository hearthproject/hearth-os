---
title: 'Development Plan from 0 to 100'
description: 'Hearth MVP-1, Stage 0–6 increments, delivery templates, release sequence, scope trimming, and the v1.0 exit.'
outline: [2, 3]
---

<p class="eyebrow">DEVELOPMENT PLAN</p>

# From 0 to 100 Development Plan

<p class="lead">A progressive development sequence driven by capability gates, not scheduled by weeks or months. Each increment is a verifiable vertical slice.</p>

## How to Read This Chapter

- The planning unit is a vertical increment `D0.1 … D6.6`, not weeks, months, or fixed iteration lengths.
- Proceed strictly in dependency order; no increment may deliver only backend, logs, or interfaces.
- Each increment must let the user complete a concrete task in the browser.
- If stage acceptance fails, stay in the current Stage to fix it; do not trade "we'll fill it in later" for progress.

---

## The Progressive Development Plan from 0 to 100

### Plan Definition and Boundaries

This chapter expands Stage 0–6 from Chapter 24 into a complete development sequence, with no development time limit and no weekly plans, monthly plans, or calendar commitments.

- **Starting point at 0:** Only a product definition, one real user, and an empty repository; no runnable system and no demonstrable real task loop.
- **End point at 100:** Hearth Personal Agent OS v1.0, passing all Stage 6 exit conditions, able to be used, migrated, recovered, and revoked over the long term in a real personal environment.
- **Planning unit:** Not "which week", but independently acceptable vertical increments `D0.1 … D6.6`.
- **Advancement approach:** Proceed strictly in dependency order; you may pause, roll back, or extend, but you cannot trade skipping reliability, interface, or verification for speed.
- **Stage relationship:** Stage is a capability level, not a waterfall date. When the stability gate of the previous stage is not met, do not enter the next stage's real side effects and higher autonomy.
- **Time meaning:** This article only describes "what to do first, what it depends on, and what counts as done"; it does not promise any completion date, duration, or iteration length.

This plan does not leave the frontend, approval, recovery, or usable product form to be filled in at the end. Each increment itself must let the user complete a concrete task in the browser.

### Six Execution Rules

1. **Vertical slices first.** Do not deliver stage milestones that are "only Event Log", "only Memory", or "only Sandbox interface". Each increment must simultaneously include user outcomes, interface, persistent state, real implementation, verification, and recovery.
2. **Frontend grows in sync.** Stage 0 delivers a clickable prototype; Stage 1's first runnable skeleton delivers a real Web Task card; every increment thereafter must project new capabilities into an operable, recoverable interface.
3. **Narrow first, then broad.** First make one task family truly dependable, then add a second task family; first prove permissions, idempotency, and receipts on one connector, then expand the number of channels.
4. **Durability before autonomy.** Tasks must not be lost after restart, external actions must not be repeated, failures must be visible; before these are done, do not add proactive loops or high-risk unattended operation.
5. **Safety before real side effects.** Real sending, writing, sharing, deletion, public publishing, and desktop operations must first go through Effect Preview, Mandate, Approval, idempotency keys, and Receipt drills.
6. **Evaluation before expansion.** Before adding new executors, connectors, models, skills, or automation scope, there must be representative tasks, baselines, failure samples, and rollback paths.

### MVP Definition: Hearth MVP-1 (v0.2)

The MVP is not a "backend preview" nor a technical skeleton that can only be demonstrated through CLI or logs. MVP-1 is a locally usable personal task workbench, defaulting to "research/document organization" as the first task wedge; if the first user's most frequent real task is code work, the wedge can be replaced, but the same vertical structure must not change.

**User story:**

> I hand several documents to Hearth and ask it to organize them into a report with citations. In the browser I can see the task plan, current progress, items that need my confirmation, and the final Artifact; if the process crashes or execution fails, I know what happened and can cancel, retry, or recover; I can see how many Tokens and how much human time this task consumed.

**The MVP must include:**

| Dimension | MVP Gate |
|---|---|
| Entry | Local Web application can create tasks, select workspaces, upload files, or reference paths |
| Task | End-to-end loop for one narrow task family: goal, scope, budget, status, acceptance criteria |
| Execution | Codex Executor executes in an isolated workspace and returns structured results and Artifacts |
| State | Queued, executing, waiting for approval, needs information, completed, failed, and recoverable states are truly persisted |
| Interface | Today/Task cards, task details, approvals, Artifacts, failures and recovery; no CLI knowledge required |
| Artifact | Reports or files can be previewed/downloaded, with sources, versions, hashes, and verification evidence |
| Approval | Effect Preview + approve/reject + practice Receipt for at least one typed external action |
| Recovery | After refresh, restart, and service crash, tasks do not disappear; can continue, cancel, retry, or hand off to a human |
| Cost | Each Run records Tokens, model, Executor, latency, and human minutes |
| Evidence | Tasks without Artifacts and verification evidence cannot be marked complete |

**The MVP explicitly does not include:**

- Real email auto-sending, real calendar writing, or real cloud drive sharing;
- Browser, GUI, and desktop takeover;
- Proactive triggers, background autonomous loops, and mobile PWA;
- Full Memory OS, skill promotion, and self-evolution;
- Multi-device sync, offline queues, and remote execution;
- Enterprise permissions, plugin marketplace, or a full chat product.

The MVP's "practice Receipt" can come from a local test service or simulated Effect sink, but it must go through the real outbox, idempotency keys, approval, and Receipt paths; it cannot be replaced by a static success screenshot.

**MVP acceptance criteria:**

1. The first user can go from creating a Task to obtaining an Artifact without touching the CLI, database, or logs.
2. At least 5 representative research/document tasks are completed, of which 3 produce stable results on repeated runs.
3. All completed tasks have Artifacts, verification results, and traceable sources.
4. Interrupt the process at four points—queued, executing, writing Artifacts, and waiting for approval—and each can recover to a clear state.
5. Retry the same test Effect multiple times, and duplicate external side effects are 0.
6. Failed tasks show the reason, next step, and recovery options on the Task card.
7. The user is willing to use it for the next day's real work, not just watch it in a demo.
8. Token, human minutes, interruption count, and failure classification have comparable baselines.

### Delivery Template for Each Increment

Each `Dx.y` increment must answer the following questions; if any is missing, it cannot enter stage acceptance:

1. **What does the user complete?** Describe the visible outcome in one sentence of user language, without internal module names.
2. **Where does the user complete it?** Specify the entry point, Task card state, primary action, Artifact, or recovery interface.
3. **What is the frontend-backend contract?** How do events, projection fields, API, Task Pack, Result, and error classification change.
4. **What is the real implementation?** Which Executor, connector, storage, or Policy actually works, rather than a permanent mock.
5. **How is completion proven?** Tests, diffs, citation checks, file structure, web page state, business rules, or manual acceptance.
6. **What happens on failure?** What the user sees and how the system recovers on timeout, crash, permission denial, network failure, and uncertain results.
7. **What evidence is left?** Token, cost, human minutes, interruption count, failure samples, and rollback results.

**Definition of Done for an increment:**

- The main path can be completed in the browser;
- Refresh or restart does not lose tasks;
- At least one failure path has actionable recovery;
- Key actions have audit events;
- No uncontrolled real side effects are introduced;
- Documentation, README, or changelog is updated in sync;
- The demo does not require manually modifying the database or only stitching commands in the terminal.

### Stage 0 Increments: Product Truth, Prototype, and Contract

The completion criterion for Stage 0 is not "the document is written", but "the product narrative, interaction, and implementation contract are sufficient to support the first real slice". This stage does not connect real high-risk side effects.

#### D0.1 Product Wedge and Real Task Baseline

- **User-visible outcome:** A clear product description that answers "who uses it in what scenario and why, instead of using Codex or a chat assistant directly".
- **Main work:** Select the first user and first task wedge; collect 20–30 real tasks; pick at least 12 acceptable tasks; establish baselines for fully manual work and direct use of Codex; write non-goals, risk list, and success metrics.
- **Completion gate:** At least 12 tasks have clear inputs, Artifacts, and acceptance methods; can explain Hearth's independent value; the task set includes success, failure, waiting for approval, and situations requiring takeover.

#### D0.2 Clickable End-to-End Product Prototype

- **User-visible outcome:** Users can create tasks in the browser prototype, see execution status, handle approvals, open Artifacts, and view failure reasons and recovery options.
- **Main work:** Design the four entry points Today, Needs You, Artifacts, and Settings; cover queued, executing, awaiting approval, needs information, completed, failed, and recoverable states; check both desktop and mobile widths; demonstrate a complete task with near-realistic mock data.
- **Completion gate:** A new user can complete the main path without reading instructions; each state has only one primary action; no internal terms such as Worker, Harness, or Mandate appear; failure states provide a next step; prototype states can map to real projection fields.

#### D0.3 Protocol, State Machine, and UI Data Contract

- **User-visible outcome:** The states, primary actions, evidence, and Artifacts seen in the prototype all have stable data-source definitions and can later be replaced by a real backend.
- **Main work:** Define Event, Task, Ticket, Run, Executor, Approval, Artifact, Receipt, and Budget; define Task Pack, Result, and failure classifications; define task card projections, approval projections, and Artifact projections; determine the Event Log, outbox, lease, migration, and SSE interfaces; establish a mock server and contract tests.
- **Completion gate:** The frontend does not depend on internal database fields; core state transitions have a single interpretation; the schema can be versioned; the same event stream can rebuild UI projections; unknown states safely display as “needs handling” rather than pretending success.

#### D0.4 Evaluation, Security, and Engineering Baseline

- **User-visible outcome:** Every development increment has a repeatable acceptance method and failure samples from day one.
- **Main work:** Establish an evaluation runner for 12 tasks, scoring rules, and manual review records; complete the threat model, risk grading, approval matrix, and secret-handling rules; initialize the monorepo, CI, lint, type checking, tests, ADRs, documentation, and fake executor; define fields for collecting Token, cost, and human minutes.
- **Completion gate:** Evaluations can be run repeatedly locally; high-risk actions must have an approval path; CI can prevent schema and contract regressions; the fake executor can drive the complete UI flow; there are no real external side effects.

### Stage 1 Increment: Durable Personal Kernel and MVP

Stage 1 is the critical phase “from prototype to a minimal product usable every day.” The order must be: first a real short closed loop, then safe side effects, and finally expand task families and reliability coverage; do not build the entire kernel first and then add the interface.

#### D1.1 Runnable Walking Skeleton

- **User-visible outcome:** Users can create tasks on a real web page and see status move from queued to executing to completed; tasks remain after refresh or restart.
- **Main work:** Start the single-process `hearthd`; integrate SQLite WAL, a minimal Event Log, and projections; implement the minimal state machine for Task/Run; use a fake executor to generate real events; connect the web app to task lists, details, creation, and SSE; provide a minimal CLI for diagnostics.
- **Completion gate:** The main path does not depend on manually editing the database; tasks and states can be recovered after a service restart; task cards show real status rather than static mocks; UI contract tests pass.

#### D1.2 First Real Codex Vertical Slice

- **User-visible outcome:** Users submit a set of local materials, and Hearth calls Codex to generate a structured report with citations; the task card shows stages, Artifacts, validation results, and cost.
- **Main work:** Codex adapter, version checks, and health checks; one-off workspace; Task Pack generation; structured output constraints; Artifact and source records; citation/file/structure validators; execution event projections; Token and latency collection; failure classification.
- **Completion gate:** One default task family works end to end; Artifacts can be opened and validated; citation or file evidence is traceable; on failure, the UI shows the category and next step; no permanent mock results are used.

#### D1.3 MVP Closeout (v0.2)

- **User-visible outcome:** Hearth MVP-1 is usable: creation, viewing, cancellation, retry, approval drills, Artifact retrieval, and recovery are all completed in the browser.
- **Main work:** Complete durable Run, cancellation and retry, task details/timeline, Artifact center, failure recovery page, budget and anomaly stop, practice Effect approval, and basic failure classification; implement all acceptance conditions in 25.3.
- **Completion gate:** At least 5 representative real tasks pass; 3 of them run repeatedly and stably; all four key interruption points are recoverable; the user explicitly wants to continue using it; there are no uncontrolled real side effects.

#### D1.4 Side-Effect Safety Skeleton

- **User-visible outcome:** Users can preview “what will happen,” approve or reject, and later see a receipt; retries do not cause a second external action.
- **Main work:** Policy and Mandate v0; Effect Preview; typed Effects; outbox, idempotency keys, Receipt; test Effect sink; Credential Broker interface; approvals bound to parameters, nonce, and expiration time; reconcile uncertain results first.
- **Completion gate:** Approvals are bound to real parameters; repeated delivery does not produce duplicate side effects; safe redelivery is possible after a crash; dead letters can be viewed and handled manually; secrets do not appear in task cards, logs, or executor contexts.

#### D1.5 Second Task Family and Kernel Hardening

- **User-visible outcome:** In addition to research/document tasks, a second task family can also be completed through the same task card model; failed tasks are easier to recover.
- **Main work:** Add a code/Issue task family or the user’s second most frequent task family; diff, test, and structured result validation; lease and fencing token; `kill -9`, network disconnection, timeout, disk full, and duplicate delivery tests; backup and restore; more complete failure classification and degradation paths.
- **Completion gate:** Both task families complete end to end; recovery rate reaches the stage gate; duplicate external side effects are 0; task states are consistent with the source of truth; failures do not require manual state reconstruction.

#### D1.6 Stage 1 Release

- **User-visible outcome:** A local product that can be continuously trialed, with a clear scope, known limitations, recovery methods, and a metrics baseline.
- **Main work:** Run 10 real tasks; compare against a baseline of fully manual work and using Codex directly; fix high-frequency failures; complete installation, backup, upgrade, and data export; complete the Stage 1 security and evaluation report.
- **Completion gate:** All exit conditions for Stage 1 in Chapter 24 are met; the MVP has not been broken by subsequent kernel work; users can use it independently without relying on the developer for manual operations.

### Stage 2 Increment: Personal Operator

Stage 2 expands from “can handle file tasks” to “can do most everyday content work.” The expansion order is read-only first, then deterministic processing, then browser, and finally real writes, avoiding handing high-risk accounts to the model from the start.

#### D2.1 Read-Only Connectors and Source Views

- **User-visible outcome:** Users can connect a real email/calendar/document account, let Hearth read a specified scope, and see the source, time, and original citation on the task card.
- **Main work:** Connect one Connector first; minimal OAuth scopes; short-lived credentials and revocation; Source normalization, deduplication, cursors, and rate limiting; source projections and source detail UI; connector health page.
- **Completion gate:** Read-only sync works; users can revoke the connection; tasks reference only authorized scopes; sources are traceable to the original object; the UI does not expose raw credentials.

#### D2.2 Document/Data Executor

- **User-visible outcome:** Users can turn PDFs, Office documents, and spreadsheets into structured reports, comparison tables, or reproducible transformation results, and view file diffs.
- **Main work:** Python sidecar; parsing, OCR, format conversion, table cleaning, and import/export; deterministic pipelines; content-addressed Artifacts; table structure/value/formula validation; artifact diff and preview.
- **Completion gate:** At least three common document formats can be processed; deterministic steps do not go through the model; results are verifiable; large files do not stuff the full text into context; original files are preserved on failure.

#### D2.3 Browser Executor and Web Research

- **User-visible outcome:** Users can have Hearth open web pages, collect sources, download authorized files, fill out non-high-risk form drafts, and take over when a CAPTCHA is required.
- **Main work:** Playwright worker; browser profile and login-state boundaries; treat page content as untrusted; prompt injection protection; domain/network egress policy; screenshots and source lists; download validation; takeover entry point.
- **Completion gate:** Representative research tasks have traceable sources; web content cannot directly expand permissions; downloaded files are validated; high-risk submissions are not executed automatically; status can continue after takeover.

#### D2.4 Draft, Approval, and Test Account Side-Effect Closed Loop

- **User-visible outcome:** Users see a full preview of email drafts, calendar changes, or document sharing, can approve or reject them, and can later view the Receipt.
- **Main work:** email drafts, calendar conflict checks and pending-approval writes, document export/sharing; real Connector Effect; test accounts; Effect Preview; outbox re-delivery; Receipt reconciliation; undo and compensation documentation.
- **Completion gate:** The “read → understand → draft → approve → execute → Receipt” loop is usable; test accounts do not send/write duplicates; uncertain results are reconciled first; approvals are bound to the real recipients, time, content, and scope.

#### D2.5 Context Compiler, Token Governor v1, and Memory v0

- **User-visible outcome:** Common Tasks have templates, and Task cards are more concise; the system can remember preferences and facts the user has explicitly approved, and explain why they were recalled.
- **Main work:** Context Compiler tailors sources per Task; Token Governor budgets, tiered routing, caching, and anomaly stops; Episodic + Semantic Memory v0; provenance, sensitivity, and basic forgetting; Task templates; refinement of notifications and the Artifact Center.
- **Completion gate:** Manual time in minutes decreases for common Tasks and Token usage is explainable; no cross-account/cross-project crosstalk; users can view, correct, and forget memories; templates do not skip acceptance checks.

#### D2.6 Stage 2 Release

- **User-visible outcome:** Hearth becomes a daily operator capable of handling research, email, calendar, document, and web Tasks.
- **Main work:** Run the full stage with representative real Tasks; complete failure classification, Connector degradation, data export, and privacy documentation; compare against the Stage 1 baseline; complete security and evaluation reports.
- **Completion gate:** All Stage 2 exit conditions in Chapter 24 are met; at least one real test account has a stable closed loop; no cross-account data crosstalk occurs; users can understand the source and Receipt of every external action.

### Stage 3 Increment: Computer Operator

Stage 3 handles desktop software without APIs. The order is observe first, then take over, then low-risk actions, and finally high-risk actions; automated operation must not be enabled when it cannot be verified or taken over.

#### D3.1 Device agentd and Device Visibility

- **User-visible outcome:** Users can see a trusted desktop device come online, what capabilities it has, and whether it can currently execute GUI Tasks.
- **Main work:** device pairing; agentd registration; capability catalog; health checks; local permission declarations; device details page; disconnection and revocation; audit of device-Task associations.
- **Completion gate:** A device can be registered, viewed, and revoked; Tasks are not assigned when capabilities do not match; an offline device has a clear status; agentd cannot access undeclared capabilities beyond its authority.

#### D3.2 GUI Observation and Manual Takeover

- **User-visible outcome:** Users can see the target window in Hearth, pause the automated process, operate it themselves, and then hand it back or terminate it.
- **Main work:** accessibility tree, screenshots, and window scope; observe-only mode; real-time takeover interface; keyboard/mouse pause and handback; state recording before and after takeover; screenshot redaction; audit events.
- **Completion gate:** Takeover is available and does not contend with automated input; Task status is clear after handback; window scope is correct; users can see what they need to complete themselves; no high-risk actions are executed automatically.

#### D3.3 Low-Risk GUI Actions and Verification

- **User-visible outcome:** Hearth can complete low-risk operations in allowlisted applications, such as opening files, navigating menus, filling in drafts, and exporting results, and display verification screenshots.
- **Main work:** application/window allowlists; action previews; keyboard/mouse and file selection; post-action state verification; screenshot/accessibility evidence; retry on failure; half-completed state detection.
- **Completion gate:** At least 3 real desktop Tasks are completed and verified; password vaults are not read and system security settings are not modified; every action has a scope; failures can be paused or taken over; the UI shows progress and evidence.

#### D3.4 High-Risk GUI and Stage 3 Release

- **User-visible outcome:** For irreversible or high-impact desktop actions, users see the full impact, secondary confirmation, and compensation method; failures do not leave behind unknown high-risk states.
- **Main work:** isolated virtual desktops; high-risk approvals; irreversible action list; compensation/recovery scripts; desktop snapshots; failure recovery; Stage 3 evaluation and operations documentation.
- **Completion gate:** At least 5 representative desktop Tasks are completed; takeover and high-risk approvals are available; no unauthorized access to password vaults or system settings; failures do not leave half-completed high-risk states; users understand how to undo or compensate.

### Stage 4 Increment: Proactive Personal Agent

The challenge of Stage 4 is not “whether it can run automatically,” but “whether it can do the right thing at the right time with the right level of interruption.” Proactivity must be built on the recovery, approval, and verification of Stages 1–3.

#### D4.1 Trigger and Proactive Inbox

- **User-visible outcome:** Hearth can suggest “what can be done now” and explain the trigger reason, suggested action, budget, and whether it will interrupt the user.
- **Main work:** email, calendar, files, and Task-dependency Triggers; event deduplication; proactive candidate generation; fast path; A1/A2 autonomy levels; proactive Task cards; “why now” explanations; pause and ignore.
- **Completion gate:** Duplicate events do not generate duplicate Tasks; proactive suggestions have sources; users can pause with one click; there are no infinite background loops; execution stops when budget is exhausted; high-risk actions still require approval.

#### D4.2 Mobile PWA: View, Approve, Take Over, and Initiate

- **User-visible outcome:** Users can see Today’s Tasks, Needs You, and Artifacts on their phone, complete approvals, take over, initiate Tasks, and receive high-signal notifications.
- **Main work:** responsive PWA; mobile Task cards and approvals; takeover entry points; Artifact previews; offline read-only cache; biometric/short-lived sessions; push notification redaction; one-handed operation and accessibility.
- **Completion gate:** Key actions can be completed on the phone; long-term primary credentials are not held; offline use produces no external side effects; approvals require re-authentication; push notifications do not leak sensitive content.

#### D4.3 Secure Pairing, Push, and Device Revocation

- **User-visible outcome:** Phone and desktop pair via a short-lived code/QR code; if the phone is lost, it can be revoked immediately, and after revocation it can no longer approve or take over.
- **Main work:** public-key pairing; secure tunnel or push relay; nonce, parameter binding, and expiration; device list; remote revocation; session invalidation; push summaries; security audit.
- **Completion gate:** Approvals cannot be replayed; lost devices can be revoked; access to Tasks and Artifacts is immediately restricted after revocation; push notifications contain no sensitive content; pairing cannot bypass user confirmation.

#### D4.4 Attention Budget and Proactive Trial Run

- **User-visible outcome:** Proactive mode can work quietly and appear only when truly needed; users can predict when they will be interrupted and can downgrade at any time.
- **Main work:** attention budgets, quiet hours, aggregated notifications, value assessment, interruption-count metrics, proactive mode switches, shadow/control runs, kill switch; evaluation of proactive Task success rate and user satisfaction.
- **Completion gate:** Average interruptions per Task ≤ 1; proactive Tasks produce real value; no notification fatigue; users can explain why they were reminded; proactive mode can be paused, revoked, or downgraded at any time.

#### D4.5 Stage 4 Release

- **User-visible outcome:** A low-interruption proactive personal Agent that can handle key actions via mobile.
- **Main work:** representative Trigger scenarios; real proactive Task trial runs; notification fatigue and approval security evaluation; cross-device audit; updates to privacy and emergency stop documentation.
- **Completion gate:** All Stage 4 exit conditions in Chapter 24 are met; mobile approval and takeover are stable; proactive mode can be paused and rolled back; no background budget overdraft or runaway loops.

### Stage 5 Increment: Memory OS and Evolution OS

Stage 5 lets Hearth accumulate personal context and improve its methods, but it must not let memory contamination or skill drift become an unexplainable black box. The order is: first make memory correctable, then make memory forgettable, then make skills evaluable, and only then allow promotion.

#### D5.1 Memory Core and Memory Browser

- **User-visible outcome:** Users can see what Hearth remembers, where it came from, and why it was recalled, and can correct or delete it.
- **Main work:** five memory model types; provenance, confidence, sensitivity, timeliness, and budget; write paths; retrieval; Context Pack injection; Memory Browser; “why recalled” view; user corrections.
- **Completion gate:** Memories have provenance and sensitivity; recall is explainable; erroneous memories can be corrected; sensitive information does not enter contexts where it should not appear; memory budgets take effect.

#### D5.2 Memory Conflicts, Forgetting, and Export

- **User-visible outcome:** Outdated facts are updated or forgotten; users can export all memory and confirm that forgetting has propagated to all relevant indexes and devices.
- **Main work:** Conflict detection and update timing; deletion/forgetting propagation; memory export; prompt injection and poisoning defenses; device synchronization reservation; forgetting audit; sensitive memory isolation.
- **Completion gate:** Forgetting is propagatable and verifiable; exports include provenance and versions; conflicts do not silently overwrite correct facts; malicious content cannot gain permissions through memory; users can understand why memory changed.

#### D5.3 Trajectories, Skill Candidates, and Evaluation Sets

- **User-visible outcome:** Repeated tasks begin to produce reusable candidate methods, and users can see what a candidate skill does, what permissions it requires, and whether it is better than existing methods.
- **Main work:** Trajectory collection and replay; failure/success samples; skill manifest; permission declarations; candidate generation; evaluation sets; Shadow runs; baseline comparison; evaluation contamination defenses.
- **Completion gate:** Evaluation is repeatable; candidate skills do not expand permissions; Shadow runs produce no real side effects; users can see candidate differences; no fabricated improvement through sample cherry-picking.

#### D5.4 Evolution Promotion Gate and Stage 5 Release

- **User-visible outcome:** A candidate skill can be promoted after evaluation, Canary, and small-scale real use; when problems occur, it can be rolled back with an explanation of why.
- **Main work:** Shadow → Canary → Promote → Rollback; permission intersection; versioning and signing; skill UI; runtime selection; rollback drills; at least one complete promotion case.
- **Completion gate:** All exit conditions for Stage 5 in Chapter 24 are met; at least one skill has comparative evaluation, promotion, and rollback records; no security regressions; users can understand why the system adopts the new method.

### Stage 6 Increment: Personal Agent OS v1.0

Stage 6 turns a single-machine product into a long-lived, multi-device, migratable personal Agent OS. Multi-device does not mean replicating multiple Agents; it means sharing one logical identity, events, memory, and authorization, with different devices providing execution and entry-point capabilities.

#### D6.1 Multi-device Reading and Event Synchronization

- **User-visible outcome:** Users see consistent tasks, artifacts, and states on a second device, and can determine which device is executing a task.
- **Main work:** Event synchronization, cursor, projection synchronization, device identity, read-only replicas, conflict detection, reconnect after disconnect; device status page; synchronization scope and sensitive field filtering.
- **Completion gate:** Switching devices does not lose tasks; projections can be rebuilt; synchronization conflicts have explicit handling; sensitive data is not copied unconditionally; offline devices do not block the primary device.

#### D6.2 Device Capability Routing and Offline Queues

- **User-visible outcome:** Tasks can choose a device with the required capabilities for execution; when a device is offline, tasks queue and continue after recovery instead of executing repeatedly.
- **Main work:** Capability catalog; routing; lease, fencing, and single writer; offline queues; execution handoff; device reconnection; task migration; duplicate side-effect protection.
- **Completion gate:** No duplicate execution across devices; offline recovery has explicit states; tasks can continue after device switching; lease expiration does not cause double writes; all external actions still have Receipts.

#### D6.3 Device Revocation, Key Rotation, and Secure Migration

- **User-visible outcome:** A lost device can be revoked immediately; users can re-pair, rotate keys, and confirm that the old device can no longer access tasks, memory, and credentials.
- **Main work:** Remote revocation; key rotation; local data wipe; session invalidation; re-pairing; encrypted transport; device audit; emergency kill switch.
- **Completion gate:** Revocation is immediate and reliable; old devices cannot approve, take over, or read new events; key rotation does not break historical events; security incidents have readable audit.

#### D6.4 Backup, Restore, Migration, and Upgrade

- **User-visible outcome:** Users can export, back up, restore, and migrate Hearth; failed upgrades can be rolled back, and historical events, memory, and skills remain consistent.
- **Main work:** Encrypted backup; full restore; data export/import; schema migration; executor version pinning; pre-upgrade checks; rollback; migration verification; user-visible health checks.
- **Completion gate:** After migration, events, artifacts, memory, skills, and credential references are verifiable; rollback is available; old data is not lost; upgrades do not require manual database modification.

#### D6.5 Long-term Operation, Resource Scheduling, and Operations

- **User-visible outcome:** Hearth can run long-term, and users can see resources, tasks, failures, and health status without needing daily maintenance.
- **Main work:** Resource scheduling, quotas, concurrency limits, watchdog, log rotation, disk management, automatic recovery, long-term metrics, remote Sandbox (optional), maintenance mode.
- **Completion gate:** Long-term operation is free of memory leaks and state drift; resource exhaustion can degrade safely; maintenance mode does not lose tasks; users can export diagnostics.

#### D6.6 v1.0 Audit and Release

- **User-visible outcome:** An installable, migratable, revocable, and long-usable Hearth v1.0.
- **Main work:** Pass all Stage 0–6 exits; complete the audit of coverage across the eight task categories; security red teaming, fault injection, migration drills, privacy documentation, installer, upgrade path, support documentation, and final evaluation report.
- **Completion gate:** All items in the “100% definition” in 25.15 are met; there are no serious unresolved security or recovery issues; core task families reach target maturity; the product can be used continuously in a real personal environment.

### Five Workstreams That Run Through All Increments

The following work must not be treated as catch-up at the end of a stage; it must be advanced in parallel within every increment:

| Workstream | What must be updated in each increment |
|---|---|
| Product and interface | User stories, states, primary actions, empty states, failure states, recovery entry points, desktop/mobile layouts |
| Protocol and projection | Event, schema, API, Task Pack, Result, projection fields, migration, and contract tests |
| Evaluation and security | Representative tasks, success/failure samples, permission checks, fault injection, security regressions, and human acceptance |
| Observability and cost | trace, executor/model, Token, latency, human minutes, interruption count, failure classification |
| Documentation and migration | README, ADR, user instructions, installation/backup/upgrade, known limitations, and data export |

If any workstream is not updated with the increment, it will become hidden debt in later stages, especially the debt of “no UI first, add it later.”

### Product Release Sequence

Version numbers express product scope and quality, not dates. Every version must be installable, usable, and recoverable within its current scope:

| Version | Corresponding increment | Product meaning |
|---|---|---|
| `v0.0` | D0.1–D0.4 | Clickable prototype, protocol, evaluation, and security baseline; not an executable product |
| `v0.1` | D1.1 | Real walking skeleton: Web + durable tasks + fake executor |
| `v0.2` | D1.3 | **MVP-1**: a real end-to-end product for one narrow task family |
| `v0.3` | D1.6 | Stage 1 complete: recoverable kernel, two task families, side-effect safety skeleton |
| `v0.5` | D2.6 | Personal Operator: email/calendar/documents/web/data daily tasks |
| `v0.7` | D3.4 | Computer Operator: GUI observation, takeover, low/high-risk desktop actions |
| `v0.8` | D4.5 | Proactive Personal Agent: proactive loop, phone PWA, attention budget |
| `v0.9` | D5.4 | Memory OS and Evolution OS: correctable memory, rollback-capable skills |
| `v1.0` | D6.6 | Personal Agent OS: multi-device, migration, long-term operation, and full audit |

Not every small increment needs an external release; however, every increment must remain demonstrable and reversible, and must not fall into a state where “you have to wait for several more large modules before it can run again.”

### Scope-cutting Order

When resources, energy, or risk do not allow further feature expansion, cut scope first, not the foundation. The recommended cutting order is:

1. Reduce the number of non-core connectors and channels;
2. Reduce proactive and background scenarios, keep manual triggering;
3. Reduce native/mobile forms, keep responsive PWA;
4. Reduce advanced memory types, keep provenance, correction, and forgetting;
5. Reduce multi-device execution, first ensure single-device reliability;
6. Reduce remote Sandbox and ecosystem extensions;
7. Pause skill promotion, keep only candidates and evaluation.

**Never cut:**

- Web UI and task cards;
- Event Log, durable state, and recovery;
- approvals, idempotency, outbox, and Receipt;
- validators and failure samples;
- permission boundaries, secret protection, and kill switch;
- data export, backup, and revocation;
- user-visible failure reasons and next steps.

An MVP is not "the backend implements part of it" but "the user can already complete a real, narrow Task." If it can only be demonstrated through the CLI, logs, or developer scripts, the scope must continue to shrink until it forms a complete product path.

### Definition of "100%": Hearth v1.0 exit

"100%" does not mean "all software, all scenarios, forever zero manual work"; it means the following conditions are all satisfied simultaneously:

1. **Stage completeness:** All stage exit criteria for Stages 0–6 pass, with no skipped steps or temporary exemptions masking gaps.
2. **Task coverage:** For all eight categories of digital content work, at least representative Tasks reach "completable"; core daily Task families reach "reliable"; unmet boundaries are clearly stated and safely handed off to humans.
3. **Product completeness:** Both desktop Web and mobile PWA can perform viewing, initiation, approval, takeover, and Artifact retrieval; critical failure paths have recovery entry points.
4. **Reliability:** Crashes, network disconnection, restarts, timeouts, duplicate delivery, and device switching do not cause Task loss or duplicate external side effects.
5. **Security:** Executors cannot bypass a Mandate; secrets do not enter the model context; high-risk actions require approval; devices, connections, and skills are revocable.
6. **Memory:** Memory is explainable, correctable, forgettable, and exportable; forgetting propagates; memory poisoning cannot escalate privileges.
7. **Evolution:** Skill candidates have control evaluation, Shadow, Canary, promotion, and rollback; permissions do not expand due to self-evolution.
8. **Multi-device:** One logical Agent, consistent across multiple devices; offline queues and device switching do not cause duplicate execution; a lost device can be revoked immediately.
9. **Portability:** Backup, restore, export, import, and upgrade have been rehearsed; after migration, Events, Artifacts, memory, and skills are verifiable.
10. **Long-term usability:** Installation, startup, health checks, resource management, logging, and upgrade paths are complete; users do not need to perform daily maintenance.
11. **Understandability:** Users can know what a Task is doing, whether it needs them, whether an Artifact is trustworthy, and how to recover from failure.
12. **Effectiveness:** Manual minutes, success rate, and user trust for real Tasks meet baseline requirements; it is not just impressive in a demo.

Once these conditions are met, the project enters the v1.0 maintenance and expansion stage; Task families, channels, and optimizations can still be added later, but the goal is no longer to "complete the foundational product."

### Stage progression checklist

Before preparing to enter the next Stage each time, confirm each item:

- [ ] All exit criteria for the current Stage have evidence, rather than being verbally declared;
- [ ] The last increment can still be fully demonstrated in the browser;
- [ ] The path for installation from an empty database, startup, Task creation, and recovery is usable;
- [ ] There are no unresolved high-risk security, duplicate side effect, or secret leakage issues;
- [ ] All newly added capabilities have failure states, recovery entry points, and user-visible explanations;
- [ ] The evaluation set, real Task results, Token/manual minutes, and failure categories have been updated;
- [ ] Data export, backup, rollback, and known limitations have been updated;
- [ ] The next stage will not depend on hidden manual operations or configurations that are only available on the development machine.

If any item is not satisfied, stay in the current Stage and fix it, rather than proceeding with "we'll fill it in later."

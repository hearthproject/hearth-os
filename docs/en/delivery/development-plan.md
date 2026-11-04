---
title: 'From 0 to 100 Development Plan'
description: 'Hearth development plan overview: seven stage modules, each with development steps, increments, deliverables, and exit gates.'
outline: [2, 3]
---

<script setup>
const modules = [
  { no: 'S0', meta: '4 increments', title: 'Definition & Prototype', text: 'Product wedge, real tasks, prototype, contracts, evaluation, and security baseline.', link: '/en/delivery/stage-0' },
  { no: 'S1', meta: '6 increments', title: 'Durable Kernel & MVP', text: 'Walking skeleton, Codex slice, MVP-1, side-effect safety, and recovery.', link: '/en/delivery/stage-1' },
  { no: 'S2', meta: '6 increments', title: 'Personal Operator', text: 'Read-only connectors, documents and data, web research, approval-gated writes.', link: '/en/delivery/stage-2' },
  { no: 'S3', meta: '4 increments', title: 'Computer Operator', text: 'Desktop agentd, observation, takeover, low-risk and high-risk GUI.', link: '/en/delivery/stage-3' },
  { no: 'S4', meta: '5 increments', title: 'Proactive Personal Agent', text: 'Triggers, proactive inbox, mobile PWA, attention budgets.', link: '/en/delivery/stage-4' },
  { no: 'S5', meta: '4 increments', title: 'Memory & Evolution', text: 'Memory Core, forgetting, skill candidates, evaluation, promotion, rollback.', link: '/en/delivery/stage-5' },
  { no: 'S6', meta: '6 increments', title: 'Multi-device & Operations', text: 'Sync, offline queues, revocation, backup migration, long-running operations.', link: '/en/delivery/stage-6' }
]
</script>

<p class="eyebrow">DEVELOPMENT PLAN</p>

# From 0 to 100 Development Plan

<p class="lead">The product roadmap answers "what counts as complete?" This plan answers "what do we build next?" It is not a weekly Gantt chart; it is seven independently verifiable engineering modules.</p>

## How to Read This Plan

- The unit is a vertical increment `D0.1 … D6.6`, not a week, month, or fixed sprint length.
- Follow dependencies strictly; no increment may deliver only a backend, log, or interface.
- Every increment must let the user complete one concrete task in the browser.
- When a stage gate fails, stay in the current Stage and repair it; do not trade recovery, UI, or verification for progress.

## Read the Master Roadmap First

The [phased product roadmap](/en/delivery/roadmap) is the master outline for scope and order. It defines Stage 0–6 goals, scope, exit conditions, and explicit deferrals. This plan expands those stages into engineering steps; when they conflict, the roadmap's stage gates take precedence.

## Seven Development Modules

<DocCardGrid :items="modules" :columns="2" />

Use every module in the same order:

1. **Prerequisites:** confirm dependencies are stable before moving on.
2. **Development steps:** build in numbered order, with a concrete outcome for each step.
3. **Increment breakdown:** confirm the user-visible result and completion evidence for each increment.
4. **Exit gates:** pass every check before entering the next module; otherwise fix the current one.

Every D increment further splits into four implementation work packages. Merge them in dependency order; together they cover the main implementation path, engineering map, acceptance rehearsal, and failure recovery. Developers can divide the packages, but no single package replaces increment acceptance.

## Plan Boundaries

- **Start:** product definition, a first user, and an empty repository, with no runnable system.
- **End:** a Personal Agent OS that can run, migrate, recover, and revoke safely in a real personal environment.
- **Unit:** a vertical increment such as D0.1, D1.1, or D2.3, not a week, month, or fixed sprint length.
- **Order:** follow dependencies strictly. You may pause, trial, and roll back, but you cannot skip recovery, UI, or verification for speed.

## Six Execution Rules

1. **Vertical slices first.** Every increment includes a user outcome, UI, durable state, real implementation, verification, and recovery.
2. **The frontend grows with the backend.** Stage 0 has a clickable prototype; Stage 1's first runnable skeleton includes a real Web task card; every later increment projects into the UI.
3. **Narrow before wide.** Make one task family dependable before adding a second; prove permissions, idempotency, and receipts on one connector before adding channels.
4. **Durability before autonomy.** Tasks cannot disappear, effects cannot duplicate, and failures must be visible before proactive loops and high-risk unattended work.
5. **Safety before real side effects.** Sending, writing, sharing, deleting, and desktop actions require Effect Preview, Mandate, Approval, idempotency, and Receipt drills.
6. **Evaluation before expansion.** New executors, connectors, models, skills, or automation need representative tasks, baselines, failure samples, and rollback.

## Where the MVP Fits

MVP-1 is the early Stage 1 exit at D1.3, not a Stage 6 product. It is a real local personal task workbench, initially centered on research/document work. If the first user mainly needs coding tasks, replace the wedge but keep the same vertical structure.

| Dimension | MVP gate |
|---|---|
| Entry | Local Web can create tasks, choose a workspace, and reference files or paths |
| Task | One narrow task family end to end: goal, scope, budget, state, and acceptance |
| Execution | Codex runs in an isolated workspace and returns structured results and artifacts |
| State | Queued, running, approval, information-needed, completed, failed, and recoverable states are durable |
| UI | Today/task cards, detail, approval, artifacts, failure, and recovery without CLI knowledge |
| Evidence | Artifacts can be previewed/downloaded with sources, hashes, and verification results |
| Side effects | At least one external action has preview, approval, idempotency, and a drill receipt |
| Recovery | Tasks survive refresh and restart; users can continue, cancel, retry, or move to human handling |
| Cost | Token, model, executor, latency, and manual minutes are recorded |

## Increment Delivery Template

| Item | Must answer |
|---|---|
| User-visible outcome | What specific thing can the user now do in the browser? |
| Main work | Which backend, frontend, protocol, executor, and test work is required? |
| Completion gate | What repeatable evidence proves it is complete? |
| Failure and recovery | What does the user see, and how can they cancel, retry, take over, or undo? |
| Cost and side effects | What are the Token, manual-minute, external-action, and receipt results? |
| Regression check | Do the last increment, last stage, and critical safety boundaries still hold? |

## Five Workstreams Across Every Increment

| Workstream | Must be updated in every increment |
|---|---|
| Product and UI | User story, states, primary action, empty states, failure states, recovery, desktop/mobile layout |
| Protocol and projections | Event, schema, API, Task Pack, Result, projection fields, migration, and contract tests |
| Evaluation and safety | Representative tasks, success/failure samples, permission checks, fault injection, security regression, human acceptance |
| Observability and cost | Trace, executor/model, Token, latency, manual minutes, interruptions, failure classes |
| Documentation and migration | README, ADR, user guidance, security, backup/upgrade, known limits, and data export |

## Demonstrable Checkpoints

| Checkpoint | Module | Demonstrable product state |
|---|---|---|
| Prototype | S0 | A clickable end-to-end flow with no real side effects |
| Walking skeleton | S1 · D1.1 | Web + durable tasks + fake executor |
| MVP-1 | S1 · D1.3 | A real end-to-end product for one narrow task family |
| Stage 1 complete | S1 | Recoverable kernel, two task families, side-effect safety skeleton |
| Personal Operator | S2 | Email/calendar/document/web/data daily tasks |
| Computer Operator | S3 | GUI observation, takeover, low/high-risk desktop actions |
| Proactive agent | S4 | Proactive loop, mobile PWA, attention budget |
| Memory and evolution | S5 | Correctable memory and rollbackable skills |
| Personal Agent OS | S6 | Multi-device, migration, long-running operation, full audit |

## Scope Trimming Order

When resources are constrained, cut scope before foundations: fewer connectors and channels → less proactivity → less native surface → fewer advanced memory types → less multi-device execution → less remote Sandbox → pause skill promotion.

**Never cut:** Web UI and task cards, Event Log and durable state, approval/idempotency/outbox/Receipt, verifiers and failure samples, permissions and secret protection, export/backup/revocation, and user-visible failure reasons and next actions.

## Definition of Complete

"100%" does not mean every app and scenario with zero human work. It means every stage exit holds: task coverage is verified; desktop and mobile can view, initiate, approve, take over, and retrieve artifacts; crashes and device switching lose no tasks; high-risk actions are approvable and revocable; memory is explainable, correctable, and forgettable; skills are evaluable and rollbackable; and the system can be installed, migrated, and run long term.

## Stage Advancement Checklist

- [ ] Every exit condition has evidence, not a verbal declaration.
- [ ] The latest increment still demonstrates end to end in the browser.
- [ ] Install, start, create task, and recovery work from an empty database.
- [ ] No unresolved high-risk security, duplicate side-effect, or secret-leak issue remains.
- [ ] Every new capability has failure, recovery, and user-visible explanation.
- [ ] Evaluation sets, real-task results, Token/manual minutes, and failure classes are updated.
- [ ] Export, backup, rollback, and known limitations are updated.
- [ ] The next stage does not depend on hidden manual work or developer-machine-only configuration.

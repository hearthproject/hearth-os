---
title: 'Delivery Route and Implementation Plan'
description: 'Hearth delivery master plan: seven capability stages, 35 vertical increments, 140 work packages, and exit evidence for each stage.'
outline: [2, 3]
---

<script setup>
const modules = [
  { no: 'S0', meta: '4 increments', title: 'Definition and Prototype', text: 'Product wedge, real tasks, clickable prototype, protocol contracts, and evaluation baseline.', link: '/en/delivery/stage-0' },
  { no: 'S1', meta: '6 increments', title: 'Durable Kernel and MVP', text: 'Walking skeleton, first Codex slice, MVP-1, side-effect safety, and recovery.', link: '/en/delivery/stage-1' },
  { no: 'S2', meta: '6 increments', title: 'Personal Operator', text: 'Connectors, documents and data, web research, and writes that require approval.', link: '/en/delivery/stage-2' },
  { no: 'S3', meta: '4 increments', title: 'Computer Operator', text: 'Desktop agentd, GUI observation, human takeover, and risk-tiered desktop actions.', link: '/en/delivery/stage-3' },
  { no: 'S4', meta: '5 increments', title: 'Proactive Personal Agent', text: 'Triggers, proactive inbox, mobile PWA, and attention budgets.', link: '/en/delivery/stage-4' },
  { no: 'S5', meta: '4 increments', title: 'Memory and Evolution', text: 'Memory Core, forgetting and export, skill candidates, evaluation, and rollback.', link: '/en/delivery/stage-5' },
  { no: 'S6', meta: '6 increments', title: 'Multi-device and Long-running', text: 'Event sync, offline queues, device revocation, backup, migration, and operations.', link: '/en/delivery/stage-6' }
]
</script>

<p class="eyebrow">DELIVERY</p>

# Delivery Route and Implementation Plan

<p class="lead">There is one master plan: Stages 0–6 define capability gates, 35 D increments define the construction order, and each increment contains four work packages. The route promises no dates, only visible product outcomes, verification evidence, and recovery paths at every stage.</p>

## Guiding Principles

- **Stage is a capability gate, not a schedule.** You can stay, trial, and roll back, but cannot skip recovery, interface, verification, or safety boundaries.
- **Every increment is a vertical slice.** User outcome, interface, persistent state, real execution, verification, and recovery arrive together.
- **Ship an MVP early.** MVP-1 is an early exit from Stage 1, not a demo produced at the end of the project.
- **Narrow before broad.** Make one task family dependable before expanding connectors, desktop, proactivity, and multi-device support.
- **Safety before side effects.** Sending, writing, sharing, deleting, and desktop actions require authorization, idempotency, and receipts first.
- **Evidence before announcements.** A stage is complete only when real tasks, failure recovery, and evaluations prove it.

## Seven Stages

<DocCardGrid :items="modules" :columns="2" />

## Stage Overview

| Stage | What the User Gets | What Must Be Proven Before Moving On |
|---|---|---|
| Stage 0 | A clickable end-to-end prototype | Product wedge, 12 real tasks, stable contracts, evaluation and approval baselines |
| Stage 1 | A locally usable personal task workbench | Persistent state, real Codex execution, approvals, artifacts, recovery, and MVP-1 |
| Stage 2 | A Personal Operator for daily content work | Connector loops, source citations, document/data verification, approved writes, and receipts |
| Stage 3 | A Computer Operator for desktop work | GUI observation, human takeover, isolation, desktop verification, and high-risk approvals |
| Stage 4 | A low-interruption proactive personal agent | Triggers, attention budgets, mobile approvals, pause, and device revocation |
| Stage 5 | An agent that accumulates context and improves safely | Correctable/forgettable/exportable memory and evaluated, promoted, rollback-capable skills |
| Stage 6 | A multi-device, portable, long-running Personal Agent OS | Sync consistency, offline recovery, device revocation, migration, and operations evidence |

Each stage page defines its scope and exit conditions in detail. Stages advance by capability dependency, not by calendar boundaries.

## 35 Increments, 140 Work Packages

Every D increment follows the same delivery template so progress cannot hide behind backend-only work:

| Deliverable | Required Answer |
|---|---|
| User-visible outcome | What concrete thing can the user now do in the browser? |
| Implementation landing | Which modules, interfaces, events, and tests must be completed? |
| Acceptance rehearsal | What repeatable steps prove that it really works? |
| Failure and recovery | What does the user see on failure, and how can they cancel, retry, take over, or undo? |

Each increment contains four implementation work packages. Work can be split, but completing one package never substitutes for accepting the whole increment.

## Where the MVP Sits

MVP-1 is D1.3 in Stage 1: a truly usable local personal task workbench. It must include Web task cards, persistent task state, real Codex execution, artifacts, an approval rehearsal, and failure recovery, but not email, calendar, GUI, proactive loops, or multi-device support.

## Six Execution Rules

1. **Vertical slices first.** Do not deliver a “partial stage” made only of CLI, logs, database, or APIs.
2. **The frontend grows at the same time.** Stage 0 has a prototype, Stage 1 has real Web task cards, and every later increment has a user path.
3. **Durability before autonomy.** Tasks cannot disappear, side effects cannot duplicate, and failures must be visible.
4. **Safety before real side effects.** High-risk actions require preview, authorization, idempotency, and receipts.
5. **Evaluation before expansion.** Every new executor, connector, model, and skill needs representative tasks, baselines, and failure samples.
6. **Cut scope, never foundations.** Reduce coverage and autonomy before reducing interface, state, recovery, audit, and revocation.

## Engineering Constraints

Every stage must also meet engineering baselines for contract and integration tests, fault injection, security tests, performance and long-running stability, observability, backup/export, and rollback-capable releases. Detailed repository layout, testing, risks, and decisions live in the appendix:

- [Engineering and Repository Structure](/en/reference/engineering)
- [Risks and Kill Criteria](/en/reference/risks)
- [ADRs and Key Decisions](/en/reference/decisions)

## Start Here

Read [Design & Tradeoffs](/en/design/) to understand why Hearth is designed this way, then begin at [Stage 0](/en/delivery/stage-0). If the current stage is already clear, use the sidebar to open the relevant stage and D increment.

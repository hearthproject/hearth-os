---
title: 'Delivery Overview'
description: 'Hearth delivery entry point: the product roadmap is the master outline, seven stage modules contain the work, and engineering safeguards cover verification, risk, and decisions.'
outline: [2, 3]
---

<script setup>
const modules = [
  { no: 'S0', meta: '4 increments', title: 'Definition & Prototype', text: 'Lock the user, task wedge, end-to-end prototype, contracts, and evaluation baseline.', link: '/en/delivery/stage-0' },
  { no: 'S1', meta: '6 increments', title: 'Durable Kernel & MVP', text: 'Walking skeleton, first Codex slice, MVP-1, side-effect safety, and recovery.', link: '/en/delivery/stage-1' },
  { no: 'S2', meta: '6 increments', title: 'Personal Operator', text: 'Connectors, documents and data, web research, and approval-gated writes.', link: '/en/delivery/stage-2' },
  { no: 'S3', meta: '4 increments', title: 'Computer Operator', text: 'Desktop agentd, GUI observation, human takeover, and tiered desktop actions.', link: '/en/delivery/stage-3' },
  { no: 'S4', meta: '5 increments', title: 'Proactive Personal Agent', text: 'Triggers, proactive inbox, mobile PWA, and attention budgets.', link: '/en/delivery/stage-4' },
  { no: 'S5', meta: '4 increments', title: 'Memory & Evolution', text: 'Memory Core, forgetting and export, skill candidates, evaluation, and rollback.', link: '/en/delivery/stage-5' },
  { no: 'S6', meta: '6 increments', title: 'Multi-device & Operations', text: 'Event sync, offline queues, device revocation, backup migration, and long-running operations.', link: '/en/delivery/stage-6' }
]

const safeguards = [
  { no: '01', title: 'Engineering & Repository', text: 'Tech stack, repository layout, process model, CLI, testing and evaluation, and release migration.', link: '/en/delivery/engineering' },
  { no: '02', title: 'Risks & Kill Criteria', text: 'Pause conditions, stage Kill Criteria, and the foundations that must never be cut.', link: '/en/delivery/risks' },
  { no: '03', title: 'ADRs & Key Decisions', text: 'Judgments that are hard to reverse and the acceptance criteria for the final product exit.', link: '/en/delivery/decisions' }
]
</script>

<p class="eyebrow">DELIVERY MAP</p>

# Delivery Overview

<p class="lead">The product roadmap defines scope, order, and stage gates. "From 0 to 100" turns that outline into seven independently buildable and verifiable modules. Engineering safeguards cover the repository, risk, and critical decisions.</p>

> **There is one reading order:** read the [product roadmap](/en/delivery/roadmap) first to confirm what the current stage does and does not include; then enter the matching Stage module; finally review [engineering safeguards](#engineering-safeguards) and the [documentation map](/en/reference/source-map).

## Layer 1: The Product Roadmap Is the Master Outline

The [product roadmap](/en/delivery/roadmap) answers four questions:

1. **Why this stage now?** Sequence is driven by capability dependencies, not calendar estimates.
2. **What ships in this stage?** The user-visible product form, core capabilities, and main risks are explicit.
3. **When is it complete?** Every Stage has exit conditions and a learning gate.
4. **What are we deliberately not doing?** High-risk, low-value, or foundation-damaging scope is deferred explicitly.

Stages are capability gates, not date commitments. You may pause, trial, and roll back at any stage, but you cannot skip recovery, UI, verification, or security boundaries.

## Layer 2: Seven Development Modules

The From 0 to 100 Development Plan is not one broad checklist. It is seven sequential modules. Every module follows the same structure: prerequisites → development steps → increment breakdown → exit gates → out of scope. A developer can begin from the current module and build directly.

The seven modules contain 35 D increments, and every increment splits into four implementation work packages, 140 packages total. Each increment page fixes the user outcome, completion gate, work packages, engineering map, interfaces, acceptance rehearsal, and failure recovery.

<DocCardGrid :items="modules" :columns="2" />

[Read the full development plan and delivery template](/en/delivery/development-plan)

## Layer 3: Engineering Safeguards

- Chapter 26 defines engineering implementation, and Chapter 27 defines risks and Kill Criteria.
- Chapter 28 summarizes ADR-001–020, and Chapter 29 provides terminology, default checklists, and the final judgment.
- The engineering foundation, recovery, security, and UI must not be cut to meet deadlines.

<DocCardGrid :items="safeguards" :columns="3" />

## Stage Sequence

| Stage | Development module | Stage exit | Evidence that cannot be skipped |
|---|---|---|---|
| Stage 0 | [Definition & Prototype](/en/delivery/stage-0) | Clickable prototype and stable contracts | 12 real tasks, complete state flow, evaluation and approval baseline |
| Stage 1 | [Durable Kernel & MVP](/en/delivery/stage-1) | A locally usable daily MVP | Durable state, real Codex execution, approvals, artifacts, and recovery |
| Stage 2 | [Personal Operator](/en/delivery/stage-2) | Daily content work can be delegated | Connector loops, source citations, approval-gated writes, and receipts |
| Stage 3 | [Computer Operator](/en/delivery/stage-3) | Desktop work can run with takeover | GUI observation, takeover, isolation, desktop verification, high-risk approval |
| Stage 4 | [Proactive Personal Agent](/en/delivery/stage-4) | Proactive work within bounded authority | Triggers, attention budget, mobile approval, and instant pause |
| Stage 5 | [Memory & Evolution](/en/delivery/stage-5) | Explainable and rollbackable accumulation | Memory correction/forgetting/export, skill evaluation, promotion, and rollback |
| Stage 6 | [Multi-device & Operations](/en/delivery/stage-6) | A portable Personal Agent OS | Sync, offline recovery, device revocation, backup migration, and long-term audit |

**Where MVP Fits:** MVP-1 is the early Stage 1 exit at D1.3, not a Stage 6 product. It must include real execution, durable tasks, Web task cards, artifacts, approval drills, and failure recovery.

## How Developers Should Start

1. New to the project: read [What is Hearth?](/en/guide/what-is-hearth) and the [product definition](/en/product/definition).
2. Ready to implement: read the [system design overview](/en/architecture/) and [durable execution](/en/architecture/durable-execution).
3. Ready to build: open [Stage 0](/en/delivery/stage-0) and complete its steps and increments in order.
4. Ready to merge: check [Risks & Kill Criteria](/en/delivery/risks) and the [default checklists](/en/reference/checklists).

To review the complete directory, reading hierarchy, and maintenance rules, open the [Documentation Map](/en/reference/source-map).

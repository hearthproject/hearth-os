---
title: 'Delivery Overview'
description: 'Hearth delivery overview: Stage 0–6, the MVP position, guiding principles, and roadmap entry points.'
outline: [2, 3]
---

<script setup>
const cards = [
  { no: '01', title: 'Phased Product Roadmap', text: 'Stage 0–6 goals, scope, exit criteria, and explicitly deferred items.', link: '/en/delivery/roadmap' },
  { no: '02', title: 'From 0 to 100 Development Plan', text: 'MVP-1, incremental templates, release sequence, scope trimming, and the v1.0 exit.', link: '/en/delivery/development-plan' },
  { no: '03', title: 'Engineering Delivery and Repository Structure', text: 'Tech stack, repository layout, process model, CLI, testing, and release migration.', link: '/en/delivery/engineering' },
  { no: '04', title: 'Risks and Kill Criteria', text: 'Pause conditions, stage Kill Criteria, and things that should not be killed.', link: '/en/delivery/risks' },
  { no: '05', title: 'ADRs and Key Decisions', text: 'Judgments that cannot be easily reversed, and the final exit for v1.0.', link: '/en/delivery/decisions' }
]
</script>

<p class="eyebrow">DELIVERY</p>

# Delivery: Advancing by Capability Gates

<p class="lead">Hearth does not commit to calendar-based delivery; it advances by capability gates. Every stage must simultaneously deliver user-visible UI, durable state, verification evidence, and recovery paths.</p>

<DocCardGrid :items="cards" :columns="2" />

## Chapters 26–29: Reading Guide

- Chapter 26 presents the engineering implementation approach; Chapter 27 covers risks and Kill Criteria.
- Chapter 28 summarizes ADR-001–020; Chapter 29 provides terminology, default checklists, and final judgment.
- The engineering foundation, recovery, security, and UI must not be cut to meet deadlines.

## Stage Overview

| Stage | Product Form | Core Capabilities |
|---|---|---|
| Stage 0 | Clickable end-to-end prototype | Product wedge, Task set, protocol, interaction, evaluation, and security baseline |
| Stage 1 | Local personal Task workspace + MVP | Recoverable kernel, Codex, Web Task cards, approvals, Artifacts, recovery |
| Stage 2 | Personal Operator | Email, calendar, documents, web, data, Context Compiler, Memory v0 |
| Stage 3 | Computer Operator | agentd, GUI, takeover, desktop isolation, and high-risk approvals |
| Stage 4 | Proactive Personal Agent | Trigger, proactive loop, attention budget, mobile PWA, device pairing |
| Stage 5 | Memory / Evolution OS | Long-term memory, skill evaluation/promotion/rollback |
| Stage 6 | Personal Agent OS v1.0 | Multi-device, offline queue, undo, backup migration, long-term operations |

**Where MVP Fits:** MVP is an early exit point for Stage 1, positioned before the full Stage 1 gate. It does not include email, calendar, GUI, proactivity, or multi-device support, but it must include real execution, durable Task state, Web Task cards, Artifacts, approval drills, and failure recovery.

## One-Page Map from 0 to 100

```text
Stage 0  Product wedge + clickable prototype + protocol/evaluation baseline
   ↓
Stage 1  Walking skeleton → first real Codex slice → MVP → side-effect safety → second task family
   ↓
Stage 2  Read-only connectors → docs/data → browser → drafts/approvals/receipts → daily operator
   ↓
Stage 3  Device agentd → observe/takeover → low-risk GUI → high-risk GUI
   ↓
Stage 4  Trigger/proactive inbox → mobile PWA → secure pairing → attention budget
   ↓
Stage 5  Memory Core → forgetting/export → skill candidates/evaluation → promotion/rollback
   ↓
Stage 6  Multi-device sync → offline queue → revocation/keys → backup migration → v1.0
```

“100%” does not mean never iterating again; it is the v1.0 exit of Stage 6: a complete product — recoverable, approvable, migratable, revocable, and usable long-term.

## Advancement Principles

- Prove reliability first, then expand coverage;
- Advance frontend and backend in parallel along vertical slices;
- Before any automation capability can produce real side effects, it must first pass safety and recovery tests;
- Every stage has both a product gate and a learning gate;
- You may pause, trial, and roll back, but you may not skip steps.

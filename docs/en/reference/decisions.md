---
title: 'ADRs and Key Decisions'
description: 'The Hearth ADR index and final decisions.'
outline: [2, 3]
---

<p class="eyebrow">DECISIONS</p>

# ADRs and Key Decisions

<p class="lead">Codify product and engineering judgments that are not easily reversible into traceable decision records.</p>

## ADR Index

The following are the recommended first batch of architecture decisions. Those with status `Accepted` should be committed to the repository as early as possible; subsequent changes are recorded through new ADRs.

| ADR | Decision | Status | Main Consequences |
|---|---|---|---|
| ADR-001 | Hearth is a single-user, self-hosted, local-first personal Agent OS | `Accepted` | No enterprise IAM; prioritize local state and portability |
| ADR-002 | Event Log is the single source of truth; UI/indexes/memory are projections | `Accepted` | Requires event schema, replay, and migration |
| ADR-003 | Use SQLite WAL and a single writer early on; do not introduce microservices | `Accepted` | Reduces operations overhead; requires leases and a horizontal scaling plan |
| ADR-004 | Adopt a modular monolith; Executor integration occurs through a unified protocol | `Accepted` | Boundaries are enforced by interfaces and tests, not network decomposition |
| ADR-005 | Use a multi-Executor model rather than pursuing a single all-purpose Agent | `Accepted` | Requires capability declarations, routing, and a unified result contract |
| ADR-006 | Codex is the first external Executor and can handle code, research, documents, and Shell, but is not the product itself | `Accepted` | Requires adapters, version pinning, and fallback paths |
| ADR-007 | Build Execution Gateway, Policy, and Broker in-house; integrate Sandbox/Runtime kernels | `Accepted` | Do not build containers/virtualization in-house; requires a unified Sandbox Provider |
| ADR-008 | All external side effects go through typed Effects, outbox, idempotency keys, and Receipt | `Accepted` | Increases implementation complexity but avoids duplication and unauditable actions |
| ADR-009 | High-risk actions require Mandate and Approval; an Executor cannot expand permissions | `Accepted` | Adds interaction but establishes a trust boundary |
| ADR-010 | Memory is divided into five categories, with provenance, confidence, sensitivity, budget, and forgetting | `Accepted` | Requires memory maintenance and a user interface |
| ADR-011 | Self-evolution produces only candidate skills, which are promoted after Shadow/Canary/evaluation/rollback | `Accepted` | Requires evaluation sets and version management |
| ADR-012 | Mobile-first PWA; start with viewing/approval/takeover/initiation/notification | `Accepted` | Do not build a full mobile Agent for now; reduce release costs |
| ADR-013 | Token Governor and Context Compiler are core architecture, not afterthought optimizations | `Accepted` | Requires unified metering, budgeting, and context assembly |
| ADR-014 | Learn from OpenClaw/Hermes patterns; do not fork their product foundations | `Accepted` | Requires building Gateway, Memory, and Evolution protocols in-house |
| ADR-015 | Human Executor and takeover are first-class capabilities | `Accepted` | Requires real-time UI, auditing, and recovery |
| ADR-016 | Do not build enterprise multi-tenancy, a public Agent marketplace, or billing | `Accepted` | Focus on personal experience and self-hosting |
| ADR-017 | Currently integrate only Codex; other external Agents are out of product scope for now | `Accepted` (provisional) | Retain the Executor interface to avoid lock-in |
| ADR-018 | Models are replaceable, local models are optional, and no foundation models are trained | `Accepted` | Requires a model catalog, routing, and evaluation |
| ADR-019 | Adopt MVP-first vertical-slice delivery; the frontend enters every small stage starting from Phase 1 | `Accepted` | Backend-first development with the UI added at the end is not allowed; phase acceptance must include browser paths |
| ADR-020 | The roadmap advances only by capability gates and small-stage order, not weekly/monthly schedules | `Accepted` | No completion dates are promised; progress is measured by real tasks, recovery, and evaluation evidence |

---

## Final Judgment

## Final Judgment

Back to the original debate: should we write only the control layer and delegate execution to external Agents, or also write the runtime and sandbox entirely ourselves?

**The product roadmap should take the former approach, but it is not a simple “thin wrapper.”**

Hearth builds in-house:

- Control Plane;
- Durable Harness;
- Event Log;
- Approval and idempotency;
- Context Compiler and Token Governor;
- Memory OS;
- Evolution OS;
- Execution Gateway;
- Credential Broker;
- Task cards, approvals, Artifacts, and mobile entry points.

Hearth integrates:

- Codex;
- Model APIs or local models;
- Container/microVM/Sandbox kernels;
- Playwright;
- Document parsing and conversion libraries;
- Official APIs for email, calendar, cloud storage, and similar services.

Hearth retains only for learning:

- A minimal event loop and session tree;
- A context compression prototype;
- A single-machine Sandbox wrapper;
- Routing and evaluation experiments.

This enables deep learning about Agent Runtime, Harness, Sandbox, Gateway, Memory, and Evolution without spending the project's life reimplementing containers, virtualization, and model inference engines.

Codex's positioning should be equally clear:

> **Codex is currently one of Hearth's strongest and most general-purpose external Executors. It can write code and also conduct research, produce long documents, reports, spreadsheets, and handle complex file work; but it is not limited to code, nor is it the core of Hearth. Email, calendar, web, desktop, deterministic document processing, and human responsibility are handled by peer Connector, Browser, GUI, Document/Data, and Human Executor components, respectively.**

Ultimately, Hearth's moat is not “having a stronger model,” but:

- Knowing when not to call a model;
- Knowing what minimal context to give an Executor;
- Knowing which actions require whose authorization;
- Knowing how to prove that a Task is truly complete;
- Knowing how to recover after failure;
- Knowing what should be remembered and what should be forgotten;
- Knowing when to stop and return attention to the human.

If these are achieved, Hearth will be more than an Agent wrapper; it will be a truly personal, long-term reliable digital work system.

Finally, the delivery judgment:

> **First build a minimal product that can be used every day in a real browser, then grow it step by step into a Personal Agent OS.**

Phase 1 uses a prototype to validate the product narrative and delivers the MVP as early as possible; thereafter, every small stage delivers UI, backend, validation, and recovery together. The roadmap sets no development time limits and does not use “which week” to prove progress; it proves the direction is right only through real tasks, recoverability, and whether users are willing to keep using it.

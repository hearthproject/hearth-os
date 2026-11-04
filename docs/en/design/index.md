---
title: 'Design & Tradeoffs'
description: 'Hearth product positioning, core tradeoffs, system architecture, execution chain, and definition of done.'
outline: [2, 3]
---

<p class="eyebrow">DESIGN</p>

# From Intent to Reliable Tasks

<p class="lead">Hearth is a single-user, self-hosted, long-running personal Agent OS. This page puts product positioning, key tradeoffs, system architecture, and completion criteria into one narrative: why Hearth exists, how it is designed, and what must be true before the work counts as complete.</p>

## The Short Version

> **Hearth is not trying to be a more talkative assistant. It makes personal digital labor durable, controllable, and verifiable.**

- Users work with tasks, approvals, and artifacts, not the internal details of Workers, Harnesses, or token budgets.
- The system owns task state, permissions, budgets, evidence, and recovery paths; models are replaceable execution capabilities.
- Capability grows by stages, but every stage must deliver a usable vertical slice rather than only another layer of infrastructure.

## Product Positioning

| Item | Definition |
|---|---|
| User | One primary user, with up to a few trusted collaborators |
| Deployment | Local-first and self-hostable; personal files and credentials stay under the user's control by default |
| Work | A mix of research, writing, documents, email, calendar, code, data, web, and desktop work |
| First wedge | One high-frequency, low-external-risk, verifiable task family with a complete end-to-end loop |
| Product form | Tasks, approvals, artifacts, and notifications rather than an endless chat transcript |
| Explicit non-goals | Enterprise multi-tenancy, a public agent marketplace, unapproved high-risk automation, or a foundation-model race |

### What It Is Not

- Another coding agent;
- A Codex wrapper that only forwards prompts;
- A black box that gives every permission to a model;
- A tool that requires daily maintenance of prompts, plugins, and workflows;
- An enterprise IAM, audit, and multi-tenant platform.

## Core Tradeoffs

| Tradeoff | Hearth's Choice | Why |
|---|---|---|
| Tasks or chat | Center on task cards and completion evidence | Long tasks need state, budgets, approvals, and recovery; chat history is not a reliable source of truth |
| Where state lives | Event Log as the source of truth; interfaces are projections | Crashes, device changes, replay, and audit all need one factual chain |
| Who executes | Native, Codex, Connector, Browser, GUI, Document/Data, and Human side by side | Different tasks need different capabilities, risk levels, and token costs |
| Build or integrate | Build control, execution kernel, memory, verification, and experience; integrate models, sandboxes, browsers, and APIs | Control, authorization, evidence, and recovery are the moat; mature lower layers should be reused |
| External effects | Preview, approval, idempotency key, outbox, and Receipt | Email, writes, sharing, deletion, and desktop actions must be traceable, reconcilable, and recoverable |
| Where data lives | Single-user, local-first, and portable | Personal context, memory, and credentials should not leave the user's control by default |
| Memory and evolution | Memory must be explainable, correctable, and forgettable; skills must be evaluated, canaried, promoted, and rolled back | Accumulate experience without unbounded self-modification |
| How delivery advances | Capability gates and vertical increments, not calendar promises | Prove reliability before expanding scope; every stage can be paused, trialed, and rolled back |

## Execution Chain

```text
User / CLI / Web / Mobile / IM
            ↓
     Experience Plane       Task cards · approvals · artifacts · takeover
            ↓
     Personal Gateway       identity · channels · devices · attention
            ↓
      Control Plane         triggers · policy · mandate · scheduling · watchdog
            ↓
     Durable Harness        task graph · budgets · lease · retry · recovery
            ↓
      Executor Layer        Native · Codex · Connector · Browser
                            GUI · Document/Data · Human
            ↓
    Execution Gateway       workspace · sandbox · network · credential broker
            ↓
 Event Log / Artifacts / Receipts
       ↓                    ↓
  Memory OS            Evolution OS
```

Every fact enters the Event Log; every external effect passes through authorization, idempotency, and a receipt; every interface state is rebuilt from projections rather than transient in-memory objects.

## System Composition

| Plane | Responsibility |
|---|---|
| Experience Plane | Task cards, approvals, artifacts, takeover, and notifications |
| Personal Gateway | Identity, channel normalization, device registration, and attention entry |
| Control Plane | Intent decisions, triggers, policy, mandate, scheduling, and watchdog |
| Durable Harness | Task graph, routing, budgets, leases, retries, and recovery |
| Executor Layer | One protocol for different executors and human takeover |
| Execution Gateway | Workspace, sandbox, network, browser, GUI, and Credential Broker |
| Memory / Evolution | Personal context, memory, skills, evaluation, promotion, and rollback |

Every plane cooperates through the Event Log. The first stage uses a modular monolith and a single writer rather than premature microservices; boundaries are enforced by interfaces, schemas, events, and tests.

## Task Coverage and Definition of Done

Hearth covers communication, documents, research, code, data, web SaaS, desktop applications, and personal errands. Autonomy ranges from A0 suggestions and A1 controlled execution to A2 authorized execution and A3 supervised autonomy, configured separately by task family, source, device, amount, and time window.

“Done” is not a model saying “done.” It requires all of the following:

- A user-visible result and next step;
- Persistent state, validators, and reproducible evidence;
- Approval, idempotency key, and receipt for every external effect;
- A visible failure reason plus a recovery entry point or explicit human takeover.

See the [Appendix](/en/reference/) and [Default Checklists](/en/reference/checklists) for the full task coverage and completion rules.

## Non-Negotiable Boundaries

1. The Event Log is the only source of truth.
2. Every state root has one write authority.
3. Every external effect has an idempotency key, an approval or explicit exemption, and a Receipt.
4. Executors never read long-lived raw credentials directly.
5. Every task has a budget, deadline, and cancellation path.
6. Memory has provenance, sensitivity, conflict, and forgetting policies.
7. Skill changes require evaluation, canary, promotion, and rollback.
8. Every increment is a complete vertical slice: user result, interface, persistent state, real execution, verification, and recovery at the same time.

## Current Status

Hearth is in the specification and planning stage. Product, architecture, security, evaluation, and delivery plans are defined; runnable implementation has not started. The next step is Stage 0: choose the first task wedge and complete a clickable prototype, protocol contracts, evaluation baseline, and real task fixtures.

## Continue Reading

<DocCardGrid :columns="3" :items="[
  { no: '01', title: 'Architecture Details', text: 'Start with the overall data flow, domain model, and durable execution.', link: '/en/architecture/overview' },
  { no: '02', title: 'Delivery Route', text: 'See how seven stages, 35 increments, and 140 work packages fit together.', link: '/en/delivery/' },
  { no: '03', title: 'Appendix', text: 'Consult engineering boundaries, risks, ADRs, terminology, checklists, and the archive.', link: '/en/reference/' }
]" />

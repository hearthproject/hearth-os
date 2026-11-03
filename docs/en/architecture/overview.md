---
title: "Overall Architecture and Data Flow"
description: "Hearth's North Star architecture, seven planes, task data flow, deployment topologies, and architectural evolution."
outline: [2, 3]
---

<p class="eyebrow">SYSTEM DESIGN</p>

# Overall Architecture and Data Flow

<p class="lead">How the seven planes work together, how state flows, and how the system grows from a minimal product into a complete Agent OS.</p>

## North Star Architecture

```text
User / CLI / Web / Mobile / IM
            ↓
     Experience Plane
     Task Card · Approval · Artifact · Takeover
            ↓
      Personal Gateway
   Identity · Channel · Device · Attention Entry
            ↓
       Control Plane
  Trigger · Policy · Mandate · Scheduling · Watchdog
            ↓
      Durable Harness
  Task Graph · Budget · lease · Retry · Recovery
            ↓
       Executor Layer
 Native · Codex · Connector · Browser
 GUI · Document/Data · Human
            ↓
     Execution Gateway
 Workspace · Sandbox · Network · Credential Broker
            ↓
  Event Log / Artifacts / Receipts
       ↓              ↓
   Memory OS      Evolution OS
```

All facts enter the Event Log; all external side effects go through the outbox, idempotency keys, and Receipts; all UI state is a projection, not a source of truth.

## The Seven Planes

| Plane | Responsibility | Not responsible for |
|---|---|---|
| Experience Plane | Task cards, approvals, artifacts, takeover, notifications | Directly executing business logic or writing to the database |
| Personal Gateway | Identity, channel normalization, device registration, attention entry point | Long-running task reasoning |
| Control Plane | Intent, triggers, Policy, Mandate, scheduling, Watchdog | Holding long-term credentials |
| Durable Harness | Task graph, routing, budget, retries, lease, recovery | Bypassing Policy to execute external actions |
| Executor Layer | Unified protocol for Native, Codex, Connector, Browser, GUI, Document/Data, Human | Expanding its own permissions or modifying Policy |
| Execution Gateway | Workspace, Sandbox, browser, GUI, network, Credential Broker | Deciding "whether it should be done" |
| Memory / Evolution | Personal context, memory, skills, evaluation, promotion and rollback | Becoming a source of truth |

The Event Log runs through all planes and is the source for state, auditing, recovery, and UI.

## Complete Data Flow of a Task

1. A user or Source produces an event.
2. The Gateway normalizes the Event, deduplicates it, and records its source.
3. The Control Plane decides: ignore / observe / suggest / create Task.
4. Policy and Mandate check scope, risk, budget, and approval requirements.
5. The Token Router selects the minimum viable model and execution tier.
6. The Context Compiler builds the Task Pack.
7. The Harness creates the Ticket, Assignment, and outbox record.
8. The Executor executes in a restricted environment, continuously producing WorkerEvents.
9. The Execution Gateway completes approved side effects through the Broker.
10. Artifacts, Receipts, failures, and human actions are written to the Event Log.
11. The validator decides to complete, retry, switch executors, or hand off to a human.
12. Memory writes candidate memories; Evolution collects trajectories.
13. The UI generates task cards, notifications, and artifact views from projections.

## Deployment Forms

| Form | Composition | Goal |
|---|---|---|
| Local | `hearth` CLI + `hearthd` + SQLite + Docker | Phase one and dogfood |
| Hybrid | Local state and device capabilities + cloud models/sandboxes | Insufficient resources or remote execution |
| Self-hosted Server | Always-on Gateway + multi-device agentd + optional remote Sandbox | Long-term online presence and multiple devices |

Phase one does not introduce microservices. A single process, single writer, and SQLite are sufficient to support the early stage. Module boundaries are guaranteed by interfaces, schemas, and tests, rather than by splitting into network services first.

## Startup Forms

```text
hearthd
  ├─ local gateway / IPC / web API
  ├─ scheduler / watcher / trigger
  ├─ task queue / event log / outbox
  ├─ token router / context compiler / budget governor
  ├─ executor supervisor
  ├─ device registry / capability catalog / lease manager
  ├─ execution gateway / sandbox manager
  ├─ watchdog / health / backup
  └─ pairing / event sync / device revocation
```

Must account for auto-start on boot, continued operation after the terminal closes, sleep/wake, network interruptions, authentication expiry, Executor crashes, version upgrades, resource reclamation, phone disconnection, and re-pairing.

## Architecture Evolution

Hearth does not implement all modules in the final architecture diagram on day one. The architecture grows incrementally with the product, but the core invariants remain:

| Product Form | Architectural Increment | Remains Unchanged |
|---|---|---|
| Stage 0 clickable prototype | Web prototype, UI data contract, simulated projection | Task-card-first, honest state, one primary action |
| Stage 1 local MVP | single-process `hearthd`, SQLite WAL, Event Log, Codex, basic approvals and Artifacts | source of truth, recovery, verification, side-effect Receipt |
| Stage 2 daily operator | Connector, Browser, Document/Data, Context Compiler, Memory v0 | least privilege, provenance, idempotency, Token budget |
| Stage 3 desktop operator | device agentd, GUI Executor, takeover and desktop isolation | single-writer, audit, approvals, failure recovery |
| Stage 4 proactive personal Agent | Trigger, attention budget, mobile PWA, push and pairing | low-interruption, revocable, proactive mode can be paused |
| Stage 5 Memory and Evolution OS | Memory OS, Evolution OS, skill evaluation and rollback | provenance, forgetting, permission intersection, rollback-capable |
| Stage 6 Personal Agent OS v1.0 | multi-device sync, offline queue, migration, long-running operation and quotas | one logical Agent, event consistency, revocable devices |

**Architecture can expand in stages, but the product form cannot be retrofitted in stages.** Every stage must have a complete user path matching its architectural complexity.

## Chapter Conclusion

The value of architecture is not the number of modules, but letting “Task, Mandate, execution, evidence, and recovery” flow along the same auditable chain. Stage 0 defines the contract first, Stage 1 implements it with the smallest real chain, and afterward the planes expand gradually without changing the source of truth and permission boundaries.

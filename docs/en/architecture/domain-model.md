---
title: 'Domain Model and Protocols'
description: 'Hearth''s core entities, relationships, Event structure, Executor protocol, and approval and receipt chains.'
outline: [2, 3]
---

<p class="eyebrow">DOMAIN MODEL</p>

# Domain Model and Protocol

<p class="lead">Core entities, relationships, events, executor protocol, approvals, and receipts. This section defines the system's source-of-truth contract, not the details of any single implementation.</p>

## Core Entities

| Entity | Definition | Key Invariants |
|---|---|---|
| `Source` | Users, email, calendars, IM, GitHub, web pages, files, cron, devices | Has identity, trust level, and rate limits |
| `Event` | Immutable facts: messages, observations, tool calls, results, approvals, errors | Append-only, replayable, with schema version |
| `Thread` | Context container around an ongoing topic | Can be associated with multiple Tickets but does not hold execution authority |
| `Intent` | A goal expressed by the user or inferred by the system | Not executed directly; must be converted into a Task/Ticket |
| `Task` | A user-visible work item with acceptance criteria | Has a deadline, status, and completion evidence |
| `Ticket` | The smallest authorized unit of work | Single owner, budget, scope, and expiration time |
| `Mandate` | A versioned instance of an authorization policy | Scope, strength, validity period, revocable |
| `Policy` | A set of personal rules | Versioned; changes can trigger revalidation |
| `Assignment` | Binding between a Ticket and an Executor | At most one active executor at any given time |
| `Run` | A single actual execution attempt | Inputs, budget, checkpoints, terminal state |
| `Executor` | Execution capability | Capability declaration, isolation boundary, cancellable |
| `Capability` | Permission for resources, actions, scope, and duration | Least privilege, expirable, revocable |
| `Approval` | A human authorization decision | Bound to the actual action, parameters, scope, and expiration time |
| `Artifact` | Documents, code, reports, screenshots, data, schedules | Content-addressed, provenance-traceable |
| `Receipt` | Receipt for external side effects | Idempotency key, time, result, revocation information |
| `Memory` | Long-term facts, preferences, experiences, or Skill index | provenance, confidence, sensitivity, forgetting policy |
| `Skill` | Reusable procedural capability | Versioned, permission declaration, evaluatable, rollbackable |
| `Device` | Trusted device node | Identity, capability allowlist, pairing status |
| `Budget` | Time, Token, cost, disk, and command budgets | Hard limit; exhaustion must pause or hand off to a human |
| `Eval` | Evaluation of a task, Run, Skill, or routing | Results cannot be cherry-picked by the operator |

## Core Relationships

```text
Source → Event → Trigger → Thread
                          ├─→ Intent → Task → Ticket → Assignment → Run
                          └─→ Subscription → fast path

Policy → Mandate → Ticket
Approval → Mandate
Run → Artifact / Receipt
Run → Eval → Skill proposal → Shadow → Eval → Promote / Rollback
Device → Capability → Assignment
Memory → Context Pack → Executor
```

## Minimal Event Structure

```ts
type Event = {
  id: string;
  type: string;
  schemaVersion: number;
  occurredAt: string;
  actor: "user" | "agent" | "executor" | "system" | "device" | "external";
  subject:
    | { kind: "thread"; id: string }
    | { kind: "task"; id: string }
    | { kind: "ticket"; id: string }
    | { kind: "run"; id: string }
    | { kind: "device"; id: string };
  causationId?: string;
  correlationId: string;
  payload: unknown;
  hashPrev?: string;
};
```

Event Log records only facts, not "what the model thinks should be." Projections can be rebuilt, model context can be recomputed, but history cannot be overwritten.

## Executor Protocol

```ts
type ExecutorCapability =
  | "files"
  | "shell"
  | "code"
  | "research"
  | "documents"
  | "email"
  | "calendar"
  | "browser"
  | "gui"
  | "http"
  | "devices"
  | "human";

interface Executor {
  id: string;
  capabilities: ExecutorCapability[];
  execute(ticket: Ticket, context: ExecutorContext): AsyncIterable<ExecutorEvent>;
  cancel(runId: string): Promise<void>;
  resume?(checkpoint: Checkpoint): Promise<void>;
  health?(): Promise<ExecutorHealth>;
}
```

The unified output includes: a standardized event stream, Artifact references, a structured final result, a verification result, external action Receipts, failure classification, and recoverability.

The Executor is not responsible for interpreting long-term preferences, deciding whether to send/delete/merge/pay, expanding its own capability, directly reading long-term raw credentials, or creating new Tasks without a budget.

## Approval and Receipts

All external side effects follow this sequence:

1. Generate an effect intent;
2. Write to the outbox;
3. Commit the transaction;
4. Dispatcher reads pending execution items;
5. Check Approval / Mandate / capability;
6. Call the external service with an idempotency key;
7. Record a Receipt;
8. Mark as complete or move to the dead-letter queue.

Rules:

- Persist first, then execute;
- The same idempotency key must not produce a second external side effect;
- Retries reuse the same idempotency key;
- External actions that cannot be idempotent must be approved and escalated to manual handling;
- After crash recovery, items can be safely redelivered;
- When an external service returns an uncertain result, reconcile first; do not retry blindly;
- Dead-letter items must be inspectable, repairable, and manually replayable.

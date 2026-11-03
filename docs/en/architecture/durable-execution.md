---
title: 'Durable Execution and Recovery'
description: 'The Run lifecycle, task graph, lease, recovery strategy, routing, and MVP relationships of the Hearth Durable Harness.'
outline: [2, 3]
---

<p class="eyebrow">DURABLE HARNESS</p>

# Durable Execution and Recovery

<p class="lead">Long-running tasks must survive crashes, sleep, network interruptions, and Executor failures. The Durable Harness is responsible for turning intent into recoverable execution.</p>

## Durable Harness

The Harness is the middle layer that "turns an intent into recoverable execution":

- Receives decisions from the Control Plane;
- Builds the task graph;
- Selects Executors;
- Enforces budgets and leases;
- Handles cancellation, retries, and recovery;
- Turns results into Artifacts, Receipts, and Eval.

It is not a model, nor is it a Sandbox.

### Run Lifecycle

```text
created
  → authorized
  → queued
  → assigned
  → running
  → verifying
  → completed

Exception branches:
  → paused
  → waiting_approval
  → waiting_input
  → retry_wait
  → failed
  → cancelled
  → needs_human
```

Every state transition must:

- Produce an event;
- Have an explicit trigger;
- Have idempotency conditions;
- Be replayable from events;
- Never overwrite history in place.

### Task Graph

Supports sequential dependencies, parallel branches, joins, failure propagation, compensation tasks, human approval nodes, cross-day waits, long-task checkpoints, and subtask budget inheritance.

Phase one does not introduce a heavyweight workflow engine; it uses explicit state machines, SQLite, outbox, timers, and leases, plus clear intermediate artifacts.

### Lease and Single Writer

- Each Ticket has at most one valid Assignment at any given moment;
- An Executor or device must hold a lease to make progress;
- After a lease expires, it can be reassigned;
- Reassignment must carry a fencing token, rejecting continued writes from the old executor;
- The same State Root has only one write authority;
- Device-local state is only a cache;
- When a device is offline, tasks are queued; upon reconnection, they resume by cursor, lease, and checkpoint;
- Device loss must revoke the lease, capability, and keys.

### Recovery Strategy

| Failure | Recovery Method |
|---|---|
| Process crash | Recover from Event Log and checkpoints |
| Network interruption | Retain outbox; redeliver by idempotency key after recovery |
| Executor timeout | Save workspace snapshot; retry or switch Executor |
| Device offline | Enter device queue; do not lose tasks |
| Uncertain external result | Mark as uncertain; reconcile first, do not blindly retry |
| Memory conflict | Preserve source; do not silently overwrite |

After recovery, re-verification is mandatory; do not trust old natural-language "completion."

### Routing

```text
Ticket
  → Capability matching
  → Risk and permission check
  → Token / cost / latency estimate
  → Select Executor or Human
  → Execute
  → Validation failed?
      ├─ Retry with the same Executor
      ├─ Switch to a more suitable Executor
      ├─ Degrade to a smaller scope
      └─ Human takeover
```

Routing should not be decided by the model alone. Rules, historical success rates, cost, permissions, and device state all participate.

### Boundary Rules

1. The Control Plane does not execute tools directly.
2. The Harness does not read raw credentials directly.
3. The Executor does not decide "whether it is allowed."
4. The Execution Gateway does not decide business intent.
5. The UI cannot bypass Policy to write to the database or trigger tools.
6. All external side effects go through the outbox, idempotency keys, and Receipt.
7. All schema changes come with migrations and compatibility tests.

## Relationship to the MVP

The MVP does not need to fully implement the Gateway, Trigger, device catalog, and all recovery policies, but it must have a minimal real chain:

- Web input enters the Gateway → Event;
- The Control Plane creates a Task/Ticket;
- The Harness persists the Run and state;
- Codex executes and produces events;
- The validator decides completion;
- The Web displays task cards and recovery entry points from the projection.

Without this chain, it is not an MVP—it is just a frontend demo or a backend library.

---
title: 'Tasks and Durable Execution'
description: 'How Hearth turns intent into long-running work with recovery, evidence, budgets, and explicit completion.'
outline: false
---

# Tasks and Durable Execution

<p class="lead">Hearth does not treat a request as a temporary conversation. It turns the request into a task that can continue across restarts, sleep, and network interruptions. Users see goals and progress; the system keeps work units, execution attempts, evidence, and recovery paths.</p>

## Design Goals

A task needs a clear goal, acceptance method, deadline, budget, and cancellation path. Work can be divided into smaller work units, and each work unit has only one executor advancing it at a time. Every real attempt should retain its input, result, artifacts, failure reason, and whether work can continue.

Task state must be honest. Queued, running, waiting for approval, waiting for input, retrying, failed, paused, and completed are different states; none of them can be hidden behind "processing". Users need to know why work stopped, how long it has been stopped, what happens next, and whether they must intervene.

Durable execution must cover real failures: service restarts, computer sleep, lost connectivity, executor crashes, external timeouts, offline devices, and version upgrades. After recovery, the system rechecks the goal and current state. It does not trust an old natural-language claim that work is complete, and it does not repeat external effects without verification.

The task graph expresses dependencies, parallelism, joins, compensation, and human steps. The first phase does not attempt to become a complete workflow platform. It implements only the sequencing, parallelism, waiting, and recovery needed for real tasks, avoiding a heavy engine introduced for architectural completeness.

## Design Tradeoffs

Tasks, work units, execution attempts, and artifacts are stored separately. A task describes the result the user wants; a work unit describes a small authorized piece of work; an attempt describes one actual run; artifacts and receipts describe what was really delivered. Combining them into one object makes retries, budgets, and auditing confusing.

Facts come before in-memory state. Every state change is written to the local record before the interface and notifications are updated. The interface is only a projection and can be rebuilt after a crash. The early system uses one process, one writer, and a local database, with explicit timers, a pending-work queue, and checkpoints for recovery instead of microservices.

| Tradeoff | Hearth's choice | Cost and control |
|---|---|---|
| Workflow implementation | Explicit state machines and a simple task graph | Complex flows need manual modeling, but behavior is easier to verify and recover |
| Execution right | One effective executor per work unit | Leases and expiry recovery are needed, but two executors cannot write at once |
| Failure handling | Verify first, then retry, switch executors, or ask for help | Recovery paths are richer, but blind retries cannot create duplicate effects |
| Long-running work | Save checkpoints and intermediate artifacts | More storage and cleanup rules, but work survives sleep and restarts |
| Budget | A hard limit and cancellation path at every level | Users may need to add budget, but the system cannot silently overspend |
| Uncertain external result | Reconcile first, do not retry directly | A person or connector must verify, but duplicate sends and writes are avoided |

A late result from an old executor cannot overwrite newer state. After a work unit is reassigned, a late submission is kept only as evidence; it cannot advance the task directly. If results must be merged, the current execution path verifies them again.

Recovery is not a simple rerun. After a process crash, work continues from the checkpoint. After a network interruption, pending actions are resubmitted with the same identity. When an executor times out, its workspace is saved and the system decides whether to change execution method. An offline device enters a device queue, and an uncertain external result enters reconciliation. Every recovery path gives the user an understandable reason and a next step.

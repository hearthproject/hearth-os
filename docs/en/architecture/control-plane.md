---
title: 'Control Plane and Autonomy'
description: 'Triggers, Policies, Mandates, scheduling, Watchdog, attention budget, and proactive loops in the Hearth Control Plane.'
outline: [2, 3]
---

<p class="eyebrow">CONTROL PLANE</p>

# Control Plane and Autonomy

<p class="lead">Who decides what to do, whether it is allowed, when to interrupt, and when to pause. The Control Plane is not an executor; it is the judgment layer for tasks and authorization.</p>

## Control Plane and Autonomy

The Control Plane decides:

- whether an event is worth processing;
- whether to create a Task;
- whether user approval is required;
- which Executor to apply;
- how many Tokens, how much time, and how much money to spend;
- when to notify and when to stay silent;
- after a failure, whether to retry, switch paths, or escalate to a human.

It does not directly call tools, does not directly hold credentials, and does not directly write to external services.

### Trigger

A Trigger is a combination of rules, subscriptions, and conditions: cron, file changes, web page changes, email arrival, upcoming calendar events, GitHub Issue/PR, device online/offline, task dependency completion, explicit user subscriptions, and failure retries.

Rule hits can directly create a Ticket; only when semantic judgment is needed is a small model invoked. A Trigger is not "having a large model observe everything all the time."

### Policy and Mandate

A Policy is a long-term rule; a Mandate is an authorization instance for a single occasion or a period of time.

A Mandate contains at least:

- allowed action types;
- resource scope;
- contact/domain/repository/folder scope;
- risk level;
- budget;
- validity period;
- whether automatic execution is allowed;
- whether forwarding or delegation is allowed;
- how to revoke it.

The model can make suggestions, but it cannot modify a Mandate, Approval, or its own capability.

### Scheduling and Watchdog

The scheduler is responsible for priority, concurrency limits, device/Executor matching, budget, deadlines, dependency waiting, and fairness.

The Watchdog runs independently of the Agent and is responsible for:

- stuck detection;
- infinite loop detection;
- budget overruns;
- device disconnection;
- credential expiration;
- external platform anomalies;
- automatic degradation or escalation to a human.

The Watchdog is not another model, but a set of deterministic supervision mechanisms.

### The Correct Boundaries of Autonomy

Autonomy is not "the model does whatever it wants," but rather:

- autonomy within an explicit Mandate;
- autonomy within budget;
- autonomy within a recoverable/rollback-able scope;
- autonomy in low-risk scenarios;
- high-risk actions always retain human confirmation.

### Attention Budget

Every task has an attention budget, not just a Token budget:

- maximum number of interruptions;
- aggregation window;
- quiet hours;
- default action;
- escalation conditions;
- behavior after the user disables a channel.

Rules:

- anything that can be verified automatically does not require human confirmation;
- anything that can safely wait does not interrupt immediately;
- anything that can be approved in batch does not interrupt item by item;
- every interruption must have one clear action;
- if the same task is interrupted more than 2 times and the count cannot be reduced, fall back to "suggest only, do not execute."

### Proactive Loop

```text
Source Event
  → Trigger / Rule
  → Small classifier
  → Task / Thread
  → Policy + Mandate
  → Budget
  → Executor
  → Verification
  → Notification / Receipt
```

Active mode and suggestion mode must be independently toggleable and backed by comparative data. The real proactive loop is not enabled before Stage 4.

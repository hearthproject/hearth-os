---
title: 'Evaluation and Cost'
description: 'How Hearth uses real tasks, verifiers, baselines, and cost metrics to prove capability instead of relying on demos.'
outline: false
---

# Evaluation and Cost

<p class="lead">A demo is not capability. Hearth trusts only evidence that is repeatable, verifiable, and includes failure cases. Evaluation asks not only whether work finished, but also how much human time, interruption, recovery, external side effect, and cost it took.</p>

## Design Goals

Evaluation must cover real tasks, not only the happy path. Task sets should include normal, edge, failure, and malicious inputs, with a held-out set that is never used for tuning. Failure cases cannot be deleted because they look bad, and a new capability cannot be justified by adding one more demo.

Completion is decided by verifiers, not model self-assessment. Code is checked with tests and diffs; documents with structure and citations; email with recipients, facts, and send receipts; web work with final state and accessibility; desktop work with target state; data with structure, row counts, sampling, and reconciliation. Results that cannot be fully verified need explicit human acceptance.

Evaluation must compare alternatives. At minimum it compares fully human work, direct use of a general coding agent, current Hearth, and alternative routing or method versions. It observes success, human minutes, interruptions, latency, cost, and recovery, not just whether the output text looks better.

Cost must be tied to effective completion. The goal is not merely fewer tokens, but less resource per completed result. Tokens, money, latency, tool calls, network requests, and human interruptions are all budgets. Exhausting any level should pause, degrade service, or ask for help; it cannot silently overspend.

## Design Tradeoffs

Tests and evaluations are separate. A test is a deterministic pass/fail gate suitable for every commit. An evaluation is a statistical quality measurement that needs task sets, baselines, and repeated comparison. Both matter, but they cannot be mixed into one CI gate that only looks at an average score.

Evaluation tasks, the scenario runner, console, scoring, and review now live in the standalone [hearth-eval](https://github.com/hearthproject/hearth-eval) project. The main repository keeps only the controlled task and judge bridge so product tests and evaluation experiments do not become one source of truth. The standalone repository does not mean real experiments, pass rates, or long-term effects have been verified.

| Evaluation layer | What it observes | When to use it |
|---|---|---|
| Component tests | Parsing, connectors, policy, verifiers, and recovery logic | Every commit |
| Single-task end to end | Whether one real task finished with evidence | Every release |
| Trajectory replay | Whether work remains reliable after changing routing, models, or injected failures | Continuously |
| Non-effect trial | Real inputs without external effects | Before a capability change |
| Limited real use | Real users, real actions, controlled scope | Before advancing a phase |
| Long-running operation | Multiple devices, offline use, upgrades, memory changes, and resource stability | Phase acceptance and v1.0 |

The initial task set should cover roughly 40 to 60 real tasks across email, calendars, documents, research, code, web, desktop, and cross-application work. Real de-identified data is preferred, and synthetic data is marked. Every task must state its goal, input, acceptance method, and verifier.

Core metrics include the proportion of tasks that pass verification, human minutes per effective completion, interruptions per task, recovery rate after a crash or network loss, duplicate effects under fault injection, unauthorized high-risk actions, token and total cost per effective completion, memory recall accuracy, and regressions in old tasks caused by a method upgrade.

Verifiers prefer deterministic results. Check files and diffs instead of trusting an explanation. Query an external system instead of trusting the phrase "sent". Reconcile instead of trusting a success response. For tasks that cannot be fully automated, keep human acceptance records and sampled review.

Fault injection is part of evaluation. It covers at least process crashes, network loss, timeouts, duplicate delivery, low disk, external rate limits or expired authentication, offline devices, expired approvals, and cache invalidation. The system does not need to succeed in every case, but it must fail honestly, recover, and avoid duplicate effects.

Cost control follows a sequence: rules first, structured data first, citations first, smaller models first, caching first, and stopping first. Context contains only the evidence needed for the current task. Long material is indexed and retrieved. Repeated content can use cache, but every cache has versions and deletion rules and cannot resurrect forgotten content.

Evaluation results feed release gates rather than an appendix. The first phase must show that the smallest product can be used daily, recovered, approved, and run without duplicate effects. Each later capability expands its real tasks, safety tests, and cost observation. Averages cannot hide a task family that fails completely.

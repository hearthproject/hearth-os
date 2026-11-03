---
title: 'Evaluation System'
description: 'Hearth''s evaluation pyramid, task sets, core metrics, validators, trajectory replay, fault injection, security red teaming, and stage gates.'
outline: [2, 3]
---

<p class="eyebrow">EVALUATION</p>

# Evaluation System

<p class="lead">A demo is not capability. The evaluation system proves the system can actually do the work through task sets, metrics, baselines, verifiers, trajectory replay, fault injection, and statistical discipline.</p>

## Evaluation System

A demo is not capability. Hearth only trusts evidence that is repeatable, verifiable, and includes failure samples.

### Evaluation Pyramid

| Level | What is evaluated | Frequency |
|---|---|---|
| Unit/Tool | Parsers, connectors, policies, verifiers | Every commit |
| Task-level | Single-task end-to-end success | Every release |
| Trajectory Replay | Historical trajectory replay, route switching, and failure recovery | Continuous |
| Shadow | Real inputs, no external side effects | Continuous |
| Live Pilot | Real users, real side effects, controlled scope | Before stage advancement |
| Long-run | Multi-device residency, device switching, memory evolution | Stage acceptance |

### Task Set

Initially establish 40–60 real tasks covering eight task families: email, calendar, documents, research, code, web, desktop, and cross-application workflows.

Requirements:

- Each task has explicit inputs, acceptance criteria, and a verifier;
- Include normal, boundary, failure, and malicious inputs;
- Real desensitized data takes priority; synthetic data is marked separately;
- Maintain a holdout set that cannot be repeatedly tuned against;
- Failure samples must not be deleted;
- When adding capabilities, add corresponding tasks rather than only adding demos;
- The MVP's narrow task family must also have an independent task set and cannot rely on a single demo script.

### Core Metrics

| Metric | Definition | Initial Target |
|---|---|---|
| Verified Task Success | Proportion of tasks that pass the verifier | Stage 1 ≥ 70% |
| Human Minutes / Verified Task | Human minutes per effectively completed task | ≥ 30% decrease relative to baseline |
| Interruptions / Verified Task | Number of interruptions per task | ≤ 1.0 |
| Recovery Rate | Proportion recovered after crash/network loss/restart | ≥ 95% |
| Duplicate Side Effects | Duplicate side effects under fault injection | 0 / 200 |
| Unsafe Action Rate | Unauthorized high-risk actions | 0 |
| Token / Verified Success | Tokens per effective completion | Continuously decreasing |
| Cost / Verified Success | Comprehensive cost per effective completion | Explainable and controllable |
| Memory Precision | Recalled memories are genuinely relevant and correct | ≥ 90% |
| Skill Regression | Promoted skills cause degradation on old tasks | 0 severe regressions |

Target values are early engineering thresholds, not marketing promises, and must be updated with real data.

### Baseline Comparison

Compare at least:

1. Fully manual;
2. Direct use of Codex;
3. The current version of Hearth;
4. Alternative routes or skill versions of Hearth.

Compare success rate, human minutes, interruptions, tokens, latency, cost, and failure recovery, not just output text.

### Verifiers

- Code: tests, type checks, diff, CI;
- Documents: structure, references, formatting, user acceptance;
- Email: recipients, facts, tone, send approval, Receipt;
- Web: DOM/accessibility state, screenshots, final state;
- Desktop: accessibility tree, screenshots, target state;
- Research: sources and citations;
- Data: schema, row counts, sampling, reconciliation, reproduction scripts;
- Side effects: idempotency keys, Receipt, reconciliation.

### Trajectory Replay and Fault Injection

Historical trajectories should be replayable, support route switching, model/executor substitution, and result comparison. Fault injection must cover at least: process crashes, network interruptions, timeouts, duplicate delivery, disk full, provider rate limiting/authentication expiry, device offline, uncertain external results, approval expiry, and memory/cache invalidation.

### Security and Red Team Evaluation

The red team must attempt to make the system exceed authority, leak secrets, duplicate side effects, bypass approvals, poison memory, expand skill permissions, and exploit devices. Evaluation results must feed into release gates, not sit in an appendix.

### Statistics and Evaluation Discipline

- Define metrics and samples in advance;
- Do not use averages to mask the collapse of a task family;
- Retain failure and rejection samples;
- Evaluation sets must not be used for skill training;
- Distinguish statistical significance from product meaningfulness;
- Record models, executors, prompts, tools, and versions;
- Re-run baselines after changes to avoid "comparing only against old versions."

### Stage Release Gates

| Stage | Must Prove |
|---|---|
| Stage 0 | Clickable end-to-end prototype, 12 acceptable tasks, core protocols and threat model |
| Stage 1 | MVP usable daily in the browser; recoverable, approvable, no duplicate side effects, Codex tasks acceptable |
| Stage 2 | Real email/calendar/document/web tasks can be completed, tokens controllable |
| Stage 3 | GUI can be taken over, failures recoverable, no exceeding authority |
| Stage 4 | Proactive tasks do not cause notification fatigue, approvals and security auditable |
| Stage 5 | Memory can be corrected/forgotten, skills can be evaluated/rolled back |
| Stage 6 | Multi-device consistency, offline recovery, migration and revocation reliable |

### Evaluation Anti-Patterns

- Looking only at demos and screenshots;
- Testing only the success path;
- Counting only model output without verifying side effects;
- Using synthetic tasks instead of real tasks;
- Treating token reduction as the sole goal;
- Evaluation sets contaminated by skill training;
- Failure samples deleted;
- Using averages to mask the collapse of a task family;
- Self-assessment passing;
- No security regression tests;
- Advancing stages with "we'll add evaluation later."

## Conclusion

Security and evaluation are not cleanup work for Stage 6. Stage 0 must already have a threat model and task set, and Stage 1 must already have real task acceptance, recovery, and side-effect drills for the MVP; each subsequent executor expansion must expand the security and evaluation surface in sync.

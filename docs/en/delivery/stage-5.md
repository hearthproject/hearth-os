---
title: 'Stage 5 · Memory & Evolution'
description: 'Hearth Stage 5 development module: Memory Core, memory browser, conflict and forgetting, trajectory mining, skill candidates, evaluation, promotion, and rollback.'
outline: [2, 3]
---

<p class="eyebrow">MODULE 5 / 7</p>

# Stage 5 · Memory & Evolution

<p class="lead">Accumulate personal context and improve methods without turning memory contamination or skill drift into an unexplainable black box. Make memory correctable, then forgettable, then skills evaluable, and only then promotable.</p>

## Prerequisites

- Task provenance, permissions, and approval boundaries are stable; sensitive data is classified.
- Memory writes, retrieval, and injection cannot bypass a Mandate or expand permissions.
- Representative tasks, success/failure samples, and a repeatable evaluation set exist.

## Development Steps

1. **Deliver Memory Core.** Implement the five memory types with source, sensitivity, time, confidence, scope, and retrieval budget; add a memory browser and "why was this recalled" view.
2. **Handle conflict and forgetting.** Implement write conflicts, correction, deletion, tombstones, forgetting propagation, export, and data migration.
3. **Mine trajectories and skill candidates.** Extract reusable methods from real trajectories into candidates with versions, permissions, and evaluation sets; never expand permissions automatically.
4. **Build evaluation and promotion gates.** Run Shadow, Canary, Promote, and Rollback with controlled evaluation, security regression, and human review.
5. **Complete the first promotion case.** Take at least one skill through candidate, evaluation, trial, promotion, and rollback, and explain it to the user.
6. **Complete the Stage 5 release.** Evaluate memory accuracy, injection quality, forgetting, export, skill benefit, permissions, and security regressions.

## Increment Breakdown

| Increment | User-visible outcome | Completion evidence |
|---|---|---|
| D5.1 Memory Core and browser | Users can inspect, understand, and correct memory in use | Five memory types, provenance, budgets, recall explanation |
| D5.2 Conflict, forgetting, and export | Wrong memory is correctable, forgetting propagates, data is exportable | Tombstones, propagation, export, migration tests |
| D5.3 Trajectories, skill candidates, evaluation sets | The system proposes reusable methods from work | Trajectory mining, candidates, versions, evaluation samples |
| D5.4 Evolution gate and release | New methods have comparative evidence and rollback | Shadow, Canary, Promote, Rollback case |

## Exit Checklist

- [ ] Memory is explainable, correctable, forgettable, exportable, and forgetting propagates.
- [ ] Memory injection accuracy meets the target; sensitive data stays out of disallowed contexts.
- [ ] Skill promotion has controlled evaluation; evolution never expands permissions.
- [ ] At least one skill completes promotion and rollback.
- [ ] Users understand why a memory was recalled or a new method was adopted.

## Out of Scope

- Self-evolution without provenance, evaluation, or rollback.
- Memory poisoning that changes permissions, approval policy, or system facts.
- Replacing repeatable evaluation with "the model thinks it is useful."

## Next

Continue to [Stage 6 · Multi-device & Operations](/en/delivery/stage-6) to turn the local product into a long-running, portable Personal Agent OS.

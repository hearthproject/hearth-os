---
title: 'Skill Evolution'
description: 'Input signals, skill model, trajectory-to-skill workflow, promotion thresholds, self-modification boundaries, and anti-patterns for the Hearth Evolution OS.'
outline: [2, 3]
---

<p class="eyebrow">EVOLUTION OS</p>

# Skill Evolution

<p class="lead">The system can form candidate skills from trajectories, but it must not let the Agent bypass permissions, evaluation, and rollback to modify itself directly.</p>

## Evolution OS

Self-evolution is not about letting the Agent modify itself; rather, it is about forming candidate capabilities from trajectories and promoting them in a limited way after validation.

### Input Signals

- Successful trajectories;
- Failures and retries;
- Human corrections, rejections, and takeovers;
- Tool/model changes;
- Changes in user preferences;
- Evaluation results and costs.

### Skill Model

A skill can be a prompt template, deterministic workflow, documentation pipeline, Connector recipe, code adapter, and validation/compensation steps, but it must have a manifest:

```ts
type SkillManifest = {
  id: string;
  version: string;
  trigger: string;
  preconditions: string[];
  inputs: SchemaRef[];
  steps: SkillStep[];
  tools: string[];
  capabilities: string[];
  budgets: BudgetSpec;
  validators: ValidatorRef[];
  fallback: FallbackSpec;
  provenance: string[];
  evalSuite: string;
  status: "draft" | "shadow" | "canary" | "active" | "retired";
};
```

Skills cannot carry new permissions of their own; they can only request the intersection of the parent Task and the user Mandate.

### From Trajectory to Skill

```text
Trajectory collection
  → Duplicate/failure clustering
  → Candidate skill description
  → Generate implementation
  → Static checks and permission audit
  → Offline replay evaluation
  → Shadow (no external side effects)
  → Canary (small-scale real usage)
  → Promote / Reject / Rollback
  → Continuous monitoring
```

### Promotion Gates

- Verified Success on the real task set is no lower than the old process;
- Zero privilege escalation in security testing;
- No expansion of capability;
- Clear improvement in Token, time, or human minutes;
- Failures are recoverable, explainable, and rollback-capable;
- The evaluation set is not severely contaminated;
- The user reviews the skill description and permissions;
- No abnormal side effects in post-launch monitoring.

"The model thinks it's better" or a single demo cannot serve as promotion evidence.

### Permission and Self-Modification Boundaries

- The Agent may propose candidates for skills, parameters, prompts, validators, and processes;
- The Agent cannot modify its own Mandate, Policy, Approval rules, and Permission;
- The Agent cannot directly rewrite the core Runtime, event formats, and security boundaries;
- Core code changes must go through a human-reviewed PR;
- Skill launch must be bound to a version, evaluation set, and rollback target;
- Skills cannot create new credentials or background tasks;
- Any permission change requires explicit user authorization.

### Anti-Patterns

- Enabling directly without evaluation;
- Using a single success to represent long-term capability;
- Skills continuously expanding their privileges;
- The evaluation set being contaminated by training/selection;
- Failure samples being deleted;
- Reducing only Token without reducing human minutes;
- No rollback;
- Letting the Agent modify its own security checks.

## Relationship with Stages

- **Stage 1**: Only execution isolation, basic credential boundaries, outbox/Receipt, and drill approvals; no full Memory/Evolution.
- **Stage 2**: Memory v0 (provenance, basic forgetting) and Context Compiler.
- **Stage 5**: Full Memory OS five types of memory, forgetting propagation, skill candidates, and Evolution promotion gates.
- **Stage 6**: Multi-device memory sync, tombstone, device revocation, and migration verification.

Security, memory, and evolution cannot wait until the end to be added; they exist in minimal form from Stage 1 and are gradually completed in subsequent stages.

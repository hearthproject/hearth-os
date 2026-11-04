---
title: 'Risks and Kill Criteria'
description: "Hearth's main risks, global pause conditions, phase Kill Criteria, project-level Kill Criteria, and the things that should not be Killed."
outline: [2, 3]
---

<p class="eyebrow">RISKS</p>

# Risks and Kill Criteria

<p class="lead">When to pause, roll back, or stop a project is a harder and more important decision than “keep going.”</p>

## Risks and Kill Criteria

### Key Risks

| Risk | Early Signal | Mitigation |
|---|---|---|
| Scope creep | New Executors added at every stage while the core loop is not stable | Control scope with Task sets and stage gates |
| Insufficient reliability | Tasks lost after crashes, duplicate sends | Single writer, outbox, lease, fault injection |
| Security incident | Privilege escalation, secret leakage, successful prompt injection | Sandbox, Broker, approvals, red teaming |
| Runaway Token cost | Per-Task cost is high and human minutes are not decreasing | Context Compiler, routing, caching, hard budgets |
| External Agent dependency | Version changes cause many Task failures | Adapters, version pinning, fallback to Native/manual |
| Maintenance burden | Large amounts of time each week fixing dependencies and channels | Do not build low-level components in-house, reduce connectors, automated upgrade tests |
| Notification fatigue | Users disable notifications or ignore approvals | Attention budget, aggregation, silence, default actions |
| Memory errors | Repeatedly citing outdated or incorrect facts | Provenance, confidence, conflicts, forgetting, user correction |
| Self-evolution drift | Skills become more complex with use, permissions increase | Evaluation, shadow, canary, permission intersection, rollback |
| Multi-device complexity | Sync conflicts, duplicate execution | Single writer, lease, fencing, offline queue |
| Product feels like a wrapper | No independent value after removing Codex | Control Plane, memory, approvals, recovery, evaluation |
| Platform limits | Browser login, CAPTCHA, API changes | Manual takeover, official API first, fallback |
| Declining user trust | Users do not understand why it did this or cannot undo it | Explainable state, Artifact, Receipt, kill switch |
| Unsustainable time investment | Maintenance exceeds available time | Narrow scope, delay non-core capabilities, automated testing |

### Global Pause Conditions

When the following occur, pause new features and prioritize fixes:

- High-risk actions overstep permissions;
- Secrets or sensitive data leak;
- Fault injection produces duplicate external side effects;
- Crash recovery rate is below 95%;
- Users cannot revoke devices, connections, or skills;
- Critical memory cannot be forgotten;
- Task status is inconsistent with the source of truth;
- External side effects cannot be reconciled.

### Stage Kill Criteria

**Stage 0:**

- Cannot define 12 tasks with acceptance criteria;
- Cannot explain the difference between Hearth and a single Codex;
- No threat model;
- The prototype cannot let users complete the main path without instructions;
- Prototype state cannot map to a real projection or data contract;
- Trying to build all Executors at once in the first stage.

**Stage 1:**

- After meeting the MVP threshold, still cannot complete 10 real tasks;
- Duplicate side effects cannot be eliminated;
- Recovery depends on manual state reconstruction;
- Task status can only be inferred from chat history;
- Token cost is completely invisible;
- The backend is available, but the Web Task card cannot complete creation, viewing, approval, recovery, and Artifact retrieval;
- Demoing only via CLI or logs does not count as an established MVP.

**Stage 2:**

- The email/calendar loop requires users to frequently rebuild context;
- Connector permissions cannot be minimized;
- Document processing results cannot be verified;
- Human minutes for common tasks have not decreased;
- Data cross-talk between different accounts/projects.

**Stage 3:**

- GUI Task success rate is low and cannot be taken over;
- Cannot prove operations did not overstep permissions;
- The desktop environment cannot be recovered;
- Every GUI Task requires heavy manual intervention.

**Stage 4:**

- Proactive Tasks create notification fatigue;
- Users cannot predict when they will be interrupted;
- Mobile approvals can be replayed or overstep permissions;
- Background Tasks cannot be stopped or budgets run out of control.

**Stage 5:**

- Memory errors cause continuous rework;
- Forgetting cannot propagate to devices and indexes;
- Skill evaluation can be manipulated by cherry-picked samples;
- Skills expand permissions or cause security regressions;
- Rollback is unavailable.

**Stage 6:**

- Multi-device duplicate execution or state split;
- A lost device cannot be revoked promptly;
- After migration, facts, memory, or Artifact are inconsistent;
- Long-term operation maintenance cost exceeds product value.

### Project-Level Kill Criteria

In the following cases, consider narrowing the product rather than continuing to add features:

- After Stage 2, there are still no stable 10 real daily tasks;
- Human minutes have not substantially decreased; users are just “watching the Agent work”;
- Maintenance cost continues to exceed available time with no downward trend;
- Simply switching models can replace most of Hearth's value;
- Security boundaries cannot reach an acceptable level;
- Users are unwilling to hand over real email, files, or calendars to it;
- Self-evolution continuously produces unexplainable drift;
- Multi-device complexity swallows the single-device experience.

### What Should Not Be Killed

- Event Log and recoverability;
- Approvals, idempotency, and Receipt;
- Evaluation and failure samples;
- Memory forgetting and user correction;
- Task cards and low-interruption experience;
- Manual takeover;
- Security boundaries and kill switch.

These are the product's foundation, not features that can be deleted when “rushing progress.”

---

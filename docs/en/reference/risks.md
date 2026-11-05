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

### Phase Kill Criteria

**Phase 1:**

- Cannot define 10 real tasks with acceptance criteria;
- Cannot explain the difference between Hearth and using existing tools directly;
- No threat model or basic security boundary;
- The prototype cannot let users complete the main path without instructions;
- After meeting the MVP threshold, still cannot complete 8 real tasks;
- Duplicate external actions cannot be eliminated;
- Recovery depends on manual state reconstruction;
- Task status can only be inferred from chat history;
- The backend is available, but the browser cannot complete creation, viewing, approval, recovery, and artifact retrieval.

**Phase 2:**

- The email or calendar loop requires users to frequently rebuild background information;
- Source permissions cannot be minimized;
- Document, table, or web results cannot be verified;
- Manual time for common tasks has not decreased;
- Data cross-talk between accounts or projects;
- External writes may run twice or cannot be checked.

**Phase 3:**

- Desktop task success rate is low and cannot be taken over;
- Cannot prove operations did not overstep permissions;
- The desktop state cannot be recovered;
- Every desktop task requires heavy manual intervention;
- Failure tends to leave a half-finished high-risk state.

**Phase 4:**

- Proactive tasks create notification fatigue;
- Users cannot predict when they will be interrupted;
- Mobile approvals can be reused or overstep permissions;
- Background tasks cannot be stopped or budgets run out of control;
- High-risk actions bypass approval because they are proactive.

**Phase 5:**

- Memory errors cause continuous rework;
- Forgetting cannot propagate to summaries, indexes, and related content;
- Method evaluation can be manipulated by cherry-picked samples;
- New methods expand permissions or cause security regressions;
- The old version cannot be restored.

**Phase 6:**

- Multi-device duplicate execution or state split;
- A lost device cannot be revoked promptly;
- After migration, tasks, memory, or artifacts are inconsistent;
- Long-term operation maintenance cost exceeds product value;
- Users cannot back up, restore, or leave independently.

### Project-Level Kill Criteria

In the following cases, consider narrowing the product rather than continuing to add features:

- After Phase 2, there are still no stable 10 real daily tasks;
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

---
title: 'Risks and Stop Conditions'
description: 'Hearth core risks, global and phase stop conditions, and product foundations that must not be removed.'
outline: [2]
---

# Risks and Stop Conditions

<p class="lead">Knowing when to pause, roll back, or narrow the product is harder and more important than continuing to add features. These are signals that take priority when they appear. A phase may move more slowly, but it must not keep advancing while a risk remains unresolved.</p>

## Core Risks and Stop Conditions

| Risk | Early signal | Response |
|---|---|---|
| Scope growth | Every phase adds executors while the core loop is unstable | Control scope with real task sets and phase exits |
| Unreliable recovery | Restarts lose tasks, sends repeat, or state disagrees | Single writer, checkpoints, idempotency, fault injection |
| Safety failure | Privilege escalation, credential leak, or successful prompt injection | Isolation, short-lived credentials, approval, denial tests |
| Cost blowout | High cost per task while human time does not fall | Hard budgets, context filtering, rules first, stop first |
| External executor dependency | An upgrade breaks many tasks | Version lock, adapters, degradation, human takeover |
| Maintenance overload | Most time goes to dependencies, channels, and environments | Do not rewrite the lower layers; reduce connectors; automate upgrade tests |
| Notification fatigue | Users disable notifications or ignore approvals | Attention budget, aggregation, quiet hours, reduced frequency |
| Wrong memory | Outdated, incorrect, or out-of-scope facts keep returning | Provenance, confidence, conflict handling, forgetting, user correction |
| Method drift | Procedures grow more complex and permissions expand | Evaluation, canary, permission intersection, rollback |
| Device divergence | Duplicate execution or a deleted item returns from an old device | One authoritative state, versions, deletion markers, device revocation |
| Product looks like a wrapper | No independent value remains without Codex | Task control, approval, recovery, memory, and evaluation must be owned |
| Trust erosion | Users cannot understand what happened or undo it | Explainable state, artifacts, receipts, stop switch |

Pause new feature work and fix the problem when any of these happens:

- A high-risk action exceeds its authority;
- Credentials or sensitive data leak;
- Fault injection produces a duplicate external effect;
- Crash recovery falls below 95%;
- Users cannot revoke a device, connection, or temporary authority;
- Important memory cannot truly be forgotten;
- Interface state disagrees with the fact record;
- An external action cannot be reconciled;
- Users do not know why they were interrupted or cannot stop proactive service.

Each phase also has its own stop conditions. They are not "did the code get written", but whether the user result promised by the phase is genuinely reliable.

| Phase | Do not advance if these remain |
|---|---|
| Phase 1 · Minimum Complete MVP | Real tasks cannot be defined or completed; the browser cannot cover create, approve, recover, and retrieve; duplicate external actions cannot be removed |
| Phase 2 · Everyday Content Work | Users still repeat context; source authority cannot be narrowed; documents, tables, or web results cannot be verified; writes repeat or cannot be reconciled |
| Phase 3 · Desktop Operation | Success is low and takeover is unavailable; operation cannot prove it stayed in scope; failures leave half-finished high-risk state |
| Phase 4 · Proactive Service and Mobile Entry | Proactive reminders cause fatigue; users cannot predict interruption; phone approvals can be replayed; background work cannot stop |
| Phase 5 · Memory and Capability Evolution | Wrong memory keeps causing rework; forgetting does not propagate; evaluation can be gamed by sample selection; new methods expand authority |
| Phase 6 · Multi-device and Long-running Operation | Devices duplicate work or diverge; a lost device cannot be revoked; migration loses data; users cannot leave independently |

If Phase 2 ends without stable real everyday tasks, human time has not fallen, or maintenance keeps exceeding available time, narrow the product instead of adding features. A safety boundary below an acceptable level, refusal to trust Hearth with real data, or multi-device complexity that ruins single-device use are also signals to reduce scope.

## Foundations That Must Stay

- Rebuildable fact records and failure recovery;
- Preview, approval, idempotency, and receipts for external actions;
- Real tasks, failure samples, and independent verification;
- Memory provenance, correction, and forgetting;
- Low-interruption task cards and attention entries;
- Pause and human takeover available at all times;
- Permission boundaries, credential isolation, and a stop switch.

These are not "later" features to cut when progress feels slow. They are preconditions for the product to exist, and no phase may trade them away.

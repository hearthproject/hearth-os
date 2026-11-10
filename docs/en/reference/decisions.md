---
title: 'Key Decisions'
description: 'Product and engineering judgments that Hearth has settled and should not reverse casually.'
outline: false
---

# Key Decisions

<p class="lead">These judgments define the product boundary and implementation direction. Evidence can revise them, but daily development should not quietly bypass them. When a disagreement appears, first check whether the conclusion itself has changed, not just the wording.</p>

| Decision | Conclusion | Main impact |
|---|---|---|
| Product shape | Single-user, self-hosted, local-first personal Agent OS | No enterprise multi-tenancy; data stays in the user's environment by default |
| Core object | Tasks rather than chat history | Interfaces organize around task cards, approvals, artifacts, and recovery |
| Source of truth | Record facts first; interfaces, indexes, and notifications are projections | State survives refreshes, device changes, and crashes |
| Write model | One write authority per state root | Early system uses one process, one writer, and a local database |
| Execution | Durable work with retry, pause, checkpoints, and takeover | Long tasks survive restarts, sleep, and network loss |
| System structure | Modular monolith before microservices | Boundaries are enforced by interfaces, tests, and permissions |
| Executors | Multiple specialized executors routed by capability, risk, and cost | No single model is asked to do everything |
| Codex position | A high-capability external executor, not the product | Hearth retains tasks, authority, verification, memory, and receipts |
| External action | Preview, authorize, execute, then reconcile | Sends, writes, deletes, publishes, and payments are not blindly retried |
| Goal completion | Goal contract plus evidence-driven completion judgement | Model self-assessment, executor exit, or UI state cannot close a goal-backed task |
| Delegation and handoff | Single-layer delegation; child work and handoffs may only narrow authority | Handoff packets carry generations, and old results cannot overwrite newer state |
| Safety | Least privilege, short-lived credentials, isolation, default-deny network | Models and executors never see long-lived raw credentials |
| Personal context | Personal ontology, Context Packs, and attention budgets | Context carries provenance, sensitivity, budget, and interruption cost; conflicts stay visible |
| Memory and evolution | Correctable, forgettable memory; evaluated, canaried, reversible methods | No unbounded self-modification and no self-expanded authority |
| Acceptance | Real tasks, independent verification, human time, recovery, and cost | A demo or model self-assessment does not prove capability |
| Evaluation ownership | The evaluation stack is standalone in `hearth-eval`; the main repository keeps only the bridge | Product automated tests cannot masquerade as real experiments or pass rates |
| Connection runtime | Transport, subscription, freshness, and execution ownership are separate, with generation fencing | Offline actions enter the outbox; old connections cannot write or advance state |
| Mobile | Phone focuses on approval, review, takeover, and simple starts | It does not duplicate every desktop management feature |
| Explicit non-goals | Enterprise multi-tenancy, public agent marketplace, unapproved high-risk automation | The product remains focused and personally controllable |

**Why these choices.** The central problem is not whether a model is smart enough. It is whether long work can be authorized, verified, recovered, and explained. If task state exists only in a chat transcript, users cannot tell which step truly finished or resume after failure. Fact records, a single writer, and durable execution are therefore foundations, not later optimizations.

Multiple executors exist because work has different boundaries. General reasoning suits short understanding. Codex suits code, long documents, and complex workspaces. Connectors suit systems with official interfaces. Browsers and desktop operation cover software without interfaces. Document and data processing suit deterministic tools. Value judgments and accountability remain with people. Routing optimizes success, latency, and cost only after permission, risk, and reversibility are satisfied.

Memory and method evolution must be slow. Memory directly affects judgment, so a wrong fact causes repeated rework. Method changes can expand system capability or quietly expand authority. Both need provenance, evaluation, canary use, and rollback; one successful demo does not prove long-term value.

**Delivery judgment.** Hearth does not build the whole backend before the interface. Every phase delivers a complete path: the user sees a result, state is persisted, execution leaves evidence, failures recover, and external actions are approved and reconciled. Phase 1 delivers the smallest complete MVP, followed by the six-phase route for broader work, proactive service, memory, and multiple devices.

Hearth's moat is not a stronger model. It is knowing when not to call a model, how much context an executor should receive, who must authorize an action, how to prove completion, how to recover from failure, what to remember, what to forget, and when to stop and return attention to the user.

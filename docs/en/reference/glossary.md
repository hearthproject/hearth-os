---
title: 'Glossary'
description: 'Shared explanations of Hearth product and engineering concepts.'
outline: false
---

# Glossary

<p class="lead">A word should mean the same thing in the documentation, the interface, and the implementation. These are the concepts Hearth uses most often, explained in user-facing language first.</p>

| Term | Meaning |
|---|---|
| Hearth | A single-user, self-hosted, long-running personal Agent OS |
| Task | A unit of work the user wants completed, verified, and recoverable |
| Goal contract | A record fixed before execution that holds the goal, constraints, acceptance criteria, forbidden actions, budget, deadline, stop conditions, and review policy |
| Completion judgement | The process of checking each acceptance criterion and its evidence to return pass, fail, human review, or blocked |
| Evidence report | A task record of criterion results, evidence references, missing evidence, forbidden actions, and check time |
| Work unit | A small authorized piece of a task that can run and be verified on its own |
| Execution record | The input, result, artifacts, and failure reason from one real attempt |
| Fact record | An append-only system record from which interfaces, reports, and notifications are rebuilt |
| Checkpoint | A recoverable state saved during long-running work |
| Snapshot | A copy of a workspace or data state used for recovery or comparison |
| Executor | A controlled capability that completes a kind of work, such as general reasoning, Codex, a browser, or desktop operation |
| Connector | An official interface to an external system such as email, calendar, or cloud storage |
| Delegation | A parent task assigns a bounded child piece of work to another execution path while inheriting the parent's constraints and remaining budget |
| Handoff packet | The diagnosis, completed work, evidence, open items, remaining budget, and generation needed to continue |
| Sandbox | A policy boundary over paths, processes, network, and credentials; the current local implementation is not a strong container or VM |
| Authorization scope | The objects, time, and risk level within which an action is allowed |
| Approval | The user's confirmation of one specific external action |
| External effect | A real-world impact such as sending, writing, deleting, publishing, paying, or operating a device |
| Receipt | A verifiable result left after an external action happens |
| Reconciliation | Querying external state when a result is uncertain to determine whether an action happened |
| Personal ontology | Entities, aliases, relations, states, decisions, and commitments with provenance, confidence, sensitivity, and validity |
| Context Pack | Context assembled for an executor by scope, budget, and channel, separating must-know, relevant, recallable, and explicitly omitted material |
| Standing intent | A long-lived user rule or concern that the heartbeat turns into attention candidates instead of directly executing actions |
| Attention budget | Interruption limits such as daily caps, quiet hours, category cooldown, per-target limits, and a high-priority cap |
| Connection runtime | The device-connection layer that separates transport, subscription, data freshness, and execution ownership and uses generations to fence old sessions |
| Offline outbox | A queue of pending actions kept while a device is offline; reconnect submits by idempotency key and never blindly replays external effects |
| Artifact | A file, report, spreadsheet, link, or other deliverable produced by a task |
| Memory | Long-term or medium-term context with provenance, scope, and sensitivity |
| Method | A verified, reusable procedure or tool recipe |
| Evaluation | Judging capability with real tasks, baselines, verifiers, and cost metrics |
| Canary | Limited real use of a new method before wider adoption |
| Stop switch | An entry point for pausing tasks, devices, or all external actions during an incident |
| Verified completion | Real completion supported by artifacts, evidence, and necessary receipts |

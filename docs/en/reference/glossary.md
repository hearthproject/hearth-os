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
| Work unit | A small authorized piece of a task that can run and be verified on its own |
| Execution record | The input, result, artifacts, and failure reason from one real attempt |
| Fact record | An append-only system record from which interfaces, reports, and notifications are rebuilt |
| Checkpoint | A recoverable state saved during long-running work |
| Snapshot | A copy of a workspace or data state used for recovery or comparison |
| Executor | A controlled capability that completes a kind of work, such as general reasoning, Codex, a browser, or desktop operation |
| Connector | An official interface to an external system such as email, calendar, or cloud storage |
| Authorization scope | The objects, time, and risk level within which an action is allowed |
| Approval | The user's confirmation of one specific external action |
| External effect | A real-world impact such as sending, writing, deleting, publishing, paying, or operating a device |
| Receipt | A verifiable result left after an external action happens |
| Reconciliation | Querying external state when a result is uncertain to determine whether an action happened |
| Artifact | A file, report, spreadsheet, link, or other deliverable produced by a task |
| Memory | Long-term or medium-term context with provenance, scope, and sensitivity |
| Method | A verified, reusable procedure or tool recipe |
| Evaluation | Judging capability with real tasks, baselines, verifiers, and cost metrics |
| Canary | Limited real use of a new method before wider adoption |
| Stop switch | An entry point for pausing tasks, devices, or all external actions during an incident |
| Verified completion | Real completion supported by artifacts, evidence, and necessary receipts |

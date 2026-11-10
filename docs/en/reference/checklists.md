---
title: 'Default Checklists'
description: 'Hearth pre-approval checks, pre-completion checks, and task coverage boundaries.'
outline: [2]
---

# Default Checklists

<p class="lead">Checklists belong in task templates, approval screens, and acceptance flows, not only in documentation. They help the user confirm that the system has not mistaken "looks finished" for "really finished".</p>

## Before Approval and Completion

Before an external action happens, confirm:

- [ ] The action type matches the real intent;
- [ ] The goal's acceptance criteria, constraints, and forbidden actions were checked;
- [ ] The recipient, file, account, device, or resource is correct;
- [ ] The content and attachments are correct;
- [ ] The action does not exceed the current authorization scope;
- [ ] Reversibility and likely impact are explained;
- [ ] Approval is still valid and has not been replayed;
- [ ] Approval binds the resolved real action and parameter fingerprint; changed parameters invalidate it;
- [ ] Failure, retry, and reconciliation paths are ready;
- [ ] No network, credential, or safety boundary is bypassed.

Reading and organizing may be authorized within the task scope. Sending, publishing, deleting, paying, and operating devices need explicit confirmation. Irreversible actions stay bounded by target, amount, or time even when pre-authorized.

Before a task is marked complete, confirm:

- [ ] The target artifact exists and the user can find it;
- [ ] Every goal acceptance criterion has a verdict and evidence reference;
- [ ] A verifier passed; the executor saying so is not enough;
- [ ] Key facts have sources, and changes have diffs or versions;
- [ ] No unauthorized external effect occurred;
- [ ] External actions have receipts, and uncertain results were reconciled;
- [ ] Uncertain effects entered an explicit reconciliation queue and have a user decision;
- [ ] Failures, skipped work, and open items are explained;
- [ ] Tokens, time, human minutes, and cost are recorded;
- [ ] Workspaces, temporary authority, and execution rights are released;
- [ ] Handoffs carry a generation and evidence, and old-generation results did not advance new state;
- [ ] Sandbox path, network, process, and credential boundaries were not bypassed, and escape attempts failed closed;
- [ ] The user can inspect, undo, retry, or continue.

## Coverage Boundaries

Hearth does not promise "every application, every scenario, 100% unattended". It promises end-to-end coverage for selected personal digital work, safe handoff when work cannot be completed reliably, and evidence, permission records, and receipts for every completion.

| Maturity | Meaning |
|---|---|
| Can attempt | The system can enter the task family and produce a draft |
| Can complete | Representative tasks pass verification |
| Can rely on | Repeated real use is stable and failures are recoverable |
| Can act proactively | Work starts without human triggering inside the authorized scope |
| Can run unattended | It runs for a long time with controlled risk |

"Can attempt" is not "can rely on", and "can complete" is not "can run unattended". Phase acceptance follows real tasks and evidence, not feature names.

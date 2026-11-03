---
title: 'Default Approval and Completion Checklist'
description: 'The final definition of the Hearth default approval checklist, default completion checklist, and task overrides.'
outline: [2, 3]
---

<p class="eyebrow">CHECKLISTS</p>

# Default Approval and Completion Checklists

<p class="lead">Put these checklists into Task templates, approval interfaces, and acceptance workflows, rather than leaving them in documentation.</p>

## Default Approval Checklist

Before any high-risk action, confirm each item:

- [ ] The action type is correct;
- [ ] The target recipient/file/repository/calendar/resource is correct;
- [ ] The account used is correct;
- [ ] The content and attachments are correct;
- [ ] The scope does not exceed the Mandate;
- [ ] Whether it is reversible has been stated;
- [ ] The failure and reconciliation approach has been stated;
- [ ] The approval has a nonce and expiry time;
- [ ] A Receipt and rollback/compensation are prepared;
- [ ] No security controls are bypassed.

## Default Completion Checklist

Before marking a Task complete, confirm each item:

- [ ] The target Artifact exists and is locatable;
- [ ] The validator passes;
- [ ] Key assertions have sources;
- [ ] Changes have a diff or version;
- [ ] There are no unauthorized side effects;
- [ ] External actions have a Receipt;
- [ ] Failures and incomplete items have been stated;
- [ ] Token, time, and cost are recorded;
- [ ] The workspace, credentials, and lease have been reclaimed;
- [ ] The user can view, revoke, or continue.

## Final Definition of Task Coverage

Hearth's goal is not to promise "any software, any scenario, 100% unattended." Its goals are:

- To provide end-to-end coverage for eight categories of digital content work;
- To gradually improve reliability and autonomy for each Task category;
- To safely stop and hand to a human for Tasks that cannot be completed reliably;
- To let users avoid understanding the internal architecture or repeatedly providing context;
- To ensure every completion has evidence, permissions, and a Receipt.

Coverage maturity should be expressed in layers:

| Level | Meaning |
|---|---|
| Attemptable | The system can enter the Task family and produce a draft |
| Completable | It passes verification on representative Tasks |
| Reliable | It is stable across repeated real-world use, and failures are recoverable |
| Proactive | It requires no manual trigger within a Mandate |
| Unattended | It runs for extended periods with controllable risk |

Do not pass off "Attemptable" as "Unattended".

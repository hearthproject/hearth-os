---
title: 'Approvals, Takeover, and External Effects'
description: 'How Hearth makes sends, writes, deletes, publishes, and other real-world actions previewable, authorized, reconcilable, and recoverable.'
outline: false
---

# Approvals, Takeover, and External Effects

<p class="lead">The real risk is not that Hearth writes text. It is that Hearth sends email, changes files, submits forms, deletes content, pays, or publishes on the user's behalf. External actions need a clear preview, authorization, execution, and receipt; a model saying "finished" is not evidence that the result happened.</p>

## Design Goals

Before an action happens, the user must see exactly what it will do: the target system, target object, key parameters, likely impact, reversibility, and required authority. Approval applies to that specific action, not a vague "let the assistant use my mailbox". Parameters changing, scope expanding, or approval expiring requires confirmation again.

Every external action needs a verifiable result. Before execution the system records the pending intent; afterward it stores a receipt with time, target, result, and reversal method. If the network breaks or a service returns an uncertain result, Hearth reconciles before resending. A confirmed failure enters a queue that can be reviewed, repaired, and replayed.

Human takeover is part of the design, not a last resort. A user can pause a running task, keep current progress and completed actions, operate directly, and return the result for verification. Key actions and judgments during takeover are recorded so later improvements have evidence.

Approval is graded by risk and reversibility. Reading and organizing usually need limited authority. Sending, publishing, deleting, paying, and operating devices need stronger confirmation. Irreversible or high-value actions stay bounded by amount, target, or time even when pre-authorized.

## Design Tradeoffs

External actions follow a sequence: preview, authorize, execute, then reconcile. The system and its executors cannot bypass this path to call an external service directly. Connectors and desktop executors only complete actions inside their authorization; they do not decide whether the action should happen.

| Action type | Default policy | Exception |
|---|---|---|
| Read, search, organize | Authorize within the task scope | Narrow scope and warn when sensitive data is involved |
| Create drafts or files | Execute directly, retaining artifacts and versions | Preview differences before overwriting an original |
| Send messages or submit forms | Confirm target, content, and scope each time | Low-risk repetitions may be pre-authorized inside a clear scope |
| Delete, publish, pay, or operate a device | Human confirmation by default | Never unconditional automatic execution |
| Actions that cannot be made reversible | Human takeover or explicit risk acceptance | Do not bypass through "trying a few more times" |

The authorization scope must be understandable to an ordinary user. An approval card explains "who, what, when, and how far" in natural language while preserving expandable technical details for verification. After a rejection, the system cannot rephrase and ask for the same action again.

Idempotency and reconciliation are the foundation of external actions. One send creates one message; one submission creates one record; retries reuse the same identity. When an external system returns no clear result, Hearth enters an uncertain state and queries or asks the user instead of executing again.

Human error is also input. A user may approve the wrong content, undo a correct action, or give conflicting instructions. The system keeps context and supports correction, compensation, and re-approval. The goal is a clear responsibility boundary, not pretending the system never makes mistakes.

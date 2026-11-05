---
title: 'Frontend and Mobile Experience'
description: "Hearth's frontend design principles, information architecture, Task cards, approvals, Artifact Center, mobile, accessibility, and experience metrics."
outline: [2, 3]
---

<p class="eyebrow">FRONTEND & MOBILE</p>

# Frontend and Mobile Experience

<p class="lead">Users only need to know three things: what the Agent is doing, whether they are needed, and where to click next. The frontend is not an after-the-fact wrapper layer.</p>

## Frontend and Mobile Experience

Hearth's frontend is not a console that displays the Agent's internal architecture; it is a quiet attention interface.

### Design Principles

1. **Task-first**: Users see the work to be completed, not models, tools, or threads;
2. **One state, one primary action**: At any moment, a Task card has only one action most worth clicking;
3. **Progressive disclosure**: By default, show only the goal, status, evidence, and next step;
4. **Quiet by default**: Do not interrupt when nothing requires a person;
5. **Honest status**: Do not disguise running as almost complete, and do not display a model's claim of completion as actually completed;
6. **Mobile parity**: Mobile devices can handle viewing, approval, takeover, initiation, and notifications;
7. **No internal jargon**: Worker, Harness, Token, and Mandate do not appear in the main interface;
8. **Interface first**: For each increment, first clarify what users see, what they can click, and how to recover after failure, then connect the backend implementation.

The frontend is not a presentation layer added after the backend is complete, but part of the product's vertical slice. Phase 1 validates the information architecture with a prototype and connects real pages to real states in the MVP; after that, every phase projects newly added capabilities into an actionable interface. A feature is considered ready for phase acceptance only when it has a complete user path, evidence, and recovery entry points in the browser.

### Information Architecture

The main navigation keeps four items:

```text
Today  |  Needs You  |  Artifacts  |  Settings
```

- **Today**: what is in progress, just completed, and what comes next;
- **Needs You**: approvals, missing information, failure takeover, and exceptions;
- **Artifacts**: reports, documents, code, spreadsheets, screenshots, receipts;
- **Settings**: connections, memory, permissions, devices, notifications, and budgets.

"New Task" is a global action and does not occupy a navigation item. Use `⌘K` / `Ctrl+K` on desktop and a clearly visible floating button on mobile.

### Home

The first screen answers: what is happening today, what needs me, what is in progress, and what was recently completed. By default, do not show tokens, model names, executor names, internal steps, or debug logs; view them in the details when needed.

### Task Card

A task card should answer:

- What is this task?
- What step is it at now?
- Is there an artifact or verification evidence?
- Does it need me?
- What can I do next?

Fields include title, status, key stage progress, artifacts, verification, risks, primary action, and time. Each status has only one primary action.

### Status and Primary Action

| Status | What the user sees | Primary action |
|---|---|---|
| Queued | Waiting for a device or time | Adjust priority |
| Running | Current stage | View progress |
| Waiting for approval | What is about to happen | Approve |
| Waiting for information | What is missing | Provide information |
| Failed | Cause and remediation | Recover/retry/hand off to a human |
| Completed | Artifacts and verification | View artifacts |

### Needs You

"Needs You" collects only items that genuinely block a person: approvals, missing information, failure takeover, and high-risk confirmation. Pure status changes and failures that can be retried automatically do not enter.

### Approval Interface

An approval card must let the user decide within ten seconds: action, account, recipient/resource, attachments and content, reversibility, validity period, and failure compensation. High-risk actions show the real scope, diff, secondary confirmation, and how to undo.

### Artifact Center

Artifacts are inspectable deliverables, not an attachment list:

- Version, source task, and executor;
- Generation time, hash, and size;
- Verification results and evidence;
- Preview, download, copy link;
- Diff against the previous version;
- Related approvals and receipts;
- Delete, archive, and export.

### Details and Timeline

The details page shows goals, constraints, plan, key tool calls, artifacts and verification, approvals and receipts, errors/retries/rerouting, budget and cost, related memory, and skills. By default, do not show the model's internal thought process; show auditable events, evidence, and decision reasons.

### New Task

Supports natural language, files and images, project/contact/deadline, autonomy level, and acceptance criteria preview. When the user only writes "help me organize this," the system should generate an editable task card rather than immediately executing without boundaries.

### Takeover Interface

Show the current browser/desktop and clearly state what the user needs to do; pause automatic input; allow operations, annotations, and additional information; record the state before and after takeover; support handing back, narrowing scope, and termination.

### Notifications

Use only for high-signal events: approval needed, additional information needed, unrecoverable failure, completion the user explicitly cares about, device offline blocking, and security anomalies.

Rules: aggregate by task, quiet hours, summary before details, redact push content, tap to go directly to the action, do not bypass after a channel is disabled, and evaluate notification frequency together with task value.

### Mobile

Mobile prioritizes a web entry; Phase 4 handles only five things:

1. View tasks and artifacts;
2. Approve high-risk actions;
3. Take over abnormal tasks;
4. Start new tasks;
5. Receive high-signal notifications.

Mobile should not: run a full Agent by default, hold long-term primary credentials, directly expose local ports, execute high-risk tasks unbounded in the background, or leak sensitive information in push body text.

Security design: secure tunnel or push relay, short-lived codes and public-key pairing, session expiration and biometrics, approvals bound to nonce/parameters/expiration time, revocable on device loss, and offline read-only cache with no side effects.

### Accessibility and Performance

Complete main flows with a keyboard; do not rely on color alone; screen readers and accessibility labels; reduced motion and dark mode; fast first-screen loading and long-list virtualization; show cache and clear status on weak networks; do not truncate key actions in Chinese or English; keep the primary action within reach for one-handed use.

### Experience Metrics

- Time for the user to understand the current status;
- Time from "Needs You" to completing an approval;
- Approval misclick rate and undo rate;
- Number of interruptions per task;
- Success rate of completing key actions on mobile;
- Processing rate after a notification is opened;
- Number of times artifacts or recovery entry points cannot be found.

## Relationship to MVP

The MVP must let users complete creation, viewing, approval drills, cancellation, retry, recovery, and artifact retrieval through the browser. Phase 1 starts with a clickable prototype, then connects real task status, and finally reaches the full MVP.

An "MVP" without a real Web path does not hold; an interface without failure states and recovery entry points is not complete either.

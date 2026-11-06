---
title: 'Agent Reference Patterns: OpenClaw, Hermes, DeerFlow, and LoopX'
description: 'Patterns Hearth adopts or rejects for proactive service, desktop operation, memory, method evolution, multi-device use, and long-running operation.'
outline: [2, 3]
---

# Agent Reference Patterns: OpenClaw, Hermes, DeerFlow, and LoopX

Across Phases 3–6, Hearth does not invent device control, proactive service, memory, method evaluation, or long-running operation from scratch. We studied working open agents and adopted only the parts that reduce accidental input, unauthorized expansion, wrong memory, and irreversible change. These notes reflect a review of public OpenClaw, Hermes, DeerFlow, and LoopX implementation or design documentation on 2026-11-06.

This page records design references, not integration claims. Hearth does not import these projects' runtimes, codebases, or protocol implementations. DeerFlow and LoopX influence task decomposition, evaluation layering, and delivery method only.

## Shared conclusions

OpenClaw and Hermes separate connection, capability grants, action execution, and human takeover. A connected device is not an authorized device. A one-time approval is not a permanent grant. The model may reference the current observation only; it cannot hold long-lived credentials or silently fall back outside the approved capability and window scope. Phases 4–6 apply the same rule: a suggestion is not an execution, a candidate is not an adopted capability, and a backup file is not proof of a complete migration.

## OpenClaw patterns worth adopting

- **Pairing is separate from capability approval.** Pairing only establishes the connection. Declared commands or capabilities require another approval. Execution must satisfy declared, approved, and gateway-policy checks together.
- **Deny rules win.** Extending capabilities requires a new approval, and revoking a device immediately invalidates its grants.
- **Short-lived pairing, durable capability records.** Pairing requests expire quickly. No capability is available before approval.
- **Observation is distinct from action.** Screen snapshots carry a frame ID, dimensions, and execution ID. Coordinate references expire. Desktop actions use `computer.act`; observation uses `screen.snapshot`.
- **Takeover precedes resumption.** Human takeover pauses agent input and cancels pending input. The agent must explicitly take control again and observe anew before resuming.
- **Fail closed.** If observation fails, the control provider changes, or a request is out of scope, return a structured refusal rather than silently choosing another path.
- **Proactive suggestions are separate from execution.** Proactive mode first produces an explainable suggestion. Accepting it or converting it to a task still follows the normal task and approval chain; being “proactive” grants no extra authority.

## Hermes patterns worth adopting

- **Explicit permission modes.** `standard`, `bounded`, and `unrestricted` are fixed at startup. `bounded` requires one approval of a capability manifest and fails closed on out-of-scope actions.
- **Native Windows input.** UIAutomation plus `SendInput`/`PostMessage` drive actions while avoiding unnecessary foreground-focus changes.
- **Short-lived references.** Element references belong to the current screenshot or observation generation and fail clearly when stale.
- **Independent health checks.** A `doctor` path exposes missing drivers, insufficient permissions, and Session 0 problems before a task half-executes.
- **Credentials remain in the main process.** Device connection credentials are not exposed to the renderer or ordinary plugins.
- **Cancellation and no silent downgrade.** Cancellation is explicit, and the capability manifest cannot change silently during a run.
- **Diagnosable runtime state.** Health checks should run independently of tasks and expose the runtime environment, permissions, and latest maintenance state early. Hearth extends this into health snapshots, maintenance records, and redacted diagnostics exports.

## DeerFlow patterns worth adopting

- **Task decomposition and staged evidence.** Break a complex task into inspectable stages, then let later steps reference prior evidence instead of handing the entire goal to one opaque execution.
- **Separate research, generation, and evaluation.** Candidate production and candidate evaluation can be separate, so one run does not both change a method and grade its own change.

Hearth borrows only this decomposition, evidence, and layered-evaluation structure for method-candidate generation and baseline/trial comparison. It does not integrate DeerFlow or add a multi-agent collaboration runtime.

## LoopX patterns worth adopting

- **Small closed-loop delivery.** Converge one verifiable capability change at a time instead of packaging several unverified features into one “big completion”.
- **State and evidence together.** A delivery note records verified paths, explicit gaps, and claims that are not allowed. A page or passing test does not replace real acceptance.
- **Acceptance by boundary.** High-risk capabilities such as devices, backup, and long-running operation require their own failure-path drills, not only a happy-path demonstration.

Hearth uses LoopX only as a delivery-method reference. It is not a runtime dependency, and its workflow mechanics are not embedded in the Hearth scheduler.

## Hearth adoption boundary

| Decision | Hearth behavior |
|---|---|
| Device identity | A same-machine Windows helper creates a short-lived pairing request over `127.0.0.1`. The user enters its pairing code in Hearth. The device token remains in the helper and server only. |
| Capability approval | Successful pairing grants nothing. Observation, desktop control, and UI automation are approved separately and bound to an application/window allowlist. Revocation is immediate. |
| Observation reference | Every observation returns a snapshot with frame ID, dimensions, and timestamp. Actions carry the frame ID; the server rechecks device presence, capability, controller, and observation generation before dispatch. |
| Human takeover | Pause, resume, takeover, release, and stop are first-class states. Takeover stops dispatch and asks the helper to cancel pending input. Release requires a new observation. |
| Action granularity | Only discrete low-risk actions inside allowlisted applications, such as click, short text entry, and key presses. Every action returns before/after observation evidence and a structured receipt. |
| Data retention | Screenshots stay in the local device data directory with short expiry. The server records audit events, not the full screen, in the event log. |
| Failure handling | Missing drivers, insufficient permissions, lost windows, scope mismatch, or unverifiable results stop the flow and return control to the user. High-risk actions are not retried, and success is never fabricated. |
| Proactive service | Produce only suggestions with source, why-now, suggested action, impact, and risk. Accept records a decision; convert creates a queued task; external actions still require approval. Daily limits, quiet hours, cooldown, and pause constrain interruption. |
| Memory | Memory starts as a candidate and needs user confirmation. Recall records reasons and budgets; injected context is marked untrusted background. Sensitive memory is not recalled by default, `secret` is never recalled, and forgetting redacts projections, versions, events, and recall audits. |
| Method evolution | A candidate can only inherit the intersection of source-task capabilities. Trials read existing terminal traces and create no external side effects. Only repeatable improvement evidence permits promotion, with rejection, rollback, and reasons retained. |
| Multi-device execution | Task leases use owner, TTL, and epoch. Expired takeover advances the epoch and rejects the old executor's commits. Sync copies only filtered event projections, not approvals, sources, outbox, device, or desktop-control events. |
| Revocation and migration | Device capabilities, device tokens, and sync peers can be revoked or rotated. The global kill switch blocks approvals and scheduler restart. Old-device invalidation needs a real drill, and database restore is described separately from artifact migration. |
| Backup and restore | Use a passphrase-encrypted database archive. Validate format, schema, integrity, and columns against a temporary database before transactional replacement, roll back on failure, and explicitly exclude artifact bodies, workspaces, attachments, and screenshots. |
| Long-running operation | Health, maintenance, and diagnostics are first-class. Maintenance cleans expired operational state without deleting tasks, memories, or artifacts. A failed maintenance run degrades health and never relaxes approval as “automatic repair”. |

## Out of scope for this phase

- Public remote device access, shared multi-user devices, or cross-device screen streaming.
- Global keyboard and mouse control outside the approved window allowlist.
- Password managers, system security settings, payments, and irreversible file operations.
- Sending screenshots automatically to chat channels or exposing device tokens to the renderer.
- Pretending a real Windows helper was verified. Anything not testable in the current environment remains disabled and is listed in delivery status.
- Turning proactive suggestions into an auto-executor or skipping approval because the system originated the suggestion.
- Treating candidate memory as fact or a candidate method as an adopted capability.
- Claiming a live shadow executor, phone PWA/push/remote takeover, or a complete migratable backup.
- Describing DeerFlow or LoopX as integrated components. They provide design and delivery-method references only.

## Impact by phase

- **Phase 2:** Drafts and approvals are separate, approvals are short-lived and single-use, approved effects write only to the local outbox rather than pretending to send mail, duplicate confirmations do not duplicate writes, and failures distinguish “not written” from “outcome uncertain”.
- **Phase 3:** Device pairing, capability approval, observation frames, human takeover, and control epochs are modeled separately. Actions that cannot be observed or verified are refused rather than silently downgraded.
- **Phase 4:** Proactive suggestions provide decision material only. Accept, ignore, snooze, and convert are first-class actions. Attention budgets, quiet hours, and pause take precedence over “more reminders”.
- **Phase 5:** Memory and methods start as candidates; recall and method use retain source and reason. Forgetting, rejection, and rollback are verifiable first-class paths.
- **Phase 6:** Sync, leases, revocation, backup restore, health, and maintenance default to fail-closed or rollback. A happy path does not replace lost-device, offline, or multi-week drills.

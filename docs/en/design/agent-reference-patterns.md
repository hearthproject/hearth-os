---
title: 'Agent Reference Patterns: OpenClaw and Hermes'
description: 'Device pairing, desktop observation, human takeover, and low-risk action patterns Hearth adopts or rejects.'
outline: [2, 3]
---

# Agent Reference Patterns: OpenClaw and Hermes

For Phase 3, Hearth does not invent a desktop-control protocol from scratch. We studied working open personal agents and adopted only the parts that reduce accidental input and make takeover recoverable. These notes reflect a review of the public OpenClaw and Hermes implementation documentation on 2026-11-06.

## Shared conclusions

Both systems separate connection, capability grants, action execution, and human takeover. A connected device is not an authorized device. A one-time approval is not a permanent grant. The model may reference the current observation only; it cannot hold long-lived credentials or silently fall back outside the approved capability and window scope.

## OpenClaw patterns worth adopting

- **Pairing is separate from capability approval.** Pairing only establishes the connection. Declared commands or capabilities require another approval. Execution must satisfy declared, approved, and gateway-policy checks together.
- **Deny rules win.** Extending capabilities requires a new approval, and revoking a device immediately invalidates its grants.
- **Short-lived pairing, durable capability records.** Pairing requests expire quickly. No capability is available before approval.
- **Observation is distinct from action.** Screen snapshots carry a frame ID, dimensions, and execution ID. Coordinate references expire. Desktop actions use `computer.act`; observation uses `screen.snapshot`.
- **Takeover precedes resumption.** Human takeover pauses agent input and cancels pending input. The agent must explicitly take control again and observe anew before resuming.
- **Fail closed.** If observation fails, the control provider changes, or a request is out of scope, return a structured refusal rather than silently choosing another path.

## Hermes patterns worth adopting

- **Explicit permission modes.** `standard`, `bounded`, and `unrestricted` are fixed at startup. `bounded` requires one approval of a capability manifest and fails closed on out-of-scope actions.
- **Native Windows input.** UIAutomation plus `SendInput`/`PostMessage` drive actions while avoiding unnecessary foreground-focus changes.
- **Short-lived references.** Element references belong to the current screenshot or observation generation and fail clearly when stale.
- **Independent health checks.** A `doctor` path exposes missing drivers, insufficient permissions, and Session 0 problems before a task half-executes.
- **Credentials remain in the main process.** Device connection credentials are not exposed to the renderer or ordinary plugins.
- **Cancellation and no silent downgrade.** Cancellation is explicit, and the capability manifest cannot change silently during a run.

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

## Out of scope for this phase

- Public remote device access, shared multi-user devices, or cross-device screen streaming.
- Global keyboard and mouse control outside the approved window allowlist.
- Password managers, system security settings, payments, and irreversible file operations.
- Sending screenshots automatically to chat channels or exposing device tokens to the renderer.
- Pretending a real Windows helper was verified. Anything not testable in the current environment remains disabled and is listed in delivery status.

## Impact on Phase 2

The same rules apply to the local outbox: drafts and approvals are separate, approvals are short-lived and single-use, approval writes only to the local outbox rather than pretending to send mail, duplicate confirmations do not duplicate writes, and failures distinguish “not written” from “outcome uncertain”.

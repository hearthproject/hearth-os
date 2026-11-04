---
title: 'Stage 3 · Computer Operator'
description: 'Hearth Stage 3 development module: device agentd, GUI observation, human takeover, low-risk desktop actions, high-risk approvals, and desktop security boundaries.'
outline: [2, 3]
---

<p class="eyebrow">MODULE 3 / 7</p>

# Stage 3 · Computer Operator

<p class="lead">Cover desktop software without APIs and cross-application workflows. Observe first, add takeover second, allow low-risk actions third, and only then open high-risk actions. Automation is blocked when outcomes cannot be verified or controlled.</p>

## Prerequisites

- Recovery, approval, idempotency, receipts, and browser isolation from Stages 1–2 are stable.
- Device capabilities, window scopes, application allowlists, and irreversible-action lists are defined.
- Takeover and revocation paths exist before automation.

## Development Steps

1. **Register desktop devices.** Implement pairing, `agentd` registration, capability catalog, health checks, permission declarations, device details, disconnect, and revocation.
2. **Build observation and takeover.** Connect the accessibility tree, screenshots, window scopes, live takeover, mouse/keyboard pause and handback, screenshot redaction, and audit events.
3. **Complete low-risk GUI actions.** Within allowlisted applications, open files, navigate menus, fill drafts, and export results, then verify with screenshots or the accessibility tree.
4. **Handle partial completion and failure.** Detect partial success, lost windows, input contention, permission changes, and unrecoverable states; offer pause, takeover, or rollback.
5. **Open high-risk actions.** Add isolated virtual desktops, impact preview, explicit confirmation, irreversible-action lists, snapshots, compensation scripts, and recovery drills.
6. **Complete the Stage 3 release.** Evaluate at least 5 real desktop tasks for completion, takeover experience, security boundaries, Tokens, and manual minutes.

## Increment Breakdown

| Increment | User-visible outcome | Completion evidence |
|---|---|---|
| D3.1 Device agentd and visibility | Users see trusted devices, capabilities, and online state | Pairing, capability catalog, health check, revocation |
| D3.2 GUI observation and takeover | Users can view, pause, operate, and hand back | Takeover UI, window scope, state record, screenshot redaction |
| D3.3 Low-risk GUI actions and verification | Allowlisted low-risk actions show evidence | App allowlist, action preview, result verification, retry |
| D3.4 High-risk GUI and Stage 3 release | High-risk actions show impact, confirmation, and compensation | Isolated desktop, approval, snapshot, recovery, 5 real tasks |

## Exit Checklist

- [ ] At least 5 real desktop tasks can be completed and verified.
- [ ] Users can pause, operate, hand back, or terminate a takeover.
- [ ] GUI failures do not leave half-completed high-risk states.
- [ ] Password vaults are not read and security settings are not changed beyond scope.
- [ ] Tokens and manual minutes are acceptable; users understand undo or compensation.

## Out of Scope

- Automating desktop actions without verification or takeover.
- Unbounded system-level control.
- Treating OCR or screenshot recognition as the sole source of truth.

## Next

Continue to [Stage 4 · Proactive Personal Agent](/en/delivery/stage-4) and add bounded proactivity on top of recovery and approval.

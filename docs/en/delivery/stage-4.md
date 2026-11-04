---
title: 'Stage 4 · Proactive Personal Agent'
description: 'Hearth Stage 4 development module: triggers, proactive inbox, mobile PWA, device pairing, push redaction, revocation, attention budgets, and shadow trials.'
outline: [2, 3]
---

<p class="eyebrow">MODULE 4 / 7</p>

# Stage 4 · Proactive Personal Agent

<p class="lead">Let Hearth work proactively within limited authorization while staying quiet. The hard question is not whether it can run automatically, but whether it acts at the right time with the right level of interruption.</p>

## Prerequisites

- Recovery, approval, verification, takeover, and revocation from Stages 1–3 are stable.
- Users have explicit attention budgets, quiet hours, and high-risk action boundaries.
- Proactive mode is controllable, pausable, downgradable, and evaluated against a baseline.

## Development Steps

1. **Connect triggers.** Generate events from email, calendar, files, and task dependencies with deduplication, cooldowns, priority, and a "why now" explanation.
2. **Build the proactive inbox.** Show proactive candidates, suggested actions, budgets, impact, and interruption level; support accept, ignore, pause, and convert to a normal task.
3. **Deliver the mobile PWA.** Support Today, Needs You, artifacts, approvals, takeover, task creation, and high-signal notifications.
4. **Complete secure pairing and revocation.** Use short-lived QR pairing, public keys, nonces, parameter binding, expiry, and a secure tunnel or push relay; a lost phone must be revocable immediately.
5. **Enforce attention budgets.** Limit interruptions, quiet hours, aggregated notifications, background budgets, and runaway loops; start in shadow or control mode.
6. **Complete the Stage 4 release.** Evaluate proactive success, interruptions per task, satisfaction, budget overruns, and security regressions.

## Increment Breakdown

| Increment | User-visible outcome | Completion evidence |
|---|---|---|
| [D4.1](/en/delivery/stage-4/d4-1) Triggers and proactive inbox | Hearth can explain what can be done now | Event dedupe, candidate generation, A1/A2 boundaries, pause and ignore |
| [D4.2](/en/delivery/stage-4/d4-2) Mobile PWA | View, approve, take over, and create from a phone | Responsive PWA, key actions, offline read-only, push redaction |
| [D4.3](/en/delivery/stage-4/d4-3) Secure pairing, push, and revocation | Pairing is simple and a lost phone can be revoked | Public-key pairing, nonce, expiry, revocation, audit |
| [D4.4](/en/delivery/stage-4/d4-4) Attention budgets and proactive trial | Proactive work is quiet and useful | Interruption metrics, quiet hours, shadow mode, kill switch |
| [D4.5](/en/delivery/stage-4/d4-5) Stage 4 release | Proactive tasks are useful and key mobile actions work | Satisfaction, success, budget, and security evaluation |

## Exit Checklist

- [ ] Proactive tasks are genuinely useful and do not create notification fatigue.
- [ ] Average interruptions per task are at most one.
- [ ] High-risk actions still require approval; mobile approvals cannot be replayed.
- [ ] A lost device can be revoked and then cannot approve or take over.
- [ ] Users can pause, revoke, and downgrade proactive mode; no runaway loops or budget overruns exist.

## Out of Scope

- Proactive loops without budgets, quiet periods, and revocation.
- Long-lived primary credentials on mobile.
- Notification bodies that leak sensitive information.

## Next

Continue to [Stage 5 · Memory & Evolution](/en/delivery/stage-5) to accumulate personal context and improve methods safely.

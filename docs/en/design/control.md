---
title: 'Control and Authority'
description: 'How Hearth decides when to observe, suggest, execute, or stop, and keeps autonomy inside explicit authorization.'
outline: false
---

# Control and Authority

<p class="lead">The control layer decides whether a request should be handled, how strongly it should be handled, and how far the system may go without someone watching. It does not run tools or expand the user's authority; it judges intent, rules, risk, and attention together.</p>

## Design Goals

The system should find work worth doing in messages, email, calendars, file changes, web pages, and scheduled events without turning every input into a task. Low-value or duplicate information can be observed and recorded. A clear goal can be suggested or turned into a task. High-risk actions must wait for the user's authorization.

Authorization must be specific, visible, and revocable. The user approves a class of action within a scope, time window, and risk level, not a vague grant of all capability to a model. When authorization expires, a task ends, a device is revoked, or risk changes, the permission must be withdrawn or confirmed again.

Proactive service must control interruption. The system can remind, prepare drafts, or complete low-risk work in advance, but it cannot keep pushing simply because something "might help". Every proactive action needs a trigger reason, expected benefit, and a boundary that protects attention. The user can pause it, reduce its frequency, or keep suggestions only.

The control layer also monitors and stops losses. When execution takes too long, spending is abnormal, calls repeat, state oscillates, an external result is uncertain, or authority is about to expire, the system pauses or asks for help instead of waiting for the user to discover a bill or a mistake.

## Design Tradeoffs

Rules and models make decisions together, with rules taking precedence. Explicit schedules, amounts, sources, keywords, and risk conditions are handled by deterministic rules. Models are used when semantic understanding and context are needed. This handles open requests while keeping safety and cost boundaries independent of a model's mood.

| Autonomy level | What the system may do | What must happen |
|---|---|---|
| Suggest only | Observe, prepare drafts, and propose next steps | A real task starts only after the user confirms |
| Controlled execution | Run low-risk steps inside an authorized scope | Every external write still needs preview or approval |
| Authorized execution | Continue within a named task family and scope | High-risk actions, budget overruns, and anomalies must stop |
| Supervised autonomy | Advance independently for a limited time and handle common exceptions | Pause, takeover, and rollback remain available at all times |

Policy is separate from execution. A model may propose plans and candidate actions, but it cannot change authorization rules, approval thresholds, or safety boundaries. Policy changes are versioned, and old executions cannot quietly gain more authority when new rules appear.

Proactive loops need rhythm. The system reacts to events and schedules instead of spinning continuously. Repeated reminders cool down, quiet hours can suppress them, and repeated ignoring lowers their frequency. Attention is a hard budget just like tokens; sending more notifications is not a way to improve completion rates.

## Proactive Loops and Notification Boundaries

Proactive service no longer depends on manual scanning. It scans once after startup and then every five minutes. Task, approval, effect, source, and system changes trigger a debounced scan after two seconds. Scans still pass through `enabled`, autonomy level, daily limit, quiet hours, cooldown, and deduplication; being scheduled never bypasses those limits.

Long-lived rules are stored as standing intents. A heartbeat generates candidates from intents, task state, and due time, and the attention governor decides delivery against daily limits, quiet hours, per-category cooldown, per-target limits, and a high-priority cap. Ignoring, snoozing, and an explicit `NO_REPLY` all become feedback; the system cannot simply rephrase the same interruption. See [Personal Context and Attention](/en/design/personal-context).

A suggestion emits `suggestion.event(action="delivered")` only when it is actually delivered, with title, reason, and priority. While the page is open, the frontend turns it into a human-readable notification. It does not promise push delivery after the page closes. For approvals away from the computer, the Feishu long connection sends approvals and task status to mapped chats. Approval commands must come from an `allowedOpenIds` member and apply only to a one-time approval belonging to the mapped conversation.

The channel never changes authority. In-app notifications, desktop notifications, and Feishu messages only make people aware. Approval still calls the same `ApprovalManager.decide`; rejection still produces no external effect. Without a notification channel, the system falls back to the in-app "Needs you" surface. Without a real account, it never fabricates delivery or a receipt.

The control layer can refuse work or complete only part of it. A refusal explains whether authority is missing, risk is too high, budget is exhausted, information is insufficient, or a device is unavailable, and it offers a concrete action. Partial completion lists what was done and what was not; it cannot package a half-finished result as success.

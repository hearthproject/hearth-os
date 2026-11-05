---
title: 'Entrances and Experience'
description: 'How Hearth turns web, command line, mobile, messaging, task cards, approvals, artifacts, and takeover into one attention interface.'
outline: false
---

# Entrances and Experience

<p class="lead">Hearth is not an endless chat window. It is an operating surface organized around tasks, approvals, artifacts, and takeover. Users do not need to know which executor is doing the work; they need to see what the system is doing, where their attention is required, and whether the result can be trusted.</p>

## Design Goals

The central problem of the entrance is attention, not information volume. When users open Hearth, they should first see running tasks, actions waiting for a decision, recently delivered artifacts, and failures that need recovery, rather than a long transcript.

Web, command line, phone, and instant messaging can all be entrances, but they share one set of task facts. A user can create a task on a computer, approve it on a phone, and return to the web to inspect the artifact. Devices are different ways to observe and act; they do not produce conflicting states.

Notifications must be restrained. The system interrupts only when judgment, authorization, or takeover is genuinely needed. Each interruption should explain what happened, the suggested action, and the consequence of ignoring it. Ordinary progress belongs on the task page, not in the user's attention.

Mobile prioritizes approvals, artifact review, pause, and takeover; it does not try to reproduce every desktop management feature. The interface must also support keyboard operation, readable contrast, screen reading, and recovery on weak networks, because these capabilities determine whether long-term use is comfortable.

## Design Tradeoffs

Task cards take priority over chat history. Chat is good for expressing intent, but long work needs state, deadlines, artifacts, and recovery. Making chat the only interface forces users to scroll upward and makes it impossible to tell which step truly finished.

| Tradeoff | Hearth's choice | Reason |
|---|---|---|
| Primary surface | Task cards, approval cards, and an artifact center | Users see work status and the next step directly instead of parsing a conversation |
| Multiple entrances | Normalize source, identity, and deduplication | The same request arriving from email, web, or messaging is handled only once |
| State source | Rebuild the interface from server records | Refreshes, device changes, and reconnects stay consistent without relying on browser state |
| Interruption policy | Decide by risk and waiting time | High-risk actions are surfaced quickly while routine progress avoids notification fatigue |
| Mobile scope | Approve, review, take over, and start simple tasks | Phones suit short actions; complex editing stays on the desktop |
| Device capability | Each device declares its capabilities; do not assume parity | Some devices can operate desktop software while others can only review and approve |

The interface issues commands; it does not rewrite task facts. When a user clicks Approve, the system must check whether the approval expired, whether parameters changed, and whether the scope is still valid, then write the result and update the interface. Two devices can therefore act at once without showing success while nothing happened.

When something fails, the interface must be honest: an interrupted connection shows offline, an uncertain result shows verification in progress, and executor failure shows the reason and recoverable actions. The system must not disguise "still trying" as "finished". When the user takes over, it pauses automatic execution, saves progress, and hands over the operable scope.

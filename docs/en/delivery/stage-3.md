---
title: "Phase 3 · Desktop Operation"
description: "Let Hearth operate desktop software and cross-application workflows without open interfaces."
outline: [2, 3]
---

# Phase 3 · Desktop Operation

See [Phase 2–6 Delivery Status](/en/delivery/status) for implemented scope, verified paths, and deliberate gaps.

## Current status

- **Implemented code loop:** Pairing for same-machine Windows devices, per-capability approval, observe, pause, resume, takeover, handback, and terminate, plus low-risk click, typing, key, and UIAutomation actions in allowlisted applications.
- **Still open:** Sensitive-region masking, isolated desktops, high-risk action preview and compensation, real UIA setvalue acceptance, and acceptance with at least 5 real desktop tasks. See [Phase 2–6 delivery status](/en/delivery/status).

## Goal

Phase 3 lets Hearth operate desktop software and cross-application workflows that have no open interface. The order is observe first, take over second, low-risk actions third, and high-risk actions last. If the system cannot observe, pause, or hand over, it must not act automatically.

This phase has four steps:

| Step | Goal |
|---|---|
| [3.1 Connect and inspect a desktop device](/en/delivery/stage-3/3-1) | Make the device, scope, and stop control clear to the user. |
| [3.2 Observe the desktop and take over](/en/delivery/stage-3/3-2) | Let the user see the work, pause, take over, and hand back. |
| [3.3 Complete desktop actions by risk level](/en/delivery/stage-3/3-3) | Start with low-risk actions; high-risk actions need preview, confirmation, and recovery. |
| [3.4 Accept desktop operation](/en/delivery/stage-3/3-4) | Prove with real desktop tasks that it is understandable, interruptible, and stoppable. |

## How to do it

1. First let the user see and trust the desktop device.
2. Then let the user observe, pause, and take over.
3. Then complete low-risk actions in allowlisted applications.
4. Only then open high-risk actions, with snapshots, compensation, and recovery drills.

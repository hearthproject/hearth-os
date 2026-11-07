---
title: "Phase 6 · Multi-device and Long-running Operation"
description: "Let the same tasks, memory, and authority run safely across devices over the long term."
outline: [2, 3]
---

# Phase 6 · Multi-device and Long-running Operation

See [Phase 2–6 Delivery Status](/en/delivery/status) for implemented scope, verified paths, and deliberate gaps.

## Current status

- **Implemented code loop:** Incremental event sync with conflict choice, task leases and epoch fencing, device revocation and token rotation, kill switch, encrypted backup and restore, health checks, maintenance, and redacted diagnostics.
- **Still open:** Two real devices switching, a lost-device drill, full migration, multi-week continuous operation, and v1.0 release acceptance. See [Phase 2–6 delivery status](/en/delivery/status).

## Goal

Phase 6 expands the single-device product into a Personal Agent OS that runs for the long term, stays consistent across devices, can be backed up, migrated, and revoked. Multi-device does not mean copying multiple agents; it means the same tasks, memory, and authority continue on different devices.

This phase has four steps:

| Step | Goal |
|---|---|
| [6.1 Sync and switch across devices](/en/delivery/stage-6/6-1) | Keep the same tasks and artifacts consistent across devices. |
| [6.2 Revoke devices and migrate safely](/en/delivery/stage-6/6-2) | A lost device can be disabled immediately, and data moves fully when replacing it. |
| [6.3 Back up, restore, and upgrade](/en/delivery/stage-6/6-3) | Changing machines, versions, or making a mistake does not lose tasks, artifacts, or memory. |
| [6.4 Long-running operation and v1.0 acceptance](/en/delivery/stage-6/6-4) | Run stably for the long term, then release v1.0 after full acceptance. |

## How to do it

1. First make tasks and artifacts consistent across devices.
2. Then handle offline use, device switching, and capability routing.
3. Then complete device revocation, backup, restore, and upgrade.
4. Finally run the long-term test and full acceptance for v1.0.

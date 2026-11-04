---
title: 'Stage 1 · Durable Kernel & MVP'
description: 'Hearth Stage 1 development module: walking skeleton, first Codex slice, MVP-1, side-effect safety, recovery hardening, and Stage 1 release.'
outline: [2, 3]
---

<p class="eyebrow">MODULE 1 / 7</p>

# Stage 1 · Durable Kernel & MVP

<p class="lead">Move from prototype to a daily-usable local product. The order is fixed: real short loop → first Codex slice → MVP closeout → side-effect safety → second task family → recovery and release.</p>

## Prerequisites

- The 12 tasks, prototype, contracts, evaluation, and security baseline from Stage 0 are usable.
- The first task family is chosen. Research/document work is the default; if the first user mainly needs coding tasks, replace the wedge but keep the same vertical structure.
- Web is the real product entry point. CLI, logs, or scripts alone are not sufficient.

## Development Steps

1. **Deliver the walking skeleton.** Start `hearthd` with SQLite WAL, a minimal Event Log, Task/Run state machine, projections, fake executor, Web task list/detail/create, and SSE.
2. **Connect the first real Codex slice.** Implement the Codex adapter, health check, one-shot workspace, Task Pack, structured output, Artifact, citation/file verification, event projection, and Token/latency capture.
3. **Close MVP-1.** Complete create, view, cancel, retry, approval drill, artifact retrieval, failure recovery, and budget stop as one real narrow task loop.
4. **Add the side-effect safety skeleton.** Implement Effect Preview, Mandate, Approval, outbox, idempotency key, Receipt, undo/compensation drills, and a single-writer lease.
5. **Add a second task family and harden the kernel.** Use it to validate routing, failure classes, budgets, concurrency, duplicate delivery, crash recovery, and projection consistency.
6. **Complete the Stage 1 release.** Run 10 real tasks, compare manual and direct-Codex baselines, fix high-frequency failures, and add install, backup, upgrade, export, security, and evaluation evidence.

## Increment Breakdown

| Increment | User-visible outcome | Completion evidence |
|---|---|---|
| D1.1 Runnable walking skeleton | Create a Web task; state survives refresh and restart | `hearthd` + SQLite + Event Log + fake executor + SSE |
| D1.2 First Codex slice | A report with sources, verification, and cost | Task Pack, structured Result, Artifact, verifier |
| D1.3 MVP closeout | Create, cancel, retry, approve, retrieve, and recover in the browser | The MVP-1 user story passes end to end |
| D1.4 Side-effect safety skeleton | External actions have preview, approval, idempotency, and receipt | outbox, idempotency, Receipt, undo/compensation drill |
| D1.5 Second task family and hardening | A second real task family is dependable and recoverable | Routing, fault injection, duplicate delivery, recovery tests |
| D1.6 Stage 1 release | Users can install, use, back up, and export independently | 10 real tasks, baseline comparison, security and evaluation report |

## Where the MVP Fits

MVP-1 is the early Stage 1 exit at D1.3, not a Stage 6 product. It may omit email, calendar, GUI, proactivity, and multi-device, but it must include real execution, durable state, Web task cards, artifacts, approval drills, and failure recovery.

## Exit Checklist

- [ ] The MVP supports one narrow task family every day in the browser.
- [ ] After a crash, refresh, or restart, tasks recover or explicitly move to human handling.
- [ ] Duplicate delivery and retries do not create duplicate external side effects.
- [ ] Task cards show state, artifacts, cost, and next action; failure reasons are understandable.
- [ ] At least 10 real tasks pass human acceptance; Token and manual-minute baselines exist.
- [ ] Permission boundaries, secret protection, kill switch, backup, and data export work.

## Out of Scope

- Email, calendar, desktop GUI, proactive loops, or multi-device.
- Expanding the number of executors before recovery, approval, and UI completeness are solid.
- Replacing real Codex execution and verification with demo scripts.

## Next

Continue to [Stage 2 · Personal Operator](/en/delivery/stage-2), starting with read-only connectors for everyday content work.

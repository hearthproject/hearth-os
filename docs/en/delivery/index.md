---
title: "Delivery Route and Implementation Plan"
description: "Hearth's six delivery phases, from a minimum complete MVP to a long-running Personal Agent OS."
outline: [2, 3]
---

# Delivery Route and Implementation Plan

<p class="lead">This route answers only two questions: what to build first, and what comes next; and how each phase moves from usable to reliable.</p>

## Overall goal

Hearth turns personal digital work into reliable tasks. The route starts from what the user can complete, not from architecture modules: deliver the smallest complete product first, then expand work coverage, proactivity, memory, and multi-device use.

## Current progress

As of 2026-11-10, Phase 1 has been accepted: all 15 cross-industry real tasks ran and 13 passed, meeting the 10/15 hard threshold. Phases 2 through 6 have runnable code and automated test loops, but real accounts, real devices, long-running operation, and failure drills remain unfinished, so they cannot be called complete delivery. See [Phase 2–6 delivery status](/en/delivery/status) for item-level evidence and the [Day07 development log](/en/log/day-07) for the latest work.

## Six phases

Each phase has four steps. Open a phase name for the detailed plan.

| Phase | Goal | Current status | What the user gets |
|---|---|---|---|
| [Phase 1 · Minimum Complete MVP](/en/delivery/stage-1) | Deliver the smallest complete product that passes at least 10 of 15 cross-industry real tasks. | **Accepted:** all 15 tasks ran, 13 passed; T07 and T08 remain open boundaries | A local task workbench that can be used every day across multiple task families |
| [Phase 2 · Everyday Content Work](/en/delivery/stage-2) | Expand from the initial cross-industry tasks to email, calendar, documents, tables, and the web. | **Partial:** local sources, extraction, draft approval, local outbox, SMTP send, and IMAP read-only sync form a code loop; real accounts and calendar are unaccepted | A personal operator that handles everyday content and writes safely after approval |
| [Phase 3 · Desktop Operation](/en/delivery/stage-3) | Let Hearth operate desktop software and cross-application workflows without open interfaces. | **Partial:** same-machine Windows pairing, observation, takeover, and allowlisted low-risk actions run; high-risk and isolation work is open | An assistant that can operate desktop software, pause, take over, and recover from failure |
| [Phase 4 · Proactive Service and Mobile Entry](/en/delivery/stage-4) | Work proactively within limited authority and use the phone for approval and takeover. | **Partial:** triggers, suggestions, inbox, attention budget, installable PWA shell, and Feishu long connection run; phone pairing, system push, and remote takeover remain unaccepted | An assistant that speaks at the right time and can be approved or taken over from a phone |
| [Phase 5 · Memory and Capability Evolution](/en/delivery/stage-5) | Let the system accumulate context and improve methods, with every change visible, correctable, and reversible. | **Partial:** memory provenance/consolidation/forgetting, skill lifecycle, method evaluation, and durable delegation form a code loop; real long-term use and production comparison are open | An assistant that accumulates context and improves methods while staying correctable and reversible |
| [Phase 6 · Multi-device and Long-running Operation](/en/delivery/stage-6) | Let the same tasks, memory, and authority run safely across devices over the long term. | **Partial:** sync, leases, revocation, backup, health checks, and connection runtime run; real two-device, remote-node, and long-running acceptance is open | A multi-device, portable, long-running Personal Agent OS |

## How to proceed

1. **Complete before expanding.** Complete at least 10 of the initial 15 tasks before adding sources, operation modes, and devices.
2. **Read-only before writes, low risk before high risk.** Observe first, draft second, and approve execution last.
3. **Accept every phase with real tasks.** Finished code or finished pages do not count as completion.
4. **Safety and recovery start in Phase 1.** Approval, artifacts, failure recovery, and permission boundaries are not postponed.

Start with [Phase 1 · Minimum Complete MVP](/en/delivery/stage-1); implemented scope and open items for Phases 2–6 are recorded in [delivery status](/en/delivery/status).
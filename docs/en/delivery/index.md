---
title: "Delivery and progress"
description: "What Hearth has delivered, what is still open, and the order in which the remaining work converges."
outline: [2, 3]
---

# Delivery and progress

<p class="lead">This is not a roadmap that only describes the future. It starts from loops that already run, records which capabilities can be proven by code and tests, which boundaries remain open, and in what order the gaps will be closed.</p>

## Bottom line

**The phase-one MVP has passed its hard gate. Phases two through six have runnable code loops and automated coverage, but have not completed real-user, real-device, or long-running acceptance.**

Verification baseline on 2026-11-06: `npm test` passed 40 test files and 198 tests; `npm run typecheck`, `npm run build`, and `npm run docs:build` passed. All 15 phase-one real tasks ran, and 13 passed acceptance.

## Six phases

| Phase | Status | Proven | Still open |
|---|---|---|---|
| [1 · Minimum complete MVP](/en/delivery/mvp) | **Accepted** | 15 real tasks, 13 passed; task, approval, artifact, recovery, and backup loops | T07 did not deliver a PR; T08's external comment awaits user approval |
| [2 · Everyday content work](/en/delivery/capabilities) | Partial | Local files, knowledge bases, web sources; document extraction; drafts, approvals, local outbox, and receipts | No email or calendar accounts; no real sending |
| [3 · Desktop operation](/en/delivery/capabilities) | Partial | Windows pairing, capability approval, observation, pause/takeover/hand-back, low-risk input, UIA actions | Sensitive-area masking, isolated desktop, high-risk compensation |
| [4 · Proactive service and mobile](/en/delivery/capabilities) | Partial | Six trigger types, proactive inbox, accept/ignore/snooze/convert, attention budget | Mobile PWA, phone pairing, push, remote approval and takeover |
| [5 · Memory and evolution](/en/delivery/capabilities) | Partial | Memory candidate/recall/correct/conflict/forget/export; method evaluate/promote/reject/rollback | Real long-term use and before/after production comparison |
| [6 · Multi-device and long-running](/en/delivery/capabilities) | Partial | Incremental sync, peer auth, leases and epoch fencing, revocation, encrypted backup, health maintenance | Real two-device switch, lost-device drill, multi-week run |

## What "partial" means

"Partial" does not mean "the page is done", and it does not mean "the capability is delivered". It means only:

1. The server, API, and projections have a runnable implementation.
2. Automated tests cover the main code paths and key boundaries.
3. Real accounts, real devices, real user tasks, or long-running evidence are still missing.

Phases two through six therefore do not become "accepted" just because code merged. Each phase needs its own real task record, failure drill, and user verification.

## Three delivery levels

| Level | Meaning | Current state |
|---|---|---|
| **Runnable** | The app starts locally and tasks can be created, executed, and viewed | Present |
| **Verified** | Tests, isolated runs, or real run records prove key paths | Phase one: yes; phases two–six: partial |
| **Accepted** | A real user, device, or external account completed the agreed tasks | Phase one: passed; phases two–six: not yet |

## Why the route was rewritten

The old route described an implementation order that had not happened yet across six phases and 24 sub-stages. The project is now substantially built, and future-tense planning hides two questions: which capabilities already run, and which only have code without acceptance.

The new route uses three layers:

- **Delivery overview**: phase status and the evidence boundary first.
- **Capability status**: implemented, verified, and deliberately empty by phase.
- **Remaining roadmap**: only unfinished workstreams, each with an exit condition.

## Continue reading

<DocCardGrid :columns="2" :items="[
  { no: '01', title: 'Phase-one MVP acceptance', text: 'Results for 15 real tasks, T07/T08 boundaries, G1–G9 criteria, and evidence.', link: '/en/delivery/mvp' },
  { no: '02', title: 'Phase 2–6 capabilities', text: 'Implemented, verified, and deliberately open items by sub-stage.', link: '/en/delivery/capabilities' },
  { no: '03', title: 'Remaining roadmap', text: 'Seven workstreams, milestones, exit criteria, and explicit non-goals.', link: '/en/delivery/roadmap' },
  { no: '04', title: 'Acceptance and evidence', text: 'Test levels, evidence rules, reproduction commands, and the definition of done.', link: '/en/delivery/acceptance' }
]" />

## Next

The priority is not to add more surface area, but to turn existing code loops into capabilities proven by real use:

1. Connect real email and calendar accounts and complete 10–15 everyday content tasks.
2. Add desktop sensitive-area masking, isolated desktop, and high-risk actions; accept at least 5 desktop tasks.
3. Build the mobile entry and complete proactive interruption acceptance.
4. Run before/after comparisons with real memory and methods.
5. Drill two-device switching, lost-device handling, and backup restore.
6. Complete multi-week operation, upgrade rollback, and v1.0 acceptance.

See [Remaining roadmap](/en/delivery/roadmap) for order and exit criteria.

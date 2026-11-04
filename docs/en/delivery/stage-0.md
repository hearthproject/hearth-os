---
title: 'Stage 0 · Definition & Prototype'
description: 'Hearth Stage 0 development module: product wedge, real-task baseline, clickable prototype, contracts, evaluation, and engineering baseline.'
outline: [2, 3]
---

<p class="eyebrow">MODULE 0 / 7</p>

# Stage 0 · Definition & Prototype

<p class="lead">Lock down who the product is for, what the first verifiable task is, and how success will be judged before building the execution kernel. Stage 0 must produce enough evidence to support the first runnable vertical slice.</p>

## Questions This Module Answers

- Who is the first real user, and what is the first high-frequency, verifiable task wedge?
- Why use Hearth instead of Codex, a chat assistant, or a collection of automation scripts?
- What does the user see when a task is created, running, awaiting approval, failed, or recoverable?
- Which stable contracts do the UI, backend, executors, approvals, and evaluation depend on?

## Prerequisites

- An empty repository and one first user willing to provide real tasks and feedback.
- Ability to record both a fully manual baseline and a direct-Codex baseline.
- No real high-risk external side effects yet.

## Development Steps

1. **Lock the product wedge.** Choose the first user, first task family, and explicit non-goals; write the positioning and a "what we do not do" list.
2. **Build a real task set.** Collect 20–30 real tasks and select at least 12 with clear inputs, artifacts, and acceptance methods, including success, failure, approval, and takeover cases.
3. **Run baselines.** Record manual minutes, success rate, Tokens, failure types, and user friction for both manual work and direct Codex use.
4. **Create an end-to-end prototype.** Cover Today, Needs You, Artifacts, and Settings, plus queued, running, awaiting approval, needing information, completed, failed, and recoverable states.
5. **Define core contracts.** Fix fields and state transitions for Task, Ticket, Run, Event, Executor, Approval, Artifact, Receipt, and Budget; define Task Pack, Result, failure classes, and UI projections.
6. **Set up the engineering skeleton.** Initialize the monorepo, type checks, lint, tests, CI, ADR template, documentation structure, and a fake executor.
7. **Establish evaluation and security baselines.** Build a runner, scoring, and human review for the 12 tasks; complete the threat model, risk tiers, approval matrix, and secret-handling rules.
8. **Rehearse the contracts.** Drive the full prototype with a mock server and verify that the same event stream reconstructs UI state without pretending unknown states are successful.

## Increment Breakdown

Each increment now has four layers: outcome and gate → four work packages → engineering map and interfaces → acceptance rehearsal. Packages can be split across developers, but merge in dependency order; completing one package does not complete the increment.

| Increment | User-visible outcome | Completion evidence |
|---|---|---|
| [D0.1](/en/delivery/stage-0/d0-1) Product wedge and task baseline | A clear explanation of why the first user needs Hearth | 12+ real tasks, two baselines, non-goals, and success metrics |
| [D0.2](/en/delivery/stage-0/d0-2) End-to-end prototype | A new user can create, approve, retrieve artifacts, and recover without instructions | Desktop/mobile prototype, all states, usability review |
| [D0.3](/en/delivery/stage-0/d0-3) Protocol and data contracts | Every prototype state maps to stable fields and events | Entity definitions, state machine, projection contracts, contract tests |
| [D0.4](/en/delivery/stage-0/d0-4) Evaluation, security, and engineering baseline | Every later increment can be verified from day one | Evaluation runner, threat model, approval matrix, CI, fake executor |

## Exit Checklist

- [ ] At least 12 tasks have inputs, artifacts, acceptance criteria, and failure samples.
- [ ] A new user can complete the main path in the prototype; each state has one primary action.
- [ ] Pages do not depend on internal database fields; the event stream reconstructs UI projections.
- [ ] High-risk actions have an approval path; evaluation is repeatable; CI catches contract and schema regressions.
- [ ] The fake executor drives the complete UI flow with no real external side effects.

## Out of Scope

- Do not build the whole kernel before the UI.
- Do not connect real sending, payments, deletion, or system-setting changes.
- Do not treat "the documents are written" as a substitute for a clickable prototype and repeatable evaluation.

## Next

Continue to [Stage 1 · Durable Kernel & MVP](/en/delivery/stage-1): deliver the walking skeleton first, then close MVP-1.

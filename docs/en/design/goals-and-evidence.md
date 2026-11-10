---
title: 'Goals, Completion, and Evidence'
description: 'How Hearth turns a user goal into an acceptance contract and decides completion from evidence rather than model self-assessment.'
outline: [2, 3]
---

# Goals, Completion, and Evidence

<p class="lead">Chat can express intent, but it cannot prove that work is done. Hearth stores a goal as a contract, splits completion into checkable criteria, and writes a report with evidence references. A model may suggest completion; only validators and an explicit review policy can confirm it.</p>

## Design Goals

A goal contract must answer four questions before execution: what the user wants, what must not happen, what counts as complete, and where to stop on failure or budget exhaustion. These answers are fixed before work starts; they are not inferred after a model has produced something.

Completion should prefer deterministic evidence. A file existing is not the same as correct content, a successful command is not the same as a correct business result, and a model saying "done" is never sufficient on its own. Checkable structure, diffs, tests, queries, and receipts come first; anything that cannot be automated is explicitly handed to a person.

Evidence must survive executors, restarts, and handoffs. A task may start in Codex, continue in the native runtime, and end with an approved external write. Whatever the path, acceptance criteria, collected evidence, and unresolved items must remain attached to the task.

## Goal Contract

| Field | Purpose |
|---|---|
| Title and objective | State the result the user wants, not the steps to perform |
| Constraints | Scope, format, sources, accounts, and time limits that must hold |
| Forbidden actions | Sends, deletes, publishes, payments, or privilege expansion that must not happen |
| Authority sources | Separate direct user instructions, document rules, and system defaults |
| Success criteria | Each criterion has an identifier, description, validator type, check, and required flag |
| Evidence requirements | Artifacts, test output, Git diffs, external receipts, or human review records |
| Budget | Limits for turns, tool calls, tokens, duration, and human minutes |
| Deadline and stop conditions | When to stop, and which failure or risk signals trigger an immediate pause |
| Review policy | Automatic, human-on-risk, or human-on-complete |
| Current state and next handoff | Where the goal stands and what the next executor must know |

Goal states are draft, active, blocked, awaiting user, validating, done, failed, and cancelled. A state change is a record, not a temporary label in the interface. A goal has one effective write authority at a time.

Validators cover commands, files, schema checks, Git, human review, and model review. Commands and Git checks run in a restricted environment and cannot expand task authority. File checks inspect content, structure, and declared artifacts; schema checks inspect format and fields; model review explains and supplements but does not replace deterministic checks.

## Completion Judgement

The scheduler runs completion judgement when a task is ready to finish. Judgement confirms that the goal and acceptance criteria exist, runs each validator, collects evidence references, records missing evidence and forbidden-action violations, and returns pass, fail, needs human, or blocked.

A completion report contains the goal, task, verdict, criterion results, evidence references, missing evidence, forbidden actions, and check time. It belongs to the task record and does not disappear when an executor exits. A goal-backed task cannot close without a completion verdict; without one it may remain waiting, validating, or blocked, but executor termination is not completion.

Completion is not bypassed with a reassuring sentence. Missing artifacts must be produced, failed commands keep their original output, unverifiable evidence goes to human review, and a forbidden action fails the task with its impact stated. Hearth does not silently retry high-risk actions or turn an uncertain external result into a success receipt.

## Budgets, Deadlines, and Stop Conditions

Budgets are measured against effective completion rather than token use alone. Turns, tool calls, tokens, duration, and human minutes are tracked separately. When any budget is exhausted, work pauses, degrades, or moves to a person, with completed and unfinished parts stated plainly.

A deadline is not a hard kill at a wall-clock instant. Near the deadline, Hearth should converge results, save checkpoints, list unfinished work, and preserve the user's choice to continue, extend, narrow scope, or cancel. Stop conditions include budget exhaustion, insufficient authority, excessive risk, uncertain external state, conflicting evidence, and user cancellation. Every stop leaves a reason and a recovery path.

## Design Tradeoffs

- **Determinism first.** Tests, file checks, Git diffs, and external-state queries outrank free-form model judgement.
- **Model review has boundaries.** A model can explain evidence and find omissions, but it cannot override a failed command, a missing file, or an unconfirmed external result.
- **Evidence is referenced, not copied.** Reports keep locations and summaries so large logs do not bloat task records or drift from their source.
- **Completion is a state, not a tone.** "Done" and "should be fine" are not verdicts; pass, fail, needs human, and blocked are traceable outcomes.
- **Handoffs keep acceptance context.** Reinterpreting a goal after an executor switch creates drift, so the handoff packet carries acceptance criteria and existing evidence.

## Current Boundaries

Command, file, schema, Git, human, and model validators form a code loop, and goal budgets, deadlines, and stop conditions are connected to scheduling. Subjective quality, aesthetics, relationship judgement, and real business impact still need human acceptance. Real long-running tasks, cross-device handoffs, and real external receipts have not completed overall acceptance.

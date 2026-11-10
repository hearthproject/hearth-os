---
title: 'Day07 · Goal evidence, delegation, and personal context'
outline: false
---

2026-11-10 moved Hearth from "tasks can run" toward "tasks have contracts, handoffs, context, and acceptance evidence". 56 commits touched 522 files (+20,709/−52,818): the first half added goal budgets, deadlines, stop conditions, command and Git validators, approval action binding, and reconciliation for uncertain effects; the second half added durable delegation, sandboxing, handoff evidence, channel idempotency, the personal ontology, Context Broker, standing intents, and connection runtime, then moved the evaluation corpus, apps, and scenario runner out of the main repository.

The large deletion count comes mainly from moving the evaluation stack and decoupling templates, not from removing product capability. The main repository keeps the evaluation bridge, task templates, product service, and operating evidence; evaluation cases, console, experiments, and scenario evidence now live in a standalone repository.

## Goal and completion evidence

| Area | Result |
|---|---|
| Budgets and stop | Goal budgets cover turns, tool calls, tokens, duration, and human minutes; deadlines, stop conditions, and review policy enter scheduling, and exhaustion pauses, degrades, or hands work to a person |
| Validators | Completion judgement adds command and Git validators alongside file, schema, human, and model review; commands run in a restricted environment and cannot expand authority |
| Scheduler | The scheduler injects custom validators when a task is ready to finish and persists the completion report; goal tasks cannot close without a verdict |
| Handoff evidence | Terminal evidence survives executor handoff, and late results from an old generation cannot overwrite new state |
| Interface | Task detail shows criteria, completion verdict, evidence, and missing items instead of only an executor summary |

## Delegation, handoff, and sandboxing

| Area | Result |
|---|---|
| Durable delegation | A parent creates bounded child tasks with budget, workspace policy, parent-child relation, lease, heartbeat, and failure state; the scheduler advances them |
| Workspace policy | Read-only, isolated-write, and shared-read policies bound what children can see and write |
| Sandbox | Checks working directory, read/write paths, network hosts, process allowlist, and credential boundaries; any violation fails closed with a reason |
| Handoff packet | Records goal, next action, acceptance criteria, evidence, permission subset, context watermark, generation, and redaction; work resumes only after verification |
| Channel idempotency | Feishu and other channel ingress events deduplicate by identity, so repeat delivery cannot create two tasks, approvals, or child tasks |

## Personal context and attention

| Area | Result |
|---|---|
| Personal ontology | Entities, aliases, relations, states, decisions, and commitments become shared records; conflicting states are not silently overwritten but become attention items |
| Context Broker | Assembles context packs for chat, task, goal, handoff, and delegation scopes into must-know, relevant, recallable, and omitted lanes; references can expand only within parent authority |
| Memory governance | Source, confidence, taint, sensitivity, and validity affect recall; consolidation is auditable, and forgetting propagates to projections, versions, events, sync, and derived memory |
| Standing intents | Long-lived user rules become standing intents; a heartbeat turns intent and task state into candidates that explain why now, the next action, and the consequence of ignoring |
| Attention budget | Daily limit, quiet hours, per-kind cooldown, per-goal and high-priority limits, ignored penalty, and `NO_REPLY` feedback regulate interruption |
| Connection runtime | Transport, subscription, data freshness, and execution ownership are separate; reconnect advances generation, old-generation writes are rejected, offline actions enter an outbox, and cached projections never pretend to be live |

## Approvals, skills, and scheduling boundaries

| Area | Result |
|---|---|
| Approval binding | Native patch, full-permission actions, GitHub writes, and SMTP sends bind the resolved real action; changed parameters, expiry, and reuse invalidate approval |
| Uncertain effects | External actions with uncertain delivery enter an explicit reconciliation queue where the user can confirm, retry, or abandon instead of blindly resending |
| Skill permissions | Skills are scoped by usage source, permission range, and risk; stale skills can be curated with rollback |
| Schedule catch-up | Scheduled tasks support bounded catch-up and failure cooldown so downtime or repeated failure cannot flood execution |
| Tests | Added regressions for goals, completion, delegation, handoff, sandbox, channels, connections, ontology, Context Broker, attention, and approval binding |

## Evaluation split and documentation

| Area | Result |
|---|---|
| Standalone evaluation | Evaluation web, service, core, cases, scenario runner, and docs moved to `hearth-eval`; the main repository keeps only task/judge bridge contracts and the managed artifact directory |
| Template decoupling | Product task templates no longer depend on the evaluation corpus; the product service owns its example inputs and output declarations |
| Artifact roots | Task artifacts land under the product artifact root, while evaluation inputs are authorized through an external root |
| Documentation facts | README, delivery status, executor handoff, evaluation guide, and phase notes now describe the split; this page and Day06 are added |

## Commits

### 2026-11-10 (56 commits, selected)

| Commit | Author | Changes |
|---|---|---|
| `753804b` | JasonBuildAI | Enforced goal budgets for turns, tools, tokens, duration, and human minutes, with deadlines and stop conditions; 4 files (+279/−20). |
| `442db1d` | JasonBuildAI | Added command and Git validators to completion judgement for tests, diffs, and workspace evidence; 2 files (+165/−2). |
| `93c3608` | JasonBuildAI | Injected custom validators from the scheduler and persisted completion reports; 2 files (+73/−2). |
| `0c778d1` | JasonBuildAI | Showed criteria, completion verdict, and missing evidence in task detail; multiple files. |
| `47c9517` | JasonBuildAI | Bound native patch and full-permission actions to the resolved real action so changed parameters invalidate approval; 3 files (+144/−24). |
| `4e73449` | JasonBuildAI | Exposed the reconciliation queue and manual handling for uncertain effects; 10 files (+394/−9). |
| `61c849d` | JasonBuildAI | Added durable single-layer delegation with budget, workspace policy, parent-child relation, and failure state; 2 files (+695). |
| `2a232e8` | JasonBuildAI | Enforced path, network, and credential sandbox boundaries and failed closed on escape; 2 files (+249). |
| `90920ba` | JasonBuildAI | Validated handoff generations and persisted handoff evidence so old-generation results cannot overwrite new state; 7 files (+1,109/−15). |
| `be5112d` | JasonBuildAI | Persisted Feishu ingress idempotency so repeat delivery does not create duplicate tasks or approvals; 3 files (+177/−35). |
| `4bb5b1d` | JasonBuildAI | Added the personal ontology, Context Broker, and attention runtime; 51 files (+7,840/−140). |
| `4e0ecce` | JasonBuildAI | Added standing intents, heartbeat, and an attention queue governed by budget and feedback; 7 files (+1,607/−3). |
| `32877f2` | JasonBuildAI | Added generation-owned connection runtime, offline outbox, and cached projections; 9 files (+1,475/−5). |
| `5a7ece2` | JasonBuildAI | Curated stale skills with rollback; 7 files (+628/−8). |
| `d43941d` | JasonBuildAI | Enforced scoped skill permissions; 7 files (+781/−7). |
| `8dbc39f` | JasonBuildAI | Added bounded catch-up and failure cooldown for schedules; 5 files (+785/−58). |
| `89df4e7` | JasonBuildAI | Moved the evaluation corpus and scenario runner out of the main repository; 259 files (−42,941). |
| `cb097b9` | JasonBuildAI | Moved evaluation web, service, and core out of the main repository; 49 files (−8,859). |
| `f14642c` | JasonBuildAI | Decoupled product task templates from the evaluation corpus; 2 files (+39/−112). |

## Boundaries and next step

- Completion judgement covers commands, files, schema, Git, human, and model review, but subjective quality, real business impact, and real external receipts still need human acceptance.
- Delegation is single-layer with no recursive agent team. The local sandbox checks paths, network, processes, and credentials; it is not a strong container or VM boundary.
- The connection runtime has generations, an offline outbox, and cached projections, but no real remote node or phone, and no real offline-reconnect or cross-node reconciliation acceptance.
- The personal ontology and Context Broker still rely mainly on local heuristic matching and ranking. Real long-term personal data, phone push, remote takeover, and cross-device context consistency remain unaccepted.
- The evaluation stack is standalone, but this documentation update did not produce real experiments or pass rates in `hearth-eval`; main-repository tests do not replace independent evaluation.
- `npm test` on the same day: 89 test files and 579 tests passed; `npm run typecheck`, `npm run build`, and `npm run docs:build` passed. Passing tests are not real-user, real-device, or long-running acceptance.

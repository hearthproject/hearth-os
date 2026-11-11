---
title: 'Hearth System Design'
description: 'Hearth product positioning, overall design, technology choices, and module map.'
outline: [2]
---

# Hearth System Design

<p class="lead">Hearth is a single-user, self-hosted personal Agent OS for long-running work. It turns intent into durable, auditable, and recoverable tasks, with models, tools, and external systems working through one task path.</p>

## Product Positioning and Goals

Hearth serves one primary user, with a small number of trusted collaborators who may review or approve work. Personal files, credentials, memory, and devices stay under the user's control by default. Cloud models, remote isolation, and sync services are optional capabilities, not a reason to hand over all data.

The product is organized around tasks, not chat history. The user needs to know what the system is doing, why it needs attention, what was delivered, and where to recover after a failure. Models, tools, and execution environments can change; task state, authority, evidence, and external receipts must remain.

Phase one did not start with all personal work. It used 15 cross-industry tasks with verifiable results to establish the first complete path from input to delivery, and 13 passed, meeting the 10/15 hard gate. It does not try to cover all personal work, but it requires document processing, web research, engineering collaboration, data/finance, customer support, recruiting, education, and marketing to share one task, approval, artifact, and recovery system. Once that foundation is reliable, Hearth expands sources, external writes, desktop operation, proactive service, memory, and multi-device use; those extensions currently have code closures only, and real acceptance lives in [Delivery](/en/delivery/).

**Explicit non-goals:** enterprise multi-tenancy, a public agent marketplace, unapproved high-risk automation, a foundation-model race, and a tool that requires daily maintenance of prompts, plugins, and workflows.

Work is not done because a model says so. It needs a user-visible result, reviewable evidence, explicit open items, and approval plus a receipt for external effects.

## Overall Design and Task Path

Hearth uses one path for every piece of work: an entrance receives the request, the control layer decides whether it deserves action, the task layer holds the goal and state, executors do the work, approval and receipts protect external effects, and verification decides whether to finish or ask for help.

| Layer | Owns | Does not own |
|---|---|---|
| Entrances and experience | Messages, files, pages, timers, task cards, approvals, artifacts, and takeover | Deciding execution or writing state directly |
| Control and authority | Ignore, observe, suggest, or create; scope, risk, and autonomy | Running tools or holding long-lived raw credentials |
| Tasks and durable execution | Goals, work units, attempts, budgets, checkpoints, and recovery | Deciding business authority or writing externally |
| Executors and routing | Choosing the right capability, risk level, cost, and device | Expanding its own authority or bypassing approval |
| Approval and external effects | Preview, authorization, idempotent execution, receipts, reconciliation, and takeover | Deciding whether the task is worth doing |
| Runtime and safety | Workspaces, isolation, network, credentials, sensitive data, and device boundaries | Replacing product-level risk judgment |
| Memory and evolution | Correctable context and reusable methods, promoted only after evaluation | Becoming the source of truth or self-expanding |
| Evaluation and cost | Real tasks, verifiers, baselines, and cost metrics | Replacing acceptance with a demo |

Every fact is recorded first. Interfaces, notifications, and reports are rebuilt from that record. The early system uses one process, one writer, and a local database; it does not split into microservices for scale that does not exist yet. Work survives restarts, sleep, and network loss. One effective executor advances a work unit at a time, and late results cannot overwrite newer state.

An external action is more than a model calling a tool. Hearth previews the action, checks authority and approval, executes with a repeatable identifier, and stores a receipt. An uncertain result is reconciled before retry. If the result cannot be confirmed or the risk is too high, Hearth pauses and hands control to the user.

## Technology Choices

Technology follows system constraints, not language preference. Hearth must run for years, share protocols across entrances, integrate tools without losing control, and be maintainable by a small team.

| Layer | Choice | Why |
|---|---|---|
| Primary language | TypeScript | Control, tasks, command line, web, and adapters share concepts and validation, reducing protocol drift |
| Service runtime | Node.js 22.13+ | Fits high-I/O orchestration and event delivery; one process, one writer; document work uses built-in `node:sqlite` |
| Local storage | SQLite WAL | Enough for a single-user, local-first, single-writer system, with simple backup and migration |
| Web interface | React and Vite | Fits task cards, approvals, artifacts, and live state; the PWA shell and mobile navigation exist, while phone pairing, system push, and remote takeover remain unaccepted |
| Live updates | Server-Sent Events | Simpler than a two-way persistent connection for server-side state changes |
| Documents and data | Server-side TypeScript | `cheerio`, `pdfjs-dist`, `mammoth`, `exceljs`, and `docx` read HTML, PDF, DOCX, XLSX, and CSV and write XLSX/CSV/DOCX in-process, without a second business protocol |
| Native boundary | PowerShell + Node bridge | The Windows helper owns window observation, UIA, and input; Rust appears only when a single binary or stronger isolation becomes a hard constraint |

TypeScript is the language; Node.js is the runtime. They are not alternatives. TypeScript provides development-time types, while Node.js provides files, network, processes, and timers. External input and stored data still need runtime validation.

TypeScript wins mainly because of shared protocols and integration speed. Tasks, approvals, artifacts, receipts, and execution events appear in the service, command line, web interface, and tests. One set of types and validation reduces drift. Hearth is mostly orchestration and waiting, not sustained large-scale computing, so Node.js is sufficient at personal scale.

Rust is not the primary language because the bottleneck is product boundaries, protocol consistency, recovery, and authority judgment, not raw speed. Desktop work first validates real interaction with PowerShell plus a Node bridge; Rust expands only if a single binary, stronger isolation, or device resources become hard constraints. Go and Python are not part of the business stack today; document parsing already runs in the TypeScript server, avoiding a second runtime in the first phase.

The frontend uses React and Vite without a second server-rendered runtime. Task state comes from the local service projection; the browser renders and sends commands. The first phase does not introduce microservices or network boundaries just to look complete. The PWA shell, mobile bottom navigation, and offline application shell exist, but phone pairing, iOS/Android installation, system push, and remote takeover remain unaccepted parts of [Phase 4](/en/delivery/stage-4).

## Module Map and Key Boundaries

The fifteen modules below are parallel design notes. Together they cover the product from the first entrance to long-running operation, without following a code directory layout.

| Module | What it solves first |
|---|---|
| [Entrances and Experience](/en/design/experience) | Let the user know what the system is doing, when attention is needed, and where results live |
| [Tasks and Durable Execution](/en/design/tasks) | Keep work alive across restarts, sleep, and failure, with evidence and recovery |
| [Goals, Completion, and Evidence](/en/design/goals-and-evidence) | Turn goals into acceptance contracts and decide completion from evidence rather than model self-assessment |
| [Control and Authority](/en/design/control) | Decide when to observe, suggest, execute, or stop, within explicit authority |
| [Executors and Routing](/en/design/executors) | Use specialized capabilities instead of one universal model |
| [Native Agent Runtime](/en/design/native-agent-runtime) | A self-built general execution kernel that unifies model protocols, tools, compaction, skills, delegation, worktrees, MCP, budgets, and checkpoints |
| [Delegation, Handoff, and Sandboxing](/en/design/delegation-and-sandbox) | Delegate bounded work, continue with handoff packets, and enforce path, network, and credential boundaries |
| [Approvals, Takeover, and External Effects](/en/design/effects) | Make sends, writes, deletes, and publishes previewable, authorized, and reconcilable |
| [Runtime and Safety](/en/design/safety) | Limit real-world impact with isolation, least privilege, and credential boundaries |
| [Storage and Context Architecture](/en/design/storage) | Unify facts, model bindings, and handoff watermarks with SQLite, content blobs, and task context |
| [Personal Context and Attention](/en/design/personal-context) | Use a personal ontology, context packs, memory recall, and interruption budgets to decide what the agent knows and when to speak |
| [Memory and Capability Evolution](/en/design/memory) | Accumulate context and methods while staying correctable, forgettable, and reversible |
| [Evaluation and Cost](/en/design/evaluation) | Prove reliability and cost with real tasks instead of demos |
| [Multi-device and Long-running Operation](/en/design/operations) | Keep one set of tasks, authority, and data consistent across devices over time |
| [Agent Reference Patterns](/en/design/agent-reference-patterns) | Record borrowed patterns and trade-offs instead of treating an external framework as the product architecture |

The non-negotiable boundaries are: every interface is rebuilt from a record; each state has one write authority; goal-backed tasks require acceptance criteria and a completion verdict; external actions have approval or an explicit exemption plus a reconcilable receipt; executors never see long-lived raw credentials; handoffs can narrow authority but never expand it; every task has a budget, deadline, and cancellation path; memory has provenance, sensitivity, and forgetting rules; method changes require evaluation, canary, promotion, and rollback.

---
title: 'Executors and Routing'
description: 'Why Hearth uses specialized executors and how it chooses a path by capability, risk, and cost.'
outline: false
---

# Executors and Routing

<p class="lead">Hearth does not hand every job to one universal model. General reasoning, code execution, connectors, browsers, desktop operation, document processing, and human judgment have different boundaries. The system selects one or several appropriate capabilities for the work.</p>

## Design Goals

An executor must actually finish a work unit and return a clear result: where the artifacts are, what evidence supports them, which steps succeeded, which failed, whether an external effect occurred, and whether the next step is verification or takeover. Executors must support cancellation, timeout, recovery, and budget limits; once started, work cannot become impossible to stop.

Different tasks need different capabilities. Code, long documents, and complex research suit stronger executors with more complete workspaces. Email, calendars, and cloud drives should use connectors with explicit interfaces. Websites without interfaces use a browser. Software without a web endpoint uses desktop operation. Parsing, conversion, spreadsheets, and reconciliation prefer deterministic document and data processing. Value judgments that carry responsibility belong to the user.

Routing is not about always trying one tool first. It selects the path most likely to succeed at acceptable risk and reasonable cost under hard constraints. Permission, data residency, reversibility, and safety level are hard constraints; success rate, latency, and expense are optimized only after those constraints are met.

Executors cooperate without sharing implicit state. One task might use a browser to gather material, general reasoning to summarize, a document executor to build a spreadsheet, and a code executor for complex processing, followed by user approval and a connector send. Every step states its input, output, and scope so one executor's guess never becomes another executor's fact.

## Design Tradeoffs

Hearth keeps several specialized executors side by side rather than building one super-agent with unlimited capabilities. This puts permission, isolation, budget, and recovery into clear boundaries and lets real data replace poorly performing paths.

| Executor | Better suited for | Not suited for |
|---|---|---|
| Hearth native | Complete tool loops for general work: reading inputs, web access, file outputs, pausing for input, and recovery | Work that needs full repository semantics and multi-file engineering checks |
| Codex | Multi-file code, long documents, complex research, and deep writing | Continuous online listening or low-cost high-frequency responses |
| Connectors | Email, calendars, cloud drives, messaging, and ticketing with interfaces | Software without an interface that needs graphical operation |
| Browser | Web research, signed-in sessions, forms, and software as a service | Direct exposure of highly sensitive credentials or unauditable bulk actions |
| Desktop operation | Local software without open interfaces and cross-application flows | Work that needs absolute determinism or high-throughput repetition |
| Documents and data | Parsing, conversion, spreadsheets, reconciliation, and deterministic processing | Open-ended judgment or complex cross-system collaboration |
| Human | Value judgments, accountability, exception takeover, and approval | Frequent, low-value work that can already be verified automatically |

The routing order is not a fixed hierarchy. Work that can be done with a rule, script, or official interface does not call a model. External data starts with a connector; browser or desktop is considered only when no connector exists. Deterministic document processing is not given to a generative model. Long chains and complex artifacts may use a stronger executor. A task can change executors midway, but the input, budget, authority, and current evidence must carry over.

The current default split is `native` for general tasks and `codex` for explicit code and engineering work. The native executor is a Hearth-owned single-agent tool loop with budgets, checkpoints, input pauses, and recovery; it is not a forwarded prompt. A failed task does not silently switch executors, and the executor identity is recorded in runs and artifact manifests. Tasks that need network access or engineering workspace writes create a proposal in chat and enter the queue only after user confirmation.

Executor output contracts are unified even though execution methods are not. The system cares about result type, evidence, artifacts, failure classification, and recoverability, not which model or interface an executor used internally. This lets Hearth replace models, add tools, or fall back to a person without changing the task layer.

Routing improves from real data. Historical success, failure types, takeover rate, latency, and cost should inform selection; one successful demo does not prove an executor is better over time. For high-risk actions, permission and data scope outrank speed and expense; a higher success rate cannot compensate for exceeding authority.

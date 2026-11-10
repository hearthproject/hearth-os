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

The current registry contains seven executors in two tiers. They share launch resolution, health checks, managed installation, model binding, context capture, and the settings surface, but their adapters and capability ceilings differ.

| Executor | Tier | Connection | Capability ceiling and boundary |
|---|---|---|---|
| `deepseek-harness` | First-class | Official `@deepseek-ai/dsh-sdk-client` SDK/JSON-RPC | Full DeepSeek Harness runtime: native tools, code, repositories, tests, session resume, and a complete event stream; requires a valid model binding |
| `codex` | First-class | Local Codex profile or a `config.toml` generated from the unified binding | Multi-file code, repositories, tests, builds, and GitHub workspaces; the model protocol is fixed to OpenAI Responses |
| `native` | First-class | Hearth-owned single-agent tool loop | General work, source reading, web, file delivery, input pauses, recovery, and desktop screenshots; supports four model protocols |
| `hermes` | External | `hermes` on `PATH` or a configured command | General agents, multi-step tool use, and automation flows; supports CLI session resume |
| `qoder` | External | `@qoder-ai/qoder-agent-sdk`, reusing a local qodercli login or PAT | Coding, workspaces, and resumed sessions |
| `workbuddy` | External | `@tencent-ai/codebuddy-code`, reusing the local login | Coding, workspaces, and resumed sessions |
| `kimi` | External | `@moonshot-ai/kimi-code` in stream-json mode | Coding, workspaces, and non-interactive batch work |

First-class does not mean universally stronger. It means deeper integration and a more complete control surface. Complex code and repository work prefer `codex` or `deepseek-harness`; general work, web, documents, and desktop capability prefer `native`; external executors fit teams that already have the corresponding CLI, login, or workflow. ZCode is no longer integrated.

The native executor is a Hearth-owned single-agent tool loop with budgets, checkpoints, input pauses, and recovery; it is not a forwarded prompt. DeepSeek Harness uses the official SDK rather than parsing command-line text. Codex has a dedicated adapter and obeys the Responses protocol. A failed task does not silently replace its executor identity, and the actual executor is recorded in runs and artifact manifests.

## Unified Model Bindings

Each executor binds a model profile in Settings instead of keeping a private configuration file. A profile stores provider, protocol, base URL, model name, and an encrypted API key. A binding may override the protocol or model, but the server enforces compatibility:

| Executor | Allowed protocols |
|---|---|
| `native` | OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini |
| `codex` | OpenAI Responses only |
| `deepseek-harness` | OpenAI Chat, OpenAI Responses, Anthropic Messages |
| `hermes`, `qoder`, `workbuddy`, `kimi` | OpenAI Chat, OpenAI Responses, Anthropic Messages |

The current Hearth chat model is `app_settings.model.chatProfileId`; it serves chat, the native executor, and failure diagnosis. An external executor uses its own profile only when its binding is valid. A Codex binding generates `.hearth/executors/codex/config.toml` and injects the key through the environment; DeepSeek Harness writes the protocol mapping into its provider configuration. Local models are excluded from the unified registry so a local port is not mistaken for a cloud service. See [Storage and Context Architecture](/en/design/storage) for the full boundary.

## Failure Diagnosis and Handoff

Failure handling classifies the cause before deciding whether to change executors. Permission, missing input, exhausted budget, uncertain external effects, and interruption are not executor failures. Runtime faults, capability gaps, contract failures, and transient faults enter handoff evaluation.

1. Deterministic rules classify first. A transient fault may retry the same executor once.
2. For executor faults, the **current Hearth chat model** reads the task, failure, runs, and recent context, then proposes a cause, confidence, recommended action, and attempts not to repeat. Diagnosis never uses the failed executor's model, so a broken model does not defend itself.
3. Under full permission, with context enabled and low risk, Hearth switches to the next eligible executor automatically and continues the task.
4. Under necessary approval, Hearth asks only “Switch to `target executor` and continue?” and starts a new run with the same task, remaining budget, and context watermark after confirmation.
5. When the cause is not the executor, Hearth reports the reason directly without switching.

The fallback order is `deepseek-harness → codex → native → hermes → qoder → workbuddy → kimi`. Attempted executors are not selected again, and the default limit is two handoffs. A handoff packet carries the diagnosis summary, completed and failed work, artifacts, open questions, remaining budget, and `context_watermark_seq`; the target continues from the same watermark. Every handoff is written to `handoffs` and produces `HANDOFF.md`. The host validates the target, acceptance, permissions, cursor, and artifact hashes before switching; a failed validation blocks the switch. `HANDOFF.md` is published as a real artifact with an `artifactRef`. Run records retain both source and target executors, stale-generation tool writes are rejected, and the failed run's own diagnosis and decision evidence remains available.

## Shared Context

Every executor adapts to Hearth task-level context instead of maintaining a separate chat history. Assistant messages, tool calls, tool results, checkpoints, and notices from the native runtime, Codex, DeepSeek Harness, and external CLIs all flow through unified callbacks into `context_items`. `executor_event_id` prevents duplicate events within a run; oversized bodies go to `.hearth/context/blobs/`; the task summary lives in `task_context_state`; startup and handoff generate a budgeted context projection.

A CLI `sessionId` is only an optimization for resume, not a source of truth. Even when session resume fails, Hearth can rebuild the task projection from shared context. Deletion, retention, and handoff limits are managed in the Context section of Settings. See [Storage and Context Architecture](/en/design/storage) for the lifecycle.

## Settings Boundaries

Settings has four sections:

| Section | Responsibility |
|---|---|
| Executors | Default executor, installation and health, command or script path, concurrency, and each executor's model binding |
| Models | Profile CRUD, current chat model, model discovery, connection tests, and masked keys |
| Context | Mode, budgets, retention, handoff limits, metrics, and deletion |
| Data | SQLite path, executor directories, context blobs, migration records, and backups |

The global default executor only seeds new conversations; the composer picker overrides it. When a preference is disabled, unavailable, lacks a required capability, or has no valid model binding, routing returns to the task-matched executor and then scans the registry for another usable path.

## Adding an executor

New executors follow the same registry pipeline instead of a forked special path:

1. Add a stable ID to `EXECUTOR_IDS` in `packages/core/src/types.ts`; add it to `FIRST_CLASS_EXECUTOR_IDS` only when it has complete adaptation, diagnosis, and verification.
2. Add the name, description, capabilities, tier, provider, and resume support in `apps/server/src/executors.ts`; add the ID to the GitHub capability list when it can read the prepared repository.
3. Add launch resolution in `apps/server/src/executor-runtime.ts`: configured path first, then managed install, then global installation and `PATH`. Include version probing and health state.
4. Add a pinned package spec in `apps/server/src/executor-install.ts`. Desktop apps that cannot be installed headlessly should return unsupported with a clear detection or manual-path hint.
5. Declare the protocol boundary in `EXECUTOR_MODEL_PROTOCOLS` in `apps/server/src/model-registry.ts`, and verify that a binding can generate the CLI or SDK configuration.
6. Add argument construction and stream parsing in `apps/server/src/external-executor.ts` or a dedicated package; register the adapter in `apps/server/src/executor-adapter.ts` and implement context callbacks.
7. Add tests for launch resolution, health probes, install jobs, argument and event parsing, model protocol validation, preferred routing, failure classification, handoff, and context capture. Settings and the chat picker render from `/api/executors` and `/api/model-registry`; do not add a private toggle path.

The boundary stays the same: an executor returns results and evidence but cannot mutate task state directly. External effects still pass through Hearth approval and the effect ledger. Credentials stay in the local CLI or environment and never enter task context.

Executor output contracts are unified even though execution methods are not. The system cares about result type, evidence, artifacts, failure classification, and recoverability, not which model or interface an executor used internally. This lets Hearth replace models, add tools, or fall back to a person without changing the task layer.

Routing improves from real data. Historical success, failure types, takeover rate, latency, and cost should inform selection; one successful demo does not prove an executor is better over time. For high-risk actions, permission and data scope outrank speed and expense; a higher success rate cannot compensate for exceeding authority.

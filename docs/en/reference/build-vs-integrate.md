---
title: 'In-House Development and Integration Boundaries'
description: 'Hearth''s boundaries between the in-house core, adapter layer, direct integrations, and learn-only-without-integration; and the Codex integration approach.'
outline: [2, 3]
---

<p class="eyebrow">BUILD VS. INTEGRATE</p>

# Build vs. Integrate Boundary

<p class="lead">Hearth builds the core control and memory itself, and directly integrates models, Codex, browsers, document parsing, and Sandbox kernels. The clearer the boundary, the less likely the product is to turn into an integration grab bag.</p>

## One-Sentence Summary

Hearth builds the “command system, ledger, gates, and acceptance” itself, and integrates “models, sandboxes, browsers, document parsers, and external APIs.”

Here, “build” mainly means building the product and core logic in-house, not writing every underlying library from scratch. For example, the Event Log protocol is built in-house, but the underlying database is SQLite; the frontend experience is built in-house, but uses React/Vite.

## Delivery Boundary: Building the Core Does Not Mean Doing It Last

“Build” describes ownership of responsibility, not development order. Hearth will not first finish the Control Plane, Harness, Memory, and all Executors, and only then add the frontend.

- **The frontend is part of the core build**: task cards, approvals, artifacts, recovery, and mobile entry points are the visible parts of product differentiation, not a wrapper layer added after the backend is complete.
- **A prototype exists at Stage 0**: use a clickable Web prototype to validate the product narrative, states, and primary actions, even if the data is simulated.
- **Deliver an MVP early at Stage 1**: on a narrow task family, simultaneously deliver a real Web app, durable state, Codex execution, artifacts, approval drills, and failure recovery.
- **Every increment is a vertical slice**: user outcomes, interface, backend, Executor, validation, and recovery appear together; a capability that exists only as a CLI or log does not count as completing a stage.
- **The build/integrate boundary does not change because of the MVP**: the MVP still does not build models, container kernels, or a complete Agent framework in-house, but it must build task control, validation, approval, recovery, and the user interface in-house.

For the specific increment order, see Chapter 25 of the main roadmap or the volume `Hearth_路线图分册/09_从0到100开发计划.md`.

## 1. Core Parts Hearth Builds Itself

These are the product moats identified in the document and cannot be outsourced:

- **Control Plane**  
  Decides whether an event should be processed, whether to create a Task, whether execution is allowed, which Executor to use, how much budget to spend, when to ask you for approval, and whether to retry or hand off to a human after failure.

- **Durable Harness**  
  Task, Ticket, Run, task graph, dependencies, lease, single writer, fencing token, checkpoints, retries, cancellation, and crash recovery.

- **Event Log and projections**  
  Append-only source of truth, schema, migration, task state projections, auditing, and replay. What is built in-house here is the protocol and semantics, not the database engine.

- **Policy, Mandate, Capability, Approval**  
  Long-term rules, one-time authorization, resource scope and duration, risk classification, approval binding, and permission revocation.

- **External side-effect control**  
  Effect Preview, outbox, idempotency keys, Effect Dispatcher, Receipt, reconciliation, and dead-letter handling. This is the core of “never send the same email twice and never make the same payment twice.”

- **Context Compiler and Token Governor**  
  Assemble the minimal Task Pack, select the model ladder, control context, caching, budget, cost attribution, and abnormal termination.

- **Memory OS**  
  Five types of memory, provenance and trustworthiness, conflicts, sensitivity, recall, forgetting, multi-device sync, and memory UI.

- **Evolution OS**  
  Trajectory mining, skill candidates, evaluation sets, Shadow, Canary, promotion, permission checks, and rollback.

- **Control logic of the Execution Gateway**  
  Workspace lifecycle, mounts and file permissions, network allowlists and egress, Capability, quotas, snapshots, recovery, auditing, and takeover.

- **Credential Broker**  
  Long-term secret storage, short-lived credential issuance, scoping by task and account, usage auditing, and revocation, ensuring models cannot see the original password or refresh token.

- **Personal Gateway and experience layer**  
  Channel event normalization, deduplication, device registration, capability catalog, attention inbox, task cards, approval UI, artifact center, mobile entry point, and takeover flow.

- **Validators and evaluation system**  
  Tests, diff, citation checks, table checks, email recipient checks, web page status checks, fault injection, and trajectory replay.

- **Thin execution layer of the Native Runtime**  
  Short-task tool loop, session tree, steering, compaction, and logic for escalation to Codex; the model itself is not built in-house.

## 2. Hearth Builds the “Adapter Layer” In-House but Uses Off-the-Shelf Capabilities Underneath

This category is not fully built in-house, nor is it a simple API call; instead, Hearth controls the interface, policy, validation, and recovery:

- **Codex Executor**  
  Integrates Codex, but Hearth handles version pinning, Task Pack, workspace isolation, structured output, timeout cancellation, validation, and failure classification.

- **Browser Executor**  
  Uses Playwright for the browser engine and automation; Hearth handles login-state boundaries, web policy, prompt injection protection, validation, screenshots, and human takeover.

- **Connector Executor**  
  Email, calendar, cloud drive, IM, and similar services connect through official APIs or MCP; Hearth handles the unified `Source/Effect` protocol, permissions, rate limiting, idempotency, receipts, and reconciliation.

- **Document/Data Executor**  
  Uses mature Python libraries for parsing, OCR, format conversion, and spreadsheet processing; Hearth handles pipeline scheduling, minimal context extraction, result validation, and division of labor with Codex.

- **Sandbox**  
  Uses Docker, OCI containers, or microVMs; Hearth handles the Sandbox Provider interface, workspace lifecycle, network allowlists, credential isolation, and reclamation.

- **GUI Executor**  
  Uses the accessibility tree, screenshots, keyboard/mouse, and window capabilities provided by the operating system; Hearth handles agentd, task boundaries, validation, recovery, and human takeover.

- **Observability**  
  Uses OpenTelemetry; Hearth handles task trajectory semantics, Token attribution, and user-visible audit views.

## 3. Parts Explicitly Integrated Directly from Others

The document explicitly does not rewrite these mature infrastructure components:

- **Models**: OpenAI, Anthropic, local models, or other model APIs, using BYOM; no training of foundation models and no in-house inference engine.
- **Codex**: currently the only integrated external Agent, capable of handling code, research, documents, spreadsheets, and complex workspace tasks.
- **Playwright**: browser automation engine.
- **Document parsing and conversion libraries**: PDF, Office, OCR, spreadsheet processing, etc.
- **Official APIs or MCP for email, calendar, cloud drive, etc.**: connections to real external systems.
- **Container/microVM/Sandbox kernels**: start with Docker; use stronger isolation for high-risk tasks.
- **OpenTelemetry**: observability infrastructure.
- **Standard technology stack**: TypeScript, Node.js, SQLite, React, Vite, Fastify/Hono, Zod, Python sidecar, etc.

## 4. Projects to Learn From Only, Without Integrating or Using as a Product Foundation

This boundary is very important:

- **OpenClaw**: learn from its Gateway, channels, device nodes, attention entry points, and always-on mode; do not fork it or use it as a runtime dependency.
- **Hermes**: learn from its memory budget, memory constraints, skill consolidation, and evolution loop; do not adopt unbounded self-modification.
- **DeerFlow**: learn from its Harness/App layering, Run lifecycle, and thread isolation; do not introduce heavy framework coupling.
- **Pi / Maka**: learn from session tree, steering, compaction, and Event Log; do not copy the complete framework.
- **OpenSandbox / OpenBot**: learn from isolation, snapshots, takeover, and receipt; do not copy the complete product.
- **OpenMuse / OpenDots**: learn from durable jobs, checkpoints, leases, and low-interruption experience.
- **Codex**: a special case—learn from its workspace execution model and also actually integrate it.

Therefore, in the current document:

> Hearth does not integrate OpenClaw, Hermes, or DeerFlow at runtime, nor does it treat them as a product foundation. The only external Agent currently integrated is Codex; other projects are mainly reference patterns and learning targets.

## Remember the boundary in one sentence

> What Hearth builds itself is “how tasks are authorized, scheduled, verified, recovered, and remembered”; what it integrates is “the mature engines and tools needed to complete tasks.”

It does not want to reinvent models, containers, browsers, or document parsers; instead, it wants to organize them into a controllable, auditable, and recoverable personal Agent OS.

## Sources in the original text

- Build vs Integrate: `Hearth_个人Agent_OS_总体路线图_v3.md:280`
- Sandbox boundary: `:2019`
- Recommended tech stack: `:3848`
- Final judgment: `:4256`

---

## V. The Real Differences Between Hearth and OpenClaw

### Conclusion first

**In terms of product capabilities that can be used directly today, OpenClaw is clearly ahead of Hearth; Hearth is still a roadmap, not a delivered system.**

Therefore, one cannot say “Hearth is already stronger than OpenClaw,” nor can one say “Hearth is naturally a layer above OpenClaw.” A more accurate statement is:

> **OpenClaw is already a mature personal assistant Gateway and Control Plane; Hearth aims to build a stricter task control layer centered on “tasks and commitments” as core objects.**

The difference between the two is not “whose feature list is longer,” but “who is responsible for what”:

- OpenClaw is primarily responsible for **sessions, channels, personal assistant experience, and always-on services**;
- Hearth primarily aims to be responsible for **whether tasks are correctly authorized, whether they are actually completed, whether external side effects are provable, and whether recovery is possible after failure**.

These two directions overlap heavily. OpenClaw already has memory, audit, approvals, sandboxing, queues, restart recovery, and multi-device entry points, so these capabilities can no longer be described as unique to Hearth.

### Where exactly do they differ

| Dimension | OpenClaw | Hearth's design goal |
|---|---|---|
| Core object | Sessions, channel messages, Agent Run, always-on personal assistant | Event → Task → Ticket → Run; tasks and commitments are first-class objects |
| Product focus | Provides an always-available personal assistant within the user's existing chat channels | Manages long-running tasks, cross-Executor collaboration, authorization, budgets, and acceptance |
| Interaction model | Chat, channel messages, Control UI, mobile and desktop nodes | Task cards, approvals, Artifact center, inbox, and mobile takeover |
| Memory | Has implemented layered memory, provenance tracking, trust boundaries, Dreaming, user models, and standing intents | Plans to build a Memory OS with provenance, conflicts, sensitivity, forgetting, and multi-device sync; functionally it overlaps significantly with OpenClaw |
| Audit | Has implemented a bounded, metadata-level audit ledger, execution identities, approval decision records, and message lifecycle auditing; its documentation explicitly states that the ledger is neither a lossless record nor authorization evidence | Plans to use the Event Log as the source of truth and bind Effects, approvals, execution, and acceptance to the same task trajectory |
| External side effects | Requires idempotency keys for side-effecting calls such as `send` and `agent`, and has message delivery auditing | Further models external side effects as typed Effects, reconciled through outbox, idempotency keys, Dispatcher, and Receipt |
| Completion determination | Has Run status, audit, and results; but “whether the task is actually complete” still mainly depends on the execution flow and higher-level judgment | Plans to make Verifier the completion gate; it cannot simply trust the Executor saying “completed” |
| Sandbox | Has implemented backends such as Docker, Podman, SSH, OpenShell, and Crabbox | Plans to build only the Sandbox Provider interface, lifecycle, network egress, and credential isolation itself, reusing mature sandboxes underneath |
| Recovery | Already has queues, session controller, watchdog, restart recovery, and automatic resumption | Plans to use Event Log, lease, fencing, checkpoint, retry, and human takeover for task-level recovery |
| Ecosystem and channels | 20+ chat channels, desktop/mobile nodes, plugins, skills, and ClawHub | The current roadmap only has a mobile-first PWA and has not yet formed a channel and plugin ecosystem |
| Maturity | Has runnable code, documentation, installers, tests, and real usage paths | Is still an architecture and implementation roadmap, with no comparable evidence of a runnable product |

### Why is it easy to mistakenly think Hearth is “a layer above”

Because both are doing “control,” but they control different objects:

- OpenClaw's Control Plane mainly controls **Gateway, sessions, channels, execution identities, and message delivery**;
- Hearth aims to control **task contracts, authorization scope, context budgets, external side effects, and acceptance results**.

If in the future Hearth integrates OpenClaw as a Gateway or Executor, then the relationship could look like this:

```text
Hearth: Task, Mandate, budget, acceptance, side-effect Receipt
                 ↓
OpenClaw: channels, sessions, personal assistant runtime, device nodes
                 ↓
Codex / other Executors: actually complete a given piece of work
```

Under this specific architecture, Hearth is the "task control layer," and OpenClaw is the personal assistant runtime beneath it. But note the following:

1. This is not what the current roadmap implements;
2. The current roadmap only integrates Codex and does not treat OpenClaw as a runtime component;
3. OpenClaw itself can already integrate with Codex and various other Agent Harnesses, so "integrating Codex" does not automatically make Hearth a layer above OpenClaw;
4. The upper/lower-layer relationship only holds when Hearth genuinely owns task authorization, budgets, side effects, and acceptance, and OpenClaw is responsible only for channels and execution.

Therefore, "a control plane one layer above" should be revised to:

> **Hearth aims to be the control plane for the task and commitment layer, not a product that is inherently superior to OpenClaw. It must earn its place as a layer above OpenClaw through explicit interfaces, permissions, and receipt boundaries.**

### Under what conditions is Hearth genuinely stronger

Strength cannot be proven by "having more features," only by verifiable differences. It must pass at least the following four categories of tests:

1. **Side-effect test**: When a task crashes midway, is retried, or is restarted, emails are not sent twice, orders are not submitted twice, files are not overwritten twice, and reconciliation can be performed using Receipts.
2. **Completion test**: After an executor claims completion, Hearth can prove through tests, diffs, citations, file structure, web page state, or business rules that the result truly satisfies the task definition.
3. **Permission test**: When an executor is subjected to prompt injection or attempts privilege escalation, it cannot obtain credentials, directories, network access, or tools beyond the Task Mandate.
4. **Cost test**: On the same task set, Hearth's Token, latency, and human-attention costs are no higher than using OpenClaw directly or Codex directly, and there is explainable attribution.

If these four things are not achieved, Hearth is just a later, more complex OpenClaw; if they are achieved, only then does it have the right to claim it is stronger at the "task reliability" layer.

## VI. Can Codex really be integrated, and can all of its capabilities be used

### Conclusion

**Technically it can be integrated, and it is feasible for the roadmap to use Codex as the first external Executor.**

**But you cannot say "all of Codex's capabilities can be used."** You can only use the subset of capabilities that Codex publicly exposes, that the current account and version permit, and whose interfaces are relatively stable.

Codex is an executor, not Hearth's permission center, task database, memory center, or external side-effect gateway.

### Confirmed integration entry points

Based on local `codex-cli 0.163.0` and `@openai/codex-sdk 0.166.0` as the verification baseline:

- **`codex exec`**: non-interactive execution, suitable for Hearth's first-phase integration.
  - `--json`: outputs a JSONL event stream;
  - `--output-schema`: constrains the final structured output;
  - `-C`: specifies the working directory;
  - `--sandbox read-only | workspace-write | danger-full-access`: sandbox mode;
  - `-a / --ask-for-approval`: global approval policy, which must be placed before `exec`; the `codex exec` subcommand itself does not accept this parameter;
  - `--ephemeral`: does not persist session files;
  - `--skip-git-repo-check`: allows non-Git directories;
  - `--add-dir`: adds a writable directory;
  - `-i`: attaches images;
  - `-o`: writes the last message to a file;
  - `resume`, `fork`, `review`: resume, fork, and code review.
- **`@openai/codex-sdk`**: TypeScript SDK, essentially launching the Codex CLI and exchanging JSONL over stdin/stdout.
  - `startThread()` / `resumeThread()`;
  - `run()` / `runStreamed()`;
  - structured output, image input, working directory, sandbox mode, approval policy, model, and reasoning effort;
  - command execution, file modification, MCP tool calls, web search, todo, and usage events.
- **`codex app-server`**: experimental interface supporting stdio, Unix socket, and WebSocket, capable of generating TypeScript bindings and JSON Schema. Suitable for deep integration requiring fine-grained streaming events and approvals, but it must be treated as an experimental interface.
- **`codex exec-server`**: experimental standalone remote execution service.
- **`codex cloud`**: experimental Codex Cloud task interface, dependent on account and Cloud capabilities.
- **MCP / plugins**: external tools and plugins can be managed via `codex mcp` and `codex plugin`.

### Why you cannot say "all capabilities"

The following limitations are structural, not laziness at the integration layer:

1. **Account and plan limitations**: models, Cloud, Web Search, organizational policies, and regional availability are all constrained by the OpenAI account and permissions.
2. **Version limitations**: the protocols of the CLI, SDK, and app-server may change; the local CLI and SDK versions are already inconsistent, and you cannot assume that arbitrary versions are compatible with each other.
3. **Experimental interface limitations**: `app-server`, `exec-server`, and `cloud` are all explicitly marked experimental and are not guaranteed to be stable.
4. **The SDK is not the full platform**: the SDK is a wrapper layer over the CLI and does not cover the Codex desktop app, account management, billing management, or all Cloud/UI capabilities.
5. **Codex does not provide Hearth's governance capabilities**: Mandate, Capability, Credential Broker, Effect outbox, idempotent delivery, Receipt reconciliation, and Verifier are all outside Codex.
6. **Session persistence is not a task event log**: Codex's thread/session can be resumed, but it cannot replace Hearth's source of truth, task graph, or audit semantics.
7. **MCP tools are not safe tools**: just because Codex can call MCP does not mean high-risk tools such as email, calendar, and payments should be handed to it directly.
8. **`danger-full-access` is not the default option**: it may only be used in disposable, strongly isolated, destroyable sandboxes; normal tasks should use the minimum directory and minimum network permissions.

### Recommended integration architecture

```text
Hearth Task / Ticket
        ↓
Context Compiler generates the minimal Task Pack
        ↓
Codex Adapter: version check, workspace preparation, permission injection, timeout control
        ↓
codex exec --json --output-schema in an isolated Workspace
        ↓
JSONL events + structured results + artifact manifest
        ↓
Hearth Verifier: tests, diff, references, file checks, business rules
        ↓
Accept / retry / roll back / manual takeover
        ↓
When external side effects are required, Hearth Connector handles them via outbox, idempotency keys, and Receipt
```

The key point is: **Codex can write files, run commands, and invoke controlled tools inside the sandbox; however, external side effects such as sending email, modifying calendars, making payments, and publishing must go back through Hearth's Effect channel and cannot be performed directly by Codex.**

### Recommended three-phase implementation

**Phase 1: Get a single task working end to end**

- Use `codex exec --json --output-schema`;
- Use a separate temporary workspace for each Run;
- Mount only the directories the task needs;
- Configure timeouts, cancellation, and process-tree cleanup;
- Parse JSONL and persist events, usage, and the final structured result;
- Use Hearth's own Verifier to determine success.

**Phase 2: Add multi-turn and recovery**

- Persist the Codex thread id, but treat the Hearth Event Log as the authoritative state;
- Use `resume` when multiple turns are needed;
- After a task fails, first classify it: model failure, tool failure, verification failure, permission failure, or environment failure;
- Use idempotency keys for retryable tasks to avoid duplicate side effects.

**Phase 3: Re-evaluate app-server**

- Introduce `app-server` only when fine-grained streaming events, native approval forwarding, or long-lived connections are truly required;
- Pin the CLI and protocol versions;
- Establish contract tests for protocol generation and event fields;
- Maintain forward compatibility with unknown events; do not crash because of newly added fields.

### Hard rules for integrating Codex

- **Pin versions**: Record the CLI version, SDK version, and protocol version, and run contract tests before upgrading;
- **Minimal workspace**: One workspace per Run, reclaimed when the task ends;
- **Minimal environment variables**: Do not pass long-lived keys, browser cookies, or unrelated credentials to child processes;
- **Minimal network egress**: Disabled by default or allowlisted, permitting only the domains the task needs;
- **Structured output**: Require `--output-schema`; do not parse natural language to determine success;
- **Independent verification**: Codex saying it is done does not count as done; it must pass the Hearth Verifier;
- **Side-effect isolation**: Codex does not directly hold permissions for email, calendars, payments, or publishing;
- **Cancellable**: Timeouts and user cancellation must terminate the entire process tree, not merely stop reading output;
- **Log redaction**: JSONL, command output, and error messages may contain sensitive data and must be redacted before being written to the Event Log;
- **Prefer ephemeral sessions**: Use `--ephemeral` for one-off tasks; explicitly persist the thread id only when recovery is needed.

### Final judgment

Codex can serve as Hearth's “high-capability workspace executor,” and Phase 1 integration can be done now. But the correct goal is not to “embed all of Codex's capabilities”; rather, it is:

> **Define a subset of Codex capabilities for which Hearth itself can verify results, enforce permissions, handle recovery, and perform billing, and encapsulate it as a stable Executor contract.**

This is also the dividing line between Hearth and a “Codex wrapper”: a wrapper treats Codex as the product; Hearth treats Codex as a replaceable, governable execution engine.

## Additional references

- Hearth's Codex positioning and Build vs Integrate: `Hearth_个人Agent_OS_总体路线图_v3.md`, sections 2.3–2.4
- Hearth's final integration boundary: `Hearth_个人Agent_OS_总体路线图_v3.md`, section 29.5
- MVP and the 0-to-100 development sequence: `Hearth_个人Agent_OS_总体路线图_v3.md`, chapter 25
- OpenClaw Gateway, channels, and device nodes: local OpenClaw documentation `docs/concepts/architecture.md`
- OpenClaw audit ledger and execution identity: local OpenClaw documentation `docs/gateway/audit.md`
- OpenClaw sandbox backends: local OpenClaw documentation `docs/gateway/sandboxing.md`
- OpenClaw memory architecture: local OpenClaw documentation `docs/concepts/memory-architecture.md`
- OpenClaw queues and recovery: local OpenClaw documentation `docs/concepts/queue.md`, `docs/gateway/restart-recovery.md`
- OpenClaw standing intents: local OpenClaw documentation `docs/concepts/standing-intents.md`
- Codex CLI capabilities: `codex exec --help`, `codex app-server --help`, `codex exec-server --help`, and `codex cloud --help` for local `codex-cli 0.163.0`
- Codex SDK capabilities: `README.md` and `dist/index.d.ts` for `@openai/codex-sdk 0.166.0`

> Note: OpenClaw capabilities are based on verification against local documentation and source code; Codex capabilities are based on the local CLI and npm SDK versions. Both may continue to evolve, so version and interface verification must be repeated before formal integration.

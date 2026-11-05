---
title: 'Engineering Delivery and Repository Structure'
description: 'Hearth''s engineering principles, tech stack, repository layout, process model, testing and evaluation, observability, and release migration.'
outline: [2, 3]
---

<p class="eyebrow">ENGINEERING</p>

# Engineering Delivery and Repository Structure

<p class="lead">Engineering principles, recommended tech stack, repository layout, process model, data directory, CLI, Event Log, testing and evaluation, observability, and release migration.</p>

## Engineering Architecture and Repository Structure

### Engineering Principles

- **Modular monolith first**: do not introduce microservices early;
- **Vertical slices first**: every milestone must simultaneously include UI, persistent state, execution, verification, and recovery;
- **The interface is the acceptance surface**: capabilities that users cannot complete in the browser do not pass the stage exit;
- **Single writer**: the same State Root has only one write authority;
- **Event sourcing**: facts are written to the Event Log; UI/indexes are projections;
- **Schema first**: inputs, outputs, Effects, and Approvals all have versioned schemas;
- **Adapter isolation**: Codex, Connector, Browser, GUI, and Sandbox are all integrated through interfaces;
- **Local first**: data is local by default, and cloud resources are replaceable;
- **Rollback-capable**: databases, skills, configuration, and releases all have rollback paths;
- **Observable**: every task has a correlation id, trace, and cost attribution.

### Recommended Tech Stack

The following are default recommendations, not an unchangeable religion:

| Layer | Recommendation |
|---|---|
| Language | TypeScript / Node.js 22+ |
| Package management | pnpm |
| Monorepo | Turborepo or equivalent tooling |
| Long-running service | Node + Fastify/Hono |
| Database | SQLite WAL + migration |
| Schema | Zod / JSON Schema |
| Web | React + Vite + PWA |
| Real-time updates | SSE first, WebSocket when necessary |
| Browser | Playwright |
| Documents/data | Python sidecar + mature parsing libraries |
| Sandbox | Start with Docker, microVMs for untrusted tasks |
| Observability | OpenTelemetry + local logs/metrics |
| Testing and evaluation | Vitest/Playwright/contract testing/fault injection/task sets and benchmarks |
| Packaging | npm CLI + Docker Compose |

The reason for choosing TypeScript is that the frontend and backend share types, event protocols, and schemas, making it suitable for rapidly building a local Web and CLI; document/data-intensive processing is supplemented by a Python sidecar to fill in the ecosystem, without splitting the entire system into multilingual microservices.

### Repository Layout

```text
hearth-os/
  apps/
    hearthd/              # Resident service: Gateway / Control / Harness
    web/                  # Task cards, approvals, artifacts, PWA
    cli/                  # hearth commands
    agentd/               # Device node (later)
  packages/
    core/                 # Domain model, state machine, error classification
    eventlog/             # Event Log, projections, migration
    harness/              # Ticket, Run, lease, outbox, recovery
    policy/               # Policy, Mandate, Capability, risk
    context/              # Context Compiler, Task Pack
    token/                # Token Governor, budget, attribution
    memory/               # Memory writes, retrieval, forgetting, sync
    evolution/            # Trajectories, skills, evaluation, promotion, rollback
    executors/
      native/
      codex/
      connector/
      browser/
      gui/
      document/
    connectors/           # email/calendar/docs/im/issue
    gateway/              # Channels, devices, notifications, identity
    execution/            # Sandbox Provider, egress, Broker
    artifacts/            # Artifacts, hashes, versions, verification
    shared/               # schema, types, utilities
  sidecars/
    docdata/              # Python document/data pipeline and pytest
  tests/
    contract/
    integration/
    e2e/
    slices/
    fault/
    replay/
    security/
    performance/
    fixtures/
    helpers/
  evals/
    suites/
    scorers/
    baselines/
  docs/
    adr/
    architecture/
  docker/
```

### Process Model

```text
hearth CLI / Web / Mobile
          │
          ▼
       hearthd
  ├─ Gateway
  ├─ Control Plane
  ├─ Durable Harness
  ├─ Token Governor / Context Compiler
  ├─ Executor Supervisor
  ├─ Event Log / projections
  ├─ Sandbox Provider client
  ├─ Credential Broker
  └─ Effect Dispatcher
          │
          ├─ Codex adapter
          ├─ Browser worker
          ├─ Connector workers
          ├─ Document/Data sidecar
          └─ Device agentd (later)
```

All Executors connect through a unified protocol and never write directly to the primary database. SQLite is written by the single `hearthd` process; Executors receive work through RPC/Task queues.

### Data Directory

```text
~/.hearth/
  state.db                # Event Log + projections
  artifacts/              # Content-addressed artifacts
  workspaces/             # Temporary and project workspaces
  config/
    policy.yaml
    connections.yaml
  secrets/                # Encrypted credentials or Broker pointers
  logs/
  backups/
  devices/
```

Minimize permissions on sensitive directories; encrypt backups; device sync transmits only the necessary projections and Artifact references.

### CLI

```text
hearth init
hearth run "compile this week's competitor updates and generate a weekly report draft"
hearth status
hearth inbox
hearth approve <id>
hearth artifacts
hearth memory search "Project A decisions"
hearth memory forget <id>
hearth doctor
hearth export
```

CLI output supports both human-readable and JSON modes, making it convenient for scripts and automated tests.

### Event Log and Projections

- Events are append-only and are not updated in place;
- Each Event has schemaVersion, correlationId, and causationId;
- Task state, inbox, Artifacts, and costs are all projections;
- Projections can be rebuilt;
- Event hash chains or equivalent integrity verification;
- Large content is stored in Artifacts, and Events store only references;
- Migrations must remain compatible with old Events;
- Event replay must not produce external side effects.

### Tasks and Leases

- Each Ticket has at most one active Assignment at any given time;
- Leases carry a fencing token;
- Executors validate the fencing token before writing;
- When a device goes offline, its lease expires and the Task can be reassigned;
- Reassignment must not duplicate external Effects;
- Task state transitions have explicit Events and conditions;
- Subtasks inherit the parent Task's budget and permission intersection.

### Testing and Evaluation System

Testing is not an appendix to feature work; it is part of every small stage's deliverable. Every small stage must ship implementation, slice E2E, failure paths, and regression tests together. "Feature first, tests later" is not acceptable.

#### Two Principles

- **Tests are not evaluations.** A test is a deterministic pass/fail gate; an evaluation (eval) is a statistical measure of quality, such as verified task success, citation accuracy, token cost, or human minutes. Both are required, but they must not be mixed into one CI gate. See [Evaluation System](/en/architecture/evaluation) for task sets, metrics, and statistical discipline.
- **Test code ships in the same PR as the feature.** Every small stage must deliver implementation, slice E2E, failure paths, and regression tests together. Do not defer testing to a later phase.

#### The Nine Testing Layers

1. **Unit tests**: pure logic, including state machines, Task/Ticket transitions, budget calculations, permission decisions, verifiers, error classification, and Context Compiler trimming rules. Use Vitest for TypeScript and pytest for the Python sidecar.
2. **Contract tests**: test boundaries, not internal implementation. Focus on Executors, Connectors, Sandbox Providers, the Credential Broker, and the Effect Dispatcher. The Codex adapter must honor the unified `TaskPack → Result` contract; email connectors must honor the `Source/Effect`, idempotency, and Receipt contracts. Contract tests are the main defense against "one behavior in mocks, another in production."
3. **Integration tests**: use a real temporary SQLite database to test the Event Log, projection rebuilds, migrations, outbox, leases, fencing tokens, duplicate delivery, and crash recovery. Do not mock the database here, because persistent behavior is exactly what must be verified.
4. **Vertical slice E2E**: every small stage has a browser acceptance path covering task creation, status, approval, artifact retrieval, and failure recovery. Phase 1 first uses simulated execution to exercise the prototype, then runs real tasks in the MVP. This is the most important test category for the project.
5. **Fault injection**: inject `kill -9` at the queueing, execution, artifact-write, and approval-wait points, then cover network loss, timeouts, full disk, duplicate delivery, device offline, and clock skew. Acceptance should map directly to stage gates: zero duplicate external side effects and the target recovery rate.
6. **Replay and determinism tests**: replay recorded event streams to verify that projections rebuild, old events can be upgraded, and replay does not produce external side effects. UI state must also be recoverable from the event stream rather than depending on in-memory objects.
7. **Security tests**: cover privilege escalation, approval replay, nonce/expiry handling, secret leakage, prompt injection, untrusted web content, SSRF/egress, cross-account isolation, and device revocation. Every new permission must ship both "allow" and "deny" tests.
8. **Performance and long-run tests**: cover startup time, task-creation latency, query latency, long-running tasks, concurrency limits, memory leaks, and disk growth. Benchmark scripts and baseline results can be committed, but do not hard-gate every PR on early thresholds.
9. **Evaluation sets (evals)**: build representative tasks, success/failure samples, scoring rules, and human review per task family. Evals focus on task success, citation traceability, human minutes, token/cost, and interruption counts. Memory and evolution stages also require dedicated evaluations for "forgetting propagation," "no permission expansion," and "Shadow/Canary rollback."

#### Repository Layout

```text
apps/
  hearthd/src/**/*.test.ts
  web/src/**/*.test.tsx
  cli/test/*.test.ts
packages/
  core/test/
  eventlog/test/
  harness/test/
  policy/test/
  executors/*/test/
tests/
  contract/
  integration/
  e2e/
  slices/D1.1/
  fault/
  replay/
  security/
  performance/
  fixtures/
  helpers/
evals/
  suites/
  scorers/
  baselines/
sidecars/docdata/tests/
```

Keep unit tests close to the source. Put cross-module, cross-process, and stage-acceptance tests under the root `tests/` directory. Keep `evals/` separate from ordinary tests.

#### Test Code That Must Be Committed

- All `.test.ts`, `.test.tsx`, `*.spec.ts`, and `test_*.py` files.
- Contract tests, fixtures, fake servers, fake executors, fake Codex JSONL cassettes, and fake effect sinks.
- Synthetic or desensitized test documents, emails, calendar data, and web samples.
- Database migration tests and old-version fixtures.
- Eval task definitions, scorers, and baseline metrics.
- CI configuration, test runner scripts, and test-data generation scripts.
- Security test cases and fault-injection scenarios.
- Small, meaningful golden files such as structured results, diffs, and JSON schemas.

#### Do Not Commit

- Real email, calendar, or document data, cookies, tokens, refresh tokens, or API keys.
- Real user data, real Codex session records, or real email bodies.
- Large test videos, screenshots, databases, coverage reports, or test logs.
- Temporary generated artifacts and caches.
- Absolute paths or developer-machine configuration that only works locally.

For external dependencies such as Codex, commit a **fake Codex CLI** that emits the agreed JSONL protocol. Run real Codex only in nightly or manual smoke tests. This keeps PR tests stable and inexpensive without drifting from the real protocol.

#### Three CI Tiers

- **Required on PRs**: unit + contract + integration + slice E2E with the fake executor, targeting under 10 minutes.
- **Nightly**: fault injection, security tests, performance, and real Codex/connector smoke tests.
- **Release**: full suite + migration + install/backup/restore + stage-exit acceptance.

#### Five Hard Rules

- Every bug fix ships with a regression test.
- Every new event schema ships with migration and old-event compatibility tests.
- Every new external side effect ships with idempotency and duplicate-delivery tests.
- Every new permission ships with denial-path tests.
- Every new executor or connector ships with contract, timeout/cancellation, and failure-classification tests.

The goal is not test count. It is to guarantee that **when Hearth says "the task is complete," tests can prove it; when Hearth says "it can recover," fault injection can prove it.**

### Observability

- Each Task/Run has a trace id;
- Each model call records the model, tokens, cost, and latency;
- Each tool call records the parameter hash, result status, and resources;
- Each external side effect records an idempotency key and a Receipt;
- The UI displays only the Events that users need;
- Detailed information is retained in a local audit view;
- Logs are automatically redacted;
- Metrics are used for routing and evaluation, not for manipulating users.

### Release and Migration

- Version schemas and APIs;
- Database migrations are forward-compatible;
- Executor versions are pinned;
- Skills are versioned;
- Run evaluations and fault injection before release;
- Support rollback to the previous stable version;
- Upgrades do not break historical Events and Artifacts;
- Users can export and migrate.
- Each small stage retains a rollback-capable version; recovery must not rely solely on rebuilding the environment.

---

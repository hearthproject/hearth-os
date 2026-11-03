---
title: 'Engineering Delivery and Repository Structure'
description: 'Hearth''s engineering principles, tech stack, repository layout, process model, data directories, CLI, testing, observability, and release migration.'
outline: [2, 3]
---

<p class="eyebrow">ENGINEERING</p>

# Engineering Delivery and Repository Structure

<p class="lead">Engineering principles, recommended tech stack, repository layout, process model, data directory, CLI, Event Log, testing, observability, and release migration.</p>

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
| Testing | Vitest/Playwright/contract testing/fault injection |
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
    evals/                # Task sets, runner, scorer
    shared/               # schema, types, utilities
  sidecars/
    docdata/              # Python document/data pipeline
  fixtures/
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

### Testing Strategy

| Layer | Content |
|---|---|
| Unit | schema, policies, validators, cost calculation |
| Contract | Executor, Connector, Sandbox, Broker |
| Integration | Event Log, outbox, lease, recovery |
| E2E | Task cards, approvals, Artifacts, email drafts |
| Slice E2E | browser path from Task creation to Artifacts/recovery for each increment |
| Fault Injection | crashes, network disconnection, timeouts, duplication, full disk |
| Replay | historical trace replay, route switching |
| Security | injection, privilege escalation, secrets, sandbox, egress |
| Performance | startup, queries, long-running Tasks, concurrency limits |

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
- Each increment retains a rollback-capable version; recovery must not rely solely on rebuilding the environment.

---

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/brand/hearth-os-logo-reverse.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/public/brand/hearth-os-logo.png">
    <img src="docs/public/brand/hearth-os-logo.png" alt="Hearth OS" width="420">
  </picture>
</p>

**A self-hosted personal Agent OS for durable, auditable, and recoverable digital work.**

[English](README.md) | [简体中文](README.zh-CN.md)

[![Documentation](https://img.shields.io/badge/documentation-%E4%B8%AD%E6%96%87%20%7C%20English-b8471d)](https://hearthproject.github.io/hearth-os/)
[![Status](https://img.shields.io/badge/status-phase%201%20MVP-b8471d)](#project-status)
[![License](https://img.shields.io/badge/license-Apache--2.0-1b1815)](LICENSE)

Hearth turns user intent into durable, auditable, and recoverable tasks. It coordinates specialized executors such as Codex, connectors, browsers, and desktop agents, while keeping every external effect behind explicit approvals, idempotency, receipts, and recovery paths.

It is not another coding agent or chat wrapper. It is a task-centric control plane for long-running personal digital work: the user sees tasks and outcomes, while the system owns state, permissions, evidence, budgets, and failure handling.

## Documentation

The complete documentation is published at **<https://hearthproject.github.io/hearth-os/>**. Chinese is the default language and every page has a parallel English version.

- [Design](https://hearthproject.github.io/hearth-os/design/) — positioning, overall design, technology choices, and nine module notes.
- [Delivery route & implementation plan](https://hearthproject.github.io/hearth-os/delivery/) — six phases, 24 small stages, and MVP placement.
- [Development log](https://hearthproject.github.io/hearth-os/log/day-03.html) — one daily summary plus commits, concrete changes, and authors.
- [Appendix](https://hearthproject.github.io/hearth-os/reference/) — engineering, risks, decisions, build boundaries, glossary, checklists, and maintenance notes.

## Project Status

Hearth has entered **Phase 1 (MVP) implementation**. The repository now contains a runnable local control plane built with TypeScript and React, a native Codex executor adapter, an append-only SQLite event log, approval-gated external effects, and a 15-task real-world evaluation suite. The Phase 1 exit requires at least 10 tasks to pass acceptance; current evidence and the per-task acceptance report live in `eval/phase-1-acceptance.md`.

## Repository Layout

```text
apps/                  runnable local control plane
  server/              Fastify API, scheduler, approvals, workspaces, artifacts
  web/                 React UI for tasks, approvals, artifacts, and settings
packages/              shared core, event log, templates, and Codex executor
eval/                  15 real-world tasks, inputs, acceptance criteria, and recorded runs
docs/                  the single source of truth and the VitePress build target
  design/              overall product design, technology choices, and nine module notes
  delivery/            delivery route and six-phase implementation plans
  log/                 daily development logs
  reference/           appendix: engineering, risks, decisions, and maintenance material
  en/                  English mirror of every documentation page
  .vitepress/          site configuration and theme
scripts/               delivery-page generation helpers
```

## Local Development

Requires Node.js 22.13 or newer (the server uses the built-in `node:sqlite` module) and npm.

### Run Hearth

```bash
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. The Vite development server proxies `/api` to the local service on `127.0.0.1:4317`.

For a production-style local run:

```bash
npm run build
npm start
```

Open <http://127.0.0.1:4317>.

### Use Codex without a Codex login

Hearth runs Codex through the Codex SDK, which reads your existing `~/.codex/config.toml`. A `codex login` session is not required when a `model_provider` and its `env_key` are configured: the key only needs to be present in the environment of the terminal that starts Hearth. The Settings page reports the active provider, model, and authentication source, and never sends the key to the browser.

### Data, backup, and stopping

- `.hearth/hearth.sqlite` stores tasks, runs, approvals, effects, and events.
- `.hearth/workspaces/` holds isolated task workspaces.
- `eval/runs/` holds accepted task artifacts.
- The sidebar exposes a global stop/resume switch. Stop aborts active runs into a recoverable state while keeping the queue and approvals.
- Settings can download a consistent SQLite backup and export all task records as JSON. Copy `eval/runs/` and `.hearth/artifacts/` alongside the backup for a complete archive.

### Build the documentation site

```bash
npm run docs:dev
```

Build and preview the production site:

```bash
npm run docs:build
npm run docs:preview
```

The build output is written to `docs/.vitepress/dist` and is not committed.

## Contributing

Hearth is still a specification-stage project. The most useful contributions clarify product boundaries, strengthen protocols, challenge risk assumptions, add real task samples, and make the documentation easier to implement from.

- Read [Contributing & documentation maintenance](https://hearthproject.github.io/hearth-os/reference/contributing.html).
- Read the [delivery route](https://hearthproject.github.io/hearth-os/delivery/) before changing scope or phase goals.
- Open an issue before changing product boundaries, design invariants, or delivery exits.

## License

Apache-2.0. See [LICENSE](LICENSE).

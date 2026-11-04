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
[![Status](https://img.shields.io/badge/status-specification%20%26%20planning-8c8378)](#project-status)
[![License](https://img.shields.io/badge/license-Apache--2.0-1b1815)](LICENSE)

Hearth turns user intent into durable, auditable, and recoverable tasks. It coordinates specialized executors such as Codex, connectors, browsers, and desktop agents, while keeping every external effect behind explicit approvals, idempotency, receipts, and recovery paths.

Hearth is not another coding agent or chat wrapper. It is a task-centric control plane for long-running personal digital work: the user sees tasks and outcomes, while the system owns state, permissions, evidence, budgets, and failure handling.

## Why Hearth

- **Durable by default.** Tasks survive process restarts, disconnects, and partial failures instead of disappearing with a chat session.
- **Evidence before “done.”** A result is complete only when it has a user-visible outcome, persistent state, verification evidence, and a recovery path.
- **Explicit external effects.** Approvals, idempotency, receipts, and reconciliation sit in front of email, calendars, files, browsers, and desktop actions.
- **Executors are interchangeable.** Codex, Native, Connector, Browser, GUI, Document/Data, and Human executors are selected by capability and risk.
- **Local-first and single-user.** Personal data, credentials, memory, and execution history stay under the user’s control.
- **Quiet task cards.** The product is organized around tasks and attention, not dashboards full of internal agent activity.

## Project Status

Hearth is currently in the **specification and planning stage**. The repository contains the complete product, architecture, safety, evaluation, and delivery plan, but implementation has not started.

| Item | Status |
|---|---|
| Documentation | Bilingual Chinese/English site generated from `docs/` |
| Phase | Specification and planning |
| Implementation | Not started |
| Next milestone | Stage 0: product truth, clickable prototype, protocol contracts, and evaluation baseline |
| License | Apache-2.0 |

### Already defined

- Product definition, target user, non-goals, and design principles;
- Eight task families, autonomy levels, and a concrete definition of done;
- Seven planes, domain entities, events, executors, approvals, and receipts;
- Durable execution, human takeover, sandboxing, credentials, memory, and evolution;
- Security, privacy, threat model, evaluation, and stage gates;
- Stage 0–6 product roadmap, 35 development increments, and 140 work packages;
- Engineering structure, risks, Kill Criteria, ADRs, and operational boundaries.

### Not started

- Runnable `hearthd`, `hearth` CLI, and Web interface;
- Stage 0 clickable prototype and real task fixtures;
- The first Codex Executor vertical slice;
- Connector, Browser, GUI, and Document/Data executors;
- Memory OS, Evolution OS, and multi-device synchronization.

## Documentation

The complete documentation is published at **<https://hearthproject.github.io/hearth-os/>**.

All formal documentation lives in one place: [`docs/`](docs/). The site is built directly from that folder. Chinese pages are the default source, and `docs/en/` is the English mirror. There is no second `sources/` documentation tree, so the repository and the published site cannot drift into two different copies. README files are only repository entry points; they summarize and link to the canonical pages instead of duplicating them.

- [中文文档](https://hearthproject.github.io/hearth-os/)
- [English documentation](https://hearthproject.github.io/hearth-os/en/)
- [Full roadmap archive](https://hearthproject.github.io/hearth-os/reference/full-roadmap.html) — the long-form reference inside the same `docs/` source.
- [Documentation map](https://hearthproject.github.io/hearth-os/reference/source-map.html) — directory structure, reading hierarchy, and maintenance rules.

### Start reading

1. [Understanding Hearth](https://hearthproject.github.io/hearth-os/guide/what-is-hearth.html) — positioning, target user, boundaries, and why it is not a Codex wrapper.
2. [Product definition](https://hearthproject.github.io/hearth-os/product/definition.html) — what Hearth does, does not do, and who it serves.
3. [System design](https://hearthproject.github.io/hearth-os/architecture/) — control plane, domain protocols, executors, safety, memory, and evaluation.
4. [Product roadmap](https://hearthproject.github.io/hearth-os/delivery/roadmap.html) — Stage 0–6 scope, exits, and deferrals.
5. [From 0 to 100 development plan](https://hearthproject.github.io/hearth-os/delivery/development-plan.html) — seven modules, 35 increments, and 140 work packages.

### Documentation map

| Area | What you will find | Entry |
|---|---|---|
| Start | Project introduction, reading paths, and current status | [Open](https://hearthproject.github.io/hearth-os/guide/) |
| Product | Definition, principles, task coverage, and completion criteria | [Open](https://hearthproject.github.io/hearth-os/product/) |
| System Design | Architecture, protocols, control plane, executors, safety, memory, evolution, and evaluation | [Open](https://hearthproject.github.io/hearth-os/architecture/) |
| Delivery | Roadmap, development plan, Stage modules, engineering, risks, and ADRs | [Open](https://hearthproject.github.io/hearth-os/delivery/) |
| Development Log | Day-by-day progress, verification evidence, problems, and decisions | [Open](https://hearthproject.github.io/hearth-os/log/) |
| Reference | Boundaries, glossary, checklists, FAQ, contributing, and the full archive | [Open](https://hearthproject.github.io/hearth-os/reference/) |

## Delivery at a Glance

The product roadmap is the master outline. The development plan decomposes it into seven sequential modules, each module contains D increments, and every increment contains four implementation work packages with engineering locations, interfaces, acceptance steps, and failure recovery.

| Stage | Module | Stage exit |
|---|---|---|
| Stage 0 | Definition and prototype | A clickable prototype with stable contracts, real tasks, and an evaluation baseline |
| Stage 1 | Durable kernel and MVP | A locally usable daily MVP with real Codex execution, approvals, artifacts, and recovery |
| Stage 2 | Personal operator | Connector, document/data, and browser loops with approval-gated writes and receipts |
| Stage 3 | Computer operator | Desktop observation, human takeover, and risk-graded GUI actions |
| Stage 4 | Proactive personal agent | Triggers, attention budget, mobile approval, and instant pause |
| Stage 5 | Memory and evolution | Explainable memory, forgetting/export, skill evaluation, promotion, and rollback |
| Stage 6 | Multi-device and operations | Sync, offline queues, device revocation, backup migration, and long-term audit |

**MVP-1 is the early Stage 1 exit.** It must include real execution, durable tasks, Web task cards, artifacts, approval drills, and failure recovery — not a late-stage demo.

## Quick Start

Requirements: Node.js 20 or newer and npm.

Install dependencies and start the local documentation site:

```bash
npm ci
npm run docs:dev
```

Build and preview the production site:

```bash
npm run docs:build
npm run docs:preview
```

The build output is written to `docs/.vitepress/dist`. Do not commit it.

## Repository Layout

```text
docs/                  Single source for the published documentation
  guide/               Project introduction, reading guide, and status
  product/             Product definition, principles, and task coverage
  architecture/        Control plane, protocols, executors, safety, and memory
  delivery/            Roadmap, development plan, Stage modules, engineering, risks, ADRs
  log/                 Development log and daily template
  reference/           Boundaries, glossary, checklists, FAQ, contributing, full archive
  en/                  English mirror of every documentation page
  .vitepress/          Site configuration and theme
scripts/               Delivery-page generation
README.md              English repository entry point
README.zh-CN.md        Chinese repository entry point
package.json           Documentation build scripts and dependencies
```

## Documentation Rules

- **One source:** formal documentation lives only under `docs/`; do not add a second documentation root or archive folder.
- **One site:** the published site is built from `docs/`; there is no separately maintained copy of the same text.
- **Bilingual parity:** every Chinese page has an English mirror with the same path, heading hierarchy, and structure.
- **Archive inside the site:** the full roadmap is a page in `docs/reference/full-roadmap.md`, not another source tree.
- **No premature release labels:** documentation is not a product release; version badges and release notes wait for an actual installable release.
- **Build before pushing:** run `npm run docs:build` and check links and bilingual structure before submitting changes.

## Contributing

Hearth is still at the specification stage. The most valuable contributions are clarifying product boundaries, strengthening protocols, challenging risk assumptions, improving task fixtures, and making the documentation easier for implementers to use.

- Read [Contributing and Documentation Maintenance](https://hearthproject.github.io/hearth-os/reference/contributing.html).
- Browse the [full roadmap archive](https://hearthproject.github.io/hearth-os/reference/full-roadmap.html) before changing scope or stage gates.
- Open an issue to discuss changes that affect product boundaries, architecture invariants, or delivery exits.

## License

Apache-2.0. See [LICENSE](LICENSE).

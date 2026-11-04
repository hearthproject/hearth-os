# Hearth

> A self-hosted personal Agent OS that makes digital work durable, auditable, and recoverable.

[![Docs](https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87%20%7C%20English-2f7fa8)](https://hearthproject.github.io/hearth-os/)

Hearth is a single-user, self-hosted personal Agent OS for long-running digital work. It turns user intent into durable, auditable, and recoverable tasks, orchestrates specialized executors such as Codex, connectors, browsers, and desktop agents, and keeps every external effect behind explicit approvals, idempotency, and receipts.

The repository currently contains the product, architecture, safety, evaluation, and delivery roadmap. Implementation has not started; the roadmap is the source of truth for scope and sequencing.

## Documentation Site

The complete documentation is published at **<https://hearthproject.github.io/hearth-os/>**. Every page is available in Chinese and English, with a one-click language switch in the site navigation.

### Start Here

1. [Understand Hearth](https://hearthproject.github.io/hearth-os/guide/what-is-hearth.html) — positioning, target user, boundaries, and current state.
2. [Read the system design](https://hearthproject.github.io/hearth-os/architecture/) — seven planes, events, durable execution, executors, safety, and evaluation.
3. [Open Stage 0](https://hearthproject.github.io/hearth-os/delivery/stage-0.html) — the first concrete development module.

### Delivery Map

- [Delivery overview](https://hearthproject.github.io/hearth-os/delivery/) — reading order and the three delivery layers.
- [Product roadmap](https://hearthproject.github.io/hearth-os/delivery/roadmap.html) — Stage 0–6 goals, scope, exits, and deferrals.
- [From 0 to 100 development plan](https://hearthproject.github.io/hearth-os/delivery/development-plan.html) — seven modules, prerequisites, steps, increments, and exit gates.
- [Stage 0](https://hearthproject.github.io/hearth-os/delivery/stage-0.html) · [Stage 1](https://hearthproject.github.io/hearth-os/delivery/stage-1.html) · [Stage 2](https://hearthproject.github.io/hearth-os/delivery/stage-2.html) · [Stage 3](https://hearthproject.github.io/hearth-os/delivery/stage-3.html) · [Stage 4](https://hearthproject.github.io/hearth-os/delivery/stage-4.html) · [Stage 5](https://hearthproject.github.io/hearth-os/delivery/stage-5.html) · [Stage 6](https://hearthproject.github.io/hearth-os/delivery/stage-6.html)

### Reference

- [Build vs. integrate](https://hearthproject.github.io/hearth-os/reference/build-vs-integrate.html)
- [Sources & coverage](https://hearthproject.github.io/hearth-os/reference/source-map.html) — every original source mapped to site pages.
- [Full roadmap archive](https://hearthproject.github.io/hearth-os/reference/full-roadmap.html)
- [English edition](https://hearthproject.github.io/hearth-os/en/)

## Repository Layout

```text
docs/                  VitePress documentation site and English mirror
  guide/               Onboarding, reading paths, project status
  product/             Product definition, principles, task coverage
  architecture/        Control plane, executors, safety, memory, evolution
  delivery/            Roadmap, development plan, seven stage modules, engineering, risks, ADRs
  reference/           Boundaries, glossary, checklists, FAQ, source map, full archive
  en/                  English mirror of every documentation page
sources/roadmap/       Original long-form roadmap, chaptered edition, and boundary note
work/                  Coverage and site verification scripts
```

The long-form source roadmap remains available as a complete [archive page](https://hearthproject.github.io/hearth-os/reference/full-roadmap), while the topic pages reorganize the same material for day-to-day reading. The [source map](https://hearthproject.github.io/hearth-os/reference/source-map.html) records the exact mapping and coverage checks.

## Local Development

```bash
npm install
npm run docs:dev
```

Build and preview the production site with:

```bash
npm run docs:build
npm run docs:preview
```

## What Hearth Is

- A task-centric personal Agent OS, not another coding agent or chat wrapper.
- A durable control plane for task state, approvals, recovery, budgets, and evidence.
- A set of interchangeable executors coordinated by capability and risk.
- A local-first system with explicit security and privacy boundaries.
- A staged roadmap from a narrow local MVP to a long-running, multi-device Agent OS.

## Status

The project is at the specification and planning stage. Work begins with Stage 0: product wedge, real task baseline, clickable prototype, contracts, evaluation, and security baseline.

## License

Apache-2.0. See [LICENSE](LICENSE).

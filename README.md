# Hearth

> A self-hosted personal Agent OS that makes digital work durable, auditable, and recoverable.

[![Docs](https://img.shields.io/badge/docs-中文%20%7C%20English-cf5c32)](https://hearthproject.github.io/hearth-os/)

Hearth is a single-user, self-hosted personal Agent OS for long-running digital work. It turns user intent into durable, auditable, and recoverable tasks, orchestrates specialized executors such as Codex, connectors, browsers, and desktop agents, and keeps every external effect behind explicit approvals, idempotency, and receipts.

The repository currently contains the **v3.2 product, architecture, safety, and delivery roadmap**. Implementation has not started yet; the roadmap is the source of truth for scope and sequencing.

## Documentation Site

The complete documentation is published at **<https://hearthproject.github.io/hearth-os/>**. Every page is available in Chinese and English, with a one-click language switch in the site navigation.

- [Start here](https://hearthproject.github.io/hearth-os/guide/)
- [What is Hearth?](https://hearthproject.github.io/hearth-os/guide/what-is-hearth.html)
- [System design](https://hearthproject.github.io/hearth-os/architecture/)
- [Delivery roadmap](https://hearthproject.github.io/hearth-os/delivery/roadmap.html)
- [Build vs. integrate](https://hearthproject.github.io/hearth-os/reference/build-vs-integrate.html)
- [English edition](https://hearthproject.github.io/hearth-os/en/)

## Repository Layout

```text
docs/                  VitePress documentation site and English mirror
  guide/               Onboarding, reading paths, project status
  product/             Product definition, principles, task coverage
  architecture/        Control plane, executors, safety, memory, evolution
  delivery/            Roadmap, development plan, engineering, risks, ADRs
  reference/           Boundaries, glossary, checklists, FAQ, full archive
  en/                  English mirror of every documentation page
sources/roadmap-v3.2/  Original v3.2 roadmap, chaptered edition, and boundary note
```

The long-form roadmap remains available as a complete [archive page](https://hearthproject.github.io/hearth-os/reference/full-roadmap), while the topic pages reorganize the same material for day-to-day reading.

## Local Development

```bash
npm install
npm run docs:dev
```

Build the production site with:

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

The project is at the **specification and planning** stage. Stage 0 and Stage 1 work will follow the vertical-slice plan in the roadmap.

## License

Apache-2.0. See [LICENSE](LICENSE).

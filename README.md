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

It is not another coding agent or chat wrapper. It is a task-centric control plane for long-running personal digital work: the user sees tasks and outcomes, while the system owns state, permissions, evidence, budgets, and failure handling.

## Documentation

The complete documentation is published at **<https://hearthproject.github.io/hearth-os/>**. Chinese is the default language and every page has a parallel English version.

- [Design](https://hearthproject.github.io/hearth-os/design/) — positioning, overall design, technology choices, and nine module notes.
- [Delivery route & implementation plan](https://hearthproject.github.io/hearth-os/delivery/) — six phases, 24 small stages, and MVP placement.
- [Development log](https://hearthproject.github.io/hearth-os/log/day-02.html) — one daily summary plus commits, concrete changes, and authors.
- [Appendix](https://hearthproject.github.io/hearth-os/reference/) — engineering, risks, decisions, build boundaries, glossary, checklists, and maintenance notes.

## Project Status

Hearth is in the **specification and planning stage**. The repository contains the complete product, overall design, safety, evaluation, and delivery plan; implementation has not started.

## Repository Layout

```text
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

Requires Node.js 20 or newer and npm.

```bash
npm ci
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

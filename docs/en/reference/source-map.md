---
title: 'Documentation Map'
description: 'The single documentation source, directory structure, reading hierarchy, bilingual rules, and update workflow for Hearth.'
outline: [2, 3]
---

<p class="eyebrow">DOCUMENTATION MAP</p>

# Documentation Map

<p class="lead">All formal documentation lives only in `docs/`. The documentation site is built directly from this folder, and the README files are repository entry points, so the repository and the published site always contain the same documentation.</p>

## Single Documentation Source

| Content | Only location | Purpose |
|---|---|---|
| Chinese documentation | `docs/` | Default reading path and source of truth for maintenance |
| English mirror | `docs/en/` | Mirrors Chinese paths, heading levels, and structure |
| Site configuration | `docs/.vitepress/` | Navigation, sidebar, theme, and build configuration |
| Full roadmap | `docs/reference/full-roadmap.md` | The only long-form archive page in the site |
| Repository entry | `README.md`, `README.zh-CN.md` | Project introduction and navigation only; no duplicated body text |

> There is no second `sources/` documentation tree. For complete detail, use the in-site [Full Roadmap Archive](/en/reference/full-roadmap) instead of looking for another copy of the original manuscript.

## Documentation Directory

| Area | Content | Entry |
|---|---|---|
| Start | Positioning, reading paths, and current status | [Start Reading](/en/guide/) |
| Product | Definition, design principles, and task coverage | [Product](/en/product/) |
| System Design | Architecture, protocols, control plane, executors, safety, memory, and evaluation | [System Design](/en/architecture/) |
| Delivery | Product roadmap, development plan, Stages and D increments, engineering safeguards | [Delivery](/en/delivery/) |
| Development Log | Daily progress, verification evidence, problems, and decisions | [Development Log](/en/log/) |
| Reference | Boundaries, glossary, checklists, FAQ, contributing, and full archive | [Reference](/en/reference/) |

## Reading Hierarchy

The product roadmap is the master outline, the development plan decomposes it, and the Stage and D increment pages drive construction and acceptance:

1. **The product roadmap** explains why the work matters, what the current stage includes, and when it is complete.
2. **The From 0 to 100 Development Plan** splits the outline into seven sequential modules.
3. **Stage module pages** define prerequisites, stage exits, and what the stage excludes.
4. **D increment pages** provide independently buildable and verifiable vertical slices.
5. **Four work packages** explain implementation steps, engineering locations, interfaces, and failure recovery.

Confirm the current stage's scope and exit before opening a concrete development page; never infer the whole product scope from a single work package.

## Three Reading Paths

### Product and Decisions

1. [Understanding Hearth](/en/guide/what-is-hearth)
2. [Product Definition and Boundaries](/en/product/definition)
3. [Phased Product Roadmap](/en/delivery/roadmap)
4. [From 0 to 100 Development Plan](/en/delivery/development-plan)
5. [Risks and Kill Criteria](/en/delivery/risks)

### Architecture and Technology

1. [System Design Overview](/en/architecture/)
2. [Domain Model and Protocols](/en/architecture/domain-model)
3. [Durable Execution and Recovery](/en/architecture/durable-execution)
4. [Executor Model](/en/architecture/executor-model)
5. [Security and Privacy](/en/architecture/security-privacy)
6. [Evaluation System](/en/architecture/evaluation)

### Start Building

1. [Stage 0 · Definition and Prototype](/en/delivery/stage-0)
2. [Engineering Delivery and Repository Structure](/en/delivery/engineering)
3. [D0.1 · Product Wedge and Real-Task Baseline](/en/delivery/stage-0/d0-1)
4. [Full Roadmap Archive](/en/reference/full-roadmap)

## Topic Pages and the Complete Archive

- Topic pages are the normal path for daily reading and maintenance, organized into product, architecture, delivery, and reference.
- The [Full Roadmap Archive](/en/reference/full-roadmap) preserves long-form detail for search, citation, and comparison.
- The archive and topic pages both live under `docs/`; they are not separate documentation sources.
- When facts, protocols, or stage gates change, update the topic pages, archive, and English mirror together.

## Maintenance Workflow

1. Edit the Chinese page first, confirming that conclusions, boundaries, and links remain accurate.
2. Create or update the English mirror at the same relative path under `docs/en/`.
3. Update related entry points, sidebars, and cross-links so no stale path remains.
4. Run `npm run docs:build` and eliminate build errors and internal dead links.
5. Check long tables, code blocks, mobile widths, and language switching in local preview.

## Pre-Commit Checklist

- Modify formal documentation only under `docs/`; do not add a second documentation root.
- Keep Chinese and English paths aligned with matching heading levels and list counts.
- Preserve the delivery hierarchy: master outline → development plan → Stage → D increment → work package.
- Keep README limited to the project pitch, quick start, and documentation navigation; do not duplicate long-form body text.
- Show no version number, release badge, or formal-release tone in the documentation UI.
- Do not commit `docs/.vitepress/dist`, caches, local secrets, or completion claims without evidence.

## Documentation and Release Boundary

- The current documentation describes specifications, design judgments, and development plans; it does not mean the product has shipped.
- Development logs record real process and verification evidence; they never impersonate product release notes.
- Maintain a formal version number and release notes only after implementation begins and an installable release exists.
- Documentation changes ship through normal pull requests or commits, without a separate “documentation release” process.

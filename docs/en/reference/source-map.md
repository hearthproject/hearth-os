---
title: 'Documentation Map'
description: 'The single documentation source, directory structure, reading hierarchy, bilingual rules, and update workflow for Hearth.'
outline: [2, 3]
---

<p class="eyebrow">DOCUMENTATION MAP</p>

# Documentation Map

<p class="lead">All formal documentation lives only in <code>docs/</code>. The site is built directly from that folder, and the README files are repository entry points, so the repository and the published site always use the same documentation.</p>

## Documentation Map

| Area | Content | Entry |
|---|---|---|
| Design | Positioning, principles, tradeoffs, architecture, and current status | [Design](/en/design/) |
| Architecture | Protocols, control plane, executors, safety, memory, and evaluation | [Architecture Overview](/en/architecture/overview) |
| Delivery | Six phases, 24 small stages, and the MVP | [Delivery Route](/en/delivery/) |
| Development Log | One daily summary plus commits, concrete changes, and authors | [Day02](/en/log/day-02) |
| Appendix | Engineering, risks, decisions, glossary, checklists, and archives | [Appendix](/en/reference/) |

## Reading Hierarchy

1. **Design** explains why the project exists, where its boundaries are, and which tradeoffs matter.
2. **Delivery Route overview** explains the order, goals, and relationships of the six phases.
3. **Phase plans** explain what a large phase must complete and why these things come first.
4. **Small-stage plans** explain the concrete goal, implementation steps, and how completion is judged.

Confirm the current phase's scope and goal before opening a concrete small-stage page; never infer the whole product scope from a single small stage.

## Three Reading Paths

### Understand the Product and Design

1. [Design and Tradeoffs](/en/design/)
2. [Architecture and Data Flow](/en/architecture/overview)
3. [Domain Model and Protocols](/en/architecture/domain-model)
4. [Execution Safety](/en/architecture/execution-safety)
5. [Evaluation](/en/architecture/evaluation)

### Review the Delivery Plan

1. [Delivery Route and Implementation Plan](/en/delivery/)
2. [Phase 1 · Minimum Complete MVP](/en/delivery/stage-1)
3. [1.1 Define the first scenario and real tasks](/en/delivery/stage-1/1-1)

### Start Building

1. [Phase 1 · Minimum Complete MVP](/en/delivery/stage-1)
2. [1.1 Define the first scenario and real tasks](/en/delivery/stage-1/1-1)
3. [Engineering and Repository Layout](/en/reference/engineering)
4. [Risks and Kill Criteria](/en/reference/risks)

## Documentation Hierarchy

- Topic pages are the normal path for reading and maintenance, organized into design, delivery, log, and appendix.
- Delivery has one structure only: overview, large phase plans, and small-stage plans; there is no parallel long-form archive.
- When facts, protocols, or phase goals change, update the Chinese page, the English mirror, and related entry points together.

## Maintenance Workflow

1. Edit the Chinese page first, confirming that conclusions, boundaries, and links remain accurate.
2. Create or update the English mirror at the same relative path under `docs/en/`.
3. Update related entry points, sidebars, and cross-links so no stale path remains.
4. Run `npm run docs:build` and eliminate build errors and internal dead links.
5. Check long tables, code blocks, mobile widths, and language switching in local preview.

## Pre-Commit Checklist

- Modify formal documentation only under `docs/`; do not add a second documentation root.
- Keep Chinese and English paths aligned with matching heading levels and list counts.
- Preserve the hierarchy: overview → large phase → small stage.
- Keep README limited to the project pitch, quick start, and documentation navigation; do not duplicate long-form body text.
- Keep one daily overview and a commit table in development logs; do not restore a log index or template.
- Do not commit `docs/.vitepress/dist`, caches, local secrets, or completion claims without evidence.

## Documentation and Release Boundary

- The current documentation describes specifications, design judgments, and development plans; it does not mean the product has shipped.
- Development logs record a daily overview, commits, specific changes, and authors; they never impersonate product release notes.
- Maintain a formal version number and release notes only after implementation begins and an installable release exists.

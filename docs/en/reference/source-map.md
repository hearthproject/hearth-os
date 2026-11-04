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
| Delivery | Stages 0–6, D increments, work packages, and MVP | [Delivery Route](/en/delivery/) |
| Development Log | One daily summary plus commits, concrete changes, and authors | [Day02](/en/log/day-02) |
| Appendix | Engineering, risks, decisions, glossary, checklists, and archives | [Appendix](/en/reference/) |

## Reading Hierarchy

1. **Design** explains why the project exists, where its boundaries are, and which tradeoffs matter.
2. **Delivery Route** turns the design into Stage 0–6 capability gates and a construction order.
3. **Stage pages** define prerequisites, stage exits, and exclusions.
4. **D increment pages** provide independently buildable and verifiable vertical slices.
5. **Four work packages** explain implementation steps, engineering locations, interfaces, and failure recovery.

Confirm the current stage's scope and exit before opening a concrete development page; never infer the whole product scope from a single work package.

## Three Reading Paths

### Understand the Product and Design

1. [Design and Tradeoffs](/en/design/)
2. [Architecture and Data Flow](/en/architecture/overview)
3. [Domain Model and Protocols](/en/architecture/domain-model)
4. [Execution Safety](/en/architecture/execution-safety)
5. [Evaluation](/en/architecture/evaluation)

### Review the Delivery Plan

1. [Delivery Route and Implementation Plan](/en/delivery/)
2. [Stage 0 · Definition and Prototype](/en/delivery/stage-0)
3. [Stage 1 · Durable Kernel and MVP](/en/delivery/stage-1)
4. [Full Roadmap Archive](/en/reference/full-roadmap)

### Start Building

1. [Stage 0 · Definition and Prototype](/en/delivery/stage-0)
2. [D0.1 · Product Wedge and Real-Task Baseline](/en/delivery/stage-0/d0-1)
3. [Engineering and Repository Layout](/en/reference/engineering)
4. [Risks and Kill Criteria](/en/reference/risks)

## Topic Pages and the Complete Archive

- Topic pages are the normal path for reading and maintenance, organized into design, delivery, log, and appendix.
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
- Preserve the hierarchy: design → delivery → Stage → D increment → work package.
- Keep README limited to the project pitch, quick start, and documentation navigation; do not duplicate long-form body text.
- Keep one daily overview and a commit table in development logs; do not restore a log index or template.
- Do not commit `docs/.vitepress/dist`, caches, local secrets, or completion claims without evidence.

## Documentation and Release Boundary

- The current documentation describes specifications, design judgments, and development plans; it does not mean the product has shipped.
- Development logs record a daily overview, commits, specific changes, and authors; they never impersonate product release notes.
- Maintain a formal version number and release notes only after implementation begins and an installable release exists.

---
title: 'Documentation Map'
description: 'Hearth documentation structure, recommended reading order, maintenance rules, and release boundary.'
outline: [2]
---

# Documentation Map

<p class="lead">All formal documentation lives under `docs/`, and the repository and published site use the same content. Chinese is the default path; English uses the same structure. When you cannot find a kind of information, start here to decide which section to read.</p>

## Site structure

| Area | Content | Entry |
|---|---|---|
| Get started | Local run, model connection, data and backup, development and tests | [Quick start](/en/guide/) |
| Design | One overall design and eleven module notes explaining why the system is shaped this way | [Overall design](/en/design/) |
| Delivery | Phase-one acceptance, phase 2–6 capabilities, remaining roadmap, acceptance rules | [Delivery overview](/en/delivery/) |
| Development log | Day01–Day04 entries with commits, diffstats, and boundaries | [Development log](/en/log/) |
| Reference | Engineering, risk, decisions, build boundaries, terminology, checklists, and maintenance | [Reference](/en/reference/) |
| Site entry | Home page and language switch | [Home](/en/) |

The design section is organised by capability, not by code directory: entrances and experience, tasks and durable execution, control and authority, executors and routing, native agent runtime, approvals and external effects, runtime and safety, memory and capability evolution, evaluation and cost, multi-device and long-running operation, plus agent reference patterns. They are peers and can be read in any order.

## Recommended reading order

For a first read, follow "why", then "what exists now", then "what is missing", then "how to run it":

1. Read the [overall design](/en/design/) for positioning, task path, technology choices, and module boundaries;
2. Read the [delivery overview](/en/delivery/) for the six phases, then enter [Phase-one acceptance](/en/delivery/mvp) or [Phase 2–6 capabilities](/en/delivery/capabilities) as needed;
3. To run it yourself, start with [Quick start](/en/guide/); to connect a model, read [Connect a model](/en/guide/models);
4. To continue development, read the [remaining roadmap](/en/delivery/roadmap), [Acceptance and evidence](/en/delivery/acceptance), and [Engineering](/en/reference/engineering).

To decide quickly whether the project is worth more time, read the positioning section in the overall design and the status table in the delivery overview.

## Maintenance and release rules

1. Change Chinese first and confirm conclusions, boundaries, and links; update the English mirror in the same commit.
2. After changing structure, navigation, or the delivery route, check the reference area, sidebar, home page, language switch, and old links.
3. Do not introduce code paths, internal class names, or implementation examples into design pages; put engineering constraints in the reference area.
4. Delete old pages directly; do not keep redirects or duplicate body text. Search the site for old paths and remove dead links.
5. Run `npm run docs:build`, then check internal links, mobile width, dark mode, and search entries.
6. Do not use "should" or "later" to hide an undecided question. Mark unverified content as a hypothesis or leave it open.

The documentation describes implemented code closures, acceptance evidence already collected, and boundaries still unaccepted. Phases 2–6 have runnable code and automated tests, but no real accounts, real devices, or long-running operation are presented as complete. Development logs record daily work and commits, not release notes. Maintain a formal version number and release notes only after an installable version exists.

The published site should match the build from `docs/`. After every deployment, verify that old addresses are gone, every bilingual page resolves, and the sidebar and home entries point to the new structure.

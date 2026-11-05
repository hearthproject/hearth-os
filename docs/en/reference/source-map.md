---
title: 'Documentation Map'
description: 'Hearth documentation structure, recommended reading order, maintenance rules, and release boundary.'
outline: [2]
---

# Documentation Map

<p class="lead">All formal documentation lives under `docs/`, and the repository and published site use the same content. Chinese is the default path; English uses the same structure. When you cannot find a kind of information, start here to decide which section to read.</p>

## Documentation Map

| Area | Content | Entry |
|---|---|---|
| Design | One overall design and nine parallel module notes, including technology choices | [Overall Design](/en/design/) |
| Delivery | Six phases, 24 small stages, and the MVP position | [Delivery Route](/en/delivery/) |
| Development Log | One daily summary and commit details | [Day03](/en/log/day-03) |
| Appendix | Engineering, risk, decisions, build boundaries, terminology, checklists, and maintenance | [Appendix](/en/reference/) |
| Site entry | Home page and language switch | [Home](/en/) |

The nine design modules are Entrances and Experience, Tasks and Durable Execution, Control and Authority, Executors and Routing, Approvals and External Effects, Runtime and Safety, Memory and Capability Evolution, Evaluation and Cost, and Multi-device and Long-running Operation. They are peers, not a code-directory map.

For a first read, follow "why", then "what comes first", then "how to implement":

1. Read the [overall design](/en/design/) for positioning, task path, technology choices, and module boundaries;
2. Read the nine modules in any order as needed;
3. Read the [delivery route](/en/delivery/) for the six phases and the MVP position;
4. Before implementation, read [Engineering](/en/reference/engineering), [Key Decisions](/en/reference/decisions), and [Risks and Stop Conditions](/en/reference/risks).

To decide quickly whether the project is worth more time, read the positioning section in the overall design and the phase overview in the delivery route. Read the engineering appendix and default checklists only when implementation begins.

## Maintenance and Release Rules

1. Change Chinese first and confirm conclusions, boundaries, and links; update the English mirror in the same commit.
2. After changing design or delivery, check the appendix, navigation, sidebar, home page, and language switch.
3. Do not introduce code paths, internal class names, or implementation examples into design pages; put engineering constraints in the appendix.
4. Delete old pages directly; do not keep redirects or duplicate body text. Search the site for old paths and remove dead links.
5. Run `npm run docs:build`, then check internal links, mobile width, and search entries.
6. Do not use "should" or "later" to hide an undecided question. Mark unverified content as a hypothesis.

The documentation describes product specifications, design judgments, and a development plan; it does not mean the product has shipped. Development logs record daily work and commits, not release notes. Maintain a formal version number and release notes only after an installable version exists.

The published site should match the build from `docs/`. After every deployment, verify that old addresses are gone, every bilingual page resolves, and the sidebar and home entries point to the new structure.

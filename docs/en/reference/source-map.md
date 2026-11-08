---
title: 'Documentation Map'
description: 'Hearth documentation structure, recommended reading order, maintenance rules, and publication boundaries.'
outline: [2]
---

# Documentation Map

<p class="lead">All official documentation lives only in `docs/`, and the repository and the live site use the same content. Chinese is the default path; English mirrors the same structure. When you cannot find a category of information, start here to decide which section to read.</p>

## Site structure

| Area | Content | Entry |
|---|---|---|
| Design | 1 overall design plus 12 parallel module designs, including technology choices and storage architecture | [Overall design](/en/design/) |
| Delivery | Six phases, 24 sub-stages, Phase 2–6 delivery status, and real acceptance boundaries | [Delivery route](/en/delivery/) |
| Development log | Day01–Day05 entries with commits, diffstats, and boundaries | [Day05](/en/log/day-05) |
| Appendix | Engineering, risks, decisions, build-vs-integrate, glossary, checklists, and maintenance material | [Appendix](/en/reference/) |
| Site entry | Home page and language switch | [Home](/en/) |

The twelve design modules are Entrances and Experience, Tasks and Durable Execution, Control and Authority, Executors and Routing, Storage and Context Architecture, Native Agent Runtime, Approvals and External Effects, Runtime and Safety, Memory and Capability Evolution, Evaluation and Cost, Multi-device and Long-running Operation, and Agent Reference Patterns. They are parallel reads, not organized by code directory.

A first pass can follow "why it exists → what exists now → what is still missing → how it is built":

1. Read the [overall design](/en/design/) for product positioning, task flow, technology choices, and module boundaries;
2. Read the twelve modules as needed, in any order;
3. Check the [delivery route](/en/delivery/) for the real state of the six phases: Phase 1 is accepted, while Phases 2–6 have code loops but no real acceptance yet;
4. Before continuing development, read [Engineering](/en/reference/engineering), [Key decisions](/en/reference/decisions), [Risks and stop conditions](/en/reference/risks), and the [Day05 development log](/en/log/day-05).

To judge quickly whether the project is worth a longer read, start with "Product positioning and goals" in the overall design and the phase overview in the delivery route. Read the engineering constraints and default checklists before implementing.

## Maintenance and publication rules

1. Change the Chinese page first, confirm that conclusions, boundaries, and links are accurate, then update the English mirror in the same commit.
2. After changing the design or delivery route, check the appendix, navigation, sidebar, home page, and language switch for consistency.
3. The design section must not contain code paths, internal class names, or implementation examples; keep engineering constraints in the appendix.
4. When removing an old page, take it offline directly without redirects or duplicated bodies; search the whole site for the old path to avoid dead links.
5. Run `npm run docs:build`, then check internal links, mobile width, search, and dark mode.
6. Do not use "should" or "later" to hide an undecided point; mark unverified content as an assumption or leave it blank.

The documentation records implemented code loops, acceptance evidence that exists, and boundaries that are still unverified. Phases 2–6 have runnable code and automated tests, but they are not described as complete without real accounts, real devices, or long-running operation. The development log records each day's work and commits and does not pretend to be a product release note; formal version numbers and release notes appear only after an installable build exists.

The live site must match the build output of `docs/` in the repository. After each publication, check that old addresses are offline, bilingual pages are reachable, and sidebar and home entries point to the correct structure.

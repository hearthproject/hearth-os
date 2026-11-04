---
title: 'Reading Guide'
description: 'The three reading paths through the Hearth documentation, documentation conventions, site map, and source material.'
outline: [2, 3]
---

<p class="eyebrow">READING GUIDE</p>

# Reading Guide

<p class="lead">This documentation is not a book you need to read from start to finish. First choose your role and goal, then follow a path to go deeper; when you need complete details, return to the archived full roadmap.</p>

## Three Reading Paths

### Product and Decision Path

Suitable for reading when learning about the project for the first time, or when you need to decide whether to continue investing:

1. [Understanding Hearth](/en/guide/what-is-hearth)
2. [Product Definition and Boundaries](/en/product/definition)
3. [Phased Product Roadmap](/en/delivery/roadmap)
4. [0 to 100 Development Plan](/en/delivery/development-plan)
5. [Risks and Kill Criteria](/en/delivery/risks)

### Architecture and Technical Path

Suitable for reading when preparing to start implementation, or when you need to check system boundaries:

1. [System Design Overview](/en/architecture/)
2. [Overall Architecture and Data Flow](/en/architecture/overview)
3. [Domain Model and Protocols](/en/architecture/domain-model)
4. [Personal Gateway](/en/architecture/gateway)
5. [Control Plane and Autonomy](/en/architecture/control-plane)
6. [Durable Execution and Recovery](/en/architecture/durable-execution)
7. [Executor Model](/en/architecture/executor-model)
8. [Executor Catalog](/en/architecture/executor-catalog)
9. [Human Takeover and Approval](/en/architecture/human-takeover)
10. [Execution Safety](/en/architecture/execution-safety)
11. [Memory System](/en/architecture/memory)
12. [Skill Evolution](/en/architecture/evolution)
13. [Security and Privacy](/en/architecture/security-privacy)
14. [Evaluation System](/en/architecture/evaluation)

### Direct Start Path

Suitable for reading when you are ready to create a repository and need to find the first vertical slice:

1. [Stage 0 · Definition and Prototype](/en/delivery/stage-0)
2. [Stage 1 · Durable Kernel and MVP](/en/delivery/stage-1)
3. [Durable Execution and Recovery](/en/architecture/durable-execution)
4. [Codex Executor](/en/architecture/executor-catalog)
5. [Engineering Delivery and Repository Structure](/en/delivery/engineering)

## Documentation Conventions

- **Stage is a capability level, not a date.** Each stage can be paused, tried, and rolled back, but steps cannot be skipped.
- **The MVP is an early exit of Stage 1.** It is not a product of Stage 6, nor is it a demo with only a CLI or API.
- **Each increment must be a vertical slice.** User outcomes, interface, durable state, real execution, verification, recovery, and metrics appear together.
- **The full version is archived.** [Full Roadmap](/en/reference/full-roadmap) retains all details; this folder is reorganized by topic, suitable for daily reading and maintenance.
- **Chinese and English remain isomorphic.** Page paths, chapter structure, and navigation hierarchy correspond one-to-one, and can be switched with one click in the upper right corner.

## Sitemap

| Area | Content |
|---|---|
| [Getting Started](/en/guide/) | Project introduction, reading guide, status |
| [Product](/en/product/) | Definition, design principles, task coverage |
| [System Design](/en/architecture/) | Architecture, protocols, control plane, executors, security, memory, evolution, Token, frontend, evaluation |
| [Delivery Roadmap](/en/delivery/) | Stage 0–6, 0–100 plan, engineering, risks, ADR |
| [Reference](/en/reference/) | Self-development boundaries, terminology, checklist, FAQ, contribution, full archive |

## Sources and Maintenance

This site is compiled from the Hearth Personal Agent OS overall roadmap, with the original material archived under `sources/roadmap/` in the repository. If there is any discrepancy between a page and the archived master document, the archived master document and the repository commit history take precedence; if you find structural issues, please submit a PR or explain in a repository Issue.

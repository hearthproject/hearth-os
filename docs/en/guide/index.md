---
title: 'Start Reading'
description: 'Hearth documentation entry point: project introduction, reading paths, documentation structure, and current status.'
outline: [2, 3]
---

<script setup>
const cards = [
  { no: '01', title: 'Understanding Hearth', text: 'A one-sentence positioning, target users, product boundaries, and why it is not just another Codex.', link: '/en/guide/what-is-hearth' },
  { no: '02', title: 'Reading Guide', text: 'Three reading paths, the site map, and the documentation conventions.', link: '/en/guide/reading-guide' },
  { no: '03', title: 'Project Status', text: 'Currently in the specification phase; learn what has been completed, what has not started, and what comes next.', link: '/en/guide/project-status' }
]
</script>

<p class="eyebrow">START HERE</p>

# From Intent to Reliable Tasks

<p class="lead">Hearth is a single-user, self-hosted, long-running personal Agent OS. The documentation site is organized as "product judgment → system design → delivery roadmap → reference appendix," helping you find the layer you need in the shortest time possible.</p>

<DocCardGrid :items="cards" />

## The Bottom Line First

The core of Hearth is not "building another model," but task control, durable execution, memory, verification, approval, receipts, and a quiet task card experience. It turns personal digital labor into an auditable, recoverable, and verifiable execution chain.

The roadmap rests on three core principles:

1. **Build the minimal product first, then the complete OS.** A daily-usable MVP must emerge within Stage 1 itself.
2. **The frontend exists from day one.** Every increment must have a user-visible path, verification, and recovery.
3. **No calendar-based scheduling.** Stages are capability gates, not schedule commitments.

## Three Reading Paths

| Path | Who It's For | Suggested Order |
|---|---|---|
| Product & Decisions | Judging whether to continue investing, needing to understand scope and risks | [Product Definition](/en/product/definition) → [Roadmap](/en/delivery/roadmap) → [Development Plan](/en/delivery/development-plan) → [Risks](/en/delivery/risks) |
| Architecture & Technology | Preparing to start implementation, needing to check system boundaries | [Architecture Overview](/en/architecture/) → [Domain Protocol](/en/architecture/domain-model) → [Control Plane](/en/architecture/control-plane) → [Executor](/en/architecture/executor-model) → [Evaluation](/en/architecture/evaluation) |
| Start Building Directly | Already prepared to create the repository, needing to find the first vertical slice | [Stage 0](/en/delivery/stage-0) → [Stage 1](/en/delivery/stage-1) → [Durable Execution](/en/architecture/durable-execution) → [Codex Executor](/en/architecture/executor-catalog) |

## Documentation Structure

- **Start**: Project introduction, reading approach, and current status.
- **Product**: Definition, design principles, task coverage, and completion criteria.
- **System Design**: Overall architecture, domain model, control plane, executor, security, memory, evolution, Token economy, frontend, and evaluation.
- **Delivery Roadmap**: The product roadmap master, seven Stages, 35 D increments, engineering structure, and risks.
- **Development Log**: Day01 and Day02 records of real progress, verification evidence, problems, and next steps, plus a copyable daily template.
- **Reference**: Build-vs-integrate boundaries, glossary, default checklist, FAQ, contribution guide, and the complete roadmap archive.

The complete main document is preserved on the [archive page](/en/reference/full-roadmap). For daily reading, we recommend the topic-based pages. The documentation site and every formal page come from the same `docs/` folder; see the [Documentation Map](/en/reference/source-map) for the full structure.

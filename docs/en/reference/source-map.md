---
title: 'Sources & Coverage'
description: 'A page-by-page mapping of the Hearth roadmap, ten volumes, build-vs-integrate note, and volume README to this site.'
outline: [2, 3]
---

<p class="eyebrow">SOURCES & COVERAGE</p>

# Sources & Coverage

<p class="lead">This site is not a set of disconnected articles; it is a topic-based reorganization of the original roadmap material. This page shows where every source document lives and which original conclusions are preserved.</p>

## Coverage Result

| Audit item | Result |
|---|---|
| Source material | One complete master document, ten volumes, one build-vs-integrate note, and one volume README |
| Ten volumes | Every substantive block is present verbatim in the Chinese site; coverage is 100% |
| Complete master document | 595/595 substantive blocks preserved; coverage is 100% |
| Build-vs-integrate note | 67/67 substantive blocks preserved; coverage is 100% |
| Bilingual structure | Every Chinese page has an English page with a matching path and heading hierarchy |

The audit works at the level of substantive blocks, not sampled character counts. The original long-form document also remains in the [full roadmap archive](/en/reference/full-roadmap). Topic pages reduce reading cost; the archive preserves complete detail.

## Original Volume README: Conclusions and Reading Paths

Hearth is a single-user, self-hosted, long-running, low-interruption, low-Token general-purpose personal Agent OS. Its core is not "another model"; it is task control, durable execution, memory, verification, approvals, receipts, and a quiet task-card experience.

The roadmap rests on three core principles:

1. **Build the smallest product first, then the complete OS.** A daily-usable MVP must appear inside Stage 1, not wait until Stage 6.
2. **The frontend exists from day one.** Stage 0 has a clickable prototype, and Stage 1 has real Web task cards; every increment needs a user-visible path, verification, and recovery.
3. **Stop planning by week or month.** Chapter 25 is the complete Stage 0–6 progressive development sequence, driven only by capability gates and with no development time limit.

### Product and Decision Path

For a first introduction to the project, or when deciding whether to continue investing:

1. [Product Definition and Design Judgment](/en/product/definition)
2. [Phased Product Roadmap](/en/delivery/roadmap)
3. [From 0 to 100 Development Plan](/en/delivery/development-plan)
4. [Engineering Delivery, Risk, and Decisions](/en/delivery/engineering)

### Architecture and Technology Path

For preparing implementation or checking system boundaries:

1. [Overall Architecture and Domain Protocols](/en/architecture/overview)
2. [Entry, Control Plane, and Durable Execution](/en/architecture/control-plane)
3. [Executor System and Human Takeover](/en/architecture/executor-model)
4. [Execution Safety, Memory, and Evolution](/en/architecture/execution-safety)
5. [Token Economics and Frontend Experience](/en/architecture/token-economics)
6. [Security, Privacy, and Evaluation](/en/architecture/security-privacy)

### Direct Build Path

For readers ready to create the repository:

1. The MVP and Stage 1 sections of the [From 0 to 100 Development Plan](/en/delivery/development-plan)
2. [Overall Architecture and Domain Protocols](/en/architecture/domain-model)
3. [Entry, Control Plane, and Durable Execution](/en/architecture/durable-execution)
4. [Engineering Delivery, Risk, and Decisions](/en/delivery/engineering)

## Source Material to Site Pages

| Volume | Corresponding master chapters | What you can answer after reading |
|---|---|---|
| [01 Product Definition and Design Judgment](/en/product/definition) | Chapters 0–3 | Who Hearth is for, what it does, what it does not do, and why it is not a Codex wrapper |
| [02 Overall Architecture and Domain Protocols](/en/architecture/overview) | Chapters 4–5 | How the seven planes cooperate and what the core entities and protocols are |
| [03 Entry, Control Plane, and Durable Execution](/en/architecture/gateway) | Chapters 6–8 | How events enter, how they are authorized, and how execution and recovery stay reliable |
| [04 Executor System and Human Takeover](/en/architecture/executor-model) | Chapters 9–16 | How Codex, Native, Connector, Browser, GUI, Document/Data, and Human divide work |
| [05 Execution Safety, Memory, and Evolution](/en/architecture/execution-safety) | Chapters 17–19 | How Sandbox, credentials, side effects, memory, and skill evolution stay controlled |
| [06 Token Economics and Frontend Experience](/en/architecture/token-economics) | Chapters 20–21 | How Tokens are controlled and why users only see tasks |
| [07 Security, Privacy, and Evaluation](/en/architecture/security-privacy) | Chapters 22–23 | The trust boundaries, threat model, evaluation, and stage gates |
| [08 Phased Product Roadmap](/en/delivery/roadmap) | Chapter 24 | What Stages 0–6 deliver and when each is complete |
| [09 From 0 to 100 Development Plan](/en/delivery/development-plan) | Chapter 25 | The build order, MVP contents, and acceptance method for each increment |
| [10 Engineering Delivery, Risk, and Decisions](/en/delivery/engineering) | Chapters 26–29 | How to lay out the repository, when to stop, and the ADRs and final judgment |

### Additional Sources

| Source | Site entry | Treatment |
|---|---|---|
| Complete master document | [Full Roadmap Archive](/en/reference/full-roadmap) | Preserves every detail for search, citation, and difference checks |
| Build-vs-integrate note | [Build vs. Integrate Boundary](/en/reference/build-vs-integrate) | Preserves the boundary conclusions, OpenClaw comparison, and Codex integration rules |
| Volume README | [Start Reading](/en/guide/), [Reading Guide](/en/guide/reading-guide), and this page | Preserves conclusions, three reading paths, the ten-volume catalog, and the one-page map |

## One-Page Map from 0 to 100

```text
Stage 0  Product wedge + clickable prototype + protocol/evaluation baseline
   ↓
Stage 1  Walking skeleton → first real Codex slice → MVP → side-effect safety → second task family
   ↓
Stage 2  Read-only connectors → docs/data → browser → drafts/approvals/receipts → daily operator
   ↓
Stage 3  Device agentd → observe/takeover → low-risk GUI → high-risk GUI
   ↓
Stage 4  Trigger/proactive inbox → mobile PWA → secure pairing → attention budget
   ↓
Stage 5  Memory Core → forgetting/export → skill candidates/evaluation → promotion/rollback
   ↓
Stage 6  Multi-device sync → offline queue → revocation/keys → backup migration → v1.0
```

"100%" does not mean never iterating again; it is the v1.0 exit of Stage 6: a complete product that is recoverable, approvable, portable, revocable, and usable long term.

## Coverage and Maintenance Rules

- **The master document** preserves every detail; volumes support topic-by-topic reading and do not replace it.
- Every volume states its corresponding master chapters and prerequisite reading at the top.
- "Stage" is a capability level, not a date; an "increment" is a development unit, not a schedule commitment.
- Every stage gate must include user-visible UI, durable state, verification evidence, and recovery paths.
- Capabilities that exist only in a CLI, log, or database do not count as stage completion.

When source documents change, update the topic pages, complete archive, and English mirror together. The coverage audit script lives at `scripts/check-coverage.py`; it must never be weakened by deleting source prose.

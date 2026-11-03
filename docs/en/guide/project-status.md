---
title: 'Project Status'
description: 'The current version of Hearth, what has been completed, what has not yet started, and the next-phase plan.'
outline: [2, 3]
---

<p class="eyebrow">PROJECT STATUS</p>

# Project Status

<p class="lead">Hearth is currently in the specification and roadmap stage. The repository already contains a complete product, architecture, security, evaluation, and delivery plan, but implementation has not yet begun.</p>

## Current Version

| Item | Status |
|---|---|
| Documentation version | v3.2 |
| Repository | `hearthproject/hearth-os` |
| Phase | Specification & planning |
| Implementation | Not yet started |
| Next milestone | Stage 0: Product truth, prototype, protocols, and evaluation baseline |
| License | Apache-2.0 |

## Completed

- Product definition, non-goals, and primary users;
- Coverage of eight Task categories, autonomy levels, and the definition of “done”;
- Seven planes, domain entities, Event, Executor, and Receipt protocols;
- Entry point, Control Plane, Durable Harness, Executor, and human takeover design;
- Execution security, memory, evolution, Token economics, frontend, and mobile experience;
- Security, privacy, threat model, and evaluation framework;
- Stage 0–6 product roadmap and a progressive development plan from 0 to 100;
- Engineering structure, risks, Kill Criteria, ADR index, and appendices;
- A deployable bilingual Chinese/English documentation site.

## Not Started

- A runnable `hearthd`, `hearth` CLI, and Web interface;
- Stage 0 clickable prototype and real data contracts;
- The first real slice of Codex Executor;
- Connector, Browser, GUI, and Document/Data Executors;
- Memory OS, Evolution OS, and multi-device synchronization.

## Next Steps

The goal of Stage 0 is not to “write more documentation,” but to pin down the product, interaction, protocols, and acceptance criteria:

1. Select the first high-frequency, low-external-risk Task family;
2. Produce a clickable end-to-end Web prototype;
3. Define projection fields and primary actions for each UI state;
4. Freeze schema v0 for Event, Task, Run, Executor, Approval, and Receipt;
5. Establish an evaluation Task set, validators, and a threat model baseline.

See the [Development Plan](/en/delivery/development-plan) for Stage 0 exit criteria, the increment checklist, and the acceptance template.

## How to Follow Along

- Read the [phased product roadmap](/en/delivery/roadmap) to understand the capability thresholds;
- Read the [0 to 100 development plan](/en/delivery/development-plan) to understand the first implementation sequence;
- Follow repository commits and Issues;
- If you want to contribute to documentation or implementation, please read [Contributing and Documentation Maintenance](/en/reference/contributing) first.

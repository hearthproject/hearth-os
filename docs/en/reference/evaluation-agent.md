---
title: 'Evaluation Agent (Standalone Repository)'
description: 'Entry points for the standalone Hearth evaluation agent, the main-service bridge, local startup, and verification commands.'
outline: deep
---

# Evaluation Agent (Standalone Repository)

<p class="lead">The evaluation agent has moved out of the main Hearth repository and is maintained as a standalone project. The task corpus, experiment orchestration, full-lifecycle console, scoring, human review, comparison, and scenario runner now live in <a href="https://github.com/hearthproject/hearth-eval">hearthproject/hearth-eval</a>. The main repository keeps only the controlled task and judge bridge.</p>

## Entry points

- **Repository:** <https://github.com/hearthproject/hearth-eval>
- **Evaluation documentation:** <https://hearthproject.github.io/hearth-eval/>
- **Local console:** after starting the evaluation service, open `http://127.0.0.1:5174`
- **Evaluation API:** `http://127.0.0.1:4318`

## What moved out

- `apps/eval-server`: experiment orchestration, SQLite, scoring, review, comparison, and SPA hosting;
- `apps/eval-web`: 11 pages covering overview, task catalog, experiments, run detail, review queue, comparison, activity, and system status;
- `packages/eval-core`: case contracts, catalog loading, graders, scoring, and scenario statistics;
- `eval/`: 60 cases, inputs, golden files, historical run evidence, and phase-one acceptance material;
- the white-box scenario runner previously stored under `apps/server/src/scenarios`;
- the evaluation README, documentation site, and deployment configuration.

## Bridge retained by the main repository

| Endpoint or setting | Purpose |
|---|---|
| `POST /api/eval/tasks` | Create or reuse a controlled evaluation task by stable `externalRef` |
| `POST /api/eval/judge` | Run model-rubric scoring against registered task artifacts |
| `HEARTH_EVAL_INPUT_ROOT` | Allowlisted evaluation input root, which can point at the standalone repository's `eval/` directory |
| `.hearth/eval-artifacts/` | Managed artifact root written by controlled standalone evaluation runs |

Task creation, executors, approvals, memory, scheduling, and product artifacts remain owned by the main repository. The evaluation service does not create a second Agent execution path.

## Local startup

Run the main service and the evaluation service side by side:

```powershell
# hearth-os\.env
HEARTH_EVAL_INPUT_ROOT=D:\App\hearth-eval\eval
```

```powershell
cd D:\App\hearth-os
npm run dev
```

```powershell
cd D:\App\hearth-eval
npm install
Copy-Item .env.example .env
$env:HEARTH_EVAL_ARTIFACT_ROOT='D:\App\hearth-os\.hearth\eval-artifacts'
npm run dev
```

The first evaluation-service startup only validates the case catalog, synchronizes versions, and recovers interrupted runs. It never starts an experiment automatically. `HEARTH_EVAL_ARTIFACT_ROOT` must match the artifact root the main service actually writes; without it, run detail cannot find registered artifacts and incorrectly reports `BLOCKER_FAILED: exists`. After a restart, confirm `artifactRoot` through `GET /api/system` before starting an experiment.

## Native 30-case results

From 2026-11-11 to 11-12, 30 offline cases ran with `native` only, one repetition, auto-scoring and auto-retry, and concurrency 4:

| Metric | Result |
|---|---:|
| Best complete run | **18/30 (60%)**, average 88.89, `EXP-20261111145332-7a95ea` |
| Cumulative targeted confirmation | **19/30**, not one continuous experiment |
| Most recent complete run | 12/30 (40%), average 73.33, `EXP-20261112003215-b1172b` |
| Final fix commit | `eb32ad5`, not yet retested continuously |

The most recent complete run was affected by provider instability, truncated scoring JSON, and timeouts, and it predates the final four normalization fixes. See [Evaluation and Results](/en/evaluation/) for the detailed boundaries and retest guidance.

## Verification

Main repository:

```bash
npm test
npm run typecheck
npm run build
npm run docs:build
```

Evaluation repository:

```bash
npm test
npm run typecheck
npm run typecheck:scenarios
npm run build
npm run docs:build
```

Neither repository's automated checks execute a real evaluation experiment or predeclare a passing result.
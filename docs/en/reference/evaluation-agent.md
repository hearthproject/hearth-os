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
- `apps/eval-web`: task catalog, experiments, run detail, review queue, comparison, and system views;
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
npm run dev
```

The first evaluation-service startup only validates the case catalog, synchronizes versions, and recovers interrupted runs. It never starts an experiment automatically. Real pass rates, executor differences, and cost data must come from experiments you run.

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
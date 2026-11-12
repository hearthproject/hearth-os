---
title: 'Evaluation and Results'
description: 'Entry point to the standalone evaluation stack, native 30-case results, reproduction steps, and boundaries that scores must not hide.'
outline: [2, 3]
---

# Evaluation and Results

<p class="lead">Evaluation answers a specific question: for the same real tasks, across executors, repetitions, and run modes, what changed in pass rate, quality, duration, tokens, and approvals? It is not a demo that proves capability.</p>

## Where the evaluation stack lives

The evaluation code is maintained in the standalone [hearthproject/hearth-eval](https://github.com/hearthproject/hearth-eval) repository:

- `apps/eval-server`: experiment orchestration, SQLite, scoring, review, comparison, and SPA hosting;
- `apps/eval-web`: overview, task catalog, experiments, run detail, reviews, comparison, activity, and system status;
- `packages/eval-core`: case contracts, catalog loading, graders, scoring, and scenario statistics;
- `eval/cases`: 60 cases with inputs and golden files;
- `scenario-runner`: 30 white-box integration scenarios that read the sibling Hearth source.

The main repository keeps only a minimal bridge: `POST /api/eval/tasks`, `POST /api/eval/judge`, `HEARTH_EVAL_INPUT_ROOT`, and `.hearth/eval-artifacts/`. The evaluation service does not create a second Agent execution path and does not bypass approvals, sandboxing, or permissions.

## Native 30-case results

From 2026-11-11 to 11-12, 30 offline cases (evenly sampled from eight task families) ran with the `native` executor only, one repetition, auto-scoring and auto-retry enabled, and concurrency 4:

| Metric | Result |
|---|---:|
| Best complete run | **18/30 passed (60%)**, average score 88.89 |
| Cumulative targeted confirmation | **19/30** cases reached 100 at least once |
| Most recent complete run | 12/30 passed (40%), average score 73.33 |
| Final fix commit | `eb32ad5`, not yet retested in one uninterrupted 30-case run |

The best run is `EXP-20261111145332-7a95ea`; the most recent complete run is `EXP-20261112003215-b1172b`. The cumulative 19/30 comes from different runs and targeted retries, not one continuous experiment, so it is not an official single-run result.

The most recent complete run was affected by slow provider responses, truncated scoring JSON, and task timeouts, and it predates the final four normalization fixes. Its 40% cannot be treated as the final code capability. Cases such as CAL01 and WEB01 still have semantic ambiguity between input and rubric; T02, T11, and WEB03 reached 100 but were marked `sampled` and were not counted as formal passes.

## Reports

- [Native 30-task final evaluation report (2026-11-12)](/evaluation/native-30-final-report-2026-11-12) — configuration, complete-run summary, per-task results, fixes, risks, and retest guidance. The report is in Chinese.
- [Native 30-task baseline evaluation (2026-11-11)](/evaluation/native-30-baseline-2026-11-11) — the invalid 0/30 baseline caused by a missing tool allowlist, and how the bridge failure was isolated. The report is in Chinese.

## Reproducing

The main service must allow the evaluation service to read case inputs:

```powershell
# hearth-os\.env
HEARTH_EVAL_INPUT_ROOT=D:\App\hearth-eval\eval
```

The evaluation service must set the artifact root explicitly; otherwise it cannot find registered artifacts and incorrectly reports `BLOCKER_FAILED: exists`:

```powershell
$env:HEARTH_EVAL_ARTIFACT_ROOT='D:\App\hearth-os\.hearth\eval-artifacts'
```

Then open the console at `http://127.0.0.1:5174`, select 30 offline cases, the `native` executor, one repetition, offline mode, auto-scoring, and auto-retry, and start the experiment. After a restart, confirm `artifactRoot` through `GET /api/system` before starting another experiment.

## What a score does not prove

- Automated tests and scenario passes prove the control plane, scoring logic, and failure boundaries, not real pass rates.
- Offline cases do not cover real mail accounts, real calendars, real desktop devices, or `live-only` tasks.
- Unavailable judges, judge conflicts, and sampled reviews enter `needs_review`; they are never silently counted as passes.
- Commit `eb32ad5` still lacks one uninterrupted 30-case run. Every single-run number must be reported with its experiment ID, commit, and run conditions.

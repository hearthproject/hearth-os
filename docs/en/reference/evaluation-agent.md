---
title: 'Evaluation Agent'
description: 'The task corpus, architecture, startup flow, scoring, human review, and safety boundaries of the standalone Hearth evaluation agent.'
outline: deep
---

# Evaluation Agent

<p class="lead">Evaluation in Hearth is not a collection of disconnected scripts. It is a control plane separate from the main agent that connects the case catalog, experiment orchestration, run traces, deterministic grading, model judging, human review, artifact browsing, and experiment comparison into one closed loop. The main service exposes only controlled task-creation and judge endpoints; the evaluation service schedules and records work; the evaluation frontend makes the whole lifecycle visible.</p>

## Goal And Boundaries

The evaluation agent answers a concrete question: how do success rate, quality score, duration, tokens, and approvals change for the same real tasks across executors, repetitions, and run modes? It follows three rules:

- **Reproducible**: cases have versions and content hashes, while experiments snapshot executors, mode, repetitions, concurrency, judge model, and Hearth schema information.
- **Traceable**: every run keeps its Hearth task ID, event stream, grading evidence, and artifact directory.
- **Correctable**: blockers, unavailable judges, and low-confidence results do not silently pass; they enter human review.

Evaluation does not replace deterministic unit, integration, or end-to-end tests. Tests are the gate on every commit; evaluation is a repeated quality measurement over a real task corpus.

## Current Corpus

`eval/cases/` currently contains **60 cases across 8 task families**. Each case has a `case.json` manifest that declares its goal, inputs, expected outputs, graders, scoring criteria, and human-review policy.

| Family | Cases | Focus |
|---|---:|---|
| `documents` | 9 | Document generation, structured rewriting, deliverable completeness |
| `email` | 8 | Classification, drafting, replies, and extraction |
| `research` | 8 | Multi-source retrieval, synthesis, citations, uncertainty |
| `code` | 8 | Code changes, tests, failure diagnosis, edge handling |
| `web` | 8 | Web reading, forms, and browser tasks |
| `calendar` | 7 | Schedule parsing, conflicts, and timezone edges |
| `cross-app` | 7 | Cross-application information flow and state consistency |
| `desktop` | 5 | Desktop observation, controlled input, and local operations |

The current difficulty mix is 24 `normal`, 25 `edge`, 6 `adversarial`, and 5 `failure` cases. The catalog includes 57 offline-capable cases, 3 `live-optional` cases, and 3 `live-only` cases. Scoring currently contains 120 deterministic criteria, 60 judge criteria, and 60 human criteria.

> These counts come from the current `eval/cases/` directory. The evaluation service validates and syncs the catalog on startup. A directory name must match the manifest `id`, and inputs plus golden artifacts must pass path and content checks.

## Architecture And Ports

```text
┌──────────────────────────┐      /api/eval/tasks       ┌──────────────────────────┐
│ Hearth main service      │ <───────────────────────── │ Evaluation service       │
│ Fastify · 4317           │      /api/eval/judge       │ Fastify · 4318           │
│ tasks, executors, model  │ ─────────────────────────> │ orchestration, storage   │
└──────────────────────────┘                            └─────────────┬────────────┘
                                                                      │
                                       ┌──────────────────────────────┴──────────────────────────────┐
                                       │ SQLite: .hearth/eval/eval.sqlite                            │
                                       │ Artifacts: .hearth/eval-artifacts/<experiment>/<case>/...   │
                                       └──────────────────────────────┬──────────────────────────────┘
                                                                      │ /api/*
                                                         ┌────────────▼────────────┐
                                                         │ Evaluation frontend      │
                                                         │ React/Vite · 5174        │
                                                         └─────────────────────────┘
```

| Entry | Default address | Purpose |
|---|---|---|
| Hearth main service | `http://127.0.0.1:4317` | Creates real tasks, reports executor health, calls the judge model |
| Evaluation service | `http://127.0.0.1:4318` | Orchestrates experiments and exposes storage, scoring, review, and comparison APIs |
| Evaluation frontend dev server | `http://127.0.0.1:5174` | React console; proxies `/api` to `4318` in development |
| Evaluation production entry | `http://127.0.0.1:4318` | Evaluation service serves the built SPA directly |

## Running The Stack

### Local Development

Install dependencies at the repository root, then start the main service and evaluation stack:

```bash
npm install
npm run dev          # Hearth main service on 4317 + main web
npm run dev:eval     # evaluation service on 4318 + evaluation web on 5174
```

The services can also be started separately:

```bash
npm run dev:eval-server
npm run dev:eval-web
```

On startup, the evaluation service only validates and syncs the case catalog, recovers interrupted runs, and waits for the user to create an experiment. **Starting the service never starts an evaluation task automatically.**

When Hearth is offline, the frontend can still browse the catalog and history, but the System page reports the service as unreachable and the executor list is empty. The UI cannot complete an experiment without an executor; a direct API request can create a record, but execution will fail because Hearth is unreachable.

### Production Build

```bash
npm run build:eval-web
npm run start:eval
```

The build output is `apps/eval-web/dist/`. When the evaluation service detects `index.html`, it serves the console on `4318`. Non-`/api` GET routes fall back to the SPA, while missing `/api/*` routes still return JSON 404.

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `HEARTH_EVAL_HOST` | `127.0.0.1` | Evaluation service bind address |
| `HEARTH_EVAL_PORT` | `4318` | Evaluation service port |
| `HEARTH_URL` | `http://127.0.0.1:4317` | Hearth main-service URL |
| `HEARTH_EVAL_DATA_DIR` | `.hearth/eval` | Evaluation SQLite directory |
| `HEARTH_EVAL_ARTIFACT_ROOT` | `.hearth/eval-artifacts` | Evaluation artifact root |
| `HEARTH_EVAL_CASES_DIR` | `eval/cases` | Case directory |

## Full Experiment Lifecycle

The frontend presents one lifecycle for every experiment:

| Stage | What the user sees | Source |
|---|---|---|
| Queued | Experiment is `queued`; no Hearth task exists yet | Experiment and run records |
| Task created | Each run gets a stable `externalRef` and submits a controlled task | `POST /api/eval/tasks` |
| Agent executing | Hearth executes while the evaluation service polls status | `GET /api/tasks/:id` |
| Waiting | The task is waiting, approving, or converging | Hearth task view |
| Grading | Deterministic graders, model judge, score projection, review triggers | Grader results and scorer |
| Human review | Blockers, low confidence, judge conflicts, failed samples, or samples enter the queue | `/api/reviews` |
| Complete | Summary of pass rate, score, duration, tokens, retries, approvals, and family deltas | Experiment summary |

Run states are `queued`, `created`, `running`, `waiting`, `grading`, `needs_review`, `passed`, `failed`, `blocked`, `cancelled`, and `error`. Experiments aggregate them into `queued`, `running`, `grading`, `needs_review`, `completed`, `failed`, and `cancelled`.

### Creating An Experiment

On the New Experiment page, select:

1. **Cases**: filter by family, difficulty, run mode, or search, then select the current result set.
2. **Executors**: only executors detected by Hearth are listed; unavailable executors show the reason.
3. **Run parameters**: 1–5 repetitions, concurrency 1–8, and offline or live mode.
4. **Grading options**: automatic model judging and one retry on a temporary judge failure.
5. **Baseline experiment**: optional; it supports later comparison but does not automatically mark a result as improved.

The number of runs is `cases × executors × repetitions`. Submission immediately opens the experiment detail page, and the primary action explicitly states that real execution will start.

### Trace And Artifact Inspection

The run detail page shows:

- status, score, duration, retries, approvals, errors, and review reasons;
- the Hearth task view and raw task state;
- the complete event stream from task creation through grading and review;
- every grader result with source, pass state, score, reason, confidence, and evidence;
- artifact paths, text previews, and byte sizes;
- human-review history and the review form.

Artifact preview is confined to that run's own output directory and the configured artifact root. Symlinks and path traversal are rejected.

### Human Review

The review queue contains runs that need human judgment and have not been reviewed:

- `blocker_anomaly`: a deterministic blocker is missing or anomalous;
- `failed_sample`: a failed run needs confirmation;
- `judge_unavailable`: a judge criterion was required but the model was unavailable;
- `judge_conflict`: deterministic and judge conclusions disagree;
- `low_confidence`: judge confidence is below the threshold or a reviewer chose `unknown`;
- `sampled`: the case sampled this run for review.

A review decision is `pass`, `fail`, or `unknown`. `pass` and `fail` recompute the run and clear the triggers; `unknown` leaves it pending. The record keeps the reviewer, decision, score, note, and update time.

## Scoring

Each case divides criteria into three sources:

- **deterministic**: file existence, text inclusion, JSON/CSV structure, artifact count, and other repeatable checks;
- **judge**: model evaluation against a rubric, returned with per-criterion conclusions and confidence;
- **human**: judgment confirmed by a reviewer and stored as a human grader result.

The default weights are 60 deterministic, 30 judge, and 10 human. The final score is normalized over the available weights, and the pass threshold is **80**. Any failed blocker produces `failed` with a score of 0 instead of hiding the failure in an average.

If auto-judging is enabled and the model is unavailable, the run enters `needs_review` rather than pretending to pass. Automatic retry only handles temporary judge failures; it does not change case criteria.

## Main-Service Evaluation Contract

The evaluation service accesses Hearth through two dedicated endpoints.

### `POST /api/eval/tasks`

The request includes `externalRef`, title, goal, inputs, expected outputs, executor, run mode, network allowlist, output directory, and timeout. Key rules:

- input files must live under the repository `eval/` directory; offline mode rejects URL inputs;
- the output directory must be a repository-relative path under `.hearth/eval-artifacts/`;
- expected outputs must be safe relative paths without absolute paths or `..`;
- repeating the same request for one `externalRef` is idempotent; different content returns `409 EVAL_REQUEST_CONFLICT`;
- tasks store both `externalRef` and the request hash, so deduplication survives restarts.

### `POST /api/eval/judge`

The request includes a task ID, judge criteria, deterministic outcomes, and locale. Hearth reads the task's registered text artifacts, builds a strict JSON prompt, calls the configured chat model, and returns the model, prompt hash, per-criterion conclusions, overall confidence, and token usage. A missing model returns `503 JUDGE_UNAVAILABLE`; a failed call returns `502 JUDGE_FAILED`.

## Control-Plane API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Evaluation-service liveness and case count |
| `GET` | `/api/system` | Hearth connectivity, judge model, executor health, data paths |
| `GET` | `/api/dashboard` | Hero summary, recent experiments, pending reviews, active runs |
| `GET` | `/api/cases` | Catalog with family, difficulty, runMode, and search filters |
| `GET` | `/api/cases/:caseKey` | Case detail, full manifest, and golden availability |
| `GET` | `/api/experiments` | Experiment list |
| `POST` | `/api/experiments` | Create and start an experiment |
| `GET` | `/api/experiments/:id` | Experiment, runs, summary, and events |
| `POST` | `/api/experiments/:id/cancel` | Cancel a queued or running experiment |
| `GET` | `/api/runs/:id` | Run, case, graders, review, events, artifacts, and Hearth task |
| `GET` | `/api/reviews` | Human-review queue |
| `POST` | `/api/runs/:id/review` | Submit a human review |
| `GET` | `/api/compare` | Two summaries plus family deltas and alignment warnings |
| `GET` | `/api/events` | Incremental event stream with experimentId, runId, after, and limit |
| `GET` | `/api/runs/:id/artifacts/*` | Controlled artifact preview |

Comparison does not stop at average score. If run mode, repetitions, executor set, or case set differ, the response includes `aligned: false` and explicit warnings. Family pass-rate deltas are reported separately so incomparable experiments are not presented as an improvement.

## Data And Safety Boundaries

| Path | Content |
|---|---|
| `.hearth/eval/eval.sqlite` | Case versions, experiments, runs, graders, human reviews, and events |
| `.hearth/eval-artifacts/<experiment>/<case>/<executor>/r<n>` | One run's artifacts and evidence |
| `eval/cases/<caseId>/` | Inputs, `case.json`, `golden/`, and optional live inputs |

The evaluation service does not accept arbitrary local input paths, does not write outside the repository, and does not mix evaluation artifacts with main-task artifacts. Offline mode does not use the network; live mode passes only the hosts declared by the case. Recovery marks interrupted runs instead of treating incomplete work as passed.

## Verification

Development checks do not create experiments:

```bash
npx vitest run packages/eval-core/src
npx vitest run apps/eval-server/src
npx tsc -p apps/eval-web/tsconfig.json --noEmit
npm run build:eval-web
```

The dashboard, case catalog, experiment detail, run trace, review queue, comparison, activity, and system views are wired into the console. Real pass rates, executor differences, and cost data must come from experiments the user runs. **The code revision behind this page did not execute a real evaluation and did not mark any experiment as passed.**

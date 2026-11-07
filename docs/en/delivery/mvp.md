---
title: "Phase-one MVP acceptance"
description: "Results, evidence, and open boundaries for 15 cross-industry real tasks."
outline: [2, 3]
---

# Phase-one MVP acceptance

<p class="lead">The phase-one exit was not "the code is written". It was proving that one task path can execute, persist, request approval, produce artifacts, recover from failure, and back up data across 15 cross-industry real tasks.</p>

## Result

| Item | Result |
|---|---|
| Acceptance date | 2026-11-05 |
| Tasks | 15 |
| Passed | 13 (T01–T06, T09–T15) |
| Artifacts passed, external approval pending | 1 (T08) |
| Failed | 1 (T07) |
| Hard gate | At least 10/15 passed; exceeded |

T07 and T08 were not used to pad the result. T07 ended `recoverable` with its failure evidence preserved; T08's GitHub comment approval is still `pending` with no external effect.

## Per-task results

| ID | Result | Evidence | Acceptance note |
|---|---|---|---|
| T01 | Passed | `runs/T01/meeting-notes.md`, `run-manifest.json` | Meeting transcript to action minutes with owners, dates, open questions, and source index |
| T02 | Passed | `runs/T02/clause-checklist.md`, `run-manifest.json` | Contract clauses, obligations, page numbers, missing attachments, and amounts are checkable; no invented facts |
| T03 | Passed | `runs/T03/executive-summary.md`, `run-manifest.json` | Multi-report merge preserves conflicts and sources instead of forcing agreement |
| T04 | Passed | `runs/T04/pages/`, `manifest.json`, `verification.md`, `run-manifest.json` | Three URLs have status, final URL, fetch time, HTTP status, and SHA-256; the WCAG access failure is preserved as evidence |
| T05 | Passed | `runs/T05/competitor-comparison.md`, `run-manifest.json` | Competitor pricing and features carry sources; undisclosed items are marked unknown |
| T06 | Passed | `runs/T06/policy-update-digest.md`, `run-manifest.json` | Policy updates use official sources only; dates and change types are traceable |
| T07 | **Failed** | `runs/T07/report.md`, `pr-preview.json`, `run-manifest.json` | Delivery validation blocked it: `backend/tests/unit/test_health_no_secrets.py` was uncommitted; no branch, no PR |
| T08 | Artifacts passed, **awaiting approval** | `runs/T08/pr-review.md`, `run-manifest.json` | PR #15 head pinned at `c007c4ed55345682689ac50bbafb090c5934c31a`; a 13 KB graded review was produced; comment approval is `pending`, `effectId` is `null` |
| T09 | Passed | `runs/T09/bug-reproduction.md`, pytest outputs, exit codes, route evidence | Reproduced eight backend failures from PR #14; environment differences and unverified items preserved |
| T10 | Passed | `runs/T10/cleaned-sales.csv`, `exceptions.csv`, `change-log.md`, `summary.md` | 20-row sales cleanup; duplicates, missing values, and anomalies traceable; source unchanged |
| T11 | Passed | `runs/T11/expense-reconciliation.md`, `run-manifest.json` | Seven line-by-line matches, 2640.00 total verified, exceptions complete |
| T12 | Passed | `runs/T12/triage.csv`, `reply-drafts.md`, `escalations.md`, `kb-draft.md` | Eight tickets classified, redacted, escalated, and drafted; nothing sent |
| T13 | Passed | `runs/T13/job-description.md`, `interview-kit.md` | No discriminatory criteria; interview kit and compliance check complete |
| T14 | Passed | `runs/T14/lesson-plan.md`, `quiz.md`, `answer-key.md` | Lesson, quiz, and answer key are consistent and cover objectives and difficulty levels |
| T15 | Passed | `runs/T15/campaign-brief.md`, `asset-checklist.md` | Claims grounded in inputs; three-channel asset list and approval state complete; nothing published |

## Runtime environment

- OS: Windows, PowerShell.
- Node.js `v26.11.1`; npm `11.20.0`.
- Control plane: Fastify + TypeScript; frontend: React + Vite.
- Executor: native Codex adapter; active configuration `OpenDesign / deepseek-v4.1-flash`.
- Auth source: `provider-env`; the key came from the terminal that started Hearth and was never sent to the browser.
- Health: `GET /api/health` returned `canRun: true`, `authSource: "provider-env"`, `issues: []`.

No `codex login` was required. If `~/.codex/config.toml` declares a `model_provider` and its `env_key`, and that variable exists in the starting terminal, Codex can run.

## G1–G9 acceptance baseline

| Baseline | Evidence |
|---|---|
| G1 Explicit input scope | Task templates and records include goal, input paths/URLs, and output directory; run manifests record input sources and SHA-256 |
| G2 Visible state | State machine covers `queued`, `running`, `waiting_input`, `waiting_approval`, `completed`, `failed`, `recoverable`, `cancelled` |
| G3 Durable results | Tasks, runs, approvals, effects, events, and artifact indexes are stored in `.hearth/hearth.sqlite` and survive restart |
| G4 Traceable artifacts | Every `run-manifest.json` records task/run ID, input digest, executor, generation time, and artifact SHA-256 |
| G5 Controlled external actions | GitHub push, PR creation, and comments produce approval previews; T08 has no effect record |
| G6 No fabrication | T04 access challenge, T08 missing CI logs, and T09 host temp-directory issues are marked unknown or failed |
| G7 Recoverable failure | T07 ends `recoverable`, names the uncommitted file, and preserves the workspace |
| G8 Least authority | The service accepts loopback only and blocks cross-site writes; external writes require a one-time approval bound to a parameter fingerprint |
| G9 User-checkable | Tasks, detail, approval previews, artifact previews, and the in-app timeline are directly visible |

## Automated checks

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build -w @hearth/web
```

At acceptance time, `npm test` passed 51 tests, typecheck passed, and the web production build passed. After 2026-11-06 the suite grew to 40 files and 199 tests; the current baseline is in [Acceptance and evidence](/en/delivery/acceptance).

## What this acceptance did not prove

- It did not prove email, calendar, real sending, or high-risk desktop actions.
- It did not prove mobile entry, proactive interruption control, or multi-device switching.
- It did not prove multi-week operation, resource drift, or upgrade rollback.
- It did not turn T07's failure or T08's pending approval into success.

Raw per-task evidence lives in `eval/phase-1-acceptance.md` and `eval/runs/`.

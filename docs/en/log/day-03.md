---
title: 'Day03 · Stage-one MVP runs end to end'
outline: false
---

On 2026-11-05, Hearth moved from specification to a working stage-one MVP. The day began by documenting technology choices, rewriting the delivery route into six phases and 24 sub-stages, and rewriting the design and appendix material. It then established 15 cross-industry real tasks and the G1–G9 acceptance baseline, and implemented the local control plane, native Codex executor, append-only SQLite event log, serial scheduler, artifact publishing, one-time approvals and effect ledger, isolated GitHub workspaces, web snapshots, global stop/resume, and backup export. The day's 46 commits touched 358 files (+58,200/−28,879).

All 15 tasks were executed: T01–T06 and T09–T15, 13 tasks in total, passed and met the 10/15 hard gate. T07 failed because a test file was not committed; no branch was pushed and no PR was created. T08 produced its review and pinned the PR head, but its external comment is still awaiting user approval. The 51-test `npm test` suite, TypeScript typecheck, and web production build passed. Evaluation material now lives in the standalone repository; per-task evidence is in the [phase-one acceptance report](https://github.com/hearthproject/hearth-eval/blob/main/eval/phase-1-acceptance.md).

## Acceptance Results

| Check | Result |
|---|---|
| Real tasks | All 15 tasks ran; T01–T06 and T09–T15, 13 tasks, passed the 10/15 hard gate. |
| Unfinished boundaries | T07 failed because `backend/tests/unit/test_health_no_secrets.py` was not committed; T08 completed its review artifact, but the PR #15 comment still awaits user approval. |
| Automated checks | `npm test` passed 51 tests; TypeScript typecheck passed; the web production build passed. |
| Evidence rules | The failed WCAG page access in T04 was preserved as evidence instead of being reported as success; external comments and PR actions were not executed automatically. |

> This entry records implementation and internal acceptance, not a formal release. The acceptance report is the source for the runnable scope, known limits, and per-task evidence.

## Commits

| Commit | Author | Changes |
|---|---|---|
| `3165904` | JasonBuildAI | Added the bilingual technology-selection page covering build-versus-integrate and runtime choices; 3 files (+260/−2). |
| `6724fd5` | JasonBuildAI | Rewrote the delivery route as six phases and 24 sub-stages, replacing the old seven-stage and increment material; 177 files (+2,537/−20,349). |
| `ed31036` | JasonBuildAI | Rewrote the overall design and nine module notes, strengthened the appendix, and removed the standalone technology-selection page; 77 files (+1,448/−6,394). |
| `6d1db2d` | JasonBuildAI | Defined the stage-one MVP evaluation baseline: 15 cross-industry tasks, fixed inputs, output paths, G1–G9 criteria, and the 10/15 gate; 39 files (+939/−101). |
| `298c9a5` | JasonBuildAI | Added the shared core state machine and append-only SQLite event log, plus the TypeScript/Vitest workspace setup; 14 files (+2,179/−112). |
| `d3d4167` | JasonBuildAI | Added native Codex provider detection and an executor that reads local configuration and authentication source; 6 files (+407). |
| `436fbaf` | JasonBuildAI | Added the Fastify local API, task service, and task-template catalog, with health checks and task creation; 10 files (+1,720/−18). |
| `e7afc32` | JasonBuildAI | Added serial task scheduling, isolated workspaces, managed artifact publishing, and run events; 8 files (+798/−7). |
| `babf658` | JasonBuildAI | Added the React + Vite local control plane with Today, Attention, task detail, artifacts, and settings pages; 26 files (+7,599/−3,069). |
| `7de4124` | JasonBuildAI | Recorded the first real Codex T01 meeting-minutes run and its artifacts; 2 files (+97). |
| `ce35601` | JasonBuildAI | Passed task acceptance criteria into Codex prompts and recorded delivery checks in results; 5 files (+147/−5). |
| `155d5a7` | JasonBuildAI | Created auditable snapshots for allowlisted web inputs, saving source, status, final URL, and content hash; 10 files (+785/−13). |
| `0b34dd0` | JasonBuildAI | Added one-time approvals, parameter fingerprints, and an effect ledger to prevent duplicate external side effects; 11 files (+614/−15). |
| `67463db` | JasonBuildAI | Prepared isolated GitHub workspaces and approval-gated push/comment effects, with integration tests; 8 files (+780/−9). |
| `9f6f8ce` | JasonBuildAI | Kept failed web pages as evidence and continued the task instead of aborting the run; 2 files (+129/−23). |
| `dccb1f9` | JasonBuildAI | Preserved HTTP status, final URL, and fetch metadata for blocked pages; 3 files (+37/−11). |
| `dbbeab6` | JasonBuildAI | Recorded the passing T01 meeting-minutes acceptance run and artifacts; 2 files (+66/−63). |
| `ca297b7` | JasonBuildAI | Recorded the passing T02 contract-checklist acceptance run and artifacts; 2 files (+190). |
| `0543ce4` | JasonBuildAI | Recorded the passing T03 multi-report executive-summary acceptance run and artifacts; 2 files (+79). |
| `46a3137` | JasonBuildAI | Recorded the T04 web-archive run, including status, hashes, and WCAG failure evidence for three URLs; 9 files (+1,249). |
| `90cb318` | JasonBuildAI | Replaced stale files when republishing managed artifacts so old outputs cannot leak into results; 2 files (+32/−1). |
| `4dd54bc` | JasonBuildAI | Removed the previous T04 run's stale artifacts so the evidence directory contains only the current run; 3 files (−441). |
| `8e4ae23` | JasonBuildAI | Recorded the passing T05 competitor-pricing acceptance run and artifacts; 2 files (+341). |
| `50a1204` | JasonBuildAI | Recorded the passing T06 policy-update-digest acceptance run and artifacts; 2 files (+236). |
| `542d8cd` | JasonBuildAI | Recorded the passing T10 sales-CSV cleanup, exception list, and change log; 5 files (+229). |
| `e63038f` | JasonBuildAI | Recorded the passing T11 expense reconciliation, line matching, and exceptions; 2 files (+140). |
| `29ba0f7` | JasonBuildAI | Recorded the passing T12 support triage, redaction, escalation, and reply drafts; 5 files (+353). |
| `66d15a5` | JasonBuildAI | Recorded the passing T13 job description, interview kit, and compliance review; 3 files (+453). |
| `ec0448a` | JasonBuildAI | Recorded the passing T14 lesson plan, quiz, answer key, and consistency checks; 4 files (+554). |
| `93f128c` | JasonBuildAI | Recorded the passing T15 campaign brief, asset checklist, and acceptance checks; 3 files (+377). |
| `681b7fb` | JasonBuildAI | Prepared offline runtimes for GitHub tasks to reduce execution-time network dependencies; 9 files (+510/−14). |
| `aebb04a` | JasonBuildAI | Cloned GitHub workspaces through `gh` HTTPS credentials, supporting environments without SSH; 3 files (+14/−5). |
| `7fde852` | JasonBuildAI | Allowed Codex to resume once when task artifacts were missing before following the failure path; 4 files (+86/−3). |
| `2d06042` | JasonBuildAI | Added retries for transient GitHub clone and fetch failures; 2 files (+56/−4). |
| `c6c9fdb` | JasonBuildAI | Reused the local GitHub repository cache to avoid repeated clones and waiting; 6 files (+151/−13). |
| `91c76c6` | JasonBuildAI | Published only the proposed review comment shown during approval, with no extra text added afterward; 7 files (+83/−7). |
| `3b70059` | JasonBuildAI | Added global stop/resume control that keeps the queue and approvals while making active runs recoverable; 8 files (+129/−5). |
| `6443cc6` | JasonBuildAI | Added task-record JSON export and consistent SQLite backup download to settings; 6 files (+83/−4). |
| `69f9461` | JasonBuildAI | Updated the bilingual READMEs and contribution notes with the runnable stage-one MVP, startup, data locations, and known limits; 6 files (+82/−10). |
| `0a35d9a` | JasonBuildAI | Recorded the T08 PR #15 review, the 13 KB review artifact, and the comment awaiting approval; 2 files (+186). |
| `8486785` | JasonBuildAI | Stopped exposing raw execution errors on task cards and replaced them with readable failures; 1 file (+9/−1). |
| `f8645d4` | JasonBuildAI | Required all expected artifacts before a task can complete; missing artifacts now lead to recovery or failure; 3 files (+42/−18). |
| `53c0298` | JasonBuildAI | Recorded T09 reproduction of the PR #14 CI failure, including pytest output, focused runs, exit codes, and route evidence; 8 files (+33,569). |
| `2a33567` | JasonBuildAI | Adjusted long task timelines and approval cards to prevent overflow and preserve readability; 3 files (+21/−2). |
| `e4bbd3f` | JasonBuildAI | Repaired incomplete delivery before failing a run, avoiding conversion of a recoverable state into failure; 2 files (+28/−5). |
| `48f2ab4` | JasonBuildAI | Recorded the phase-one acceptance results: 13/15 passed, T07 failed, T08 awaited approval, with the README status updated; 7 files (+223/−2). |

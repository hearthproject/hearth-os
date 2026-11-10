---
title: 'Day06 · Workflows, skills, and the evaluation console'
outline: false
---

2026-11-09 moved Hearth's product entrances, task workflow, and evaluation infrastructure forward at the same time. 89 commits touched 445 files (+24,538/−1,793): the morning completed task follow-ups, the Git workspace, approval previews, the PWA shell, and browser E2E; the day then made memory provenance, consolidation, forgetting, and skill lifecycle auditable, and ended by building the first complete evaluation control plane for cases, console, run orchestration, and human review.

The theme was not more concepts. It was making existing capabilities usable every day, reviewable through evidence, and independently evaluable. A page may look complete, but follow-ups must respect scheduling, skills must keep permissions and generations, and the evaluation console must trace every run to its real trajectory.

## Interaction and task workflow

| Area | Result |
|---|---|
| Task follow-ups | A running task can queue "continue after this turn" or abort the current turn and rerun with added information; both keep the task, artifacts, and existing evidence |
| Git workspace | Task detail shows workspace and branch diffs, files, commits, previews, PR state, and CI checks instead of treating terminal output as the final result |
| Approval and tools | The native runtime pauses before sensitive tools; file writes, commands, network access, and screenshots wait when approval is required, continue when approved, and skip with a reason when rejected |
| PWA and navigation | Adds an installable manifest, icons, offline shell, mobile bottom navigation, and command palette; task and approval pages remain usable on narrow screens |
| Screenshots and home | An isolated instance generates README and documentation screenshots; the home page leads with product surfaces, positioning, and current state instead of abstract architecture alone |

## Memory, skills, and execution input

| Area | Result |
|---|---|
| Provenance and trust | Memory records source, confidence, taint, sensitivity, validity, and purpose; recall filters by scope and trust |
| Consolidation | Consolidation handles only explainable duplication and conflict while preserving source chain, versions, and report; model summaries do not become new facts |
| Forget propagation | Forgetting covers projections, versions, events, recall audit, device sync, derived memory, and consolidation, and leaves tombstones so old content cannot return |
| Skill lifecycle | Skill packages support export, import, inspection, pinning, archive, and restore; adopted methods can become scoped skills |
| Automation | Finished tasks best-effort generate method candidates, while stale skills can be curated with rollback; auto-learning remains gated by a switch and evidence rules |

## Goals, completion, and the evaluation control plane

| Area | Result |
|---|---|
| Goal contract | Exposes goal creation, query, acceptance criteria, budget, deadline, stop conditions, and review policy |
| Completion judgement | Adds evidence-driven completion: each criterion, evidence item, missing item, and forbidden action is checked; goal tasks cannot close without a verdict |
| Case catalog | Adds a case catalog loader, legacy manifest compatibility, and samples for email, calendar, documents, research, code, web, desktop, and cross-app work |
| Evaluation console | Adds dashboard, case catalog, experiment launch, run trajectory, human review, experiment comparison, and system status pages |
| Evaluation service | Persists evaluation lifecycle and orchestrates runs, human review, control-plane APIs, and artifact boundaries as a code loop |
| Documentation | Documents the standalone evaluation workflow and refreshes README and screenshots; case and product template structures still share some code temporarily |

## Commits

### 2026-11-09 (89 commits, selected)

| Commit | Author | Changes |
|---|---|---|
| `9ec69ce` | JasonBuildAI | Rewrote README and the documentation home with product screenshots, current state, and reading entrances; 15 files (+1,083/−342). |
| `7843359` | JasonBuildAI | Added task follow-ups, abort-and-rerun, tool approvals, Git workspace, PWA shell, command palette, and narrow-screen interaction; 47 files (+4,380/−100). |
| `149e7c9` | JasonBuildAI | Added repeatable browser E2E in an isolated data directory covering chat, tasks, settings, key masking, and recovery; 6 files (+533/−6). |
| `d01f61f` | JasonBuildAI | Persisted memory provenance, confidence, taint, sensitivity, and validity; 4 files (+229/−22). |
| `3ff7889` | JasonBuildAI | Added auditable memory consolidation with sources, versions, grouping reasons, and a report; 7 files (+565/−22). |
| `be07437` | JasonBuildAI | Propagated forgetting to projections, versions, events, sync, and derived memory, with tombstones; 6 files (+396/−52). |
| `0d06a3a` | JasonBuildAI | Persisted skill lifecycle and exposed export, import, inspection, pinning, archive, and restore; 6 files (+632/−9). |
| `4e46792` | JasonBuildAI | Exported adopted methods as permission-scoped skill packages; 3 files (+490). |
| `85d9886` | JasonBuildAI | Added a case catalog loader with legacy manifest compatibility across task families; 33 files (+740). |
| `ce57f05` | JasonBuildAI | Made the evaluation service orchestrate runs and human review with lifecycle, failed samples, and review actions; 3 files (+935/−1). |
| `2c415d9` | JasonBuildAI | Added evidence-driven completion judgement over criteria, evidence, missing items, and forbidden actions; 2 files (+413). |
| `c828e5f` | JasonBuildAI | Exposed the goal contract API for criteria, budget, and review policy; 1 file (+134/−3). |
| `aa93b56` | JasonBuildAI | Required a completion verdict before closing a goal task instead of treating executor exit as completion; 3 files (+104). |

## Boundaries and next step

- The PWA shell, mobile navigation, and offline shell are entrances, not phone pairing, system push, or remote takeover; those remain unaccepted.
- Task follow-ups act on turn boundaries, not inside a live token stream. The Git workspace depends on a real repository and credentials and has no multi-repository stress acceptance.
- Memory consolidation, forget propagation, and skill lifecycle have automated tests but no real long-term personal data, wrong-memory drill, or production method comparison.
- Completion judgement is connected to goals and scheduling, but subjective quality, real business impact, and cross-device handoff still require human acceptance.
- The evaluation console, case catalog, and service form a code loop, but no real experiment has run; the next day moves them to a standalone repository with only a bridge left in the main repository.
- Real accounts, devices, phone entry, and long-running acceptance for Phases 2–6 are unchanged.

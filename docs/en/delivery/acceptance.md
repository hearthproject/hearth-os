---
title: "Acceptance and evidence"
description: "How Hearth decides a capability is really complete and which evidence must be kept."
outline: [2, 3]
---

# Acceptance and evidence

<p class="lead">Hearth does not treat "the page exists", "the code merged", or "the tests pass" as delivery. Acceptance answers three questions: what was done, where the evidence is, and what is still unproven.</p>

## Definition of done

A capability is complete only when all of the following hold:

1. **A user-visible result exists.** The result appears in the UI, an artifact, or a receipt, not only in the model saying "done".
2. **Evidence can be checked.** Inputs, run records, artifact digests, approvals, and external receipts are traceable.
3. **A failure path exists.** Failure becomes recoverable or explicitly failed; success is not fabricated and external actions are not blindly retried.
4. **Real acceptance happened.** The agreed scenario ran with a real task, device, or account; automated tests cannot replace it.

## Test levels

| Level | Proves | Does not prove |
|---|---|---|
| Unit tests | Pure logic such as state machines, budgets, permissions, extraction, and encryption | Real environment, accounts, or user willingness |
| API / integration tests | Server routes, projections, approvals, backup, sync, and other code loops | Real desktop, real network, or long-running operation |
| Isolated-instance runs | The end-to-end path works in a controlled environment | Real user tasks and willingness to recover |
| Real task acceptance | Agreed tasks complete in a real environment and can be checked | Long-term stability and every boundary |
| Long-running acceptance | Multi-week operation, resource drift, and upgrade rollback | Uncovered task types |

The current automated baseline is **40 test files and 199 tests**. It covers the service layer, API, model protocols, native tool loop, budgets, permissions, checkpoints, proposal confirmation, desktop boundaries, memory, methods, sync, security, backup, and operations. It does not replace real acceptance.

## Reproduce the current checks

```bash
npm test
npm run typecheck
npm run build
npm run docs:build
```

Run on 2026-11-06:

| Check | Result |
|---|---|
| `npm test` | 40 files, 199 tests passed |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm run docs:build` | Passed |

## Evidence rules

### Keep failure evidence

- Preserve HTTP status, final URL, fetch time, and failure cause when a page fails.
- A task missing artifacts becomes recoverable or failed; empty files are not results.
- Reconcile uncertain external actions before retrying.
- Prove that a revoked device cannot operate with a drill, not with a sentence in a document.

### External actions must be checkable

- Produce a preview before the action.
- Bind approval to a parameter fingerprint and execute once.
- Record the result and receipt in the effect ledger.
- When approval is rejected or expires, update the draft and task state.

### No fabricated success

- T04's WCAG access failure is preserved as evidence.
- T07 failed because a test file was uncommitted; nothing was pushed and no PR was created.
- T08's comment approval is still `pending`; there is no external effect.
- When a backup excludes artifact bodies, both the UI and the docs say so.

## Acceptance record template

Keep at least the following for each completed phase or workstream:

```text
Workstream:
Acceptance date:
Real environment:
Task count:
Passed / failed / pending approval:
Input and output paths per task:
Failure causes and recovery:
External actions and receipts:
Still unproven boundaries:
```

## Phase-one evidence index

| Evidence | Location |
|---|---|
| Phase-one acceptance report | `eval/phase-1-acceptance.md` |
| Runs and artifacts for 15 tasks | `eval/runs/T01` … `eval/runs/T15` |
| Run manifests and SHA-256 | `run-manifest.json` in each task directory |
| Automated tests | `npm test` |
| Typecheck and build | `npm run typecheck`, `npm run build` |

Per-task results are in [Phase-one MVP acceptance](/en/delivery/mvp).

## Next acceptance focus

The next round does not add pages that only look complete. It closes:

1. Real email/calendar accounts and 10–15 everyday content tasks.
2. At least 5 real desktop tasks and high-risk failure drills.
3. Mobile approval/takeover and 5–10 proactive interruption tests.
4. Wrong-memory/wrong-method drills and before/after production comparison.
5. Two-device, offline, lost-device, and backup-restore drills.
6. Multi-week operation, resource drift, and upgrade rollback.

Until these finish, phases two through six remain "partial".

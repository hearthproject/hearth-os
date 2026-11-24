---
title: "Current Delivery Status"
description: "Code, automated tests, builds, and deliberately unfinished work as of 2026-11-24."
outline: [2, 3]
---

# Current Delivery Status

Checked on 2026-11-24 against `main`, target version `0.5.0`. This page records only what current code and local runs can prove; a page existing is not a closed loop, and an old plan is not current status.

> Phase 2–6 pages are historical plans; parts of them are superseded by the current scope. Use this page for current facts. The Chinese page is canonical and includes the full 2026-11 acceptance report.
>
> 0.4.0 reintroduces goal mode on `main`: one goal binds one anchor task, advances across rounds and restarts, and is closed by an independent verifier. 0.5.0 adds plan mode (read-only planning, explicit approval before execution) and removes this instance's budget, round, time, tool-call, artifact, and permission ceilings. See [Plan Mode](/en/design/plans) and [Goal Mode](/en/design/goals); the remaining numbers here are the 0.3.4 acceptance snapshot.

## What changed in this version

- **Runtime stability:** Tool side effects split into business settlement and physical cleanup. `settled` no longer means "cleaned"; terminal runs really terminate registered shell processes and write `confirmed / failed` back to `run_operations`. The recovery gate walks the parent run chain and refuses to replay unknown side effects.
- **Single source of truth:** The server no longer writes JSONL journals. Messages, tool settlements, checkpoints, and run boundaries go to SQLite `events` (schema v40); checkpoint files are materialized views rebuilt from `event_seq`.
- **Host lifecycle:** `HostKernel` owns the single data-directory lease and advances through `lease → store → operations → runs → tasks → background → ready`. `/api/ready` returns 503 and write routes return `HOST_NOT_READY` until recovery completes.
- **Windows native sandbox:** `hearth-native.exe` starts children with an AppContainer package SID, workspace/temp ACLs, a kill-on-close Job Object, and a parent watchdog. Network is `deny | open`; declared host allowlists or a missing helper fail closed.
- **PTY and background processes:** `shell` supports `pty: true` with `cols` / `rows`; `shell_input` and `shell_resize` operate the ConPTY session. Every session is recorded in `background_processes`; restart kills matching process trees and marks reused PIDs `lost`.
- **Evidence and pruning:** Every terminal run writes `run-evidence.json`; the long-run matrix grew from 12 to 18 crash points; `npm run storage:prune` previews and reclaims old runs and unreferenced tool output.
- **UI contraction:** Task list, task detail, and the "Needs you" inbox pages are gone. Runs render inline in chat; primary navigation is Chat, Library, and Context, with Mail / Schedules / Connections under More.

## Automated verification

| Item | Command | Result |
|---|---|---|
| Version consistency | `npm run version:check` | 0.3.4 across 7 workspaces, Cargo, Tauri, and the lockfile |
| Typecheck | `npm run typecheck` | 0 errors |
| Unit/integration | `npm test` | 140 files, 946 cases (931 passed, 15 skipped, 0 failed) |
| Long-run matrix | `npm run test:longrun` | 18/18 passed |
| Web build | `npm run build` | Passed (JS 643.06 kB / CSS 158.97 kB) |
| Docs build | `npm run docs:build` | Passed |
| Offline first run | `npm run first:run -- --fake` | Passed (script and task chain only; not a real model) |
| 0.3.4 installer | `npm run release:build` | NSIS 30.5 MiB, portable zip 47.2 MiB; published as a GitHub Pre-release |
| Windows sandbox | `npm run test:sandbox` | 12 real tests: escape write, read-only, junction escape, secret filtering, network deny, PTY, and Job close |

> Real process tests (worktrees, subagents, sandbox) are slow on Windows; Vitest uses a 20-second test timeout and 30-second hook timeout. Results above were re-run on `main` on 2026-11-23. The 0.2.0 and 0.3.3 snapshots remain historical records in the Chinese acceptance report.

## Still deliberately open

- **Updater signing is not shipped:** no private key, public key, or update endpoint; 0.3.4 has no updater artifacts.
- **No Windows Authenticode:** the installer may trigger SmartScreen.
- **Clean-machine install/uninstall is unverified:** the installer was freshly installed and launched on the development machine, but not on a clean Windows user environment, upgrade path, or enterprise policy.
- **Real-model first run is unverified:** it still depends on local model configuration and provider permissions; without a working key only `first:run --fake` is available.
- **No everyday Chrome extension bridge:** the product uses a dedicated Chrome profile; sites must be logged in there. Chrome 136+ blocks remote debugging on the default profile.
- **Real accounts are unverified:** Feishu tenant, SMTP/IMAP accounts, and desktop devices have code and local tests only.
- **No weeks-long crash-recovery drill:** 18 crash points are covered by automation, not by real power loss, blue screens, or forced kills over time.
- **Cleanup coverage is partial:** registered shell processes are really terminated; resources without a cleanup handler (subagents, worktrees, browser sessions) are recorded as `failed` with a reason.

## Moved out of scope

- Task list, task detail, and the "Needs you" inbox;
- task templates;
- proactive service, attention budgets, standing intents, and suggestion clusters;
- method learning bound to tasks;
- multi-device sync, remote nodes, and an executor plugin marketplace.

Reintroducing these requires separate design and acceptance; old documents do not make them available.


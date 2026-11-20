# Coding Harness

Hearth's native executor is a general-purpose agent runtime. This document describes the coding profile added on top of it and the gap it closes against [opencode](https://github.com/sst/opencode) and [pi](https://github.com/badlogic/pi-mono).

## Goals

- One runtime, two profiles: `general` keeps office/document behaviour; `coding` activates repository-aware prompting, stronger edit/search/shell tools, plan/todo/verification loops and recovery snapshots. Neither profile has a default turn, tool-call, token or wall-clock budget.
- Match pi's coding loop and exceed it on verification, planning, background processes and benchmarkability. Reach roughly 80% of opencode's core harness without its Effect runtime, plugin market, multi-client architecture, codemode or provider matrix.
- Every capability must be testable without a model. Model quality is evaluated separately with public benchmarks.

## Baseline gaps

| Area | Before | Consequence |
| --- | --- | --- |
| Editing | Exact `oldText` match only | CRLF, indentation and Unicode quote drift fail; models retry blindly |
| Search | Hand-written walker with a narrow extension allowlist | Java, Go, Rust, generated and hidden files are missed |
| Shell | One `spawn` per call, timeout kills the tree | Servers, watchers, REPLs and long builds cannot be used |
| Context | 8k character truncation; old tool output kept forever | Failures scroll out of context; compaction can split tool pairs |
| Completion | JSON deliverable check only | A coding task can "finish" without a test run |
| Loop | Serial tool calls; identical call skipped | Read-only batches are slow; retries are punished instead of no-progress loops |
| Prompt | Chinese office instructions plus benchmark-specific keyword rules | Wrong priors for repository work |
| Budget | 24 turns / 64 tool calls in standard mode | Real coding tasks exceed the budget before verification |

## Architecture

```
apps/server/src/native-executor.ts
  profile selection -> coding prompt / budget / permissions
        |
packages/agent-runtime/src/runtime.ts
  scheduler, tool batch partition, plan gate, per-tool timeout,
  no-progress detector, steering, checkpoints, post-edit hook
        |
packages/agent-runtime/src/tools.ts
  read/write/edit/patch, shell sessions, todo, tests, diagnostics,
  plan, snapshots, memory, goals, shell_wait
        |
packages/agent-runtime/src/harness/*
  profiles, agent profiles, environment, instructions, project profile,
  prompt sections, file state, edit matching, omission detection, output
  truncation, shell sessions, search, todo, verification, plan, snapshots,
  checkpoint state, post-compact restoration, command policy, memory, goal
```

`harness/*` modules are pure functions or small state objects. They do not import the server and can be unit tested directly.

## Coding profile

Enabled by default; set `HEARTH_CODING_HARNESS=0` to force the general profile. A task selects `coding` when any of these is true:

- `taskKind === "workspace"`
- the workspace contains `.git`
- the task text mentions code execution or GitHub operations

The coding profile uses `CODING_RUN_BUDGET`, which is empty by default: there is no turn, tool-call, token or wall-clock limit unless a caller passes an explicit budget. It exposes the coding toolset dynamically. The prompt lists only tools that are actually callable for the current run. The set includes file ACI (`read_file`, `edit_file`, `apply_patch`), search, shell sessions (`shell`, `shell_output`, `shell_kill`, `shell_wait`), todo, tests, diagnostics, plan, snapshots (`rewind`, `rewind_turn`), typed subagents (`agent`, `agent_wait`, `agent_status`, `agent_kill`), repository memory and persisted goals.

## Prompt sections

`codingPromptSections` returns stable, composable sections: `rules`, `tools`, `environment`, `memory`, `instructions`, `mode`, `skills` and `extra`. `codingSystemPrompt` joins the non-empty sections, so callers can inspect or reuse a section without rebuilding the whole prompt. The plan-mode section is always present and is backed by a runtime gate, not only by prompt text.

## Editing contract

1. The file must be read before it is edited, unless `write_file` is called with `overwrite=true`.
2. Content is normalized to LF and BOM is stripped for matching, then restored on write.
3. Matching tiers: exact, line trim, whitespace normalization, indentation, block anchor, similarity and Unicode normalization. Each tier must produce a unique match. Unicode matching decodes `\uXXXX` and `\xNN` escapes and folds curly quotes and zero-width characters while preserving original file offsets.
4. Omission placeholders (`...`, `// ... existing code ...`, `// 其余不变`) are rejected in both `edit_file` and `apply_patch` instead of being written as real code.
5. Multi-edit is atomic: one failed edit leaves the file untouched.
6. Every mutation snapshots the previous file under the task output directory and returns a snapshot id. Snapshots are grouped per turn; `rewind_turn` restores the previous completed turn or a named turn.
7. Repeated reads of an unchanged range return a short unchanged notice unless `force=true`. Binary files and missing paths return actionable errors, including similar filename suggestions.
8. A successful file-changing tool can trigger the optional `afterEdit` hook with the changed paths; hook failures are reported as notices and never abort the run.

## Verification contract

`finish_task` for coding tasks is rejected when:

- a todo is not completed;
- the repository has changes but the summary does not explain a read-only task;
- conflict markers remain in changed files;
- code changed and no test command ever ran;
- the latest diagnostics contain errors.

`run_tests` and `diagnostics` use the detected project commands, record results in the progress ledger, and return structured failure metadata.

## Loop contract

- Consecutive read-only tools may run in parallel up to `maxParallelTools`. Mixed batches are partitioned around sequential write tools: reads before and after a write keep their original order, and authorization and budget accounting still apply per call.
- Plan mode is enforced at the tool boundary. Non-whitelisted tools are rejected before execution, and `shell` is limited to approved read-only commands.
- Each tool has a timeout. A timed-out shell command is migrated to a background session instead of killing the process tree.
- Repeated identical calls are allowed to a point; five identical call/result pairs stop the run with an explicit no-progress message.
- Steering messages are drained at turn boundaries. Background subagent completion notices arrive through this channel.
- Compaction keeps complete assistant/tool pairs, keeps the most recent tool outputs intact, prunes older output with head+tail, and injects a progress ledger plus project instructions.
- After compaction, a `<post_compact_context>` block restores mode, recently read files with hashes and ranges, unfinished todos, the active plan, active skills and subagents.
- Native checkpoints persist tool state and mode. Resume restores tool state only; historical usage stays deducted by the scheduler, so per-attempt counters start at zero and are not double-counted.

## Context continuity

The compaction summary is a nine-section structured report: primary request and intent, key technical concepts, files and code sections, errors and fixes, problem solving, all user messages, pending tasks, current work and suggested next steps. It must cite real paths, line numbers and commands; invented progress is rejected by review.

Read state is cleared after compaction so the summary is not treated as the original tool output, and `ranges` prevents duplicate reads only while the file content hash still matches.

## Agent orchestration

`agent` is the typed entry point. Profiles are:

| Profile | Mode | Isolation | Purpose |
| --- | --- | --- | --- |
| `explore` | plan | read-only | Locate code and answer questions |
| `plan` | plan | read-only | Produce an implementation plan |
| `review` | plan | read-only | Inspect a diff for defects |
| `general-purpose` | build | worktree | Independent implementation |

`delegate_task` remains a compatibility alias. Background agents return an id immediately and are managed by `agent_wait`, `agent_status` and `agent_kill`; parent cancellation propagates to children. Each child writes a JSONL transcript with prompt, summary, usage, messages, branch and commit. Completion notices are injected into the parent as steering messages rather than rewriting parent history.

## Long-horizon state

- `shell_wait` waits for a background process to exit, match output or time out instead of polling; the default wait is 60 seconds and the cap is 10 minutes. A timeout leaves the process running and returns its current output.
- Repository memory lives in `.hearth/memory` with a `MEMORY.md` index; `memory_read`, `memory_write` and `memory_search` expose it to coding and read-only profiles. The index is bounded to 200 lines / 25 KB and is injected at prompt startup; topic bodies are loaded only on demand.
- A long-running goal lives in `.hearth/goal.json`; `get_goal`, `create_goal` and `update_goal` persist title, objective, constraints, success criteria and plan path. Only one active goal is allowed. `finish_task` is rejected while a goal is active and turns are counted across runs, but `maxTurns` is advisory and never pauses execution.
- Per-turn file history lives in `.hearth/file-history/turn-N/manifest.json` with before/after hashes, line deltas and created-file markers. `rewind_turn` restores the previous completed turn or a named turn, removes files created by that turn, reports partial failures, and keeps the most recent 100 turn manifests.
- The older `rewind` remains available for a single snapshot, and per-turn snapshots are still persisted through checkpoints.

## Benchmarks

| Benchmark | What it measures | Adapter |
| --- | --- | --- |
| Internal `hearth-coding` suite | Repository navigation, editing, tests, multi-file changes | `scripts/bench/aci-bench.ts` |
| Aider Polyglot | 225 exercises, 6 languages, pass@2 and format errors | `scripts/bench/run-suite.ts` + upstream dataset conversion |
| SWE-bench Verified | 500 Python issues, easy/hard split | `scripts/bench/run-suite.ts` + Docker patch adapter |
| Terminal-Bench 2.x | 89 terminal tasks, 16 categories | `scripts/bench/run-suite.ts` + Harbor container |

The public adapter is a generic JSONL suite runner: each task names a workspace, prompt and optional test command. The runner copies the workspace, invokes the same `run-agent` entry point as the server, executes the test command, captures `git diff --binary` and writes a report with `agentStatus`, `testExitCode`, `passed`, duration and patch. Container orchestration stays outside the harness so results remain comparable across benchmarks.

The first milestone is harness-only: all unit tests green and the internal suite improves over the recorded baseline for the same model. Public benchmark runs require Docker/Linux and are tracked separately.

### Measured ACI baseline

`scripts/bench/legacy-aci.ts` runs the same fixture tasks against the pre-change worktree (`c6fbf41`) and the new harness. Results from 2026-11-19:

| Capability | Before | After |
| --- | --- | ---: |
| Exact edit | pass | pass |
| CRLF + indentation edit | fail | pass |
| Multi-edit | fail | pass |
| Fuzzy patch context | fail | pass |
| Java search | fail | pass |
| Read-before-write guard | not present | pass |
| Background shell timeout | killed tree | migrated session |
| `run_tests` / finish gate | missing | pass |
| Todo state | missing | pass |
| Rewind | missing | pass |
| Total | 3/10 | 10/10 |

Reports live in `eval/aci/pre-change.json` and `eval/aci/post-change.json`. These measure the harness, not model quality; model benchmarks still need a configured model and Docker.

### Headless runner

```bash
npm run agent:run -- \
  --workspace /path/to/repo \
  --goal "Fix the failing test in src/cart.ts" \
  --out /tmp/hearth-run \
  --base-url https://api.example.com/v1 \
  --api-key "$HEARTH_MODEL_API_KEY" \
  --model example-model
```

The runner uses the same coding prompt, tools, budget (unlimited by default) and finish gate as the server, so benchmark adapters can drive it without starting the desktop app.


## Commit policy

- Work happens directly on `main`; no feature branch and no merge commits.
- One logical change per commit.
- Subject and body are English. Body uses `Why / What / Test`.
- Generated assets, logs and personal files are never committed.

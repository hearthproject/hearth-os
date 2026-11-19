# Coding Harness

Hearth's native executor is a general-purpose agent runtime. This document describes the coding profile added on top of it and the gap it closes against [opencode](https://github.com/sst/opencode) and [pi](https://github.com/badlogic/pi-mono).

## Goals

- One runtime, two profiles: `general` keeps office/document behaviour; `coding` activates repository-aware prompting, a larger budget, stronger edit/search/shell tools, plan/todo/verification loops and recovery snapshots.
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
  scheduler, per-tool timeout, no-progress detector, steering, checkpoints
        |
packages/agent-runtime/src/tools.ts
  read/write/edit/patch, shell sessions, todo, tests, diagnostics, plan, rewind
        |
packages/agent-runtime/src/harness/*
  profiles, environment, instructions, project profile, prompt,
  file state, edit matching, output truncation, shell sessions, search,
  todo, verification, plan, snapshots, command policy
```

`harness/*` modules are pure functions or small state objects. They do not import the server and can be unit tested directly.

## Coding profile

Enabled by default; set `HEARTH_CODING_HARNESS=0` to force the general profile. A task selects `coding` when any of these is true:

- `taskKind === "workspace"`
- the workspace contains `.git`
- the task text mentions code execution or GitHub operations

The coding profile uses `CODING_RUN_BUDGET` (300 turns, 2500 tool calls, the native token ceiling, 8 hours) and adds the following tools: `todo_write`, `todo_read`, `run_tests`, `diagnostics`, `submit_plan`, `rewind`, `shell_output`, `shell_kill`.

## Editing contract

1. The file must be read before it is edited, unless `write_file` is called with `overwrite=true`.
2. Content is normalized to LF and BOM is stripped for matching, then restored on write.
3. Six matching tiers: exact, line trim, whitespace normalization, indentation, block anchor, similarity. Each tier must produce a unique match.
4. Multi-edit is atomic: one failed edit leaves the file untouched.
5. Every mutation snapshots the previous file under the task output directory and returns a snapshot id for `rewind`.

## Verification contract

`finish_task` for coding tasks is rejected when:

- a todo is not completed;
- the repository has changes but the summary does not explain a read-only task;
- conflict markers remain in changed files;
- code changed and no test command ever ran;
- the latest diagnostics contain errors.

`run_tests` and `diagnostics` use the detected project commands, record results in the progress ledger, and return structured failure metadata.

## Loop contract

- Consecutive read-only tools may run in parallel up to `maxParallelTools`.
- Each tool has a timeout. A timed-out shell command is migrated to a background session instead of killing the process tree.
- Repeated identical calls are allowed to a point; five identical call/result pairs stop the run with an explicit no-progress message.
- Steering messages are drained at turn boundaries.
- Compaction keeps complete assistant/tool pairs, keeps the most recent tool outputs intact, prunes older output with head+tail, and injects a progress ledger plus project instructions.

## Benchmarks

| Benchmark | What it measures | Adapter |
| --- | --- | --- |
| Internal `hearth-coding` suite | Repository navigation, editing, tests, multi-file changes | `scripts/bench/aci-bench.ts` |
| Aider Polyglot | 225 exercises, 6 languages, pass@2 and format errors | `hearth-eval` Aider adapter |
| SWE-bench Verified | 500 Python issues, easy/hard split | Docker + patch adapter |
| Terminal-Bench 2.x | 89 terminal tasks, 16 categories | Harbor adapter |

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

The runner uses the same coding prompt, tools, budget and finish gate as the server, so benchmark adapters can drive it without starting the desktop app.


## Commit policy

- Work happens on `feat/coding-harness`.
- One logical change per commit.
- Subject and body are English. Body uses `Why / What / Test`.
- Generated assets, logs and personal files are never committed.

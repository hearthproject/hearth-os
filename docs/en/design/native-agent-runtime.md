---
title: 'Native Agent Runtime'
description: 'How Hearth uses a Pi-style single-agent tool loop with task-scoped permissions, budgets, checkpoints, and recovery.'
outline: [2, 3]
---

# Native Agent Runtime

<p class="lead">Hearth's native executor is not a prompt that forwards a task to a model. It is a single-agent tool loop that can pause, resume, and enforce permissions and budgets. It follows the shape of Pi's compact kernel but is implemented by Hearth and does not depend on the Pi npm package.</p>

## Two execution paths

| Executor | Role | Typical work |
|---|---|---|
| `native` | General single agent using the configured chat model and built-in tools | Research notes, documents, web summaries, simple file work |
| `codex` | Specialist for repositories and multi-file engineering | Code fixes, tests, commits, workspace changes |

The native executor is the default general path. The router selects Codex only for explicit repository or engineering work. A failed task does not silently switch executors.

## Kernel shape

```text
task + user follow-up
        ↓
system prompt + message history
        ↓
streamed model turn ──→ answer / tool calls
        ↓                       ↓
usage and budget         permissioned tools
        ↓                       ↓
checkpoint  ←────────  tool result is appended
        ↓
completed / waiting input / budget exceeded / cancelled
```

The model must call `finish_task` to declare completion, and declared outputs must exist and be non-empty. The runtime, not the model's prose, decides whether a task is complete.

## Protocols and tools

Hearth supports OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and Gemini through one normalized streaming agent turn. Provider changes do not alter the tool loop.

Built-in tools cover reading, listing, searching, writing, editing, patching, shell checks, URL fetches, user questions, and completion. Paths are restricted to the task workspace and output directory, network access is deny-by-default, and shell is enabled only for workspace tasks. Dangerous commands, symlink escapes, private addresses, and unapproved hosts are rejected at the tool layer.

## Budgets, checkpoints, and recovery

Runs enforce limits on turns, tool calls, tokens, and duration. Checkpoints are written after model turns, tool steps, waiting-input pauses, and completion. Recovery copies the prior workspace, restores messages and counters, appends a user follow-up when present, and continues from the pause instead of restarting.

When declared deliverables are missing, the runtime sends a repair prompt with the previous agent context and allows up to two repair rounds. If the contract still fails, the task fails explicitly.

## Completion contract

- General and delivery tasks must produce their declared outputs, normally `result.md`.
- Workspace tasks must include a final summary plus evidence of changes and tests.
- Intermediate JSON, command logs, checkpoints, and runtime files are never user deliverables.
- A task detail shows the final result and declared files first; commands and checkpoints remain folded technical details.

## Proposals and approval

Tasks that need network access or engineering workspace writes create a proposal in chat before dispatch. The proposal states the executor, expected outputs, requested hosts, and reason. The task is created only after the user confirms; rejecting it creates nothing. Ordinary general tasks can be dispatched directly.

## Current boundaries

- One agent per task; no parallel subagents in this version.
- Execution uses the configured chat model; there is no hidden second execution model.
- Network is denied by default and workspaces are isolated per run.
- Pi is a design reference, not an integrated runtime dependency.

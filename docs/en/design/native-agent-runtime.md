---
title: 'Native Agent Runtime'
description: 'How Hearth upgraded a Pi-style kernel into a general execution kernel with task-scoped permissions, context management, delegation, worktrees, MCP, checkpoints, and recovery.'
outline: [2, 3]
---

# Native Agent Runtime

<p class="lead">Hearth's native executor is not a prompt that forwards a task to a model. It is a general execution kernel that can pause, resume, and enforce permissions and budgets. It starts from Pi's compact tool loop, borrows long-horizon orchestration ideas from DeerFlow and general execution-surface ideas from OpenCode, and is implemented by Hearth without importing those runtimes.</p>

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

The model must call `finish_task` to declare completion, and declared outputs must exist and be non-empty. A plain-text reply is no longer treated as completion. The runtime, not the model's prose, decides whether a task is complete.

## Protocols and general tools

Hearth supports OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and Gemini through one normalized streaming agent turn. Provider changes do not alter the tool loop.

| Tool | Purpose | Default boundary |
|---|---|---|
| `read_file`, `read_document`, `list_files`, `search_text` | Read text, PDF, DOCX, XLSX, CSV, JSON, and HTML | Task workspace and approved roots only; document size and returned characters are bounded |
| `glob`, `grep` | Locate files by pattern and search with an RE2-compatible regex plus include/exclude filters | Result, file-size, and scan-time budgets; path escapes are rejected |
| `write_file`, `edit_file`, `apply_patch` | Create files, preview edits, apply atomic patches, move and delete files | `edit_file` supports dry-run diffs; patches are fully validated before one atomic write, avoiding partial multi-file success |
| `write_spreadsheet`, `write_document` | Create XLSX/CSV and DOCX office files | Approved destinations only, with file-action approval |
| `shell` | Run necessary checks | Workspace tasks only; full output is retained in task logs while only the tail is returned; timeout kills the process tree |
| `fetch_url`, `web_search` | Fetch pages or search through Tavily/SearXNG | Network is off by default; research tasks receive an explicit public-network grant; fetches still require approval and check redirects, DNS, and private addresses |
| `load_skill`, `read_skill_resource` | Load adopted skills and resources on demand | Prompts receive only an index; loading verifies content hash and task permissions; resource paths cannot leave the skill package |
| `delegate_task` | Bounded read-only or isolated-write delegation | Fresh context, one layer, serial, at most two per task, no automatic merge |
| `mcp__<serverId>__<toolName>` | Call a local stdio MCP tool | Only enabled, successfully probed servers; schema validation, bounded results, secret redaction, and per-call approval |
| `ask_user` | Pause when critical information is missing | Enters `waiting_input` instead of guessing |
| `finish_task` | Declare completion with a user-facing summary | Plain text is not completion; output checks still apply |

Symlink escapes, path traversal, private addresses, and unapproved hosts are rejected at the tool layer. Permissions are fixed per task and cannot be expanded by the model during a run.

## Context and execution stability

Model profiles store `contextWindowTokens` and `maxOutputTokens`. Legacy settings migrate to a 128K context window and an 8K output limit, and settings expose both fields. Compaction triggers at the context window minus `max(16K, 15%)`, retaining roughly 20K recent tokens.

Compaction starts only at complete turn boundaries and never separates an assistant tool call from its tool result. It preserves complete turns before summarizing and writes a checkpoint after compacting. If summarization fails, it falls back to safe truncation so the task can continue. A restored conversation that is over budget compacts again.

Only 429, 5xx, and network failures receive two transient retries. 4xx, cancellation, and permission rejection are not retried. Context-overflow failures force compaction before retrying. Repeated tool calls with the same name and arguments are warned once and fail after the threshold instead of looping.

## Skills, projects, and worktrees

Adopted skills normally enter the prompt as an index only; the body is loaded through `load_skill`. Loading verifies the content hash, records an audit result, and checks task permission. A skill supplies method only and cannot expand paths, network, tools, or approval requirements. `read_skill_resource` is limited to declared relative resources inside the skill package.

A local project must be a Git root with an existing branch. Project tasks default to `native` and `workspace`, create an isolated worktree on `hearth/<task-id>`, and reuse it on resume. Branches and worktrees survive both success and failure and are removed only after an explicit user request and a clean-workspace check; dirty worktrees are refused. GitHub tasks continue to default to Codex and are never silently switched.

## Bounded delegation

`delegate_task` starts with a fresh message context and supports only read-only or isolated-write work. Read-only children lose write tools and shell. Isolated-write children branch from the parent worktree's current HEAD, commit their work, and return a branch and commit for human-inspected cherry-pick; automatic merge is not supported.

Delegation is single-layer, serial, and capped at two children per parent. Children cannot delegate again or use MCP. Child usage rolls into the parent task, and any limit violation fails explicitly.

## Local MCP

The first version supports local stdio servers only. Users configure the command, arguments, and environment; the environment is encrypted with Hearth's `SecretBox`, views expose key names only, and Hearth model keys or arbitrary parent secrets are not inherited. Probe failure, startup crash, and call timeout are isolated and do not take down the task process.

Tools use the stable name `mcp__<serverId>__<toolName>`. Discovery checks names, descriptions, tool count, schemas, and cross-server conflicts. Calls validate the JSON Schema again and bound the result size. Tool output, errors, and server stderr are redacted.

MCP calls use the normal per-call tool approval flow, binding the server, tool, and argument digest. Only full-permission mode auto-approves, with an audit event. Hearth does not retry MCP calls automatically and does not claim exactly-once delivery; users remain responsible for deciding whether a tool with external side effects should run.

## Capability matrix

This assessment is based on public capabilities and code maturity, not a shared benchmark. It does not support a numeric claim that Hearth now exceeds Pi, DeerFlow, or OpenCode.

| Dimension | Hearth native | Pi | DeerFlow | OpenCode |
|---|---|---|---|---|
| General coding surface | glob/grep, atomic edits, shell, office files, search, skills, subagents, local MCP, and worktrees | Mature core file tools and compact coding loop | More complete long-task middleware, sandbox, subagents, skills, memory, and lazy tools | Broadest public surface: rule-based tools, editing, shell, skills, subagents, MCP, compaction, and worktrees |
| Long-horizon orchestration | Budgets, checkpoints, recovery, goal acceptance, and approval governance | Primarily a compact loop | Stronger long-horizon orchestration | Strong execution, but not Hearth's task-ledger control model |
| Context management | Token-window triggers, complete-turn compaction, summary fallback, checkpoint after compaction | Session tree and compaction | Complete context middleware | Mature compaction |
| Delegation | One layer, serial, at most two, read-only or isolated write, no auto-merge | Not a first-version focus | Stronger subagents and staged orchestration | More mature and broader subagents |
| MCP | Local stdio only, per-call approval, crash isolation | Not a core capability | Not a primary MCP reference | More complete public support |
| Projects and worktrees | Local Git registry, isolated worktrees, manual cleanup | More focused on the compact coding loop | Stronger sandbox and orchestration | Most complete worktree coverage |
| Control and evidence | Strongest approval, effect records, checkpoints, recovery, output verification, and task governance | Lighter control plane | Different governance model | Lighter control plane |

The fair conclusion is: OpenCode has the most complete general execution surface, DeerFlow is stronger for long-horizon orchestration, and Pi is more mature within its compact coding scope. Hearth native has the strongest control plane and has closed enough of the execution gap for multi-file coding, research and office work, skill reuse, bounded delegation, local MCP, and local project worktrees, but remains behind on LSP, formatters, remote MCP, browser automation, visual understanding, and automatic merging.

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

- Subagents are single-layer, serial, and capped at two; there are no parallel teams, recursive delegation, or automatic merges.
- MCP is local stdio only; remote HTTP, OAuth, managed multi-tenancy, and tool-level exactly-once are not supported.
- Search is off by default, and public-network grants never bypass private-address checks or per-fetch approval.
- Browser-automation search, image/scan visual understanding, PPTX, LSP, formatters, background shell sessions, and automatic cherry-pick are not supported.
- Execution uses the configured chat model, with no hidden second execution model. Workspace tasks prefer a local worktree.
- Intermediate steps, internal JSON, and terminal output are not deliverables.
- There is no shared benchmark or numeric claim of superiority over Pi, DeerFlow, or OpenCode; only public capability differences and the closed scope are documented.

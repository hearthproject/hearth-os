---
title: 'Day08 · General execution kernel and native 30-case evaluation'
outline: false
---

From 2026-11-11 to 11-12, Hearth upgraded `native` from a compact coding loop to a general execution kernel and measured 30 offline cases through the standalone evaluation repository. The 16 plan items on 11-11 touched 81 files (+7,156/−850); after baseline `4617419`, another 91 commits on 11-12 (19 files, +2,358/−17) focused on evaluation-result normalization and final fixes. The final fix commit is `eb32ad5`, followed by documentation.

## General execution kernel

| Area | Result |
|---|---|
| Files and commands | Added glob/grep, document reads, and XLSX/CSV/DOCX generation; `edit_file` previews diffs, patches validate every target before atomic writes, and move and real delete are supported; full shell output goes to the task-local `.hearth/shell` log with only the tail returned, and a timeout kills the whole process tree |
| Context and stability | The model window defaults to 128K and max output to 8K; the runtime reserves `max(16K, 15%)` and keeps about 20K recent tokens, compacts only at complete turn boundaries, never splits a tool call from its result, and writes a checkpoint after compaction; plain text no longer counts as completion, and repeated turns without `finish_task` fail; 429/5xx/network errors retry at most twice, and a repeated tool call with identical arguments is flagged and not executed again |
| Skills and delegation | The prompt injects only a skill index; `load_skill` verifies the content hash, task permission, and audit before returning the body, and `read_skill_resource` stays inside the package; `delegate_task` uses a fresh context, allows only read-only or isolated writes, is single-layer and serial with at most two children per parent, forbids MCP and automatic merging, and charges child usage to the parent |
| Projects and worktrees | Added a local Git project registry with path and Git-root validation, branch validation, and a settings list; project tasks use an isolated `hearth/<task-id>` worktree, reuse it on resume, keep it on success or failure, and delete it only on explicit user cleanup when the worktree is clean; GitHub tasks continue through Codex |
| Local MCP | stdio only; server command, arguments, and encrypted environment values are managed in settings; startup probing, tool discovery, timeouts, and crash isolation form a loop; tools are named `mcp__<serverId>__<toolName>`, arguments are validated against JSON Schema with `ajv`, results are bounded, output/errors/stderr are redacted, and cross-server or built-in name conflicts are detected |
| Search and approval | Search is off by default and supports only Tavily and SearXNG; public network access still blocks DNS, redirect, and private-address escapes, and every fetch still requires approval; every MCP call enters the existing per-call approval with server, tool, and argument digest binding, and only full-permission mode auto-approves with an audit event |

The boundaries are explicit: no remote MCP, OAuth, browser-automation search, image/scanned-document understanding, PPTX, LSP, formatters, background shell sessions, or automatic cherry-pick. More tools do not prove that execution quality has passed real-user acceptance.

## Native 30-case evaluation

The evaluation used 30 offline cases from `hearthproject/hearth-eval` (evenly sampled from eight task families), the `native` executor only, one repetition, auto-scoring and auto-retry enabled, and concurrency 4.

| Stage | Result |
|---|---:|
| Initial baseline `EXP-20261111051349-b71b80` | 0/30 passed; evaluation-bridge tasks carried an empty `permissions.tools`, so every tool was filtered out |
| First complete 30-case run `EXP-20261111141538-011506` | 15/30 passed (50%), average 81.33 |
| Best complete 30-case run `EXP-20261111145332-7a95ea` | **18/30 passed (60%)**, average 88.89 |
| Most recent complete 30-case run `EXP-20261112003215-b1172b` | 12/30 passed (40%), average 73.33 |
| Cumulative targeted confirmation | **19/30** cases reached 100 at least once |

The most recent complete run was affected by slow provider responses, truncated scoring JSON, and task timeouts, and it predates the final four normalization fixes, so it cannot be treated as the final code capability. The cumulative 19/30 comes from different runs and targeted retries, not one continuous experiment. Final commit `eb32ad5` has not been retested in one uninterrupted 30-case run; this validation boundary must stay visible.

Fixes concentrated in three groups: evaluation bridge and runtime (restore the default tool allowlist, task-scoped approval mode, forbid evaluation-task handoff, shell access for code tasks, transient retries, machine-readable facts gate); result contracts and normalization (blocking counts, conflict flags, alternate slots, next queries, flat metadata, required fields, desktop move/delete counts); prompt contracts (contract tests, direct delivery, recovery final state, rollback section, regression checks).

## Verification

On 2026-11-12 on the current branch:

```bash
npm test              # 100 test files, 725 tests passed
npm run typecheck     # TypeScript type check
npm run build         # Web control surface
npm run docs:build    # VitePress documentation site
```

`vitest.config.ts` raises the per-test timeout to 20 seconds so Git, worktree, and MCP-probe tests on Windows are not failed by the default 5-second timeout. The standalone evaluation repository has 11 test files and 41 tests; `npm run typecheck:scenarios` now passes with a module declaration for `turndown-plugin-gfm`.

## Selected commits

| Commit | Change |
|---|---|
| `0a26af5` | Added glob and safe grep |
| `49d883d` | Made file edits atomic with diff preview |
| `cc83883` | Hardened shell execution and process-tree timeout |
| `c7cd318` | Added office artifact tools |
| `bfc7478` | Added web research tools |
| `babb0c2` | Added token-aware context compaction |
| `58d0ccf` | Loaded skills on demand |
| `96559e9` / `c659692` | Added local Git project registry and isolated worktrees |
| `909431e` | Added bounded subagents |
| `09741da` / `276a91f` | Added local MCP management and approval-bound tool calls |
| `0df47a3` / `238b14b` / `cee1e02` | Restored evaluation task tools, task-scoped approval, and no handoff |
| `05bb8de` / `4f992c4` / `6bb4479` / `eb32ad5` | Final four result-normalization fixes |

See [Evaluation and Results](/en/evaluation/) for the reports and reproduction steps, and [Delivery Status](/en/delivery/status) for the Phase 2–6 capability matrix.

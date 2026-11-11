---
title: 'Build vs. Integrate'
description: 'Which layer Hearth owns, which mature capabilities it uses directly, and where native, Codex, MCP, and the reference projects sit.'
outline: [2]
---

# Build vs. Integrate

<p class="lead">Hearth owns how work is authorized, executed, verified, recovered, and remembered. It directly uses the models, browsers, document parsers, isolation environments, and external interfaces needed to complete the work. Clear boundaries keep the product from becoming a pile of integrations that disagree.</p>

## Build and Integration Boundaries

Building describes responsibility, not development order. Hearth does not finish the backend first and add the interface last; task cards, approvals, artifacts, and takeover are part of the product from Phase 1. These capabilities must stay under Hearth's control because they determine whether work can be trusted.

- **Task control**: decide whether a request deserves action, when to create a task, which execution path to use, and when to stop for the user.
- **Durable execution**: store goals, work units, execution records, checkpoints, budgets, and recovery paths so long work survives restarts and network loss.
- **Fact records**: write facts first and rebuild interfaces, notifications, and reports from the record; each state root has one writer.
- **Authority and approval**: bind rules, one-time authorization, device capability, and external actions to explicit scopes.
- **External-effect control**: preview an action, authorize it, leave a verifiable receipt, and reconcile uncertainty instead of retrying blindly.
- **Runtime and safety**: workspaces, isolation levels, network egress, short-lived credentials, privacy, and a global stop entry.
- **Memory and evolution**: memory with provenance, sensitivity, and forgetting; method changes with evaluation, canary, promotion, and rollback.
- **Verification and cost**: real tasks, independent verifiers, human minutes, recovery, and cost determine completion.
- **Entrances and experience**: task cards, approvals, artifacts, takeover, notifications, and mobile entries are the product, not a presentation layer.

Owning these does not mean rewriting databases, browsers, or model runtimes. Hearth owns protocols, policy, verification, and recovery while using mature components underneath. Model services, Codex, browser automation, isolation kernels, document parsing, external connections, and general development tooling are integrated directly; reimplementing them creates no product difference and only adds maintenance burden.

Hearth builds the adapter layer: version locking, minimal workspaces, short-lived authority, network limits, timeout and cancellation, structured results, independent verification, and fallback to another executor or a person. An adapter is not a pass-through; it decides whether an external capability can be used safely by the task system.

## General Execution Kernel and Integration Boundaries

`native` is Hearth's own general default execution kernel. It owns the message loop, tool calls, context compaction, skills, bounded delegation, project worktrees, local MCP, approval, checkpoints, and recovery. When the user explicitly selects a local project, its tasks default to native in an isolated worktree; GitHub engineering work still defaults to Codex. Learning from OpenCode or DeerFlow never causes a silent executor switch.

OpenCode, DeerFlow, and Pi provide public capability shapes and boundary references only. Hearth does not import their runtimes, codebases, or protocol implementations. Matching the number of tools is not the same as matching the execution surface; a capability enters the product only after passing Hearth's permission, task-ledger, approval, effect-record, checkpoint, and artifact-verification boundaries.

New dependencies stay in explicit layers: `@modelcontextprotocol/sdk` starts and calls local stdio MCP servers, `ajv` validates tool JSON Schema before invocation, and `exceljs` plus `docx` generate spreadsheet and Word artifacts. MCP environment values and search keys use the existing `SecretBox`, and views expose key names only. MCP inherits neither Hearth model keys nor arbitrary parent-process secrets, and the first version supports no remote HTTP, OAuth, automatic retry, or exactly-once guarantee.

Codex remains the default external executor for GitHub engineering work. It is strong at code, long documents, complex research, and multi-file work, but Hearth can use only its public, stable, currently allowed capabilities. Codex does not hold the task database, long-lived credentials, the memory center, or authority for external writes. It receives minimal context, works in an isolated workspace, and returns artifacts, structured results, and failure categories. Email, calendar, payments, and publishing must return to Hearth's approval and receipt path.

| Integration requirement | Hearth's handling |
|---|---|
| Version changes | Pin the version and run contract tests before upgrades |
| Workspace | One temporary workspace per execution; destroy it afterward |
| Authority | Mount only necessary directories and never pass long-lived secrets |
| Network | Default closed or allowlisted; open only what the task needs |
| Result | Require structured output and verify it inside Hearth |
| Failure | Separate model, tool, verification, permission, and environment failures before retrying, degrading, or taking over |

This is also the line between Hearth and a "Codex wrapper": the wrapper treats Codex as the product; Hearth treats Codex as a replaceable, constrained, verifiable execution engine.

## Relationship to Other Personal Assistant Projects

OpenClaw is already a working personal assistant product and is clearly ahead of Hearth today in channels, sessions, long-running service, device nodes, and ecosystem. Hearth has just entered Phase 1 MVP implementation. It cannot claim to be stronger, and the two are not naturally a parent and child product.

The clearer distinction is what each owns. OpenClaw is mainly responsible for sessions, channels, personal-assistant experience, and long-running operation. Hearth aims to own task contracts, authorization scopes, external effects, completion evidence, and failure recovery. If OpenClaw were integrated later as a channel or runtime entry, Hearth would still need to own tasks, authority, budgets, acceptance, and receipts to qualify as a task-control layer.

Hearth learns from OpenClaw, Hermes, Pi, DeerFlow, OpenCode, and similar projects about channel organization, memory constraints, checkpoints, human takeover, general execution surfaces, and low-friction experience. It does not fork their product foundations or use them as current runtime dependencies. The current route combines Hearth's own native general kernel with the Codex engineering executor; the other projects mainly provide design references.

Being stronger must be proven by verifiable differences: on the same tasks Hearth must avoid duplicate external effects, prove completion independently, preserve authority under injected attacks, and keep tokens, latency, and human attention from getting worse. More features are not evidence, and a successful demo is not evidence.

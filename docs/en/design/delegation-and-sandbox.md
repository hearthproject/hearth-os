---
title: 'Delegation, Handoff, and Sandboxing'
description: 'How Hearth delegates bounded work, continues across executors with reviewable handoffs, and enforces path, network, and credential boundaries.'
outline: [2, 3]
---

# Delegation, Handoff, and Sandboxing

<p class="lead">Hearth must hand a bounded piece of work to another executor without splitting task ownership, budget, or evidence. Delegation, handoff, and sandboxing answer one question together: how work continues without authority quietly expanding.</p>

## Design Goals

Delegation does not create an unconstrained new agent. A child task has an explicit goal, budget, workspace policy, and failure boundary, and advances through the same scheduler. The parent keeps final responsibility; the child completes only the authorized slice.

When work continues in another executor, the receiver must not reconstruct context by re-reading chat history. The handoff carries the goal, next action, acceptance criteria, existing evidence, permission subset, and context watermark. The previous executor cannot keep writing new state after the handoff.

The sandbox is first a set of denial rules. Paths cannot escape, network hosts cannot exceed authorization, processes cannot leave the allowlist, and credentials cannot enter model context. A boundary violation fails with a reason rather than letting an executor explain it away.

## Durable Single-layer Delegation

Delegation is currently single-layer: a parent creates one or more bounded child tasks and does not spawn a recursive agent team. Children record budget, workspace policy, parent-child relationship, and failure state; the scheduler advances their lifecycle.

Workspace policies are read-only, isolated-write, and shared-read. Read-only work can read authorized material only. Isolated-write work produces results in a separate workspace. Shared-read lets multiple tasks read the same source while writes remain constrained by each task's authority. When a parent receives child results, it checks budget, evidence, and artifacts before including them in its own completion judgement.

Children use leases and heartbeats. If an executor pauses, crashes, or loses its lease, the scheduler can reclaim and requeue the child instead of leaving the parent waiting forever. External effects are guarded: a confirmed action is not repeated by a rerun, and an uncertain action enters reconciliation.

## Handoff Packet

When an executor switches or a task resumes after a pause, Hearth prepares a reviewable handoff. It records the goal, current state, next action, acceptance criteria, evidence references, known failures, permission subset, source context watermark, generation, and redaction.

A handoff can only narrow authority, never expand the parent's authorization. The receiver checks generation and context watermark before resuming; late results from an old generation cannot overwrite new state. Verification checks the goal, next action, acceptance items, evidence, permissions, and generation, and refuses to continue when required parts are missing.

Handoff artifacts remain with terminal evidence. After an executor closes, the user can still see what evidence exists, which criteria remain unmet, and what the next executor should do.

## Sandbox Boundaries

| Boundary | Check | On violation |
|---|---|---|
| Working directory | Current directory, read roots, and write roots stay inside authorization | Refuse and record the path |
| Read and write | Requested paths stay under allowed roots | Refuse the read or write |
| Network | Requested hosts belong to the task's declared hosts | Refuse network access |
| Process | The command is in the allowed process list | Refuse to start |
| Credentials | Execution receives short-lived capability, not long-lived raw keys | Refuse injection or redact |
| Policy backend | The declared sandbox backend is available | Fail closed |

Checks run in sequence, and any failure stops execution. The result leaves an explanation so the user can see whether path, network, process, or credential policy blocked the action.

Channel ingress uses the same idempotency discipline. If a Feishu message, file, or image is delivered twice, the system deduplicates by channel event identity so one message cannot create two tasks, two approvals, or two child tasks.

## Design Tradeoffs

- **Single-layer, not a recursive team.** Make parent-child tasks, budget, and handoff reliable first; avoid an authority tree that no one can audit just to demonstrate multi-agent work.
- **Handoff packet, not shared chat.** Chat contains too much irrelevant history; the packet carries only the evidence and constraints needed for the next slice.
- **Permission subset, not copied authority.** A handoff can grant less, never more; expanding authority returns to user approval.
- **Fail closed, not best effort.** An unavailable backend, ambiguous path, or unclear credential boundary stops work.
- **Local policy checks are not strong isolation.** The local backend checks paths, network, and processes; it does not make an ordinary process a safe boundary against malicious code.

## Current Boundaries

Single-layer delegation, lease heartbeats, pause and requeue, handoff verification, permission subsets, path/network/process/credential checks, and channel idempotency form a code loop. Recursive delegation trees, strong container or VM backends, real remote-node scheduling, and real multi-executor stress acceptance are not complete.

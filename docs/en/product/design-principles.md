---
title: 'Design Principles and Architectural Invariants'
description: 'Hearth''s five non-negotiable judgments, core design choices, seven architectural invariants, and reference system boundaries.'
outline: [2, 3]
---

<p class="eyebrow">DESIGN PRINCIPLES</p>

# Design Principles and Architectural Invariants

<p class="lead">These judgments constrain Hearth's product form, technical boundaries, and all subsequent phases. They are not suggestions, but design contracts that cannot be easily compromised.</p>

## Five Non-Negotiable Judgments

1. **Value lies in the Control Plane, memory, and verification—not in "building another model."**
2. **Codex is a powerful peer Executor, not the product itself, nor the sole execution brain.**
3. **Token consumption is an architectural metric; wherever a model can be avoided, avoid it resolutely.**
4. **The frontend must be simple enough that users don't need to learn Agent architecture; complex logic stays in the backend.**
5. **Self-evolution can only produce candidate skills and candidate policies; it cannot bypass permissions, evaluation, and human review.**

This version adds one delivery judgment:

6. **First build a minimal product usable every day, then gradually grow it into a complete OS; the frontend exists from the first increment.**

## Core Design Judgments

### Codex Is a Peer Executor, Not the Product Center

Codex excels at long-chain workspace work, code, testing, Issues/PRs, research, documentation, spreadsheets, and multi-step Shell operations; it is not suited to be long-term memory, a permission center, a credential center, a persistent event listener, or a real-time desktop operator.

The routing principle is:

> **Whichever Executor can complete and pass verification with the lowest Token cost, highest reliability, and least privilege—choose that one.**

### The Boundary Between Building and Integrating

Hearth builds in-house:

- The Control Plane, Durable Harness, and Event Log protocol;
- Policy, Mandate, Capability, and Approval;
- Context Compiler and Token Governor;
- Memory OS and Evolution OS;
- Execution Gateway control logic and Credential Broker;
- Task cards, approvals, Artifacts, and the mobile entry point;
- Validators and the evaluation system;
- The thin execution layer of the Native Runtime.

Hearth integrates:

- Model APIs or local models;
- Codex;
- Playwright;
- Document parsing/conversion libraries;
- Official email, calendar, and cloud drive APIs/MCP;
- Container/microVM/Sandbox kernels;
- OpenTelemetry.

Hearth does not rewrite model inference engines, container/virtualization kernels, complete third-party Agent frameworks, or document parsers.

### The Frontend Is Not a Post-Hoc Wrapper Layer

When users open Hearth, they only need to know three things: what it is doing, whether it needs me, and where to click next.

- The home page is not an infinite chat stream, but Task cards;
- Each state has only one primary action;
- Approvals are not buried in multiple layers of settings;
- High-risk action confirmations can be completed on mobile;
- Technical jargon does not enter the main interface;
- Any anomaly has an actionable recovery path;
- Capabilities that exist only in the CLI, logs, database, or tests do not count toward phase completion.

### One Logical Agent, Multi-Device Execution

```text
One logical Hearth
  ├─ One primary Gateway / Control Plane
  ├─ One Event Log / single writer
  ├─ agentd on multiple devices
  ├─ Phone as the entry point for viewing, approval, takeover, and initiation
  └─ Each device registers its own capabilities
```

Devices provide only execution capability and entry points; they do not replicate identity, the source of truth, or authorization.

### Learn from OpenClaw and Hermes, but do not copy them

OpenClaw is worth learning from for its Gateway, channels, device nodes, always-on residency, autonomy tiers, and attention entry points; Hermes is worth learning from for its memory budgets, memory constraints, skill crystallization, subtask lifecycle, and evolution loop.

Do not fork them, do not depend on them at runtime, and do not let reference projects become the product's foundation. Hearth absorbs patterns only and implements them through its own Event Log, Policy, Memory, and Evolution protocols.

## Seven architectural invariants

1. The Event Log is the single source of truth.
2. Each State Root has exactly one write authority.
3. Every external side effect must have an idempotency key, an approval or an explicit exemption, and a Receipt.
4. Executors must not read long-lived raw credentials directly.
5. Every task must have a budget, a deadline, and a cancellation path.
6. Memory must have provenance, sensitivity, conflict, and forgetting policies.
7. Any self-evolution must go through evaluation, canary, and rollback.

Plus one delivery invariant:

8. **Every increment must be a usable vertical slice: user outcome, interface, durable state, real execution, verification, recovery, and metrics all present at once.**

## Positioning of reference systems

| Reference | What to learn | What not to do |
|---|---|---|
| OpenClaw | Gateway, channels, devices, attention, always-on residency | Do not fork; do not replicate its channel scale |
| Hermes | Memory budgets, skills, lifecycle, evolution | Do not do unbounded self-modification |
| DeerFlow | Harness/App layering, Run lifecycle | Do not introduce heavy framework coupling |
| Pi / Maka | session tree, steering, compaction | Do not copy the entire framework |
| OpenSandbox / OpenBot | Isolation, snapshots, takeover, receipt | Do not copy the entire product |
| OpenMuse / OpenDots | durable job, checkpoint, lease | Do not copy the task model verbatim |
| Codex | Workspace execution, code, research, documentation | Do not use it as a permission center or memory center |

## Chapter conclusion

Hearth's moat is not "having a stronger model," but knowing when not to call a model, what minimal context to give an executor, which actions require whose authorization, how to prove a task is truly complete, how to recover after failure, what to remember, and what to forget.

But all of this must first appear as a genuinely usable minimal product, rather than waiting until the architecture is fully complete before users see it.

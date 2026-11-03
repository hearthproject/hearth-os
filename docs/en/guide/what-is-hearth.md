---
title: "Understanding Hearth"
description: "Hearth's product positioning, target users, core capabilities, and current status."
outline: [2, 3]
---

<p class="eyebrow">PROJECT INTRODUCTION</p>

# Hearth: Turning Digital Labor into Reliable Tasks

<p class="lead">Hearth is a single-user, self-hosted, long-running, low-interruption, low-token general-purpose personal Agent OS. Its goal is not to create another chat window that needs supervision, but to let repetitive digital labor be confidently delegated, verified, and recovered.</p>

## One-Sentence Positioning

> **Hearth is a general-purpose personal Agent OS with personal context, durable execution, real tools, and multi-device entry points; it frees people from repetitive digital labor rather than creating another chat window that needs supervision.**

The product name is Hearth, the repository is `hearth-os`, the command line is `hearth`, the long-running service is `hearthd`, and the package namespace is `@hearth/*`.

## What Problem It Solves

Existing Agents can often complete a single demo, but are difficult to use over the long term. The problem is usually not model capability, but what lies outside the model:

- Task state is stored in chat history and cannot be reliably recovered after a crash or device switch;
- External side effects lack approval, idempotency, receipts, and reconciliation;
- Permissions, credentials, and memory have no clear boundaries;
- Users must understand the Agent's internal structure to judge whether it has actually completed;
- Every task repeatedly reads a large amount of context, making token costs uncontrollable;
- The frontend is treated as an afterthought wrapper layer, leaving users with only logs or a CLI.

Hearth puts these capabilities at the center of the product: **Control Plane, durable execution, parallel Executors, memory, evolution, experience, and evaluation**.

## What It Is Not

- Not another Coding Agent;
- Not a Codex wrapper that merely forwards prompts;
- Not black-box automation that hands all permissions to the model;
- Not an enterprise multi-tenant Agent platform;
- Not a tool that requires users to maintain prompts, plugins, and workflows every day.

In Hearth, Codex is a powerful **parallel Executor**, not the product itself, and not the sole execution brain.

## One Logical Agent, Multi-Device Execution

```text
One logical Hearth
  ├─ One primary Gateway / Control Plane
  ├─ One Event Log / single writer
  ├─ agentd on multiple devices
  ├─ Phone as the entry point for viewing, approval, takeover, and initiation
  └─ Each device registers its own capabilities
```

Devices provide only execution capabilities and entry points; they do not replicate identity, sources of truth, or authorization. All facts enter the Event Log; all external side effects pass through the outbox, idempotency keys, and Receipts; all interface states are projections, not sources of truth.

## Core Capabilities

| Capability | Problem It Solves |
|---|---|
| Task Control Plane | Decides what to do, whether it is allowed, when to interrupt, and how to recover |
| Durable Execution Kernel | Turns intent into execution that is recoverable, auditable, and receipt-backed |
| Parallel Executors | Selects Codex, Native, Connector, Browser, GUI, or Human based on capability, risk, and Token cost |
| Memory and Evolution | Enables safe recall of people, projects, preferences, commitments, and experience, and distills repeated successes into controlled skills |
| Experience Plane | Carries interaction through Task cards, approvals, and Artifacts rather than endless chat logs |
| Security and Evaluation | Proves "it can actually do it" through validators, red teaming, fault injection, and stage gates |

## Current Status

The repository currently contains the **v3.2 product, architecture, security, and delivery roadmap**. Implementation has not yet begun; Stage 0 and Stage 1 will proceed according to the vertical slice plan in the roadmap.

Continue reading:

- [Product Definition and Boundaries](/en/product/definition)
- [System Design Overview](/en/architecture/)
- [Phased Product Roadmap](/en/delivery/roadmap)
- [Project Status](/en/guide/project-status)

---
title: 'Product Definition and Boundaries'
description: "Hearth's one-sentence positioning, what it is and is not, primary users, explicit non-goals, and experience commitments."
outline: [2, 3]
---

<p class="eyebrow">PRODUCT DEFINITION</p>

# Product Definition and Boundaries

<p class="lead">Who Hearth is for, what problem it solves, and what it explicitly does not promise. Establish the boundaries first, then discuss architecture and implementation.</p>

## One-Sentence Positioning

> **Hearth is a general-purpose personal Agent OS with personal context, durable execution, real tools, and multi-device entry points; it frees people from repetitive digital labor instead of creating another chat window that needs supervision.**

It is a single-user, self-hosted, long-lived, low-distraction, low-Token personal Agent OS. The product name is Hearth, the suggested repository is `hearth-os`, the command line is `hearth`, the resident service is `hearthd`, and the package namespace is `@hearth/*`.

## What It Is and What It Is Not

Hearth is not:

- another Coding Agent;
- a Codex wrapper that only forwards prompts;
- a black-box automation that hands all permissions to the model;
- an assistant that only answers questions in a chat box;
- an enterprise multi-tenant Agent platform;
- a tool that requires users to maintain prompts, plugins, and workflows every day.

Hearth is:

- **Control Plane**: decides what to do, whether it is permitted, when to interrupt, and how to recover;
- **Durable Harness**: turns intent into recoverable, auditable execution with Receipts;
- **A peer set of Executors**: Native, Codex, Connector, Browser, GUI, Document/Data, Human;
- **Memory OS**: makes people, projects, preferences, commitments, and experience safely recallable;
- **Evolution OS**: distills repeated success into skills, but changes must go through evaluation and rollback;
- **Experience Plane**: carries interaction through Task cards, approvals, and Artifacts rather than an endless chat history.

## Target User

| Item | Assumption |
|---|---|
| User | 1 primary user, possibly 1–3 trusted collaborators |
| Devices | One primary computer, one always-on machine, one phone |
| Work | A mix of research, writing, documentation, email, calendar, code, Issues, PRs, data, and web operations |
| Technical skill | Able to run local services, but does not want to maintain Agent configuration daily |
| Privacy requirements | Personal files and credentials must not be uploaded by default to untrusted third parties |
| Usage mode | Proactive Tasks, scheduled Tasks, notification-triggered Tasks, and manual initiation coexist |

The first version does not aim for “everyone can use it”; it aims for “one real user is willing to use it every day.”

## What It Explicitly Does Not Promise

- physical-world robot operation;
- assuming legal, medical, financial, or other professional responsibility on the user's behalf;
- unapproved payments, contract signing, deletions, public releases, or permission changes;
- 100% unattended operation of arbitrary software;
- enterprise IAM, multi-tenancy, organizational audit, and billing;
- covering all eight Task categories on day one;
- competing with underlying model vendors on model capability;
- creating the illusion of “being human” through unbounded autonomous loops.

## Experience Commitments

- The user can see at a glance what the Agent is doing;
- When a human is needed, only one clear action appears;
- The user does not need to understand internal jargon such as Worker, Harness, or Token;
- The phone can handle viewing, approvals, takeover, and initiation;
- For any failure, the cause and recovery options are visible;
- Notifications are predictable;
- Starting from the first runnable increment, users can complete Tasks through a real interface, rather than only seeing capabilities in the CLI, logs, or tests.

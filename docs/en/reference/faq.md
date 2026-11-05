---
title: 'Frequently Asked Questions'
description: 'Common questions about Hearth and Coding Agents, Codex wrappers, internet access, Phase 1 capabilities, side effects, evolution, multi-user support, mobile, and bilingual documentation.'
outline: [2, 3]
---

<p class="eyebrow">FAQ</p>

# Frequently Asked Questions

<p class="lead">This page answers the questions most likely to come up when first encountering Hearth. For more complete definitions and boundaries, see [Design and Tradeoffs](/en/design/) and [Architecture Overview](/en/architecture/overview).</p>

## Is Hearth another Coding Agent?

No. Codex is an important peer Executor for Hearth, but Hearth's product center is Task control, durable execution, memory, verification, approval, and Receipts. It is meant to handle a broader range of personal digital labor, including email, documents, schedules, the web, desktops, and data.

## Is it a Codex wrapper?

No. Hearth does not treat Codex as its sole execution brain, nor does it let Codex hold long-lived credentials, become the memory hub, or expand its own permissions. Codex receives minimal context through a Task Pack and returns Artifacts, verification, and failure classification via structured output.

## Does it require an internet connection?

Local-first by default. State, events, memory, and credentials are stored locally first; model APIs, remote Sandbox, and cloud sync are all optional capabilities. For specific deployment forms, see [Overall Architecture](/en/architecture/overview).

## What can Phase 1 do?

Phase 1 delivers the Hearth MVP: recoverable task state, real execution, Web task cards, approval drills, artifacts, and failure recovery. It does not include email, calendar, desktop operation, proactive loops, full memory, or multi-device.

## Why not just build an all-purpose Agent?

Because “all-purpose” usually means permissions, context, and failure boundaries are all uncontrollable. Hearth chooses multiple peer Executors, routed by capability, risk, and Token cost; each Executor has clear boundaries, a verifier, and a takeover path.

## How are external side effects prevented from being duplicated?

All external actions go through an outbox, idempotency keys, approval/authorization checks, and a Receipt. Persist first, then execute; retries reuse the same idempotency key; non-idempotent external actions must be approved and handed off to a human; reconcile uncertain results first.

## Will Hearth modify itself automatically?

There is no unbounded self-modification. Evolution OS can only produce candidate skills or candidate Policies, which must go through evaluation, canary, promotion, and rollback. Changes to the core Runtime still require a manual PR.

## Does it support multiple users or enterprises?

Not a first-version goal. Hearth is a single-user, self-hosted product; enterprise IAM, multi-tenancy, organizational audit, and billing are explicitly not promised.

## Can it be used on mobile?

Mobile is a Phase 4 focus: viewing, approval, takeover, initiation, and notifications. Mobile is not a full Agent replica but a controlled entry point.

## Why are there two versions of the documentation, in Chinese and English?

Chinese is the source language of the current roadmap, and English is for broader developer readership. Both sets of pages keep the same paths and structure, with one-click switching in the upper right. If you find translation or structure issues, see [Contribution and Documentation Maintenance](/en/reference/contributing).

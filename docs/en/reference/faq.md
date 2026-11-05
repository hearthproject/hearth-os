---
title: 'Frequently Asked Questions'
description: 'How Hearth relates to coding agents, Codex, connectivity, Phase 1, external effects, self-evolution, and multi-user use.'
outline: false
---

# Frequently Asked Questions

<p class="lead">These are the questions most likely to come up on first contact with Hearth. See the [overall design](/en/design/) for product boundaries and the [delivery route](/en/delivery/) for phase order.</p>

**Is Hearth another coding agent?** No. Codex is an important executor, but Hearth's product center is task control, durable execution, approval, receipts, memory, and verification. It is meant for broader personal digital work including email, calendars, documents, the web, desktops, and data.

**Is it a Codex wrapper?** No. Hearth does not let Codex hold long-lived credentials, become the memory center, or expand its own authority. Codex receives minimal context, works in an isolated workspace, and returns artifacts and structured results. External actions still go through Hearth's approval, execution, and reconciliation.

**Does it require an internet connection?** Local-first by default. Tasks, artifacts, memory, and credentials stay in an environment the user controls. Models, remote execution, and sync services are optional. When cloud capability is used, Hearth explains which data leaves the device, how long it is retained, and how it can be deleted.

**What can Phase 1 do?** Phase 1 delivers the smallest complete MVP. It serves one narrow task family but covers the full path in a real browser: create, execute, approve, inspect artifacts, and recover from failure. It does not include email, calendars, desktop operation, proactive loops, full memory, or multiple devices.

**Why not build one universal agent?** Because "universal" usually means permission, context, and failure boundaries are all uncontrolled. Hearth uses multiple specialized executors and chooses a path by capability, risk, reversibility, and cost. Each executor has explicit boundaries, verification, and human takeover.

**How are external actions prevented from repeating?** Every external action records pending intent, receives preview and authorization, executes under the same identity, and saves a receipt. A retry does not create a second email or record. When an external system returns an uncertain result, Hearth reconciles first and stops for the user if it cannot confirm what happened.

**Will Hearth modify itself automatically?** Not without bounds. Hearth can propose new methods from real traces, but a candidate must pass permission checks, replay, side-effect-free trials, limited real use, and rollback verification. The model cannot change authorization rules, approval thresholds, or core safety boundaries.

**Does it support multiple users, enterprises, and mobile?** Hearth is a single-user, self-hosted product. Enterprise multi-tenancy, organizational audit, and billing are not first-version goals. Mobile is a controlled entry focused on review, approval, takeover, simple starts, and notifications; it does not duplicate every desktop management feature. Phase 1 only guarantees the minimal complete path on local web.

To continue, read the [overall design](/en/design/) and the [delivery route](/en/delivery/). For implementation or maintenance details, use the other appendix pages.

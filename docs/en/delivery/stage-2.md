---
title: 'Stage 2 · Personal Operator'
description: 'Hearth Stage 2 development module: read-only connectors, document and data execution, web research, draft approvals, Context Compiler, Token Governor, and Memory v0.'
outline: [2, 3]
---

<p class="eyebrow">MODULE 2 / 7</p>

# Stage 2 · Personal Operator

<p class="lead">Expand from file tasks to most everyday content work. The order is read-only first, deterministic processing second, the browser third, and real writes on test accounts last.</p>

## Prerequisites

- Stage 1's durable tasks, approvals, idempotency, receipts, and recovery are stable.
- The first connectors and document/data tasks are chosen, with test accounts available.
- Every external source enters a unified Source model with permissions, provenance, and audit data.

## Development Steps

1. **Connect read-only sources.** Sync email, calendar, files, and knowledge bases read-only; add source views, deduplication, incremental sync, and permission checks.
2. **Add the Document/Data Executor.** Support document conversion, tables, structured extraction, citation location, and verifiable artifacts.
3. **Add the Browser Executor.** Start with public web research, citations, and page diffs; isolate sessions and defend against untrusted pages and prompt injection.
4. **Close test-account side effects.** Use a test account to complete "read → understand → draft → approve → send/write → receipt," verifying idempotency, reconciliation, and undo.
5. **Compile context and control cost.** Add Context Compiler, Token Governor v1, and Memory v0; record recalled sources, Token use, and manual minutes.
6. **Complete the Stage 2 release.** Evaluate representative daily tasks for success, manual minutes, cross-account isolation, failure recovery, and user trust.

## Increment Breakdown

| Increment | User-visible outcome | Completion evidence |
|---|---|---|
| D2.1 Read-only connectors and source views | Users can inspect email, calendar, file, and knowledge sources | Sync, dedupe, incremental updates, permissions, source audit |
| D2.2 Document/Data Executor | Documents and tables convert, extract, and verify | Artifacts, citations, structure, and failure samples |
| D2.3 Browser Executor and web research | Research has sources, citations, and page-change evidence | Isolated sessions, page diffs, injection defenses |
| D2.4 Draft, approval, and test-account effects | Users approve sends/writes and inspect receipts | Test-account loop, idempotency, reconciliation, undo |
| D2.5 Context Compiler and Memory v0 | Tasks use less context and explain recall | Token baseline, recall sources, budgets, degradation |
| D2.6 Stage 2 release | Manual minutes fall materially on daily content tasks | Real-task evaluation, cross-account isolation, security report |

## Exit Checklist

- [ ] The email loop "read → understand → draft → approve → send → receipt" works.
- [ ] Calendar conflict checks and approval-gated writes work.
- [ ] Document conversion, data extraction, and web research are verifiable and traceable.
- [ ] Manual minutes fall materially on common tasks, with a Token baseline.
- [ ] No cross-account or cross-project data leakage; failures recover or explicitly move to human handling.

## Out of Scope

- Taking over an unisolated primary account.
- Sacrificing permissions, idempotency, and receipts for connector count.
- Letting untrusted web content alter system permissions or approval policy.

## Next

Continue to [Stage 3 · Computer Operator](/en/delivery/stage-3) for desktop software without APIs.

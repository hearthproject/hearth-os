---
title: 'Personal Context, Ontology, and Attention'
description: 'How Hearth uses a personal ontology, context packs, memory recall, and attention budgets to give agents the right background while controlling interruption and overreach.'
outline: [2, 3]
---

# Personal Context, Ontology, and Attention

<p class="lead">Context is not dumping every history item into a model, and attention is not maximizing reminders. Hearth first organizes people and things, then assembles a context pack under budget, and finally uses an interruption budget to decide when the user should see something.</p>

## Design Goals

Personal context must answer who someone is, what they are connected to, what state they are in, what decisions were made, and what was promised. Each fact carries provenance, confidence, sensitivity, and validity instead of becoming an untraceable model summary.

Context given to a model must be bounded. A task receives only the evidence needed for the current work. Material beyond budget keeps a reference and summary and can be expanded on demand rather than being inlined by default. Long sources keep their location; task records keep verifiable references.

Attention has a cost. A proactive suggestion appears only when the user can act and interruption is genuinely worth it now. Repetitive, low-value, non-actionable, or ignored suggestions must not return with different wording.

## Personal Ontology

The ontology stores entities, aliases, relations, states, decisions, and commitments. Entities cover people, organizations, projects, goals, tasks, documents, artifacts, accounts, devices, and topics. Aliases merge different source spellings of the same person or project.

States record a value and validity period for an entity key, such as project owner, account status, or device ownership. Decisions record the choice, rationale, alternatives, decision maker, and evidence. Commitments record the counterparty, description, due time, status, and evidence. Conflicting states are not silently overwritten; they become attention items that need the user.

Confidence distinguishes confirmed, observed, inferred, and stale. Sensitivity distinguishes normal, sensitive, and secret. When the user corrects, revokes, or deletes a source, related states, commitments, and memories update as well; they do not merely disappear from the current page.

## Context Packs

A context pack is assembled for chat, task, goal, handoff, or delegation scope with a token budget and content references. Every item has a source, summary, confidence, validity, reason for inclusion, and whether it can be expanded.

| Lane | Purpose |
|---|---|
| `must_know` | Goals, constraints, forbidden actions, and critical state without which the agent would act incorrectly |
| `relevant` | Evidence, decisions, commitments, and past results directly related to the current question |
| `recallable` | References and summaries kept when budget is tight, expandable when needed |
| `omitted` | Content explicitly left out, with a reason, so the system does not pretend it was known |

A child handoff pack can reference only material available to its parent pack and cannot use expansion to bypass parent authority. Expansion rechecks source, sensitivity, and validity; expired, forgotten, or untrusted content cannot be revived.

## Memory and Recall

Memory records provenance, confidence, taint, sensitivity, validity, and purpose. Capture is gated before write. Recall filters by scope, sensitivity, and trust so unconfirmed, expired, or untrusted memory is not treated as fact.

Memory consolidation handles only explainable duplication and conflict while preserving the source chain and versions. Forgetting propagates to projections, versions, events, recall audit, device sync, derived memories, and consolidation records, and leaves tombstones so old content cannot return through cache or sync. Export includes the memory, its provenance, and forget records.

## Standing Intents and Attention

Standing intents preserve rules the user cares about over time, such as checking project risk weekly or being told when an approval is waiting. A heartbeat turns intents and task states into attention candidates. Each candidate states why the user is needed now, what the next action is, what happens if it is ignored, and who or what is waiting.

The attention budget controls a daily limit, quiet hours, per-kind cooldown, per-goal limit, and high-priority limit. Ignore, snooze, accept, and wrong feedback all adjust future scoring. `NO_REPLY` means the user explicitly does not need to respond; the system must not treat it as unread and keep asking.

Notification channels do not change authority. The in-app inbox, desktop notifications, and Feishu messages make something visible; approval still goes through the one-time approval and effect ledger. Without a delivery channel, Hearth falls back to the in-app "Needs you" surface and does not fabricate delivery.

## Design Tradeoffs

- **The ontology is not a knowledge base.** It stores relationships, states, decisions, and commitments that affect judgement and action, not every piece of information.
- **References before copies.** Long documents, logs, and artifacts keep locations and summaries to avoid context bloat and version drift.
- **Conflicts stay visible.** When two sources disagree, the system asks the user instead of hiding the problem behind last-write-wins.
- **Interruption needs a reason.** Every attention item explains why now, what to do next, and what ignoring it means.
- **Suggestions are not execution.** Proactive service may suggest or create a task, but it cannot bypass approval for an external action.

## Current Boundaries

The personal ontology, entity merge, state conflict, context-pack lanes, memory provenance and trust, consolidation, forget propagation, standing intents, heartbeat, and attention feedback form a code loop. Entity matching and context ranking remain local heuristics. Real long-term personal data, phone push, remote takeover, and cross-device context consistency are not yet accepted.

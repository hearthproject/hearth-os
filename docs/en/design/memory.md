---
title: 'Memory and Capability Evolution'
description: 'How Hearth accumulates correctable context and reusable methods without creating unsourced, unforgettable, or self-expanding memory.'
outline: false
---

# Memory and Capability Evolution

<p class="lead">Memory is not chat history, and more memory is not automatically better. It is a constrained cache for judgment that reduces repeated questions. Capability evolution forms reusable methods from real trajectories and evaluation, rather than letting an agent rewrite its permissions and safety boundaries.</p>

## Design Goals

The system should remember context the user provides repeatedly, preferences, project facts, lessons from past tasks, and work methods that have already been verified. When memory is recalled, Hearth should say where it came from, how trustworthy it is, which scope it applies to, whether it expired, and why it was used.

Memory must be correctable and forgettable. Users can inspect what the system remembers, fix errors, limit how sensitive information may be used, and confirm that deletion reached indexes, caches, device copies, and derived summaries, not just the original page.

Capability evolution should form candidate methods from successes, failures, human corrections, takeovers, and cost data. A candidate can be a prompt, a fixed procedure, a document-processing pipeline, a connector recipe, or a set of verification steps. It becomes a default capability only after replay, non-effect trial runs, limited real use, and user review.

Memory and capability cannot become sources of truth. Task state, approvals, artifacts, and receipts come from records. Memory supplies context and methods. A skill can request only authority the original task already holds; it cannot create credentials, background tasks, or a larger authorization scope.

## Design Tradeoffs

Hearth divides memory into five types with separate lifetimes and uses. This reduces repeated context without turning everything into an unexplainable long-term state.

| Memory type | What it stores | Lifetime and use |
|---|---|---|
| Working memory | The current goal, constraints, temporary observations, and intermediate results | Cleared when the task ends; serves only current execution |
| Episodic memory | What happened in past tasks, results, failures, and human corrections | Kept for the medium term, summarized, and used as reference for similar work |
| Fact memory | People, projects, organizations, and stable relationships | Kept long term with source, validity period, and sensitivity |
| User model | Preferences, communication style, habits, and value boundaries | Kept long term, highly editable, and used to reduce repeated explanation |
| Method memory | Verified procedures, tool recipes, and verification methods | Versioned for repeated tasks and capability evolution |

Memory enters a candidate state before being written. The system checks source, sensitivity, duplication, conflict, and user authorization. Web pages, email, documents, and tool output can all contain misleading content, so a single appearance does not make a high-confidence fact. Highly sensitive information is not written automatically by default.

Retrieval filters by task need, applicable scope, source trust, freshness, sensitivity, and context budget. The system does not stuff all memory into one task or let different accounts and projects contaminate each other. New facts cannot silently overwrite old ones; conflicts preserve sources and ask for confirmation. Low-confidence memory cannot by itself trigger a high-risk action.

Forgetting must reach caches and derived summaries. Caches need versions, invalidation, and deletion rules; forgotten content cannot be recalled again. Multi-device sync carries versions and deletion markers so an old device cannot resurrect memory that was deleted.

Method evolution follows a path: collect trajectories, cluster repeated work and failures, write a candidate explanation, audit permissions, replay offline, run without side effects, use in a limited real scope, then decide to promote, reject, or roll back. Promotion must show that real-task success did not fall, no authority was exceeded, no scope expanded, cost or human time improved measurably, and failures remain explainable and recoverable.

The system may propose new methods but cannot change its authorization rules, approval thresholds, core safety boundaries, or event formats. Every permission change needs explicit user approval, and core changes go through human review. One successful demo, a model claiming it is better, or lower token use without lower human time is not enough to promote a method.

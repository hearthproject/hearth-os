---
title: 'Memory'
description: 'How Hearth accumulates correctable context without creating unsourced, unforgettable, or self-expanding memory.'
outline: false
---

# Memory

<p class="lead">Memory is not chat history, and more memory is not automatically better. It is a constrained cache for judgment that reduces repeated questions. What gets written, when it is recalled, and how it is forgotten are all governed by visible rules.</p>

## Design goals

The system should remember context the user provides repeatedly, preferences, project facts, and lessons from past tasks. When memory is recalled, Hearth should say where it came from, how trustworthy it is, which scope it applies to, whether it expired, and why it was used.

Memory must be correctable and forgettable. Users can inspect what the system remembers, fix errors, limit how sensitive information may be used, and confirm that deletion reached indexes, caches, and derived summaries, not just the original page.

Memory cannot become a source of truth. Task state, approvals, artifacts, and receipts come from records. Memory supplies context only; it cannot create credentials, background tasks, or a larger authorization scope.

## Trade-offs

Hearth divides memory into four types with separate lifetimes and uses.

| Memory type | What it stores | Lifetime and use |
|---|---|---|
| Working memory | Current task constraints, temporary observations, and intermediate results | Cleared when the task ends; serves only current execution |
| Episodic memory | What happened in past tasks, results, failures, and human corrections | Kept for the medium term, summarized, and used as reference for similar work |
| Fact memory | People, projects, organizations, and stable relationships | Kept long term with source, validity period, and sensitivity |
| User model | Preferences, communication style, habits, and value boundaries | Kept long term, highly editable, and used to reduce repeated explanation |

Memory enters a candidate state before being written. The system checks source, sensitivity, duplication, conflict, and user authorization. Web pages, email, documents, and tool output can all contain misleading content, so a single appearance does not make a high-confidence fact. Highly sensitive information is not written automatically by default.

Retrieval filters by task need, applicable scope, source trust, freshness, sensitivity, and context budget. The system does not stuff all memory into one task or let different accounts and projects contaminate each other. New facts cannot silently overwrite old ones; conflicts preserve sources and ask for confirmation. Low-confidence memory cannot by itself trigger a high-risk action.

Forgetting must reach caches, the semantic index, and derived summaries. Caches need versions, invalidation, and deletion rules; forgotten content cannot be recalled again.

## Relationship to the knowledge base

Hearth is the sole write authority for memory. Memory is projected into the local library tree for search and reading; deletion, forgetting, and trash remain controlled by the memory service, and rebuilding derived search data never changes memory provenance or forgetting state.

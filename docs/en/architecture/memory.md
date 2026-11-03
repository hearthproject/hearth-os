---
title: 'Memory System'
description: 'The five memory types of Hearth Memory OS, record structure, write and retrieval, budgets, conflicts, forgetting, poisoning defenses, and synchronization.'
outline: [2, 3]
---

<p class="eyebrow">MEMORY OS</p>

# Memory System

<p class="lead">Memory is not chat history; it is a constrained judgment cache. It must have provenance, confidence, sensitivity, conflict handling, and a forgetting policy.</p>

## Memory OS

Memory is not chat history, and more is not better. It is a "constrained judgment cache" that must be explainable, correctable, and forgettable.

### Five types of memory

| Type | Content | Lifecycle | Purpose |
|---|---|---|---|
| Working Memory | Current goals, constraints, steps, and temporary observations | Cleared when the Task ends | Task Pack, current plan |
| Episodic Memory | Past Tasks, results, failures, human corrections | Medium-term, summarizable | "How was a similar Task handled last time" |
| Semantic Memory | People, projects, organizations, facts, relationships | Long-term, requires provenance and validity period | Project background, contacts, decisions |
| User Model | Preferences, communication style, boundaries, habits, value ordering | Long-term, highly editable | Reduce repeated explanations |
| Procedural Memory | Skills, workflows, tool recipes, validators | Versioned, rollback-capable | Reuse for repeated Tasks, Evolution |

A Skill includes permissions, versioning, evaluation, and rollback metadata; Memory only stores "experience that was once valid."

### Memory records

Each memory contains at least:

- id, type, subject, statement;
- scope (user, project, person, device);
- sourceRefs and sourceTrust;
- confidence, sensitivity;
- createdAt, lastUsedAt, expiresAt;
- supersedes, conflictsWith;
- status: quarantined / active / superseded / forgotten;
- forgetPolicy.

The key is not having many fields, but that every memory can answer: where it came from, how trustworthy it is, who can see it, when it expires, which memory it conflicts with, and how the user can correct or delete it.

### Writing and retrieval

Memory writing is not "if the model says it's worth remembering, remember it." It should first enter a candidate area, where provenance, sensitivity, duplication, conflict, and user authorization are checked; highly sensitive content is not written automatically by default.

Retrieval filters by Task needs, scope, source trustworthiness, recency, sensitivity, and Token budget; it must not stuff all memories into context, nor allow different projects/accounts to contaminate each other.

### Memory budget

- Total memory volume budget;
- Per-record length budget;
- Context injection budget;
- Recall frequency and decay;
- Expiration and archiving.

The memory budget is linked with the Token Governor to avoid the illusion that "the more memory, the smarter."

### Conflict, updates, and confidence

- New facts must not silently overwrite old facts;
- Preserve provenance and time;
- Mark conflicts or request user confirmation;
- Low-confidence memories must not independently trigger high-risk actions;
- Explicit user corrections take priority;
- Expired facts can be downweighted or forgotten.

### Forgetting

Forgetting must propagate to indexes, caches, device copies, and derived summaries. The user should be able to confirm:

- what was forgotten;
- why it was forgotten;
- which devices and indexes have been updated;
- whether it still exists in backups;
- how to verify.

### Memory poisoning and prompt injection

Web pages, emails, documents, and external tool outputs are all untrusted sources. They can become candidate memories, but must not directly gain high trustworthiness, and certainly must not expand permissions through memory. Highly sensitive or externally untrusted content should be quarantined, downweighted, or rejected from being written.

### Multi-device sync and UI

- Synced memories must carry version, provenance, and tombstones;
- Deletions must not "resurrect" on another device;
- Sensitive memories are filtered by device scope;
- The memory browser shows "what was remembered, why it was recalled, where it came from";
- Users can correct, delete, and export;
- "Why it was recalled" must not be explained by the model alone; it needs provenance and rule evidence.

### Memory metrics

- Recall accuracy;
- Rework caused by incorrect memories;
- User correction rate;
- Forgetting compliance rate;
- Injected Tokens and latency;
- Block rate of sensitive information leakage attempts.

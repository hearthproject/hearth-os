---
title: 'Token Economics'
description: 'Hearth''s budget hierarchy, Token Governor, Context Compiler, model tiers, caching, hard budgets, cost attribution, and default policies.'
outline: [2, 3]
---

<p class="eyebrow">TOKEN ECONOMICS</p>

# Token Economics

<p class="lead">The goal is not simply to use fewer tokens, but to make every effective completion cheaper. Tokens are an architectural constraint, not an after-the-fact bill.</p>

## Token Economics

The goal is not "use fewer tokens," but "make every effective completion cheaper." Tokens, cost, latency, and human minutes must be viewed together; you cannot manufacture false savings by lowering quality.

### Budget Hierarchy

```text
Global daily budget
  → User/Project budget
  → Task budget
  → Run budget
  → Step budget
  → Per-context-injection budget
  → Output Token budget
```

Budgets include Token, cost, time, tool call count, network requests, and human interruptions. If any tier is exhausted, the system must pause, degrade, or hand off to a human; it must not silently overspend.

### Token Governor

Token Governor is the cross-Executor cost Control Plane:

- Rule-first: Tasks that do not require a model go directly through deterministic paths;
- Task classification: determine Task family, complexity, risk, and privacy level;
- Model catalog: maintain capabilities, price, latency, context, and availability;
- Context Compiler: build the minimal sufficient context;
- Router: select an Executor based on expected success rate/cost;
- Cache: reuse parsing, retrieval, summaries, and verified Artifacts;
- Meter: record input, output, cache, and tool overhead in real time;
- Watchdog: detect abnormal consumption, loops, and budget overruns;
- Attribution: attribute costs to Tasks, projects, skills, and Executors.

### Context Compiler

Context Compiler compresses "everything the system knows" into "the evidence this Task actually needs." A Context Pack usually contains:

1. Goals and acceptance criteria;
2. Current Task status;
3. Explicit user constraints and preferences;
4. Relevant facts and source references;
5. Necessary file snippets and Artifact references;
6. Available tools and permissions;
7. Output schema;
8. Budget and deadline;
9. Known failures and prohibited paths;
10. Questions requiring human decisions.

Rules:

- Do not use the full chat history as context;
- Do not stuff in entire mailboxes, repositories, or web pages;
- Index, paginate, retrieve, and summarize long material first;
- Keep only assertions with sources;
- Reuse system prompts with stable prefixes and cache-friendly structures;
- Summaries must not lose critical qualifiers, numbers, or references;
- Clean up Working Memory after the Task ends.

### Model and Executor Ladder

| Tier | Capability | Typical use | Cost strategy |
|---|---|---|---|
| T0 Deterministic | Rules, SQL, scripts, API, diff | Filtering, transformation, reconciliation, reading | No model calls |
| T1 Local classifier | Small models, embedding, rule models | Classification, priority, entity recognition | Local, low latency |
| T2 Small model | Short context, structured output | Summarization, extraction, short drafts | Usage-based, strict caps |
| T3 Native large model | General reasoning and tools | Short-chain planning, complex classification | Medium cost |
| T4 Codex | Long chains, multiple files, complex Artifacts | Code, research, long documents | High cost, strong verification |
| T5 Human | Judgment, responsibility, takeover | High risk, ambiguity, irreversibility | Scarcest, requires budget |

Routing dynamically selects by Task shape, historical success rate, privacy, and cost, not by tool preference.

### Incremental Reading

Prefer file diff and version comparison, incremental synchronization and cursors, retrieval by page/section/table/row, document indexing and reference location, structured field extraction, summaries of duplicate material, Artifact references, relevant code files and test results, web accessibility trees, and page diff.

### Caching, Batching, and Local Models

- Cache parsing, retrieval, summaries, embedding, and verified Artifacts;
- Do not call large models one by one for low-value Tasks that can be batched and aggregated;
- Prefer local models for privacy-sensitive, low-latency, or offline Tasks;
- Local models are not free: latency, maintenance, and quality costs still count;
- Caches must have versioning, invalidation, and deletion policies; they must not resurrect forgotten content.

### Hard Budgets and Abnormal Stops

- Each budget tier has a hard limit;
- Loops, repeated tool calls, and abnormal context growth trigger the Watchdog;
- Pause or degrade when the budget is exhausted; do not continue silently;
- Users can see "why this cost so much";
- Human interruptions are also a cost;
- High-risk Tasks must not skip verification to save budget.

### Cost Attribution and Metrics

- Cost per Task, project, Executor, model, skill, and user-visible action;
- Verified Success per dollar;
- Token per verified task;
- Joint reduction of human minutes and Token;
- Cache hits, duplicate reads, and invalid retries;
- Abnormal consumption and number of budget stops.

### Anti-patterns

- Optimizing only Token, not human minutes and success rate;
- Using a smaller model and failing repeatedly;
- Stuffing all memory and full text into context;
- Replacing structured extraction with natural-language summaries;
- Unlimited retries;
- Cache pollution;
- Hidden costs;
- Skipping verification or approval to save model calls.

### Default Policy

1. If rules/scripts can handle it, do not call a model;
2. If it can be structured, do not generate natural language;
3. If an Artifact can be referenced, do not repeat the full text;
4. If a small model can handle it, do not use a large model;
5. If it can be cached, do not repeat;
6. If you can stop, do not over-retry;
7. If it can be handed off to a human, do not run high-risk unattended.

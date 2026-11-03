---
title: 'Executor Models and Routing'
description: 'Hearth executor models, capability matrix, routing principles, and how multiple executors collaborate.'
outline: [2, 3]
---

<p class="eyebrow">EXECUTOR MODEL</p>

# Executor Model and Routing

<p class="lead">Executors are not a list of Workers; they are peer execution entities with explicit capabilities, risk boundaries, and output contracts.</p>

## Executor Is Not a Worker List

Hearth uses peer `Executor`s rather than cramming everything into one "universal Agent":

- **Native Runtime**: built-in general-purpose reasoning and short tool loops;
- **Codex Executor**: high-capability workspace Executor covering code, research, and documents;
- **Connector Executor**: email, calendar, documents, cloud drives, IM, and Issue Trackers;
- **Browser Executor**: web pages, forms, authenticated sessions, and SaaS;
- **GUI Executor**: desktop applications without APIs;
- **Document/Data Executor**: parsing, transformation, spreadsheets, reconciliation, and deterministic processing;
- **Human Executor**: approvals, judgment, takeover, and high-risk accountability.

A single Task can be handled collaboratively by multiple Executors; Executors do not share credentials, files, or implicit context.

## Capability Matrix

| Capability | Native | Codex | Connector | Browser | GUI | Document/Data | Human |
|---|---|---|---|---|---|---|---|
| Code, tests, Issues, PRs | Medium | High | Low | Low | Low | Low | Review |
| Research and structured investigation | High | High | Medium | High | Low | Low | Judgment |
| Document generation and editing | Medium | High | Medium | Medium | Medium | High | Acceptance |
| Shell and file conversion | Medium | High | Low | Low | Medium | High | No |
| Email/calendar | Low | Low | High | Medium | Medium | Low | Approval |
| Login and forms | Low | Low | Medium | High | Medium | Low | Takeover |
| Desktop applications | Low | Low | Low | Low | High | Low | Takeover |
| Persistent event handling | High | Low | High | Low | Low | Low | No |
| Long-term memory | Medium | Low | Low | Low | Low | Low | Review |
| High-risk side effects | Low | Low | High | High | High | Low | High |

The matrix is not a fixed conclusion; it must be updated based on real Tasks and failure data. Codex can receive email, calendar, and document excerpts retrieved by Connectors for understanding, research, and drafting; actual sending, inviting, deleting, or publishing is still handled by Connectors, the Credential Broker, and the approval chain.

## Routing Principles

There is no fixed order of "always use Native first and only use Codex last." Routing is optimization under hard constraints:

```text
Candidate executors
  → capability matching
  → permission and data residency checks
  → expected success rate
  → Token / cost / latency
  → risk and reversibility penalty
  → select the option that maximizes user value
```

Practical decision sequence:

1. No model required: cron, rules, SQL, scripts, file diffs, official APIs.
2. External data or side effects required: prefer Connector; if there is no API, use Browser; if there is no browser interface, use GUI.
3. Deterministic document/data transformation: Document/Data.
4. Long task chains, multiple files, multiple Artifacts, complex research, code, or deep writing: Codex.
5. High-frequency, short, low-risk, privacy-sensitive, or low-budget reasoning: Native + small/local models.
6. Value judgments, accountability, or exception handling: Human.

Risk, permissions, and data residency are hard constraints; a high score cannot offset them.

## Executor Collaboration

A typical task: “Find information on three competitors, organize it into a comparison table, write it into the weekly report, and email the key conclusions to the team.”

Possible chain:

1. Browser retrieves web pages;
2. Native extracts and summarizes;
3. Document/Data generates a table;
4. Codex handles the long document, formatting, and citations;
5. Human approves the email;
6. Connector sends it and generates a Receipt;
7. Memory records the project background and commitments;
8. Evolution observes whether it is worth codifying into a skill.

Each step has its own inputs, outputs, budget, and validator.

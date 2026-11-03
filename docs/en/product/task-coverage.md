---
title: 'Task Coverage and Definition of Done'
description: 'Hearth''s eight task coverage categories, A0–A3 autonomy levels, and completion evidence for different task types.'
outline: [2, 3]
---

<p class="eyebrow">TASK COVERAGE & DONE</p>

# Task Coverage and Definition of Done

<p class="lead">Hearth does not aim to “do everything”; instead, it uses eight explicit Task categories, autonomy levels, and verifiers to define what is worth doing, when it can be done automatically, and what counts as done.</p>

## Coverage of Eight Task Categories

| Task family | Typical work | Preferred execution method |
|---|---|---|
| Communication and collaboration | Email, IM, meeting notes, follow-ups, calendar coordination | Connector + Native/Codex + approval |
| Documents and content | docx, xlsx, pptx, PDF, Markdown, reports, translation, rewriting | Document/Data Engine, Native, Codex |
| Research and information organization | Search, reading, comparison, citations, summaries, knowledge base | Native + Browser + Codex |
| Code and R&D | Repository changes, tests, Issue, PR, code review | Codex + test/CI tools |
| Data and spreadsheets | Cleaning, reconciliation, statistics, charts, import/export | Document/Data Engine + Python sidecar |
| Web and SaaS | Login, forms, downloads, uploads, back-office operations | Browser Executor |
| Desktop applications | Software without APIs, system settings, cross-application workflows | GUI Executor |
| Personal affairs | Forms, appointments, bills, reminders, device operations | Connector, Browser, GUI, high-risk approval |

A Task can be handled collaboratively by multiple executors; “research competitors and write it into the weekly report” may use Browser, Native, Document Engine, and Codex at the same time.

## Autonomy Levels

| Level | Behavior | Default use |
|---|---|---|
| A0 Suggest | Only generate suggestions, drafts, or plans | New scenarios, high risk, unvalidated capabilities |
| A1 Controlled execution | Automatically complete low-risk steps; require approval for medium risk on first occurrence | Default for Stage 1–2 |
| A2 Authorized execution | Automatically complete authorized actions within a Mandate; high-risk actions still require approval | After Stage 4 |
| A3 Supervised autonomy | Run over long periods while retaining approval, budget, kill switch, and Receipt | Long-term goals |

Autonomy must be configured independently by Task family, source, time period, device, risk, and amount; a single “fully automatic switch” cannot cover all scenarios.

## Definition of “Done”

Natural-language “done” is not evidence of completion. Different Tasks require different verifiers:

| Task | Evidence of completion |
|---|---|
| Code/Issue/PR | Tests, type checks, diff, CI, or human review |
| Documents | Structure checks, citation checks, formatting checks, user acceptance |
| Email draft | Recipient, fact, and tone checks; approval before sending |
| Email sending | Approval, Broker execution record, provider message id, or an explicit uncertain state |
| Web operations | DOM/accessibility state, screenshots, final state, and Receipt |
| Desktop operations | Accessibility tree, screenshots, target state, and human confirmation |
| Research | Traceable sources; key claims have citations |
| Calendar | Time, time zone, participants, conflict checks, and calendar Receipt |
| Data | schema, row count, sampling, reconciliation, and reproducible scripts |

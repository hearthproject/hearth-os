---
title: 'Executor Directory'
description: 'Positioning, boundaries, and acceptance criteria for Codex, Native, Connector, Browser, GUI, and Document/Data executors.'
outline: [2, 3]
---

<p class="eyebrow">EXECUTOR CATALOG</p>

# Executor Catalog

<p class="lead">What Codex, Native, Connector, Browser, GUI, and Document/Data are each good at, when they get selected, and how they are verified and taken over.</p>

## Codex Executor

### Positioning

Codex is not limited to code; it can take on research, long documents, reports, spreadsheets, code, and multi-file workspace tasks. But it is an Executor, not Hearth's permission center, task database, memory center, or external side-effect gateway.

Suited for:

- Long-chain reasoning in an isolated workspace;
- Code changes, testing, Issue triage, PR preparation;
- Research, summarization, and structured investigation;
- Document, report, spreadsheet, and data file generation/modification;
- Multi-step Shell, file conversion, and verification.

Not suited for:

- Directly managing email, calendars, and contacts;
- Serving as long-term memory;
- Serving as a permission, approval, or credential center;
- Resident event listening;
- Real-time desktop and mobile operation;
- Directly sending and publishing high-risk side effects.

### Task Pack and Output Contract

Do not give Codex an unbounded long prompt. The input should be a Task Pack:

- Goal, acceptance criteria, and prohibitions;
- Minimal necessary files, references, and artifact paths;
- Workspace scope, writable directories, and network boundaries;
- Available tools, budget, deadline, and cancellation semantics;
- Required structured output schema;
- Known failure samples and degradation approach.

The output must include at least: a standardized event stream, artifact references, a structured final result, verification results, failure classification, and recoverability. A natural-language "done" does not count as done.

### Isolation, Cancellation, and Recovery

- One workspace per Run, reclaimed when the task ends;
- Version-locked CLI/SDK; run contract tests before upgrading;
- Minimal environment variables and network egress;
- Cancellation must terminate the entire process tree;
- Timeouts, crashes, and recovery must preserve checkpoints or a rebuildable workspace;
- High-risk accounts and long-lived credentials are not handed directly to Codex.

### Acceptance

- The Task Pack is reproducible;
- Structured results are parseable;
- Artifacts have diffs, tests, references, or file evidence;
- Cancellation, timeout, and failure classification are available;
- Tokens and cost are attributable;
- No reliance on a natural-language "done".

## Native Runtime

Native is a lightweight, local, replaceable general-purpose reasoning layer, suited for short tasks, low-risk classification, context compression, and some privacy-sensitive work. It does not aim to replace Codex's long-chain capabilities.

### Model Ladder

- Rules/scripts: no model at all;
- Small/local models: classification, extraction, short summaries;
- Mid-sized models: general reasoning, structured organization;
- Codex/large models: long-chain, multi-file, high-value tasks.

### Tool Interface and Escalation

Native reads and writes files, executes commands, and calls Connectors only through a controlled tool interface. Escalate to Codex when:

- The task requires extensive file coordination;
- Long-chain planning and repeated verification are needed;
- Native fails repeatedly or the context exceeds budget;
- Artifact quality or reliability falls short;
- Stronger code/document handling capability is required.

### Evaluation

Evaluation should not just look at whether "the answer looks decent", but also at task success rate, human minutes, Tokens, tool-call correctness rate, failure classification, and escalation rate. A small model that "saves money but fails repeatedly" is usually more expensive.

## Connector Executor

Connectors turn external systems into auditable `Source` and `Effect`, not "handing the API keys to the model".

### Unified Model

- Source: read, sync, normalize, provenance, cursor, rate limiting;
- Effect: typed actions, preview, approval, outbox, idempotency key, Receipt, reconciliation;
- Credentials: the Credential Broker issues short-lived permissions; the Executor never sees long-lived keys;
- Permissions: scoped by account, resource, action, time, and scope;
- Failures: retryable, non-retryable, indeterminate, and requiring human takeover are handled separately.

### Email, Calendar, Documents, IM

- Email: read-only sync, threads, contacts, attachments, drafts, sends pending approval;
- Calendar: read-only, time zones, conflict checks, writes pending approval;
- Documents/cloud drive: read, version, export, sharing pending approval;
- IM/Issue/code hosting: messages, Issues, PRs, comments as Source/Effect, with approval for high-risk actions.

In Stage 2, connect one real read-only Connector first, then gradually add writes. Do not enable all high-risk actions on the first Connector at once.

### Rate Limiting, Retries, and Reconciliation

- Every delivery has an idempotency key;
- Rate limiting and backoff are controlled by the system, not left to the model to retry freely;
- Indeterminate results are queried/reconciled first;
- Dead letters can be inspected, fixed, and manually replayed;
- Revocation and permission reclamation must be audited.

## Browser Executor

Browser uses Playwright to operate web pages that have no API or an insufficient API, but web page content is untrusted input.

### Three Modes

1. **Read-only research**: open, restricted login state, capture, screenshots, provenance;
2. **Draft operations**: fill forms, prepare submission but do not auto-send;
3. **Controlled execution**: submit low/medium-risk actions under a Mandate and approval.

### Execution Flow

- Clarify the goal and allowed domains;
- Prepare an isolated profile;
- Observe the page and provenance;
- Auto-execute non-high-risk steps;
- Take over on CAPTCHAs, anomalies, or high-risk submissions;
- Save screenshots, DOM/state evidence, and provenance;
- Verify the final state and produce a Receipt (if there are side effects).

### Security

- Page text must not be treated as system instructions;
- Prompt injection must not expand permissions;
- Login state is isolated from long-lived credentials;
- Network egress allowlist;
- Downloaded files must have their type and provenance verified;
- Untrusted pages must not directly trigger payments, publishing, deletion, or permission changes.

### Failures and Takeover

Browser failures usually cannot be solved by "try again". CAPTCHAs, MFA, page structure changes, expired logins, and irreversible submissions must explicitly enter `needs_human` and show the user what they need to do.

## GUI Executor

GUI operates desktop software without an API and cross-application workflows. It is more fragile than Browser, so it relies more on allowlists, verification, and takeover.

### Runtime Location

- The device `agentd` runs on the target desktop;
- Uses the accessibility tree, screenshots, keyboard/mouse, windows, and file selection;
- High-risk tasks run on an isolated virtual desktop;
- Mobile is only a view/takeover entry point, not the default execution authority.

### Execution Flow

1. Identify the target application and window;
2. Confirm capabilities and permissions;
3. Observe the current state;
4. Perform the minimal action;
5. Verify via the accessibility tree, screenshots, or target state;
6. On failure, pause, take over, or roll back;
7. Record audit and evidence.

### Boundaries

- Application/window allowlist;
- Do not read password vaults;
- Do not modify system security settings;
- Secondary confirmation for high-risk actions;
- Do not assume screen coordinates are always stable;
- Verify state after each operation, not just "the click succeeded".

### Failures and Takeover

GUI must assume it will fail. Users must be able to pause automated input, take over, operate, hand back, or terminate; the system must record the state before and after takeover to avoid automated flows and humans fighting over keyboard and mouse at the same time.

## Document/Data Executor

Document/Data lets deterministic work bypass the model: parsing, OCR, format conversion, spreadsheet cleansing, reconciliation, statistics, charts, and import/export.

### Pipeline

```text
Input file → Type detection → Parsing/OCR → Structured intermediate result
→ Deterministic transformation/computation → Validation → Artifact + Provenance
```

The model only handles the parts that truly require semantic judgment; repeated calculations, format conversions, and data validation do not invoke the model.

### Verification

- Document structure, page numbers, citations, and key fields;
- Table schema, row counts, formulas, sampling, and reconciliation;
- Output is reproducible, diffable, and traceable back to the original file;
- For large files, only the required fragments and Artifact references are extracted;
- The original file is not destroyed, and failures can be rolled back.

### Division of Labor with Codex

- Deterministic processing: Document/Data;
- Long document understanding, writing, complex formatting, and multi-file coordination: Codex;
- Routing decides which is cheaper and more reliable, not tool preference.

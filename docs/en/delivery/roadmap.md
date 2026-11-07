---
title: "Remaining roadmap"
description: "The path from partial completion to a long-running v1.0."
outline: [2, 3]
---

# Remaining roadmap

<p class="lead">The remaining route is organized by missing real acceptance, not by which module to write next. Every workstream needs an explicit exit condition; merged code or a finished page does not advance a phase.</p>

## Principles

1. **Real acceptance before new surface.** Capabilities that already have code loops must be proven with real accounts, devices, or tasks before expanding.
2. **Risk before coverage.** Desktop high-risk actions, external writes, lost devices, and backup restore need failure drills first.
3. **Evidence before conclusion.** Keep inputs, run manifests, artifact digests, approvals, and receipts; keep failures too.
4. **No automatic promotion.** Phase status is decided by acceptance records, not commit count, page count, or test count.

## Seven workstreams

| Workstream | Goal | Exit condition |
|---|---|---|
| W1 Everyday content acceptance | Connect real email/calendar and close the everyday content loop | 10–15 real tasks with time, accuracy, recovery, and user willingness recorded |
| W2 Desktop safety and high risk | Add masking, isolated desktop, high-risk actions, and compensation | At least 5 real desktop tasks; sensitive areas never leak; takeover and failure drills pass |
| W3 Mobile entry and proactive service | Mobile approval/takeover with controlled interruption | PWA pairing, push, remote approval; 5–10 proactive tasks average at most one interruption each |
| W4 Memory and method production comparison | Prove memory and methods help and can roll back | Wrong-memory/wrong-method drills; before/after success, human time, and cost comparison |
| W5 Multi-device and lost device | Real two-device switch, revocation, and restore | Offline recovery, lost device, token rotation, backup restore, and migration verification |
| W6 Long-running operation and upgrade | Multi-week run and upgrade rollback | Resource/state drift data; failed upgrade can roll back; full task-type regression matrix |
| W7 v1.0 release | An installable, upgradeable, removable version | Install/upgrade/migration/exit acceptance; release notes and known limits |

## W1 · Everyday content acceptance

**Why now:** sources, extraction, drafts, approvals, and the local outbox have code loops, but there is no real account or send receipt. Without this, phase two is not complete.

**Work:**

- Connect one real test mailbox and one calendar account, read-only first, then write.
- Cover 10–15 real everyday tasks: mail summaries, calendar cleanup, document extraction, table cleanup, web archiving, and draft replies.
- Record duration, human edits, failure causes, and recovery for each task.
- Make the UI difference between "local outbox" and "real send" unmistakable.

**Exit:**

- At least 10 tasks pass, and failed tasks have recoverable records.
- Real sends have receipts; when nothing was sent, the UI says so.
- The user can verify sources, artifacts, and external actions without reading internal logs.

## W2 · Desktop safety and high risk

**Why now:** the Windows helper can pair, observe, take over, and execute low-risk actions, but sensitive-area masking, isolated desktop, high-risk confirmation, and compensation are missing. Expanding desktop automation without these boundaries is not acceptable.

**Work:**

- Sensitive-area masking and redaction in screenshots.
- High-risk action preview, second confirmation, and recoverable compensation.
- Isolated desktop or an equivalent verified input boundary.
- Failure drills for window loss, permission changes, user takeover, and UIA setvalue.

**Exit:**

- At least 5 real desktop tasks with success rate, takeover count, and failure causes recorded.
- Sensitive areas never enter screenshots, logs, or model context.
- High-risk actions cannot execute without explicit approval.

## W3 · Mobile entry and proactive service

**Why now:** proactive suggestions, the inbox, and attention budget exist, but the entry is same-machine web only. Mobile PWA, pairing, push, and remote approval are missing.

**Work:**

- Mobile PWA and short-lived pairing.
- Push/notification channel and delivery records.
- Mobile approval, rejection, snooze, and takeover.
- 5–10 real proactive interruption tests.

**Exit:**

- The phone can approve and take over; a lost phone can be revoked immediately.
- Proactive tasks average at most one interruption per task.
- The user can pause temporarily, set quiet hours, and inspect budget use.

## W4 · Memory and method production comparison

**Why now:** memory candidates, recall, correction, forgetting, method evaluation, promotion, and rollback have code loops, but lack real long-term use and before/after comparison.

**Work:**

- Wrong-memory injection, correction, forgetting, and export verification.
- Wrong-method drill: a candidate cannot expand authority and failure must roll back.
- Baseline/after comparison on real tasks: success, human time, tokens, and approvals.

**Exit:**

- Wrong memory can be found, corrected, and forgotten; export excludes forgotten bodies.
- Promotion has trial evidence; rollback keeps reasons and audit.
- At least one real task group proves the adopted method is better, or records no improvement explicitly.

## W5 · Multi-device and lost device

**Why now:** incremental sync, peer auth, leases, revocation, token rotation, and encrypted backup exist, but there is no real two-device run, offline recovery, or lost-device drill.

**Work:**

- Two real devices complete incremental sync and task takeover.
- Offline, recovery, conflict, and epoch-fencing drills.
- Lost-device revocation, token rotation, and read-blocking verification.
- Verify task, artifact, and workspace boundaries after encrypted backup restore.

**Exit:**

- Two devices can switch tasks and old-owner commits are rejected.
- A revoked device cannot approve, take over, or read.
- Backup restore is repeatable and explicitly lists excluded artifacts and attachments.

## W6 · Long-running operation and upgrade

**Why now:** health snapshots, maintenance, diagnostics, and encrypted backup exist, but there is no multi-week run, resource-drift data, or upgrade rollback evidence.

**Work:**

- Run for at least several weeks, recording memory, disk, task backlog, and maintenance results.
- Build an app version upgrade and failed-upgrade rollback pipeline.
- Build a full task-type regression matrix.
- Drill incompatible schema, maintenance failure, and diagnostics export.

**Exit:**

- No unrecoverable state drift during continuous operation.
- Failed upgrade can roll back without data loss.
- Maintenance failure marks health degraded and produces redacted diagnostics.

## W7 · v1.0 release

**Why last:** v1.0 is not "more features"; it is install, upgrade, migration, exit, and known limits that a user can verify.

**Work:**

- Installer or one-command startup.
- Upgrade, migration, and exit instructions.
- Release notes, known limits, and support boundaries.
- Final overall acceptance.

**Exit:**

- A new user can install, configure, and use Hearth without reading source code.
- Upgrade and migration have rollback paths.
- Release notes do not describe partial work as complete.

## Milestone order

| Milestone | Workstreams | Completion signal |
|---|---|---|
| M1 Usability convergence | W1, W2 | Real everyday-content and desktop tasks pass; high-risk boundaries are provable |
| M2 Entry and learning | W3, W4 | Mobile approval works; memory/methods have production comparisons |
| M3 Reliability and migration | W5, W6 | Two-device, lost-device, long-running, and upgrade-rollback evidence exists |
| M4 v1.0 | W7 | Install, upgrade, migration, exit, and release notes are complete |

Milestones can run in parallel, but exit conditions cannot be skipped. If a workstream lacks real evidence, later milestones remain "partial".

## Explicit non-goals

- Do not turn proactive suggestions into an auto-executor.
- Do not let the model expand tool, network, or approval authority on its own.
- Do not replace real acceptance with simulated email, simulated devices, or fake data.
- Do not expand high-risk desktop actions without failure drills.
- Do not split into microservices or multi-agent teams just to look complete.

## Stop conditions

Pause expansion and return to risk and recovery when:

- Real tasks fail repeatedly without explanation.
- External actions duplicate or cannot be reconciled.
- A revoked device can still read or operate.
- Backup restore produces unexplained data loss.
- The user cannot tell whether a task finished without reading internal logs.

See [Risks and stop conditions](/en/reference/risks) for more.

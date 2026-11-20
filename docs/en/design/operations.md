---
title: 'Data, Backup, and Operations'
description: 'How Hearth handles backup, restore, maintenance, diagnostics, and the global kill switch locally, and what each action does not cover.'
outline: false
---

# Data, Backup, and Operations

<p class="lead">Hearth is a single-machine control plane: tasks, authority, and data stay local, with no assumption that a remote node or second device keeps state for you. The goal of operations is not more features, but the ability to see clearly, roll back, and stop.</p>

## Design goals

Users should know where data lives, which actions modify it, and which actions only stop external effects. Backup, restore, maintenance, and diagnostics are four separate entries; stopping must not be disguised as deleting, and a database backup must not be described as a full migration.

Long-running operation is about resources, not merely "it did not crash". Memory, disk, caches, logs, background tasks, and temporary files need limits and cleanup rules. Health checks, alerts, upgrades, and rollback cover the service, database, and desktop agent.

## Trade-offs

| Capability | What it does | What it does not do |
|---|---|---|
| Encrypted backup | Derives a key from a passphrase and packs SQLite plus necessary metadata | Does not include artifact bodies, workspaces, source bodies, or external attachments |
| Restore | Runs schema, integrity, and projection checks in a temporary database; rolls back on failure | Does not undo external effects already released |
| Maintenance | Clears expired approvals, leases, desktop commands, screenshots, pairings, and temporary files | Does not delete tasks, memory, or artifacts |
| Diagnostics | Exports a redacted health snapshot and counts | Does not include keys, absolute paths, or environment secrets |
| Global stop | Immediately halts the scheduler, pending approvals, and desktop sessions | Does not delete data; executors still need a manual start afterward |

Keep backup archives and passphrases apart. A forgotten passphrase makes the archive unrecoverable. Restore warns that current data will be replaced and asks for confirmation. Executors stay stopped after restore so old tasks cannot replay against the new data.

## Entry points

Everything lives under **Settings → Data**: directory layout, SQLite settings tables, migration records, trash, encrypted backup, restore, maintenance, redacted diagnostics, and the global kill switch. Health, task counts, and disk usage are summarized there; there are no standalone operations or security pages.

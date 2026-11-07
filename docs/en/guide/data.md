---
title: 'Data, backup, and restore'
description: 'Local data layout, encrypted backup, restore boundaries, and global stop.'
outline: [2, 3]
---

# Data, backup, and restore

<p class="lead">The source of truth is the local SQLite event log. The interface, statistics, and notifications are rebuilt from records, so backing up the database matters more than backing up page state.</p>

## Data layout

| Path | Contents | In encrypted backup |
|---|---|---|
| `.hearth/hearth.sqlite` | Tasks, runs, approvals, effects, memory, methods, sync, events | Yes |
| `.hearth/model-settings.json` | Chat-model configuration and key | Included as encrypted metadata |
| `.hearth/master.key` | Local master key | Included after encryption |
| `.hearth/workspaces/` | Isolated task workspaces | No |
| `.hearth/artifacts/` | Managed artifacts | No |
| `.hearth/outbox/` | Local outbox and receipts | No |
| `.hearth/backups/` | Encrypted backup archives | No |
| `.hearth/sources/` | Source content snapshots | No |
| `.hearth/device-frames/` | Desktop observation frames | No |
| `eval/runs/` | Phase-one acceptance runs and artifacts | No |

## Encrypted backup

The server exposes an encrypted backup API. The passphrase must be at least 12 characters; it is stretched with scrypt (N=32768, r=8, p=1), and the archive uses AES-256-GCM.

Create a backup:

```bash
curl -X POST http://127.0.0.1:4317/api/backups \
  -H "content-type: application/json" \
  -d "{\"passphrase\":\"replace-with-a-long-passphrase\"}"
```

List and download:

```bash
curl http://127.0.0.1:4317/api/backups
curl -OJ http://127.0.0.1:4317/api/backups/<id>/download
```

Restore from a stored archive:

```bash
curl -X POST http://127.0.0.1:4317/api/backups/<id>/restore \
  -H "content-type: application/json" \
  -d "{\"passphrase\":\"replace-with-a-long-passphrase\"}"
```

Restore writes a temporary SQLite file, checks `user_version`, schema, and `integrity_check`, rebuilds projections, then copies in a transaction; failure rolls back. The scheduler stops during restore and restarts afterward if it was running and the global kill switch is not active.

::: warning A recoverable database is not a portable artifact archive
The backup does not include artifact bodies, workspaces, source bodies, outbox attachments, desktop screenshots, or external service data. After restore, tasks may reappear while artifact files still need separate verification. For a complete archive, also copy `.hearth/artifacts/`, `.hearth/workspaces/`, `.hearth/sources/`, `.hearth/outbox/`, and `eval/runs/`.
:::

## Global stop and kill switch

After `POST /api/security/kill-switch` enables the global stop:

- The scheduler stops and desktop sessions freeze.
- Pending approvals are cancelled and related tasks become recoverable.
- The scheduler does not auto-start when the service restarts.
- A security audit record is written.

Clearing the kill switch does not automatically restart the scheduler; call `POST /api/system/start` or restart the service explicitly.

## Health and maintenance

- `GET /api/health`: uptime, memory, disk, schema, task counts, scheduler, approvals, kill switch, and last maintenance.
- `GET /api/maintenance`: last maintenance result.
- `POST /api/maintenance/run`: run maintenance manually.
- `GET /api/diagnostics`: download redacted diagnostics without paths, keys, or environment secrets.

Maintenance runs every six hours after startup. It clears expired approvals, recovers interrupted tasks, and deletes expired leases, desktop commands, screenshots, pairings, and temporary files. It does not delete tasks, memory, or artifacts.

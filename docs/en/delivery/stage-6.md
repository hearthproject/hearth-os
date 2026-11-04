---
title: 'Stage 6 · Multi-device & Operations'
description: 'Hearth Stage 6 development module: event sync, device routing, offline queues, revocation and key rotation, backup and restore, long-running operations, and full audit.'
outline: [2, 3]
---

<p class="eyebrow">MODULE 6 / 7</p>

# Stage 6 · Multi-device & Operations

<p class="lead">Turn the local product into a long-running, multi-device, portable, and revocable personal Agent OS. Multi-device is not multiple agents: it is one logical identity, event history, memory, and authorization across devices.</p>

## Prerequisites

- Single-device install, recovery, backup, security, and upgrade paths work.
- Events, leases, fencing tokens, memory versions, and device identity have stable contracts.
- Multi-device operation cannot bypass approval, idempotency, or revocation boundaries.

## Development Steps

1. **Implement read and event sync.** Add device identity, cursors, incremental sync, conflict handling, event replay, and projection consistency.
2. **Add capability routing and offline queues.** Route GUI, file, and execution tasks by device capability; queue while offline, then replay idempotently without duplicate effects.
3. **Complete revocation and key rotation.** Handle lost devices, remote revocation, key rotation, session invalidation, and secure migration.
4. **Complete backup, restore, and upgrade.** Support encrypted backup, full restore, export/import, schema migration, executor version pinning, pre-upgrade checks, and rollback.
5. **Build long-running operations.** Add health checks, quotas, logs, monitoring, resource reclamation, failure recovery, and long-term migration drills.
6. **Complete the system audit.** Pass every stage exit, audit all eight task families, run red-team and fault injection, rehearse migration, and publish privacy, installer, upgrade, and final evaluation evidence.

## Increment Breakdown

| Increment | User-visible outcome | Completion evidence |
|---|---|---|
| D6.1 Multi-device read and event sync | Consistent tasks and artifacts across devices | Device identity, cursors, incremental sync, replay |
| D6.2 Capability routing and offline queues | Tasks go to the right device and survive disconnection | Capability routing, offline queue, idempotent replay |
| D6.3 Revocation, key rotation, and secure migration | Lost devices are revocable and data can move safely | Revocation, rotation, session invalidation, migration drill |
| D6.4 Backup, restore, migration, and upgrade | Users can fully back up, restore, and upgrade | Encrypted backup, schema migration, rollback |
| D6.5 Long-running operations and resources | The system runs long-term without daily maintenance | Health checks, quotas, monitoring, resource reclamation |
| D6.6 Full audit and release | An installable, portable, revocable personal Agent OS | Eight-family coverage, red team, fault injection, final evaluation |

## Exit Checklist

- [ ] One logical agent stays consistent across devices; switching devices loses no tasks.
- [ ] Offline recovery meets target; device switching and retries do not duplicate external effects.
- [ ] Device revocation is immediate and blocks further approval or takeover.
- [ ] Events, artifacts, memory, and skills verify after migration.
- [ ] Long-running operation has no leaks, state drift, or unexplained permission expansion.
- [ ] Install, upgrade, backup, restore, privacy, and export paths are complete.

## Out of Scope

- Multiple inconsistent agents presented as multi-device support.
- Using sync conflicts or offline queues to excuse duplicate effects.
- Declaring completion without migration drills and revocation.

## After Completion

After this module, the project enters long-term maintenance and expansion. More task families, connectors, and optimizations will follow, but foundational product, recovery, security, approval, and migration are no longer deferred work.

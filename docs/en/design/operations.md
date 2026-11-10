---
title: 'Multi-device and Long-running Operation'
description: 'How Hearth keeps tasks, authority, and data consistent across devices over time and handles backup, recovery, revocation, and upgrades.'
outline: false
---

# Multi-device and Long-running Operation

<p class="lead">Multi-device does not mean opening the same web page in several places. It means letting a computer, phone, and other trusted devices work with one logical assistant while handling offline use, synchronization, revocation, backup, and long-term state drift.</p>

## Design Goals

Users should see the same tasks, approvals, and artifacts on different devices and continue from where they stopped when switching devices. Devices can have different capabilities: a phone is better for approvals and takeover, a desktop can operate local software, and a home server can stay online. The system cannot assume every device is equal.

The connection runtime separates transport, subscription, data freshness, and execution ownership. Each device and user has an owner connection; reconnect advances the generation and rejects old-generation writes. Offline actions enter only the connection outbox, while cached projections expose `cached`, `asOf`, and cursor values so they cannot masquerade as live data. A remote action that disconnects becomes uncertain and requires explicit reconciliation. Real remote nodes, phone reconnect, and cross-node outbox reconciliation are still unaccepted, so a code loop is not a completed multi-device delivery.

Offline is a normal state. A disconnected device can still inspect existing tasks, record actions, and queue pending actions. When it reconnects, actions are submitted in order. A conflict preserves both sources and asks for confirmation; it is never silently overwritten. When a device is lost or revoked, other devices stop sending it sensitive data and withdraw capability and keys as soon as possible.

Long-running operation is about resources, not merely "it did not crash". Memory, disk, caches, logs, background tasks, connections, and temporary files need limits and cleanup rules. Health checks, anomaly alerts, upgrades, and rollback cover the service, database, device agents, and external connections.

Backup, recovery, and migration must be tested on real data. Users can export tasks, artifacts, memory, and necessary configuration, restore them on another device, and confirm that sensitive data, authority, and deletion state remain correct. Version upgrades keep old data readable, and a failed migration can roll back.

## Design Tradeoffs

Hearth keeps one logical authoritative state while devices hold local projections and necessary offline queues. The user experiences one assistant, not several robots that disagree. Sync uses versions and deletion markers so an old device cannot resurrect content that was deleted.

| Scenario | Hearth's handling | What must not happen |
|---|---|---|
| Switching devices | Rebuild tasks and artifacts from the shared record and keep the last position | Treating one device's temporary interface state as fact |
| Offline action | Queue locally, submit in order after reconnect, and validate versions | Silently choosing one side of a conflict |
| Device revocation | Withdraw capability, stop sync, rotate keys, and clear sensitive copies | Assuming a lost device will leave on its own |
| Backup and restore | Export with encryption and verify tasks, artifacts, memory, and authority | Backing up only the database while ignoring files and configuration |
| Version upgrade | Back up before migration and verify and support rollback afterward | Changing data structures when rollback is impossible |
| Long-running operation | Resource limits, health checks, cleanup, and anomaly alerts | Using "just restart it" to hide a leak or persistent drift |

Devices are capability and trust boundaries, not just login terminals. Pairing declares what a device can do, which data it can access, and whether local confirmation is required. High-risk capability is available only on explicitly authorized devices. Tasks can queue while a device is offline, but work involving a real-time external action pauses or asks for help.

Long-running tests last for weeks and observe memory, disk, task state, sync delay, permission drift, and external connections. If authority expands, state fails to converge, deleted content reappears, or external effects repeat, release stops and returns to the last stable version instead of adding more features.

The v1.0 standard is that a user can install, use, back up, migrate, and leave independently. The system does not need to cover every enterprise scenario, but a personal user must know where data lives, which devices are still valid, how to revoke authority, how to recover failed work, and how to continue without depending on the developers.

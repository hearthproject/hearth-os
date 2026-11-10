---
title: 'Runtime and Safety'
description: 'How Hearth limits real-world impact through workspaces, isolation, network egress, credentials, privacy, supply chain, and device loss.'
outline: false
---

# Runtime and Safety

<p class="lead">Security is not a layer added at the end. It is the precondition for a product that touches real files, accounts, and devices on the user's behalf. Hearth grants only the minimum needed for the task and withdraws temporary capability when the task ends.</p>

## Design Goals

The execution environment must distinguish what can be read, written, sent over the network, and accessed through credentials. Research can be read-only. Code and document work uses a recoverable workspace. Untrusted files enter isolation. Work that needs a specific device runs only on that device. Temporary authority, file mounts, and network rules cannot remain forever.

Network access is denied by default; only domains and ports explicitly needed by the task are opened. Access is logged through a proxy, local management interfaces and cloud metadata addresses are blocked, and downloads enter quarantine before scanning and parsing. Attempts to bypass network restrictions are security incidents, not ordinary failures.

Credentials are managed behind a separate boundary. Models and executors never see long-lived passwords, refresh tokens, or complete secrets. They receive short-lived capabilities for the task and scope. Connectors inject credentials when calling an external service, and use is audited, redacted, and revocable.

Local-first is part of privacy design. Personal files, memory, events, and credentials remain in an environment the user controls by default. When remote models, remote execution, or cloud sync are used, the system states which data leaves the device, how long it is retained, whether it can be deleted, and how it can be exported.

## Design Tradeoffs

Workspaces are chosen by task risk rather than sharing one large directory. Read-only workspaces support research and review. Disposable workspaces are destroyed when the task ends. Copy-on-write workspaces preserve originals and support diffs and rollback. Long-lived project workspaces have versions, quotas, and cleanup rules. Remote device workspaces use encrypted transfer and short-lived authority.

| Isolation method | Suitable for | Limitation |
|---|---|---|
| Restricted process | Trusted scripts and lightweight tools | Not a strong boundary against malicious code |
| Container | General code, tests, and document conversion | Shares the kernel and is not absolute protection |
| Lightweight virtual machine | Untrusted code, external files, and high-risk research | Higher startup and resource cost |
| Virtual desktop | Graphical software and untrusted desktop apps | Complex to operate and still needs network and credential control |
| Remote device | Operations that must happen on a particular device | Loss, offline state, and revocation need separate handling |

Containers are useful operational isolation, not an absolute guarantee against malicious code. Macros, downloads, browser pages, external code, and high-risk documents need stronger isolation. The safety level follows task source, data sensitivity, reversibility, and external impact, not just the executor type.

Credentials never enter the model context. Hearth grants short-lived capability by account, resource, action, device, and time, then revokes it when the task ends. Logs, errors, and model inputs are redacted automatically. Users can see which connections remain active and revoke all grants at once.

Delegation is single-layer, and a child task can only inherit and narrow the parent's workspace, network, and credential scope. A handoff packet must carry the goal, evidence, remaining budget, and generation; results from an old generation cannot overwrite newer state. The current local sandbox checks path, process, network, and credential policy and fails closed on escape. It is not a container- or VM-level strong boundary, so high-risk code still needs a stronger isolated environment. See [Delegation, Handoff, and Sandboxing](/en/design/delegation-and-sandbox).

Supply chain and device safety are product boundaries too. Dependencies are pinned, audited, and minimized. Extensions do not receive all permissions by default. Device pairing declares identity and capability, and a lost device can be revoked, have keys rotated, and have local data cleared. A serious incident needs a global pause and isolation entry, not only one-by-one task cancellation.

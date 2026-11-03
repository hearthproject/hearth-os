---
title: "Security and Privacy"
description: "Hearth's trust boundaries, threat model, Capability model, risk classification, credentials, Sandbox, prompt injection, privacy, and incident response."
outline: [2, 3]
---

<p class="eyebrow">SECURITY & PRIVACY</p>

# Security and Privacy

<p class="lead">Security is not a pre-release check; it is a product capability. Trust boundaries, Capability, risk classification, credentials, and incident response must all be reflected in the architecture.</p>

## Security Is a Product Capability

Hearth security is not "adding an approval dialog"; it is a system capability that spans provenance, context, permissions, execution, side effects, and recovery. Models are not trusted execution environments, web pages are not trusted instructions, documents are not trusted code, and data returned by Connectors is not automatically trusted.

### Trust Boundaries

```text
Untrusted external content
  → Gateway normalization
  → Policy / data labeling
  → Minimal context
  → Executor
  → Sandbox
  → Effect Dispatcher
  → External systems
```

Each layer assumes the next layer may be compromised. External content can influence task content, but cannot expand permissions, modify Policy, or directly trigger high-risk side effects.

### Threat model

| Threat | Scenario | Defense |
|---|---|---|
| Prompt injection | Web pages/emails request file leaks or instruct ignoring rules | Data-instruction separation, tool allowlist, untrusted markers |
| Credential theft | Model is induced to read tokens | Broker, minimal injection, log redaction |
| Data exfiltration | Malicious documents induce uploads | egress allowlist, DLP, read-only mounts |
| Duplicate side effects | Retry after timeout causes duplicate sending | Idempotency keys, outbox, reconciliation |
| Malicious attachments | Macros, zip bombs, path traversal | Sandboxed parsing, macro disabling, resource limits |
| Supply chain | Dependencies/skills tampered with | Version pinning, signatures, SBOM, review |
| Sandbox escape | Malicious code breaks out of the container | Strong isolation, non-root, no host sockets |
| Memory poisoning | Untrusted sources write long-term preferences | quarantine, dual-source, user confirmation |
| Device loss | Phone or computer used by someone else | Revocation, expiration, biometrics, encryption |
| Over-automation | Agent expands scope without supervision | Mandate, budget, kill switch |

### Capability model

A Capability is not “an Agent has a tool,” but a permission for a specific resource, action, scope, and time limit:

```ts
type Capability = {
  action: string;
  resource: string;
  scope?: Record<string, string>;
  constraints?: Record<string, unknown>;
  expiresAt: string;
  revokedAt?: string;
  issuedBy: string;
  mandateId: string;
};
```

Principles: least privilege, short-lived validity, reclamation when the Task ends, scoped by device/account/resource/action, Executor cannot self-sign or expand, all use is auditable, revocation takes effect immediately.

### Risk levels

| Level | Example | Default handling |
|---|---|---|
| R0 Read-only | Viewing files, reading email, searching | May be automatic |
| R1 Low-risk writes | Drafts, temporary files, workspace changes | Automatic within Mandate |
| R2 Externally visible | Sending email, comments, sharing | Approval on first use or every use |
| R3 Irreversible | Deletion, payments, permission changes, public publishing | Strong approval + Receipt + compensation |
| R4 Prohibited | Bypassing security controls, leaking secrets, unauthorized transfers | Denied by the system |

### Credentials and secrets

- Long-term secrets exist only in the Broker/key vault;
- Model context never contains refresh tokens, private keys, or cookies;
- Short-term tokens are injected only when calling external APIs;
- Logs, exceptions, screenshots, and Artifact content are scanned for sensitive information;
- Development, testing, and production use different credentials;
- Local storage and backups are encrypted;
- Revocation by connection, device, and account is supported;
- Users can view “who used what permission and when”.

### Sandbox, network, and prompt injection

- Minimal mounts and shortest lifecycle by default;
- Deny outbound by default; open allowlists per Task;
- External pages and documents are marked as untrusted;
- Untrusted content cannot directly determine tool calls;
- High-risk actions must pass through the Effect Dispatcher and approval;
- Downloads, macros, and attachments enter quarantine;
- Sandbox failures are treated as security incidents and are not masked with “try again.”

### Privacy and local-first

- Local storage by default;
- Upload only the minimal context required by the Task;
- Sensitive data can be designated for local models or manual handling;
- Memory, logs, and Artifact have sensitivity levels;
- Deletion and forgetting must propagate;
- Backups are encrypted;
- Data export and migration are available;
- User data is not used for training or sharing without consent.

### Supply chain and extensions

- Dependencies are version-locked, verified, and covered by SBOM;
- Skills/plugins are signed or source-verified;
- Third-party Connectors use least privilege;
- Plugins cannot bypass Policy;
- High-risk extensions require manual review;
- Run security and contract tests before upgrades.

### Multi-device security

- Device pairing uses short-term codes and public keys;
- Phones do not hold long-term master credentials;
- Approvals are bound to nonce, parameters, and expiration time;
- Lost devices can be revoked remotely;
- Offline caches are read-only and produce no external side effects;
- Only necessary projections and artifact references are synchronized across devices;
- Memory deletion cannot be resurrected on another device.

### Incident response and kill switch

- Global stop switch;
- Local stops by device, Connector, skill, Task, and account;
- After stopping, audit and recovery entry points are retained;
- Key rotation;
- Clean up affected credentials and caches after an incident;
- Output readable incident reports;
- Do not treat “restarting the service” as incident handling.

### Backup, recovery, and deletion

- Encrypted backups;
- After recovery, verify events, artifacts, memory, and permissions;
- Deletion propagates to projections, indexes, caches, and devices;
- Retain the minimum information required for auditing, but do not retain sensitive content that should not be retained;
- Users can export their own data;
- Re-verify after migration; do not assume the copy succeeded.

### Security testing

- Prompt injection and tool privilege escalation;
- Secret leakage;
- Path traversal, macros, zip bombs;
- Sandbox escape;
- Network egress bypass;
- Approval replay;
- Device revocation;
- Duplicate side effects;
- Supply chain tampering;
- Memory poisoning;
- Data and backup deletion.

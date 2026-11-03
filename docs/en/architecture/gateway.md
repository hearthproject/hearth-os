---
title: 'Personal Gateway and Multiple Entry Points'
description: 'Channel normalization, event deduplication, attention inbox, device registration, and mobile access for the Hearth Personal Gateway.'
outline: [2, 3]
---

<p class="eyebrow">PERSONAL GATEWAY</p>

# Personal Gateway and Multiple Entry Points

<p class="lead">How users, email, calendars, IM, GitHub, web pages, files, and devices are normalized into deduplicable, traceable events.</p>

## Personal Gateway and Multiple Entry Points

Personal Gateway is the sole entry point between Hearth and the outside world. It is responsible for:

- identifying users, devices, and channels;
- receiving text, voice, files, images, web pages, email, calendar, and scheduled events;
- converting them uniformly into `Event`;
- deduplicating, ordering, rate-limiting, and source tagging;
- determining which events enter the attention inbox;
- maintaining device registration, online status, and pairing relationships;
- providing secure APIs and push notifications for mobile devices instead of exposing local ports.

The Gateway does not perform long-running task reasoning or directly execute business actions.

### Input Channels

| Channel | Typical Input | Handling |
|---|---|---|
| CLI | Commands, scripts, development debugging | Direct to Gateway; structured output supported |
| Web/PWA | Text, files, drag-and-drop, sharing | Task cards and approval center |
| Mobile | Text, voice, sharing, photo capture, notifications | Approve, view, take over, initiate |
| IM | Messages, files, forwarding | Normalized by Channel Adapter |
| Email | Email and attachments | Read-only sync, drafts, send pending approval |
| Calendar | Calendar events and invitations | Read-only, conflict checking, writes pending approval |
| Device | Files, screen, camera, sensors | Device capabilities and authorization |
| Cron/Watch | Timers, file changes, web page changes | Trigger evaluation |
| API/MCP | External service events | Normalized by Connector |

Stage 0 only designs the channel model and UI states; Stage 1 only connects Web and CLI; Stage 2 then connects the first real Connector. Do not roll out all channels from the start.

### Event Normalization and Deduplication

All channel events contain at least:

- source type and source id;
- trust level;
- user/device identity;
- original timestamp;
- content reference or redacted summary;
- conversation/thread association;
- idempotency key;
- whether it is allowed to trigger proactive Tasks.

Default policies:

- the same event from the same source is processed only once;
- duplicate notifications are merged;
- low-value events are only recorded, not reasoned over;
- untrusted sources cannot create high-risk Mandates;
- external content cannot override system Policy.

### Attention Inbox

The Attention Inbox is not a message list but the “minimal set that requires human handling”:

- actions that require approval;
- Tasks that require additional information;
- Tasks that failed and cannot recover automatically;
- browsers or desktops that require takeover;
- completed Artifacts;
- summaries that can be reviewed later.

By default, the following do not enter the inbox: low-confidence observations with no side effects, duplicate events filtered by rules, pure state changes, and failed retries that do not require human decisions.

Ordering criteria:

```text
priority = risk × blockedness × deadline × userImpact × reversibilityPenalty
```

After the user closes a channel, no other channel can bypass it.

### Device Registration and Capability Catalog

During device registration, the device reports:

- device id and public key;
- operating system and version;
- online status and heartbeat;
- available capabilities: files, terminal, browser, screen, camera, microphone, notifications, clipboard;
- accessible local data scope;
- security boundaries and Sandbox support;
- user-granted capabilities;
- device lease and expiration time.

Device capabilities are not permanent authorizations. After a Task ends, temporary capabilities should be reclaimed automatically.

### Mobile Access

Phones are Hearth's remote entry point, not the default execution authority. The first version of Stage 4 supports only:

1. Viewing Tasks, status, and Artifacts;
2. Approving high-risk actions;
3. Taking over abnormal Tasks;
4. Initiating new Tasks;
5. Receiving high-signal notifications.

Security requirements:

- Access through a secure tunnel or push service;
- Do not expose Agent ports directly;
- Device pairing uses short-lived codes and public keys;
- Approvals bind to a nonce, action parameters, and expiration time;
- Notifications contain only redacted summaries;
- If a device is lost, all tokens and leases can be revoked.

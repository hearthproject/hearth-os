---
title: "Phase 2 and 3 Delivery Status"
description: "Verified capabilities, local substitutes, and deliberately unfinished work."
outline: [2, 3]
---

# Phase 2 and 3 Delivery Status

Checked on 2026-11-06. This page records only what the current code and real runs can prove; a page existing is not treated as a completed loop.

## Phase result

- **Phase 2: partially complete.** Local files, knowledge bases, public web, document and spreadsheet extraction, task source references, and the draft → approval → local outbox write → receipt loop are usable. Email and calendar accounts, real sending, and external system writes are not implemented, so Phase 2 is not accepted as a whole.
- **Phase 3: partially complete.** A same-machine Windows device can pair, approve capabilities individually, observe, pause, resume, take over, hand back, terminate, and run low-risk click, type, key, and UI Automation actions against an explicitly approved target app. Sensitive-area masking, isolated desktops, high-risk actions, snapshots, and compensation are not implemented, so Phase 3 is not accepted as a whole.

## Phase 2 capabilities

| Step | Status | Implemented | Deliberately unfinished |
|---|---|---|---|
| 2.1 Read-only sources | Partial | Local file, knowledge, and public web sources; host allowlists; source status, read time, errors, incremental reads, deduplication, disconnect, reconnect, and clear | Email and calendar only show “needs configuration”; no credentials, reads, or permission verification |
| 2.2 Documents, tables, and web material | Basic loop complete | TXT, Markdown, CSV, JSON, HTML, PDF, DOCX, and XLSX extraction; page, paragraph, sheet, range, and gap metadata; web snapshots and source items can be reviewed | Complex layouts, OCR for scans, page-level citation navigation, and spreadsheet formula fidelity are not implemented |
| 2.3 Draft, approval, and external write | Partial | Editable, savable, and discardable drafts; one-time short-lived approval; approved effects write to the local outbox with a receipt; rejection and expiry update the draft | Only writes local `.hearth/outbox` files and does not contact mail servers; calendar and other external writes are absent |
| 2.4 Everyday-content acceptance | Not complete | Automated tests and isolated-instance checks cover local sources, extraction, and the outbox loop | No 10–15 real everyday tasks, time, accuracy, recovery, or willingness-to-reuse acceptance |

The local outbox is not presented as a fake success: the UI states that it only writes locally and does not send to recipients. It must not be described as sent before a real mail account is connected.

## Phase 3 capabilities

| Step | Status | Implemented | Deliberately unfinished |
|---|---|---|---|
| 3.1 Connect and inspect a device | Partial | Six-digit pairing code, device token, pairing approval separate from capability approval, per-capability grants, app allowlist, online state, and device revocation | No tray or always-visible global “auto control” indicator; Windows same-machine helper only |
| 3.2 Observe and take over | Partial | Session-bound screenshots; pause, resume, takeover, hand back, and terminate; takeover cancels queued input and advances the control epoch; user-idle check; two-minute screenshot expiry | Sensitive-area masking, long recordings, and complete desktop snapshots are absent |
| 3.3 Tiered desktop actions | Partial | Target-app binding and focus revalidation; click, short text, Enter/Tab/Escape/Ctrl+S; allowlisted UIA invoke/setvalue; command status and result records; structured rejection | High-risk preview and confirmation, isolated desktop, snapshots, compensation, and real UIA action acceptance are not complete |
| 3.4 Desktop acceptance | Not complete | Isolated-port checks cover pairing, capability approval, observation, pause, resume, takeover, hand back, and the pro view | No five real desktop tasks, success-rate, takeover-count, and failure-drill acceptance |

The Windows helper currently focuses the server-approved target app before capture or input; it does not claim reliable background input. UWP apps whose windows are hosted by `ApplicationFrameHost` (for example Calculator) cannot yet be mapped reliably to the approved app name. This remains an explicit limitation and must not silently fall back to another app.

## Borrowed patterns and tradeoffs

- **OpenClaw:** pairing is separate from capability approval; commands are declared per device and approved individually; an observation frame is the basis for actions; takeover cancels queued input and advances the control epoch; unsupported actions fail closed. Hearth adopts these boundaries.
- **Hermes:** explicit capability manifests, target revalidation before execution, and session isolation. Hearth adopts app allowlists and target/epoch checks. It does not claim background focus-free input because the current Windows layer cannot reliably prove input still lands in the approved window.

## Remaining real acceptance

1. Read-only email and calendar accounts, real test accounts, and real send receipts.
2. Acceptance records for 10–15 everyday content tasks and at least five desktop tasks.
3. Sensitive-area masking, isolated desktops, snapshots, compensation, and high-risk actions.
4. UWP window mapping, real UIA invoke/setvalue acceptance, and failure drills for lost windows, permission changes, and user takeover.

These gaps are intentionally left open rather than replaced with simulated data or UI that only looks complete.

# Daily Use and Self-Report

Hearth separates "things that need a human" from "what the system is doing". In daily use you only need two places.

## The "Needs You" inbox

**Needs You** (`/inbox`) in the sidebar only carries four signals:

- a task has been running for more than 30 minutes;
- an approval has been waiting for more than 10 minutes;
- a task stopped at its budget limit;
- a task failed or failed recoverably.

Each item can be marked read, snoozed (4 hours by default) or dismissed. The same task and kind do not repeat within 6 hours, and no new items are created between 22:00 and 08:00.

Notifications are not chat bubbles and are never sent to Feishu or email. They live in the local `data/supervision.json` file and are read by the web UI.

## Yesterday's digest

After 08:00, the first inbox request generates a digest for the previous day: completed, failed, waiting-approval and open counts, plus at most three suggestions. It uses the local date and never backfills older days.

## The dogfood report

`npm run dogfood:report` reads the local event log for the last 7 days:

```bash
npm run dogfood:report
npm run dogfood:report -- --days 30 --project hearth-os --out reports/dogfood.md
```

The report contains:

- tasks created, completed, failed and still active;
- success rate (completed ÷ concluded) and first-attempt success;
- attempts, turns, tool calls and input/output tokens;
- approvals, approvals granted and rejected;
- the most common failure messages and tasks that needed more than one attempt.

These numbers describe real local use, not a public benchmark. For public evaluation use `npm run bench:suite` and `docs/evaluation/`. Reports default to `reports/`, which is local-only and not committed.

The runtime console (`/runtime`) shows the same 7-day summary for use without a terminal.

## Boundaries

- The inbox does not decide how a task should be fixed; it reports facts and actions that need a human.
- The dogfood report does not infer causes or blame the model or the user; failure messages are aggregated as recorded.
- Data stays on this machine. Report files can contain task titles; review them before sharing.

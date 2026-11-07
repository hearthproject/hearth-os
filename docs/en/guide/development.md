---
title: 'Development and tests'
description: 'Local scripts, tests, documentation, and code layout.'
outline: [2, 3]
---

# Development and tests

<p class="lead">The repository is one npm workspaces monorepo. The server, web app, shared packages, evaluation suite, and documentation share one TypeScript configuration.</p>

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the server and web dev server together |
| `npm run build` | Build the web production bundle into `apps/web/dist` |
| `npm start` | Start the server in production-style local mode |
| `npm test` | Run the full Vitest suite |
| `npm run test:watch` | Watch mode |
| `npm run typecheck` | TypeScript typecheck |
| `npm run helper:windows` | Start the Windows desktop helper |
| `npm run docs:dev` | Start the docs dev server |
| `npm run docs:build` | Build the docs site into `docs/.vitepress/dist` |
| `npm run docs:preview` | Preview the production docs build |

## Current verification baseline

On 2026-11-07, in the current working tree:

```text
npm test          40 test files, 199 tests passed
npm run typecheck passed
npm run build     passed
npm run docs:build passed
```

Coverage includes the service layer, API, model protocols, native tool loop, budgets, permissions, checkpoints, proposal confirmation, desktop boundaries, memory, methods, sync, security, backup, and operations. Automated tests prove code loops, not real-user, real-device, or long-running acceptance.

## Layout

```text
apps/server/src/
  app.ts              Fastify routes and startup
  scheduler.ts        Serial scheduling and execution
  service.ts          Task state and projections
  approvals.ts        One-time approvals
  effects.ts          Effect ledger and external actions
  sources.ts          Source registry and reads
  extractors.ts       Document and web extraction
  outbox.ts           Local outbox
  desktop.ts          Windows devices and sessions
  proactive.ts        Proactive suggestions and attention budget
  memory.ts           Memory candidates, recall, and forgetting
  methods.ts          Method candidates, evaluation, and promotion
  sync.ts             Event sync and conflicts
  security.ts         Kill switch, tokens, and audit
  backups.ts          Encrypted backup and restore
  health.ts           Health snapshots
  maintenance.ts      Periodic maintenance
packages/
  core/               Domain types, state machine, and DTOs
  eventlog/           SQLite event log and projections
  agent-runtime/      Native tool loop, budgets, checkpoints
  codex-executor/     Codex SDK adapter
  templates/          Task templates and acceptance
```

## Documentation site

`docs/` is the single source of truth for the site. Chinese is the default path and English mirrors live under `docs/en/`.

```bash
npm run docs:dev
npm run docs:build
npm run docs:preview
```

When adding a page, update the nav and sidebar in `docs/.vitepress/config.mts` and add the English mirror. Before publishing, run `docs:build` and check internal links, mobile width, and search.

## Change boundaries

- Do not bypass approval to execute external actions.
- Do not let the interface become a second source of truth; rebuild state from the event log.
- A new executor must declare permissions, budgets, and failure semantics and write its identity into the run manifest.
- When tests fail, do not replace real evidence with fake data or a UI that only looks complete.

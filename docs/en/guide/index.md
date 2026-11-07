---
title: 'Quick start'
description: 'Install Hearth locally, start it, and complete the first task.'
outline: [2, 3]
---

# Quick start

<p class="lead">Hearth is a local-first, single-user application. The server, database, and web control plane all run on your machine and listen only on loopback by default.</p>

## Requirements

| Item | Requirement |
|---|---|
| Node.js | 22.13 or newer (the server uses the built-in `node:sqlite`; verified on 26.11.1) |
| npm | Included with Node.js |
| Operating system | Windows, macOS, or Linux; desktop control currently requires the same-machine Windows helper |
| Model | Any tool-calling OpenAI Chat, OpenAI Responses, Anthropic Messages, or Gemini-compatible service |

## Install and start

```bash
git clone https://github.com/hearthproject/hearth-os.git
cd hearth-os
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. Development mode starts two processes:

- `@hearth/server`: Fastify API and scheduler on `127.0.0.1:4317`.
- `@hearth/web`: Vite dev server, proxying `/api` to the local service.

Production-style local run:

```bash
npm run build
npm start
```

Open <http://127.0.0.1:4317>. The server serves the built web assets directly.

## Complete the first task

1. Open **Settings**, choose a model provider, and fill in Base URL, model, and API key. Click **Test connection**.
2. Return to **Chat** and describe the work in one sentence, for example: "Turn this meeting transcript into action minutes with owners and dates."
3. General tasks are dispatched directly. Tasks that need network access or a writable engineering workspace first produce a **task proposal**; the task enters the queue only after you confirm.
4. Open **Tasks** to inspect status, executor, tokens, duration, and artifacts. A task waiting for input can be continued from chat.
5. External actions appear as approval cards. An approval binds to a parameter fingerprint, executes once, and stores a receipt.

## Where data lives

The default data directory is `.hearth/` at the repository root. Override it with `HEARTH_DATA_DIR`, `HEARTH_PORT`, or `HEARTH_HOST`.

For example, in a Windows terminal:

```bat
set HEARTH_DATA_DIR=D:\HearthData
npm start
```

On macOS or Linux:

```bash
HEARTH_DATA_DIR=/path/to/data npm start
```

## Next

- [Connect a model](/en/guide/models): four protocols, provider presets, and the Codex executor.
- [Data, backup, and restore](/en/guide/data): database, artifacts, encrypted backups, and restore boundaries.
- [Development and tests](/en/guide/development): scripts, tests, documentation, and code layout.

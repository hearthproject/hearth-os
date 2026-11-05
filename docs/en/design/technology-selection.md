---
title: 'Technology Choices & Decisions'
description: 'Hearth''s tradeoffs between TypeScript, Node.js, Rust, Go, Python, and frontend frameworks.'
outline: [2, 3]
---

<p class="eyebrow">TECHNOLOGY</p>

# Technology Choices & Decisions

<p class="lead">Technology choices start from system constraints, not language preferences: Hearth must run for the long term, recover from failure, stay auditable, and share one protocol across its TypeScript frontend, CLI, executors, and control plane.</p>

## Decision at a Glance

| Layer | Decision | Rationale |
|---|---|---|
| Core language | TypeScript | Control plane, Durable Harness, CLI, Web, and executor adapters share types and schemas |
| Service runtime | Node.js 22+ | Runs `hearthd` and the CLI; no microservices in the first stage |
| Server framework | Fastify or Hono | HTTP API, SSE, health checks, and process entry point |
| Database | SQLite WAL + migrations | Single-user, local-first, single-writer; no external database yet |
| Schema | Zod / JSON Schema | Runtime validation and versioned contracts for events, approvals, and Effects |
| Web | React + Vite + PWA | Task cards, approvals, artifacts, takeover, and mobile entry point |
| Realtime | SSE first | Simpler than WebSocket for server-side projection updates |
| Documents and data | Python sidecar | Parsing, OCR, spreadsheets, batch jobs, and evaluation scripts use mature libraries |
| Native components | Rust where needed | Sandbox Supervisor, device agents, crypto, and other boundary components |

The core judgment is: **TypeScript is the primary language, Node.js is the runtime, React and Vite are the frontend implementation, and Python and Rust are boundary capabilities.** This is a modular monolith with a small number of explicit sidecars, not a multilingual microservice system.

## TypeScript Is Not Node.js

TypeScript and Node.js live at different layers and are not alternatives:

- **TypeScript is a language.** It adds static types, interfaces, generics, union types, and type checking to JavaScript. The source eventually becomes JavaScript.
- **Node.js is a runtime.** It is built on V8 and libuv and provides files, networking, processes, HTTP, timers, and other system capabilities.
- **TypeScript does not provide memory safety, concurrency scheduling, or process isolation.** It constrains development-time types; runtime input still needs Zod, JSON Schema, or explicit validation.
- **Node.js does not type-check.** Recent Node versions can strip some TypeScript syntax, but type errors still require `tsc` or an editor.

When this project says “use TypeScript,” it means: **write the control plane, CLI, Web, and executor code in TypeScript, run server code on Node.js, build the browser with Vite, and serve HTTP and SSE through Fastify/Hono.** See [Engineering Delivery and Repository Structure](/en/reference/engineering) for the full stack.

## Why TypeScript Remains the Primary Language

### Shared protocols are the largest structural benefit

Hearth's `Task`, `Ticket`, `Run`, `Event`, `Approval`, `Effect`, `Receipt`, and `Artifact` appear in the server, CLI, browser, and tests. With TypeScript on both sides, these contracts can live in a shared package that produces both runtime validation and static types.

If the backend moved to Rust, the frontend would still need TypeScript types and the backend would need Rust types. JSON Schema, OpenAPI, Protobuf, or N-API boundaries could bridge them, but would add version drift, serialization differences, and another debugging path.

### Hearth orchestrates work rather than computing it

The control plane handles state transitions, policy decisions, scheduling, event writes, SSE, and external process orchestration. These are I/O-heavy tasks. Node's event loop and non-blocking I/O are sufficient, while genuinely CPU-heavy work can move to workers, the Python sidecar, or a Sandbox.

The current target is a single-user, local-first deployment with SQLite WAL and a single `hearthd` process. At this scale, Rust's performance and memory advantages are not the bottleneck. Cross-language complexity would move attention away from task correctness and toward FFI, async runtimes, and build tooling. See [Architecture & Data Flow](/en/architecture/overview).

### The ecosystem shortens the integration path

An Agent OS connects to Codex CLI, MCP servers, email and calendar APIs, Playwright, PWA, SSE, SQLite, process supervision, and testing tools. TypeScript/Node has mature libraries, examples, and debugging support for these integrations. Rust would usually need another adapter or process boundary.

### Single-writer and event sourcing are language-independent

Hearth's reliability comes from the Event Log, outbox, leases, fencing tokens, idempotency keys, and recovery tests, not from a language's memory model. Rust can eliminate some memory errors at compile time, but it cannot guarantee task state machines, approval scope, or side-effect idempotency.

### AI coding changes throughput, not architectural constraints

AI coding lowers the cost of typing, but not the cost of requirement clarification, protocol evolution, integration, or human review. The Rust compiler catches more local errors, but it cannot decide whether a task should run automatically or whether an external effect is authorized. Semantic correctness, recoverability, and security boundaries still require design, testing, and review.

## Boundaries for Rust, Go, and Python

| Language | Strength | Role in Hearth |
|---|---|---|
| TypeScript | Shared frontend/backend types, broad ecosystem, fast iteration | Control plane, Harness, CLI, Web, executor adapters |
| Rust | Memory safety, low overhead, strong types, single binary | Optional Sandbox Supervisor, device agent, crypto, and low-level boundary components |
| Go | Simple concurrency, single binary, easy deployment | Not selected now; revisit if the project moves to a high-concurrency cloud service |
| Python | Mature document, data, OCR, ML, and evaluation ecosystem | `sidecars/docdata`, offline processing, and evaluation scripts |

Revisit Rust if any of these conditions becomes true:

- Target devices cannot run Node.js reliably, or a single native binary is required;
- A large amount of untrusted code must run in-process and memory isolation becomes a core security boundary;
- Local event volume, file processing, or concurrent tasks grow far beyond a single-user MVP;
- The team can maintain a long-lived Rust async and multi-crate codebase.

Even then, the better route is **Rust boundary components plus a TypeScript control plane**, not an immediate rewrite. Events and APIs should remain language-neutral so implementations can be replaced later.

## Frontend: Full-Stack TypeScript Still Uses a Framework

“Full-stack TypeScript” means the frontend and backend share one language. It does not mean avoiding UI frameworks or build tools. The layers are:

| Layer | Choice | Role |
|---|---|---|
| Language | TypeScript | Business logic, components, types, and protocols |
| UI | React | Components, state binding, routing, and interaction |
| Build | Vite | Compile TS/TSX, hot reload, bundling, and PWA |
| Runtime | Browser / Node.js | Web runs in the browser; `hearthd` runs on Node |
| Server framework | Fastify / Hono | HTTP, SSE, and the server entry point |

### Why React

Hearth's frontend is not a static showcase. It is the operating surface for task cards, approvals, artifacts, takeover, live state, and failure recovery. React's component model, TypeScript support, testing tools, PWA options, and accessibility ecosystem fit this kind of interaction, and match the current `React + Vite + PWA` choice.

React is not the only answer. Vue 3 + Vite is also a valid TypeScript solution with a lighter template syntax. If the team is more comfortable with Vue, there is no reason to force a switch. What must stay stable is the server projection, command interface, error semantics, and permission boundary, not the component implementation.

### Why not native HTML/CSS/JavaScript

Native HTML, CSS, and JavaScript are the foundation of the browser, but building the whole application directly requires solving component reuse, state synchronization, routing, form validation, accessibility, live events, and test organization. Hearth's task cards and approval flows have many shared states and failure paths; hand-written DOM code tends to reinvent an incomplete framework.

The native stack is a good fit for documentation sites, static pages, and one-off prototypes. Use React or Vue for the real application, and keep the UI as a rendering layer over server projections.

### Why not Next.js yet

Local-first `hearthd` already provides HTTP, SSE, and single-writer state. Next.js adds a server runtime, rendering layer, and deployment model that can easily become a second source of truth. For now, a Vite SPA with SSE is simpler and matches the boundary of a single-process local service.

## Risks and Constraints

| Risk | Mitigation |
|---|---|
| Node's single thread is blocked by CPU work | Move CPU work to workers, the Python sidecar, or a Sandbox; keep the control plane orchestration-only |
| TypeScript has no runtime types | Validate all external input, events, and Effects with Zod / JSON Schema |
| Long-running process memory leaks | Process supervision, soak tests, heap snapshots, and rollback-capable releases |
| SQLite write contention | Single writer, WAL, outbox, leases, and fencing tokens |
| npm supply-chain risk | pnpm lockfile, dependency auditing, minimal dependencies, and release checks |
| AI-generated semantic errors | Contract tests, fault injection, permission-denial tests, and human review |
| Cross-language migration cost | Keep events and APIs language-neutral rather than locking domain protocols into TypeScript |

## Decision Recap

**Final decision: TypeScript / Node.js is the primary stack, React + Vite + PWA is the frontend, Python is the document and data sidecar, and Rust is reserved for boundary components that genuinely need it.** AI coding makes implementation faster, but does not change the conclusion: speed is not the bottleneck; system boundaries, protocol consistency, recoverability, and security responsibility are.

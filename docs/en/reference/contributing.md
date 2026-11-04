---
title: 'Contributing and Documentation Maintenance'
description: "Hearth's repository structure, local development, documentation writing conventions, PR checklist, sources of truth, and license."
outline: [2, 3]
---

<p class="eyebrow">CONTRIBUTING</p>

# Contributing and Documentation Maintenance

<p class="lead">Hearth is still in the specification stage. The most valuable contributions right now are clarifying product boundaries, strengthening the protocol, challenging risk assumptions, and making the documentation easier for implementers to use.</p>

## Repository Structure

```text
hearth-os/
├─ docs/
│  ├─ index.md                 # Chinese homepage
│  ├─ en/                      # English mirror
│  ├─ guide/                   # Getting started
│  ├─ product/                 # Product definition and principles
│  ├─ architecture/            # System design
│  ├─ delivery/                # Roadmap, planning, engineering, and risks
│  ├─ reference/               # Boundaries, terminology, FAQ, archive
│  └─ .vitepress/              # Site configuration and theme
├─ package.json
└─ README.md
```

## Local Development

```bash
npm install
npm run docs:dev
```

Build and preview:

```bash
npm run docs:build
npm run docs:preview
```

## Documentation Writing Conventions

- State the conclusion first, then explain the reasoning; avoid burying implementation details in long paragraphs.
- Use explicit entity names: Task, Ticket, Run, Mandate, Receipt, Artifact, Memory, Skill.
- Distinguish between "facts," "judgments," and "hypotheses pending verification"; do not write aspirations as completed capabilities.
- Every phase must have a user-visible interface, persistent state, verification evidence, and a recovery path.
- External side effects must clearly document approval, idempotency, receipts, and reconciliation.
- Prefer text or Mermaid for diagrams to ensure they are diffable and translatable.
- Keep Chinese and English isomorphic: paths, heading levels, and navigation positions must match.

## Before Submitting a PR

1. Run `npm run docs:build` to confirm there are no dead links or build errors;
2. Check whether the paths of Chinese pages and English pages correspond;
3. If you have modified facts, protocols, or phase gates, also check the [full roadmap](/en/reference/full-roadmap) and related ADRs;
4. Explain which phase, which readers, and which risks the change affects;
5. Do not commit `.vitepress/dist`, caches, or local secrets.

## Documentation Source of Truth

This site is the readable edition of the original roadmap; the [full roadmap archive](/en/reference/full-roadmap) retains the original long-form document. If discrepancies arise between the two, the full master document and the repository commit history take precedence, and the reason for restructuring should be explained in the PR.

## License

The project uses Apache-2.0. Submitting a contribution indicates that you agree to publish the content under this license.

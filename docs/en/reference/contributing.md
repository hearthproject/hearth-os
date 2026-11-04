---
title: 'Contributing and Documentation Maintenance'
description: "Hearth's repository structure, local development, documentation conventions, PR checklist, sources of truth, and license."
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
│  ├─ design/                  # Positioning, principles, tradeoffs, and status
│  ├─ architecture/            # Detailed architecture pages
│  ├─ delivery/                # Delivery route and Stages 0–6
│  ├─ log/                     # Daily development logs
│  ├─ reference/               # Appendix, engineering, risks, and decisions
│  └─ .vitepress/              # Site configuration and theme
├─ scripts/                    # Delivery-page generation
├─ package.json
├─ README.md                   # English repository entry
└─ README.zh-CN.md             # Chinese repository entry
```

## Local Development

```bash
npm ci
npm run docs:dev
```

Build and preview:

```bash
npm run docs:build
npm run docs:preview
```

## Documentation Conventions

- State the conclusion first, then explain the reasoning; avoid burying implementation details in long paragraphs.
- Use explicit entity names: Task, Ticket, Run, Mandate, Receipt, Artifact, Memory, Skill.
- Distinguish between facts, judgments, and hypotheses pending verification; do not write aspirations as completed capabilities.
- Every stage must have a user-visible interface, persistent state, verification evidence, and a recovery path.
- External side effects must clearly document approval, idempotency, receipts, and reconciliation.
- Prefer text or Mermaid for diagrams so they remain diffable and translatable.
- Keep Chinese and English isomorphic: paths, heading levels, and navigation positions must match.
- Write formal documentation only under `docs/`; README is an entry point, not a second copy of the body text.

## Development Log Rules

- Keep one page per day; do not restore a log index or log template.
- Start with a single daily summary that explains what was completed and which parts were merged or adjusted.
- Follow the summary with only a commit table: Commit, Author, Changes.
- When new commits land on the same day, append rows to the existing table; do not add stage reports, retrospectives, or todo sections.

## Before Submitting a PR

1. Run `npm run docs:build` to confirm there are no dead links or build errors.
2. Check whether Chinese and English paths correspond.
3. If facts, protocols, or stage gates changed, also check the [full roadmap](/en/reference/full-roadmap) and related ADRs.
4. Explain which stage, readers, and risks the change affects.
5. Do not commit `.vitepress/dist`, caches, or local secrets.

## Documentation Source of Truth

`docs/` is the only formal documentation source shared by the repository and the site; there is no second copy of the body text. Chinese pages are the default reading path, and English pages mirror them under `docs/en/`. The [full roadmap archive](/en/reference/full-roadmap) is also a page inside `docs/` and preserves long-form detail. When facts, protocols, or stage gates change, update the Chinese page, English mirror, and related indexes together.

## License

The project uses Apache-2.0. Submitting a contribution indicates that you agree to publish the content under this license.

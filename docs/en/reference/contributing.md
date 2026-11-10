---
title: 'Contributing'
description: 'Hearth repository structure, local setup, writing conventions, submission checks, and documentation source of truth.'
outline: [2]
---

# Contributing

<p class="lead">Hearth has entered Phase 1 MVP implementation. The most valuable contributions still clarify boundaries, challenge risk assumptions, add real tasks, and make the documentation easier for implementers to use; implementation changes backed by acceptance evidence are now welcome too. A change does not need to be long, but it must make the conclusion more accurate or the evidence clearer.</p>

## Local Setup and Writing Conventions

Formal documentation lives only under `docs/`, and the site builds directly from it. The README is a repository entry point, not a second copy of the body text. Chinese is the default reading path, and English mirrors use the same paths and structure.

| Directory | Content |
|---|---|
| `docs/design/` | One overall design and fifteen parallel module notes, grouped into three sets |
| `docs/delivery/` | Six phases, 24 small stages, and the delivery overview |
| `docs/reference/` | Engineering, risk, decisions, boundaries, terminology, checklists, and maintenance |
| `docs/en/` | English mirror of every page |
| `docs/.vitepress/` | Site configuration, navigation, sidebar, and theme |
| `scripts/` | Delivery-page generation and coverage checks |

Local development needs Node.js 22.13 or newer and npm. Install dependencies with `npm ci`, develop with `npm run docs:dev`, build with `npm run docs:build`, and preview with `npm run docs:preview`. The build output goes to `docs/.vitepress/dist` and is not committed.

State the conclusion first, then the reason. One paragraph should carry one main point. Design pages describe product goals and tradeoffs only, not code paths, internal class names, or implementation detail. Use as few second-level headings as possible and avoid third-level headings that fragment the argument. Prefer tables for comparison and short lists for steps.

Use shared concepts a user can understand. Explain necessary technical names on first use instead of stacking jargon. Separate facts, judgments, and hypotheses; do not describe plans as delivered capability. Keep Chinese and English at the same path, heading level, and broadly equivalent content. Do not create pages that exist on only one side. When design or delivery conclusions change, check related appendix pages, navigation, sidebar, and cross-links.

Each development log has one page per day: a summary plus commits, authors, and concrete changes. Append rows when new commits land; do not restore a log index, template, or phase report.

## Submission Checks and Source of Truth

Complete these checks before submitting:

1. Run `npm run docs:build` and confirm there are no build errors or internal dead links.
2. Check that Chinese and English paths correspond and that the sidebar and language switch work.
3. Check that design pages contain no code blocks, code paths, or meaningless subheadings.
4. If facts, permissions, risks, or phase goals changed, update the related decisions and appendix pages.
5. Do not commit build output, caches, local secrets, real user data, or completion claims without evidence.

The submission message should say what changed, why, which readers or phases are affected, and what evidence is still needed to confirm completion.

`docs/` is the only formal source shared by the repository and the site. There is no second long-form copy and no separately maintained "archive version". Change Chinese first and include the English mirror in the same commit. If a translation or link is wrong, fix the source directly.

The project uses Apache-2.0. Submitting a contribution means agreeing to publish it under that license.

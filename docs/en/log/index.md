---
title: 'Development Log'
description: 'Day-by-day records of the Hearth documentation site and development process, plus a repeatable template for future entries.'
outline: [2, 3]
---

<p class="eyebrow">DEVELOPMENT LOG</p>

# Development Log

<p class="lead">This log records real documentation, interface, and engineering progress. A daily entry is not a product release announcement; it lets contributors see what changed, how it was verified, and what remains.</p>

## Entries

| Date | Log | Topic |
|---|---|---|
| 2026-11-03 | [Day01 · Bilingual documentation launch](/en/log/day-01) | Information architecture, light-blue visual design, bilingual navigation, and source coverage |
| 2026-11-04 | [Day02 · Delivery decomposition and development log](/en/log/day-02) | 35 D increments, nested sidebar, log template, and deployment |
| 2026-11-04 | [Day03 · Delivery increments expanded into developer playbooks](/en/log/day-03) | 140 work packages, engineering maps, acceptance rehearsal, and bilingual expansion |

## How to add a day

1. Copy the [log template](/en/log/template) and create a new file such as `day-04.md` or `day-05.md`.
2. Record only work that is finished and has evidence; put plans under Next, never under completed work.
3. Create a structurally identical `docs/en/log/day-03.md`; keep heading levels and list counts aligned with Chinese.
4. Add the entry to the table on this page and add it to the `/log/` sidebar in `docs/.vitepress/config.mts`.
5. Run `npm.cmd run docs:build`, link checks, and the translation structure check before committing and deploying.

## Daily entry template

```markdown
# Day03 · One-line topic

## Completed
- What user-visible or engineering result was delivered

## Verification evidence
- Build, test, screenshot, or online URL

## Problems encountered
- Problem, cause, and current handling

## Decisions and tradeoffs
- What was chosen and what was deliberately excluded

## Next
- The next verifiable item

## Related commits
- Commit hash or link
```

## Writing rules

- One entry maps to one real change; do not split the same work into several bullets.
- State the user-visible result first, then the internal implementation.
- Keep failures, rollbacks, and unresolved risks; do not manufacture an all-green story.
- Logs record project process only; product versions and release notes are maintained separately at actual release time.

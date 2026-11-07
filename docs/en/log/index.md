---
title: 'Development log'
description: 'Hearth day by day: what shipped, what was committed, and which boundaries were not crossed.'
outline: false
---

# Development log

<p class="lead">Each entry records the implementation, the verification, and the boundaries still open that day. This is not a release note, and "the code is written" is never written up as "accepted"; every entry carries its commits, diffstats, and reproducible checks.</p>

<DocCardGrid :columns="2" :items="[
  { no: 'D04', title: 'Day04 · The runtime takes shape', text: 'From the stage-one MVP to a full local Agent OS: native runtime, four model protocols, sources, desktop, proactive service, memory, methods, sync, safety, and backup.', link: '/en/log/day-04', meta: '2026-11-06 · 102 commits' },
  { no: 'D03', title: 'Day03 · Stage-one MVP runs end to end', text: '15 real tasks, 13 passed; control plane, approvals, artifacts, recovery, and backup form a closed loop.', link: '/en/log/day-03', meta: '2026-11-05 · 46 commits' },
  { no: 'D02', title: 'Day02 · Documentation structure cleanup', text: 'Consolidated the docs structure, removed duplicated route material, and gave design, route, and appendix distinct jobs.', link: '/en/log/day-02', meta: '2026-11-04' },
  { no: 'D01', title: 'Day01 · Bilingual documentation launch', text: 'From an empty repository to a public docs site: license, product and technical baseline, bilingual docs, and GitHub Pages deployment.', link: '/en/log/day-01', meta: '2026-11-03' }
]" />

## How to read the log

- For **what works today**, read [Day04](/en/log/day-04), then check [Delivery](/en/delivery/) for which capabilities have real acceptance.
- For **how phase one was proven**, read [Day03](/en/log/day-03) and [Phase-one MVP acceptance](/en/delivery/mvp).
- For **why the docs site changed**, read [Day02](/en/log/day-02) and the [documentation map](/en/reference/source-map).

## Recording rules

1. Record only what actually happened that day: commits, change size, passing checks, and failing evidence.
2. Separate "code closure", "automated tests pass", and "real acceptance passed"; one cannot substitute for another.
3. The commit table uses real SHAs and diffstats; nothing is merged, backfilled, or polished.
4. Any boundary not crossed goes into "Boundaries and next step" and is checked by the next entry.

---
title: 'Log template'
description: 'A copyable Hearth daily development log template, with naming, bilingual mirroring, and pre-commit checks.'
outline: [2, 3]
---

<p class="eyebrow">LOG TEMPLATE</p>

# Log template

<p class="lead">Copy this structure for Day03, replace the date, completed items, and evidence; stay concise, but never make an unverified plan look complete.</p>

## Copy this structure

```markdown
---
title: 'Day03 · One-line topic'
description: 'One line describing today’s real change and evidence.'
outline: [2, 3]
---

# Day03 · One-line topic

## Completed
- 

## Verification evidence
- 

## Problems encountered
- 

## Decisions and tradeoffs
- 

## Next
- 

## Related commits
- 
```

## Naming and placement

- Put Chinese in `docs/log/day-03.md` and English in `docs/en/log/day-03.md`.
- Keep numbering sequential and title the entry Day03 · Topic, not only a date.
- Keep heading levels, list counts, table rows, and link counts identical across languages.
- Preserve failures, rollbacks, and unresolved issues, not just completed work.

## Pre-commit checks

- [ ] Every completed item points to code, documentation, a build, a screenshot, or an online page.
- [ ] Next work is separate from completed work.
- [ ] Chinese and English structures match and internal links resolve.
- [ ] The log index, sidebar, and previous/next content are updated.
- [ ] A documentation commit is not described as a formal product release.

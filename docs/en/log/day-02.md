---
title: 'Day02 · Documentation structure cleanup'
outline: false
---

On 2026-11-04, the Hearth documentation site took its second complete shape: Stages 0–6 received 35 D increments and 140 work packages, the documentation source and bilingual READMEs were consolidated, Hearth OS branding and the testing/evaluation strategy were applied; the information architecture was then reworked so the homepage became a single-page entry, design and delivery became two focused paths, reference became the appendix, and the development log was reduced to essentials.

| Commit | Author | Changes |
|---|---|---|
| `69330ab` | JasonBuildAI | Reworked the Chinese and English information architecture, homepage components, and visual system; simplified the development-plan page and adjusted language switching; 63 files (+2,157/−1,433). |
| `bd38c41` | JasonBuildAI | Adjusted `custom.css` to increase the header and hero spacing. |
| `4927d52` | JasonBuildAI | Added 35 D increment pages for Stages 0–6 and a nested sidebar; 107 files (+8,430/−90). |
| `f01d637` | JasonBuildAI | Expanded all 35 increments into four work packages each (140 total), adding engineering maps, interfaces, acceptance rehearsals, and failure recovery; 103 files (+6,018/−1,157). |
| `3c7df1e` | JasonBuildAI | Consolidated the documentation source, removed the old `docs/roadmap` material, rewrote both READMEs, and fixed links; 39 files (+490/−8,667). |
| `afae9b9` | Jason Cat | Applied Hearth OS identity across theme colors, logos, the GitHub avatar, the homepage, and the READMEs; 20 files (+264/−179). |
| `8e51f09` | JasonBuildAI | Added the nine testing layers, the boundary between tests and evaluations, regression requirements, and release evidence to the engineering page; 4 files (+218/−38). |
| `1bd9a4c` | JasonBuildAI | Fixed both READMEs to use the theme-aware Hearth OS logo; 3 files. |
| `e18c929` | JasonBuildAI | Simplified the development logs to one daily overview plus commit records, removed the log index, template, Day03, and long-form sections, and updated navigation and links; 17 files. |

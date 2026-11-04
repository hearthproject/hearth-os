---
title: 'Day01 · Bilingual documentation launch'
description: 'Hearth development log Day01: bilingual information architecture, light-blue visual design, homepage reading paths, and source coverage.'
outline: [2, 3]
---

<p class="eyebrow">DAY 01 · DOCUMENTATION SITE</p>

# Day01 · Bilingual documentation launch

<p class="lead">Turn the roadmap, volumes, and architecture material into a searchable, language-switchable, maintainable documentation site.</p>

## Completed

- Built Chinese and English pages with corresponding paths, heading levels, and primary structure.
- Reorganized the roadmap into Start, Product, System Design, Delivery, and Reference entry points.
- Delivered a light-blue visual system, homepage reading paths, and responsive desktop/mobile layout.
- Kept the complete roadmap, volumes, build boundary, and source map traceable.

## Verification evidence

- Both Chinese and English sites build independently and are reachable on GitHub Pages.
- Internal links, search, Mermaid diagrams, and language switching pass checks.
- The source-coverage script confirms that 100% of source prose blocks appear in the Chinese site.

## Problems encountered

- The source material is long; copying it directly leaves readers unsure where to begin.
- If Chinese and English structures diverge, maintenance and search accuracy degrade.
- An old documentation version can make readers mistake the docs for a product release.

## Decisions and tradeoffs

- Used a three-layer structure: product roadmap, topic pages, and the complete archive.
- Removed the old documentation version from the interface; product milestones such as MVP-1 and v1.0 remain only as build goals.
- Prioritized reading and scanning efficiency over decorative density.

## Next

- Decompose Stages 0–6 into independently buildable and verifiable increment pages.
- Add a development-log entry and a maintainable daily template.
- Verify deployment, mobile layout, and sidebar expansion online.

## Related commits

- `2ea8909` created the bilingual Hearth documentation site; `69330ab` refined its architecture and visual design.

---
title: 'Appendix'
description: 'Hearth appendix: engineering implementation, risks and decisions, build boundaries, terminology, checklists, FAQ, contribution, and archive.'
outline: [2, 3]
---

<p class="eyebrow">APPENDIX</p>

# Appendix

<p class="lead">The main documentation explains what Hearth does, why it is designed this way, and how it is delivered. The appendix keeps the engineering boundaries, risks, decisions, terminology, and checklists that implementers and maintainers return to.</p>

## Engineering and Decisions

<DocCardGrid :columns="3" :items="[
  { no: '01', title: 'Engineering and Repository Structure', text: 'Technology stack, repository layout, process model, testing, releases, and migrations.', link: '/en/reference/engineering' },
  { no: '02', title: 'Risks and Kill Criteria', text: 'Global pause conditions, stage kill criteria, and foundations that must never be cut.', link: '/en/reference/risks' },
  { no: '03', title: 'ADRs and Key Decisions', text: 'Architecture, permission, delivery, and product decisions that are hard to reverse.', link: '/en/reference/decisions' }
]" />

## Reference Material

<DocCardGrid :columns="2" :items="[
  { no: '04', title: 'Build vs. Integrate Boundaries', text: 'Which capabilities Hearth must own and which lower layers should be integrated.', link: '/en/reference/build-vs-integrate' },
  { no: '05', title: 'Glossary', text: 'Unified definitions for Task, Run, Mandate, Receipt, Memory, Skill, and related terms.', link: '/en/reference/glossary' },
  { no: '06', title: 'Default Checklists', text: 'The definitive approval, completion, and task coverage checklists.', link: '/en/reference/checklists' },
  { no: '07', title: 'FAQ', text: 'How Hearth relates to coding agents, Codex, Stage 1, multi-user use, and evolution.', link: '/en/reference/faq' },
  { no: '08', title: 'Contributing and Documentation', text: 'Local development, writing conventions, PR checks, and the source of truth.', link: '/en/reference/contributing' },
  { no: '09', title: 'Documentation Map', text: 'Current information architecture, directory structure, bilingual rules, and maintenance workflow.', link: '/en/reference/source-map' },
  { no: '10', title: 'Full Original Roadmap (Archive)', text: 'The old long-form content, retained for search, citation, and historical comparison.', link: '/en/reference/full-roadmap' }
]" />

## How to Use This Appendix

- For product scope and design tradeoffs, start with [Design & Tradeoffs](/en/design/);
- For the current stage and increment order, start with [Delivery Route](/en/delivery/);
- For engineering implementation, risks, and irreversible decisions, this appendix is authoritative;
- When discussing terms or checklists, use the unified definitions in the appendix.

---
title: 'Reference Overview'
description: 'Hearth reference and appendix entry points: build boundaries, terminology, checklists, FAQ, contributing, source coverage, and the complete roadmap archive.'
outline: [2, 3]
---

<script setup>
const cards = [
  { no: '01', title: 'Build vs. Integrate Boundaries', text: 'Hearth builds its own core control and memory, and directly integrates models, Codex, browsers, document parsing, and the Sandbox kernel.', link: '/en/reference/build-vs-integrate' },
  { no: '02', title: 'Glossary', text: 'Unified definitions for core terms such as Task, Ticket, Mandate, Run, Receipt, Memory, and Skill.', link: '/en/reference/glossary' },
  { no: '03', title: 'Default Checklists', text: 'The definitive definitions of the default approval checklist, the default completion checklist, and task coverage.', link: '/en/reference/checklists' },
  { no: '04', title: 'FAQ', text: 'How Hearth relates to Coding Agents, Codex wrappers, Stage 1, side effects, evolution, and multi-user support.', link: '/en/reference/faq' },
  { no: '05', title: 'Contributing and Documentation Maintenance', text: 'Repository structure, local development, writing conventions, PR checklist, and source of truth.', link: '/en/reference/contributing' },
  { no: '06', title: 'Sources & Coverage', text: 'A page-by-page mapping from the master document, ten volumes, boundary note, and volume README to this site.', link: '/en/reference/source-map' },
  { no: '07', title: 'Full Roadmap (Archived)', text: 'The complete master document, retaining all original details, suitable for search and citation.', link: '/en/reference/full-roadmap' }
]
</script>

<p class="eyebrow">REFERENCE</p>

# Reference and Appendix

<p class="lead">This section contains materials that implementers and maintainers will consult repeatedly: boundaries, terminology, checklists, FAQ, contribution guidelines, and the complete roadmap archive.</p>

<DocCardGrid :items="cards" :columns="2" />

## How to Cite

- When discussing product scope, prioritize citing the [full roadmap](/en/reference/full-roadmap) and [product definition](/en/product/definition);
- When discussing engineering boundaries, prioritize citing [build vs. integrate boundaries](/en/reference/build-vs-integrate) and [engineering delivery](/en/delivery/engineering);
- When discussing terminology, use the definitions in the [glossary](/en/reference/glossary) to avoid ambiguity from identical names;
- When discussing phase progression, use the exit criteria in the [roadmap](/en/delivery/roadmap) and [risks](/en/delivery/risks).

## Sources and Maintenance

This site is curated from the original roadmap. If there are discrepancies between the complete archive and topic pages, the complete master document and repository commit history take precedence; [Sources & Coverage](/en/reference/source-map) lists the full mapping.

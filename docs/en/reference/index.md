---
title: 'Appendix'
description: 'Hearth reference material on engineering, risk, decisions, build boundaries, terminology, and documentation maintenance.'
outline: false
---

# Appendix

<p class="lead">The design section explains why the product is built this way, and the delivery route explains what comes first. The appendix keeps the facts, boundaries, and checklists that implementation and review return to.</p>

<DocCardGrid :columns="2" :items="[
  { no: '01', title: 'Engineering', text: 'Technology stack, runtime shape, repository organization, testing, and release constraints.', link: '/en/reference/engineering' },
  { no: '02', title: 'Evaluation Agent (Standalone)', text: 'The evaluation code, 30 scenarios, 60 cases, console, and documentation now live in hearth-eval.', link: '/en/reference/evaluation-agent' },
  { no: '03', title: 'Risks and Stop Conditions', text: 'Signals that mean Hearth should pause, roll back, or narrow the product.', link: '/en/reference/risks' },
  { no: '04', title: 'Key Decisions', text: 'Product and engineering judgments that should not be reversed casually.', link: '/en/reference/decisions' },
  { no: '05', title: 'Build vs. Integrate', text: 'Which layer Hearth owns and which mature capabilities it uses directly.', link: '/en/reference/build-vs-integrate' },
  { no: '06', title: 'Glossary', text: 'Shared definitions for tasks, authority, execution, receipts, memory, and evaluation.', link: '/en/reference/glossary' },
  { no: '07', title: 'Default Checklists', text: 'What to check before approval and before marking work complete.', link: '/en/reference/checklists' },
  { no: '08', title: 'FAQ', text: 'How Hearth relates to coding agents, Codex, connectivity, multi-user use, and mobile.', link: '/en/reference/faq' },
  { no: '09', title: 'Contributing', text: 'Local setup, writing conventions, submission checks, and the documentation source of truth.', link: '/en/reference/contributing' },
  { no: '10', title: 'Documentation Map', text: 'Site structure, recommended reading order, and maintenance rules.', link: '/en/reference/source-map' }
]" />

For a first read, start with [Design](/en/design/) and [Delivery](/en/delivery/). Return here when you need an implementation constraint, a review rule, or a maintenance detail. The appendix records implemented engineering facts, known risks, and checklists that still need review; it does not replace the acceptance evidence on the delivery route.

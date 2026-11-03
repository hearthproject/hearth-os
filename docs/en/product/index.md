---
title: 'Product Overview'
description: 'Hearth''s product positioning, product wedge, and the directions it explicitly does not pursue.'
outline: [2, 3]
---

<script setup>
const cards = [
  { no: '01', title: 'Product Definition and Boundaries', text: 'Whose product Hearth is, what problems it solves, and what it explicitly does not promise.', link: '/en/product/definition' },
  { no: '02', title: 'Design Principles and Architectural Invariants', text: 'Five non-negotiable judgments, key design choices, and seven architectural invariants.', link: '/en/product/design-principles' },
  { no: '03', title: 'Task Coverage and Definition of Done', text: 'Eight Task categories, autonomy levels, and what counts as “truly done.”', link: '/en/product/task-coverage' }
]
</script>

<p class="eyebrow">PRODUCT</p>

# Product: Starting from Personal Pain Points

<p class="lead">Hearth is not a general-purpose platform for everyone and every organization. The first version pursues only one real user who is willing to use it every day: single-user, self-hosted, controllable, recoverable, and low-interruption.</p>

<DocCardGrid :items="cards" />

## Product Wedge

Prioritize a high-frequency, low-external-risk, verifiable Task family as the MVP. It must produce user-visible Artifacts while exposing core design issues such as durable state, approvals, recovery, and Token budget.

## Directions We Do Not Pursue

- We do not build enterprise multi-tenancy, IAM, organizational auditing, or billing;
- We do not aim to cover all eight Task categories on day one;
- We do not compete with underlying model vendors on model capabilities;
- We do not build unbounded, unattended high-risk automation;
- We do not treat "human-like" as a product goal.

Next: read [Product Definition and Boundaries](/en/product/definition), or go directly to the [Roadmap](/en/delivery/roadmap).

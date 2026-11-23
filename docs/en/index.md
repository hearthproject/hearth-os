---
layout: home
hero:
  name: Hearth OS
  text: Turn digital labor into reliable tasks
  tagline: A single-user, self-hosted, long-running personal Agent OS. Start from chat, hand work to three built-in executors, and finish real tasks under approvals and verifiable receipts.
  image:
    src: /hero.svg
    alt: Hearth OS task system
  actions:
    - theme: brand
      text: Read the design
      link: /en/design/
    - theme: alt
      text: View the delivery route
      link: /en/delivery/
---

<nav class="home-quicklinks" aria-label="Documentation">
  <a href="#product">
    <span class="home-quicklinks__label">Product</span>
    <span class="home-quicklinks__meta">Chat, Library, Context, and executors</span>
  </a>
  <a href="/hearth-os/en/design/">
    <span class="home-quicklinks__label">Design</span>
    <span class="home-quicklinks__meta">Positioning, fifteen design modules, and current boundaries</span>
  </a>
  <a href="/hearth-os/en/delivery/">
    <span class="home-quicklinks__label">Delivery</span>
    <span class="home-quicklinks__meta">Phased plan from MVP to v1.0</span>
  </a>
  <a href="/hearth-os/en/evaluation/">
    <span class="home-quicklinks__label">Evaluation</span>
    <span class="home-quicklinks__meta">Native 30-case reports, reproduction, and boundaries</span>
  </a>
  <a href="/hearth-os/en/log/day-08.html">
    <span class="home-quicklinks__label">Dev Log</span>
    <span class="home-quicklinks__meta">Execution kernel, evaluation updates, and daily commits</span>
  </a>
</nav>

## Product

<p class="home-section-lead">
  This is not a chat shell with a new skin. Each piece of real work becomes a traceable task: goal, executor, budget, approval, artifacts, and receipt all stay in one control surface.
</p>

<section class="home-showcase" aria-label="Hearth screenshots">
  <figure class="screenshot-spotlight">
    <img src="/screenshots/chat.png" alt="Hearth chat workspace">
    <figcaption>
      <strong>Chat workspace</strong>
      <span>Run cards stay inline in the conversation; the right-side artifacts panel opens on demand with files, background jobs, and preview.</span>
    </figcaption>
  </figure>

  <div class="screenshot-gallery">
    <figure class="screenshot-card">
      <img src="/screenshots/library.png" alt="Library">
      <figcaption>
        <strong>Library</strong>
        <span>Files, memories, sources, and skills in one tree; search, preview, and trash on the same page.</span>
      </figcaption>
    </figure>
    <figure class="screenshot-card">
      <img src="/screenshots/context.png" alt="Context handoff">
      <figcaption>
        <strong>Context handoff</strong>
        <span>Build a handoff brief, original records, and an export bundle from active memories.</span>
      </figcaption>
    </figure>
    <figure class="screenshot-card screenshot-card--wide">
      <img src="/screenshots/settings.png" alt="Settings and executors">
      <figcaption>
        <strong>Settings and executors</strong>
        <span>Navigation on the left; executor health, model bindings, browser, extensions, and data in one right column.</span>
      </figcaption>
    </figure>
  </div>
</section>

## Positioning

Hearth is not another chat shell, and it is not an agent that only serves code. It is a **task-centered personal control surface**: the user states intent; the system preserves the goal, assigns an executor, constrains authority, records evidence, and requires explicit approval before external actions.

<DocCardGrid :columns="3" :items="[
  {
    no: '01',
    title: 'Tasks first, not messages first',
    text: 'Every run has a budget, checkpoints, a recovery path, and artifact records. Failures can be retried, and a result counts only after it is written.',
    link: '/en/design/tasks',
    meta: 'Durable execution'
  },
  {
    no: '02',
    title: 'Approve external effects, then keep receipts',
    text: 'Email, desktop actions, and external comments produce a preview first; one-time approvals bind to a parameter fingerprint.',
    link: '/en/design/effects',
    meta: 'Approval & effects'
  },
  {
    no: '03',
    title: 'Swap executors without losing the record',
    text: 'The native runtime, Codex, and DeepSeek Harness share a registry, routing, and run manifest.',
    link: '/en/design/executors',
    meta: 'Three executors'
  }
]" />

## Start here

<DocCardGrid :columns="2" :items="[
  {
    title: 'Delivery and status',
    text: 'Phase 1 MVP is accepted; phases 2–6 have working code loops, while real-user and long-running acceptance is still in progress.',
    link: '/en/delivery/status',
    meta: 'Current status'
  },
  {
    title: 'Storage and backup boundaries',
    text: 'SQLite data domains, context lifecycle, encrypted backup, and why a recoverable database is not a portable artifact archive.',
    link: '/en/design/storage',
    meta: 'Data & backup'
  },
  {
    title: 'Delegation, handoff, and sandboxing',
    text: 'Single-layer durable delegation, reviewable handoff packets, leases and generations, and path, network, process, and credential boundaries.',
    link: '/en/design/delegation-and-sandbox',
    meta: 'Delegation & sandbox'
  },
  {
    title: 'Personal context and attention',
    text: 'How the personal ontology, context packs, memory recall, standing intents, and interruption budgets decide what the agent sees and when it should speak.',
    link: '/en/design/personal-context',
    meta: 'Context & attention'
  }
]" />

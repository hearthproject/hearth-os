---
layout: home
hero:
  name: Hearth OS
  text: Turn digital labor into reliable tasks
  tagline: A single-user, self-hosted, long-running personal Agent OS. Start from chat, hand work to seven executors, and finish real tasks under approvals and verifiable receipts.
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
    <span class="home-quicklinks__meta">Chat, tasks, inbox, memory, and executors</span>
  </a>
  <a href="/hearth-os/en/design/">
    <span class="home-quicklinks__label">Design</span>
    <span class="home-quicklinks__meta">Positioning, overall design, and nine modules</span>
  </a>
  <a href="/hearth-os/en/delivery/">
    <span class="home-quicklinks__label">Delivery</span>
    <span class="home-quicklinks__meta">Phased plan from MVP to v1.0</span>
  </a>
  <a href="/hearth-os/en/log/day-05.html">
    <span class="home-quicklinks__label">Dev Log</span>
    <span class="home-quicklinks__meta">Daily summary, commits, and concrete changes</span>
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
      <span>One intent becomes a task proposal; executor, stage, tokens, duration, and approval actions stay in context.</span>
    </figcaption>
  </figure>

  <div class="screenshot-gallery">
    <figure class="screenshot-card">
      <img src="/screenshots/tasks.png" alt="Task list">
      <figcaption>
        <strong>Task list</strong>
        <span>Running, waiting for approval, completed, and attention-needed work in one view.</span>
      </figcaption>
    </figure>
    <figure class="screenshot-card">
      <img src="/screenshots/task-detail.png" alt="Task detail">
      <figcaption>
        <strong>Task detail</strong>
        <span>Goal, executor, budget, artifacts, and final result remain on record.</span>
      </figcaption>
    </figure>
    <figure class="screenshot-card">
      <img src="/screenshots/inbox.png" alt="Proactive inbox">
      <figcaption>
        <strong>Needs you</strong>
        <span>Proactive suggestions can be accepted, ignored, snoozed, or converted into tasks.</span>
      </figcaption>
    </figure>
    <figure class="screenshot-card">
      <img src="/screenshots/memory.png" alt="Memory management">
      <figcaption>
        <strong>Memory</strong>
        <span>Candidates, recall, correction, conflict, forgetting, and export all have explicit boundaries.</span>
      </figcaption>
    </figure>
    <figure class="screenshot-card screenshot-card--wide">
      <img src="/screenshots/settings.png" alt="Settings and executors">
      <figcaption>
        <strong>Settings and executors</strong>
        <span>Model profiles, executor installation, health checks, protocol compatibility, and default routing in one place.</span>
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
    text: 'Every run has a goal, budget, checkpoints, and an artifact summary. Failures can be recovered; interruptions can be resumed.',
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
    text: 'The native runtime, Codex, DeepSeek Harness, and external executors share a registry, routing, and run manifest.',
    link: '/en/design/executors',
    meta: 'Seven executors'
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
  }
]" />

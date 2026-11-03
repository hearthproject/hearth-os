---
title: 'System Design Overview'
description: 'Hearth system design overview: architectural foundations, entry points and control, executors, security, memory, evolution, evaluation, Token, and frontend.'
outline: [2, 3]
---

<script setup>
const foundations = [
  { no: '01', title: 'Overall Architecture and Data Flow', text: 'The seven planes, the complete data flow of a single Task, deployment patterns, and architectural evolution.', link: '/en/architecture/overview' },
  { no: '02', title: 'Domain Model and Protocols', text: 'Core entities, Event, Executor protocol, approvals, and Receipt.', link: '/en/architecture/domain-model' }
]
const execution = [
  { no: '03', title: 'Personal Gateway and Multiple Entry Points', text: 'Channel normalization, event deduplication, attention inbox, and device registration.', link: '/en/architecture/gateway' },
  { no: '04', title: 'Control Plane and Autonomy', text: 'Trigger, Policy, Mandate, scheduling, Watchdog, and attention budget.', link: '/en/architecture/control-plane' },
  { no: '05', title: 'Durable Execution and Recovery', text: 'Run lifecycle, Task graph, lease, recovery strategy, and routing.', link: '/en/architecture/durable-execution' },
  { no: '06', title: 'Executor Model and Routing', text: 'Capability matrix, routing principles, and Executor collaboration.', link: '/en/architecture/executor-model' },
  { no: '07', title: 'Executor Catalog', text: 'Codex, Native, Connector, Browser, GUI, and Document/Data.', link: '/en/architecture/executor-catalog' },
  { no: '08', title: 'Human Takeover and Approval', text: 'Approval cards, takeover protocols, and human input errors.', link: '/en/architecture/human-takeover' }
]
const safety = [
  { no: '09', title: 'Execution Safety and Side Effects', text: 'Sandbox, network, Credential Broker, Effect Dispatcher, and threat matrix.', link: '/en/architecture/execution-safety' },
  { no: '10', title: 'Memory System', text: 'Five types of memory, budgets, conflicts, forgetting, poisoning defenses, and synchronization.', link: '/en/architecture/memory' },
  { no: '11', title: 'Skill Evolution', text: 'From trajectories to skills, promotion thresholds, permission boundaries, and rollback.', link: '/en/architecture/evolution' },
  { no: '12', title: 'Security and Privacy', text: 'Trust boundaries, Capability, risk tiers, credentials, and incident response.', link: '/en/architecture/security-privacy' },
  { no: '13', title: 'Evaluation System', text: 'Task suites, metrics, validators, trajectory replay, fault injection, and stage gates.', link: '/en/architecture/evaluation' }
]
const experience = [
  { no: '14', title: 'Token Economics', text: 'Budget hierarchy, Context Compiler, model ladder, and hard budgets.', link: '/en/architecture/token-economics' },
  { no: '15', title: 'Frontend and Mobile Experience', text: 'Task cards, approvals, Artifact center, mobile, and experience metrics.', link: '/en/architecture/frontend-experience' }
]
</script>

<p class="eyebrow">SYSTEM DESIGN</p>

# System Design: A Single Auditable Execution Chain

<p class="lead">Hearth's architectural value is not the number of modules, but that tasks, authorization, execution, evidence, and recovery flow along the same chain. Start with the overall architecture, then go deeper layer by layer through the Control Plane, Executor, safety, and experience.</p>

## Architecture Foundations

<DocCardGrid :items="foundations" :columns="2" />

## Entry, Control, and Durable Execution

<DocCardGrid :items="execution" :columns="2" />

## Safety, Intelligence, and Evaluation

<DocCardGrid :items="safety" :columns="2" />

## Economics and Experience

<DocCardGrid :items="experience" :columns="2" />

## North Star Architecture

```text
User / CLI / Web / Mobile / IM
            ↓
     Experience Plane
     Task Card · Approval · Artifact · Takeover
            ↓
      Personal Gateway
   Identity · Channel · Device · Attention Entry
            ↓
       Control Plane
  Trigger · Policy · Mandate · Scheduling · Watchdog
            ↓
      Durable Harness
  Task Graph · Budget · lease · Retry · Recovery
            ↓
       Executor Layer
 Native · Codex · Connector · Browser
 GUI · Document/Data · Human
            ↓
     Execution Gateway
 Workspace · Sandbox · Network · Credential Broker
            ↓
  Event Log / Artifacts / Receipts
       ↓              ↓
   Memory OS      Evolution OS
```

All facts enter the Event Log; all external side effects pass through the outbox, idempotency keys, and Receipt; all interface state is a projection, not a source of truth.

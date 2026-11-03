<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'

const { lang } = useData()
const isEnglish = computed(() => lang.value.startsWith('en'))

const copy = {
  zh: {
    statusLabel: '当前阶段',
    statusValue: '规格与路线图',
    statusDetail: '实现尚未开始 · Stage 0 即将启动',
    stats: [
      { value: '7', label: '架构平面' },
      { value: '7', label: '能力阶段' },
      { value: '8', label: '任务族' },
      { value: '1', label: '逻辑 Agent' }
    ],
    manifestoKicker: 'WHY HEARTH',
    manifestoTitle: 'Agent 的难点不是“会回答”，而是“能负责”。',
    manifestoText:
      'Hearth 把任务状态、授权、执行、证据和恢复放在同一条可审计链路上。它不试图制造一个更会聊天的模型，而是让个人数字劳动变得持久、可控、可验证。',
    manifestoPoints: [
      '任务卡优先，而不是无限聊天记录',
      '外部副作用必须经过审批、幂等与回执',
      '每个阶段都必须交付可用的纵向切片'
    ],
    featuresTitle: '六个不可妥协的设计选择',
    featuresLead:
      '这些选择决定了 Hearth 不是 Codex 套壳、不是自动化脚本集合，也不是一个无法恢复的黑盒。',
    features: [
      {
        no: '01',
        title: '任务，而不是聊天',
        text: '用户面对任务卡、审批和产物，不需要理解 Worker、Harness 或 Token 的内部结构。',
        link: '/product/definition'
      },
      {
        no: '02',
        title: '持久执行内核',
        text: 'Event Log、lease、检查点与恢复策略让长任务跨越崩溃、休眠和网络中断继续工作。',
        link: '/architecture/durable-execution'
      },
      {
        no: '03',
        title: '并列执行器',
        text: 'Codex、Native、Connector、Browser、GUI 与 Human 按能力、风险和 Token 成本路由。',
        link: '/architecture/executor-model'
      },
      {
        no: '04',
        title: '副作用有回执',
        text: '所有外部动作经过 outbox、幂等键与 Receipt；失败可对账、可撤销、可重放。',
        link: '/architecture/execution-safety'
      },
      {
        no: '05',
        title: '记忆与进化受控',
        text: '记忆有来源、敏感度和遗忘策略；技能必须经过评估、canary 和回滚。',
        link: '/architecture/memory'
      },
      {
        no: '06',
        title: '本地优先，逐步长大',
        text: '从本地 MVP 到多设备 Agent OS，每一阶段都同时有界面、状态、验证和恢复。',
        link: '/delivery/roadmap'
      }
    ],
    flowKicker: 'PUBLIC CONTRACT',
    flowTitle: '一条可审计的执行链',
    flowLead:
      '所有事实进入 Event Log；所有外部副作用经过 outbox、幂等键和 Receipt；所有界面状态都是投影，不是事实源。',
    flow: [
      '入口',
      'Personal Gateway',
      'Control Plane',
      'Durable Harness',
      'Executor Layer',
      'Execution Gateway',
      'Event Log'
    ],
    stagesKicker: 'CAPABILITY LADDER',
    stagesTitle: '从 Stage 0 到 Personal Agent OS v1.0',
    stagesLead: '阶段是能力门槛，不是工期承诺。可以停留、试用和回退，但不能跳步。',
    stages: [
      { no: '0', name: '定义与原型', text: '产品楔子、协议、交互与评测基线' },
      { no: '1', name: '本地 MVP', text: '持久内核、Codex 切片、任务卡、审批与恢复' },
      { no: '2', name: 'Personal Operator', text: '邮件、日历、文档、网页与数据任务' },
      { no: '3', name: 'Computer Operator', text: '桌面 agentd、GUI 执行与人工接管' },
      { no: '4', name: '主动个人 Agent', text: 'Trigger、注意力预算、手机 PWA' },
      { no: '5', name: 'Memory / Evolution', text: '长期记忆、技能候选、评估与回滚' },
      { no: '6', name: 'Personal Agent OS', text: '多设备、离线、迁移与长期运维' }
    ],
    pathsKicker: 'READING PATHS',
    pathsTitle: '选择你的阅读路径',
    pathsLead: '按角色和时间预算进入，而不是从头读完 4,700 行。',
    paths: [
      {
        tag: '产品与决策',
        title: '先判断值不值得做',
        text: '产品定义 → 阶段路线图 → 开发计划 → 风险与决策',
        link: '/guide/reading-guide'
      },
      {
        tag: '架构与技术',
        title: '准备开始实现',
        text: '总体架构 → 领域协议 → 控制面 → 执行器 → 安全与评估',
        link: '/architecture/'
      },
      {
        tag: '直接开工',
        title: '从 MVP 纵向切片开始',
        text: 'Stage 1 → Event Log → Codex Executor → 任务卡 → 恢复',
        link: '/delivery/development-plan'
      }
    ],
    notice:
      '当前仓库处于规格阶段。路线图是范围与顺序的事实源；实现尚未开始。所有内容按 v3.2 整理。'
  },
  en: {
    statusLabel: 'Current stage',
    statusValue: 'Specification & roadmap',
    statusDetail: 'Implementation has not started · Stage 0 is next',
    stats: [
      { value: '7', label: 'architecture planes' },
      { value: '7', label: 'capability stages' },
      { value: '8', label: 'task families' },
      { value: '1', label: 'logical agent' }
    ],
    manifestoKicker: 'WHY HEARTH',
    manifestoTitle: 'The hard part of an agent is not answering. It is taking responsibility.',
    manifestoText:
      'Hearth puts task state, authorization, execution, evidence, and recovery on one auditable path. It is not trying to build a more conversational model; it is making personal digital work durable, governable, and verifiable.',
    manifestoPoints: [
      'Task cards first, not an endless chat log',
      'External effects require approval, idempotency, and receipts',
      'Every stage must ship a usable vertical slice'
    ],
    featuresTitle: 'Six non-negotiable design choices',
    featuresLead:
      'These choices keep Hearth from becoming a Codex wrapper, a pile of automation scripts, or an unrecoverable black box.',
    features: [
      {
        no: '01',
        title: 'Tasks, not chat',
        text: 'Users see task cards, approvals, and artifacts. They never need to understand workers, harnesses, or token internals.',
        link: '/en/product/definition'
      },
      {
        no: '02',
        title: 'Durable execution kernel',
        text: 'An event log, leases, checkpoints, and recovery policies keep long-running work alive across crashes, sleep, and network loss.',
        link: '/en/architecture/durable-execution'
      },
      {
        no: '03',
        title: 'Interchangeable executors',
        text: 'Codex, Native, Connector, Browser, GUI, and Human are routed by capability, risk, and token cost.',
        link: '/en/architecture/executor-model'
      },
      {
        no: '04',
        title: 'Receipts for side effects',
        text: 'Every external action passes through an outbox, idempotency key, and receipt. Failures can be reconciled, reversed, and replayed.',
        link: '/en/architecture/execution-safety'
      },
      {
        no: '05',
        title: 'Governed memory and evolution',
        text: 'Memory has provenance, sensitivity, and forgetting rules. Skills must pass evaluation, canary, and rollback.',
        link: '/en/architecture/memory'
      },
      {
        no: '06',
        title: 'Local-first, growing by stages',
        text: 'From a local MVP to a multi-device Agent OS, every stage has UI, state, verification, and recovery.',
        link: '/en/delivery/roadmap'
      }
    ],
    flowKicker: 'PUBLIC CONTRACT',
    flowTitle: 'One auditable execution chain',
    flowLead:
      'Every fact enters the Event Log. Every external effect passes through an outbox, idempotency key, and receipt. Every UI state is a projection, never the source of truth.',
    flow: [
      'Entry',
      'Personal Gateway',
      'Control Plane',
      'Durable Harness',
      'Executor Layer',
      'Execution Gateway',
      'Event Log'
    ],
    stagesKicker: 'CAPABILITY LADDER',
    stagesTitle: 'From Stage 0 to Personal Agent OS v1.0',
    stagesLead:
      'Stages are capability gates, not calendar promises. You can pause, trial, and roll back, but you cannot skip a gate.',
    stages: [
      { no: '0', name: 'Definition & prototype', text: 'Product wedge, contracts, interaction, and evaluation baseline' },
      { no: '1', name: 'Local MVP', text: 'Durable kernel, Codex slice, task cards, approvals, and recovery' },
      { no: '2', name: 'Personal Operator', text: 'Email, calendar, documents, web, and data tasks' },
      { no: '3', name: 'Computer Operator', text: 'Desktop agentd, GUI execution, and human takeover' },
      { no: '4', name: 'Proactive personal agent', text: 'Triggers, attention budget, and mobile PWA' },
      { no: '5', name: 'Memory / Evolution', text: 'Long-term memory, skill candidates, evaluation, and rollback' },
      { no: '6', name: 'Personal Agent OS', text: 'Multi-device, offline, migration, and long-term operations' }
    ],
    pathsKicker: 'READING PATHS',
    pathsTitle: 'Choose your reading path',
    pathsLead: 'Start by role and time budget, not by reading all 4,700 lines.',
    paths: [
      {
        tag: 'Product & strategy',
        title: 'Decide whether this is worth building',
        text: 'Definition → roadmap → plan → risks and decisions',
        link: '/en/guide/reading-guide'
      },
      {
        tag: 'Architecture & engineering',
        title: 'Prepare to implement',
        text: 'Architecture → domain contracts → control plane → executors → safety and evaluation',
        link: '/en/architecture/'
      },
      {
        tag: 'Start building',
        title: 'Begin with an MVP vertical slice',
        text: 'Stage 1 → Event Log → Codex Executor → task card → recovery',
        link: '/en/delivery/development-plan'
      }
    ],
    notice:
      'The repository is at the specification stage. The roadmap is the source of truth for scope and sequencing; implementation has not started. All content is organized around v3.2.'
  }
}

const text = computed(() => (isEnglish.value ? copy.en : copy.zh))
const homeLink = (link: string) => withBase(link)
</script>

<template>
  <div class="home-dashboard">
    <section class="status-strip" aria-label="Project status">
      <div class="status-strip__main">
        <span class="status-strip__dot" aria-hidden="true"></span>
        <span class="status-strip__label">{{ text.statusLabel }}</span>
        <strong>{{ text.statusValue }}</strong>
      </div>
      <span class="status-strip__detail">{{ text.statusDetail }}</span>
    </section>

    <section class="stat-grid" aria-label="Project at a glance">
      <div v-for="stat in text.stats" :key="stat.label" class="stat">
        <strong>{{ stat.value }}</strong>
        <span>{{ stat.label }}</span>
      </div>
    </section>

    <section class="manifesto">
      <div class="section-kicker">{{ text.manifestoKicker }}</div>
      <h2>{{ text.manifestoTitle }}</h2>
      <p class="manifesto__lead">{{ text.manifestoText }}</p>
      <ul>
        <li v-for="point in text.manifestoPoints" :key="point">{{ point }}</li>
      </ul>
    </section>

    <section class="feature-section">
      <div class="section-heading">
        <div>
          <div class="section-kicker">DESIGN CONTRACT</div>
          <h2>{{ text.featuresTitle }}</h2>
        </div>
        <p>{{ text.featuresLead }}</p>
      </div>

      <div class="feature-grid">
        <a
          v-for="feature in text.features"
          :key="feature.no"
          class="feature-card"
          :href="homeLink(feature.link)"
        >
          <span class="feature-card__no">{{ feature.no }}</span>
          <strong>{{ feature.title }}</strong>
          <span>{{ feature.text }}</span>
          <span class="feature-card__arrow" aria-hidden="true">↗</span>
        </a>
      </div>
    </section>

    <section class="flow-section">
      <div class="section-kicker">{{ text.flowKicker }}</div>
      <h2>{{ text.flowTitle }}</h2>
      <p class="flow-section__lead">{{ text.flowLead }}</p>
      <div class="flow">
        <div v-for="(step, index) in text.flow" :key="step" class="flow__step">
          <span class="flow__index">{{ String(index + 1).padStart(2, '0') }}</span>
          <strong>{{ step }}</strong>
          <span v-if="index < text.flow.length - 1" class="flow__arrow" aria-hidden="true">→</span>
        </div>
      </div>
    </section>

    <section class="stage-section">
      <div class="section-kicker">{{ text.stagesKicker }}</div>
      <h2>{{ text.stagesTitle }}</h2>
      <p class="stage-section__lead">{{ text.stagesLead }}</p>
      <div class="stage-list">
        <div v-for="stage in text.stages" :key="stage.no" class="stage-row">
          <span class="stage-row__no">S{{ stage.no }}</span>
          <strong>{{ stage.name }}</strong>
          <span class="stage-row__text">{{ stage.text }}</span>
        </div>
      </div>
    </section>

    <section class="path-section">
      <div class="section-kicker">{{ text.pathsKicker }}</div>
      <h2>{{ text.pathsTitle }}</h2>
      <p class="path-section__lead">{{ text.pathsLead }}</p>
      <div class="path-grid">
        <a
          v-for="path in text.paths"
          :key="path.title"
          class="path-card"
          :href="homeLink(path.link)"
        >
          <span class="path-card__tag">{{ path.tag }}</span>
          <strong>{{ path.title }}</strong>
          <span>{{ path.text }}</span>
          <span class="path-card__arrow" aria-hidden="true">→</span>
        </a>
      </div>
    </section>

    <section class="notice">
      <span class="notice__mark" aria-hidden="true">§</span>
      <p>{{ text.notice }}</p>
    </section>
  </div>
</template>

<style scoped>
.home-dashboard {
  width: min(1152px, calc(100% - 48px));
  margin: 0 auto;
  padding: 8px 0 96px;
}

.status-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin: 12px auto 28px;
  padding: 14px 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: color-mix(in srgb, var(--vp-c-bg-soft) 76%, transparent);
  color: var(--vp-c-text-2);
  font-size: 13px;
}

.status-strip__main {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-strip__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e8874d;
  box-shadow: 0 0 0 5px rgba(232, 135, 77, 0.14);
}

.status-strip__label {
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.status-strip strong {
  color: var(--vp-c-text-1);
  font-weight: 650;
}

.status-strip__detail {
  color: var(--vp-c-text-3);
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 88px;
  border-top: 1px solid var(--vp-c-divider);
  border-bottom: 1px solid var(--vp-c-divider);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 22px 8px 22px 0;
  border-right: 1px solid var(--vp-c-divider);
}

.stat:last-child {
  border-right: 0;
  padding-left: 24px;
}

.stat:not(:first-child) {
  padding-left: 24px;
}

.stat strong {
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 30px;
  font-weight: 500;
  line-height: 1;
}

.stat span {
  color: var(--vp-c-text-3);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.section-kicker {
  margin-bottom: 16px;
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.16em;
}

.manifesto {
  max-width: 900px;
  margin-bottom: 104px;
}

.manifesto h2,
.feature-section h2,
.flow-section h2,
.stage-section h2,
.path-section h2 {
  margin: 0;
  color: var(--vp-c-text-1);
  font-size: clamp(30px, 4vw, 50px);
  font-weight: 500;
  letter-spacing: -0.035em;
  line-height: 1.18;
}

.manifesto__lead {
  max-width: 760px;
  margin-top: 24px;
  color: var(--vp-c-text-2);
  font-size: 18px;
  line-height: 1.9;
}

.manifesto ul {
  display: grid;
  gap: 12px;
  margin: 32px 0 0;
  padding: 0;
  list-style: none;
}

.manifesto li {
  position: relative;
  padding-left: 22px;
  color: var(--vp-c-text-1);
  font-size: 15px;
}

.manifesto li::before {
  position: absolute;
  top: 0.6em;
  left: 0;
  width: 8px;
  height: 1px;
  background: var(--vp-c-brand-1);
  content: '';
}

.feature-section,
.flow-section,
.stage-section,
.path-section {
  margin-bottom: 104px;
}

.section-heading {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(260px, 0.75fr);
  gap: 48px;
  align-items: end;
  margin-bottom: 34px;
}

.section-heading p,
.flow-section__lead,
.stage-section__lead,
.path-section__lead {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 1.8;
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-top: 1px solid var(--vp-c-divider);
  border-left: 1px solid var(--vp-c-divider);
}

.feature-card {
  position: relative;
  display: flex;
  min-height: 212px;
  flex-direction: column;
  gap: 12px;
  padding: 26px 24px 22px;
  border-right: 1px solid var(--vp-c-divider);
  border-bottom: 1px solid var(--vp-c-divider);
  background: transparent;
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition: background 0.22s ease;
}

.feature-card:hover {
  background: color-mix(in srgb, var(--vp-c-brand-soft) 62%, transparent);
}

.feature-card__no {
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
}

.feature-card strong {
  font-size: 18px;
  font-weight: 600;
}

.feature-card > span:not(.feature-card__no):not(.feature-card__arrow) {
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 1.7;
}

.feature-card__arrow {
  margin-top: auto;
  color: var(--vp-c-text-3);
  font-size: 18px;
  transition: color 0.2s ease, transform 0.2s ease;
}

.feature-card:hover .feature-card__arrow {
  color: var(--vp-c-brand-1);
  transform: translate(2px, -2px);
}

.flow-section {
  padding: 36px 36px 32px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 24px;
  background:
    radial-gradient(circle at 100% 0%, var(--vp-c-brand-soft), transparent 36%),
    color-mix(in srgb, var(--vp-c-bg-soft) 70%, transparent);
}

.flow-section__lead,
.stage-section__lead,
.path-section__lead {
  max-width: 720px;
  margin-top: 18px;
}

.flow {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 8px;
  margin-top: 32px;
}

.flow__step {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 44px;
  padding: 8px 13px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg);
  font-size: 12px;
}

.flow__index {
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 9px;
}

.flow__step strong {
  font-weight: 550;
}

.flow__arrow {
  margin-left: 4px;
  color: var(--vp-c-text-3);
}

.stage-list {
  margin-top: 28px;
  border-top: 1px solid var(--vp-c-divider);
}

.stage-row {
  display: grid;
  grid-template-columns: 48px minmax(170px, 0.55fr) minmax(0, 1fr);
  gap: 20px;
  align-items: baseline;
  padding: 18px 0;
  border-bottom: 1px solid var(--vp-c-divider);
}

.stage-row__no {
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
}

.stage-row strong {
  font-size: 14px;
  font-weight: 600;
}

.stage-row__text {
  color: var(--vp-c-text-2);
  font-size: 13px;
}

.path-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-top: 28px;
}

.path-card {
  display: flex;
  min-height: 210px;
  flex-direction: column;
  gap: 14px;
  padding: 24px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 18px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition: transform 0.22s ease, border-color 0.22s ease, box-shadow 0.22s ease;
}

.path-card:hover {
  transform: translateY(-3px);
  border-color: var(--vp-c-brand-2);
  box-shadow: 0 18px 46px rgba(31, 22, 14, 0.1);
}

.path-card__tag {
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.path-card strong {
  font-size: 18px;
  line-height: 1.35;
}

.path-card > span:not(.path-card__tag):not(.path-card__arrow) {
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 1.7;
}

.path-card__arrow {
  margin-top: auto;
  color: var(--vp-c-brand-1);
  font-size: 18px;
}

.notice {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  padding: 22px 24px;
  border-left: 2px solid var(--vp-c-brand-1);
  background: color-mix(in srgb, var(--vp-c-brand-soft) 48%, transparent);
}

.notice__mark {
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 18px;
}

.notice p {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 1.8;
}

@media (max-width: 960px) {
  .home-dashboard {
    width: min(100% - 40px, 760px);
  }

  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .stat:nth-child(2) {
    border-right: 0;
  }

  .stat:nth-child(3),
  .stat:nth-child(4) {
    border-top: 1px solid var(--vp-c-divider);
  }

  .section-heading {
    grid-template-columns: 1fr;
    gap: 18px;
  }

  .feature-grid,
  .path-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .feature-card:last-child,
  .path-card:last-child {
    grid-column: span 2;
  }
}

@media (max-width: 640px) {
  .home-dashboard {
    width: calc(100% - 32px);
  }

  .status-strip {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }

  .status-strip__detail {
    padding-left: 18px;
  }

  .stat-grid {
    margin-bottom: 64px;
  }

  .stat strong {
    font-size: 24px;
  }

  .manifesto,
  .feature-section,
  .flow-section,
  .stage-section,
  .path-section {
    margin-bottom: 72px;
  }

  .feature-grid,
  .path-grid {
    grid-template-columns: 1fr;
  }

  .feature-card:last-child,
  .path-card:last-child {
    grid-column: auto;
  }

  .flow-section {
    padding: 26px 20px;
  }

  .flow__arrow {
    display: none;
  }

  .stage-row {
    grid-template-columns: 42px 1fr;
    gap: 6px 12px;
  }

  .stage-row__text {
    grid-column: 2;
  }
}
</style>

<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'

const { lang } = useData()
const isEnglish = computed(() => lang.value.startsWith('en'))

const copy = {
  zh: {
    startKicker: 'START HERE',
    startTitle: '第一次来？按这三步开始',
    startLead:
      '先理解 Hearth，再看懂系统，最后进入对应 Stage 的开发模块。不用从头读完所有材料，每一步都有明确的下一步。',
    startSteps: [
      {
        no: '01',
        meta: '10 分钟',
        title: '先理解项目',
        text: '一句话定位、目标用户，以及 Hearth 明确不做什么。',
        action: '认识 Hearth',
        link: '/guide/what-is-hearth'
      },
      {
        no: '02',
        meta: '30 分钟',
        title: '再看懂系统',
        text: '七个平面、事件流、持久执行和执行器边界。',
        action: '阅读系统设计',
        link: '/architecture/overview'
      },
      {
        no: '03',
        meta: '准备开发',
        title: '最后按阶段动手',
        text: '路线图给总纲；从 Stage 0 开始，每个模块都有步骤与验收。',
        action: '打开开发计划',
        link: '/delivery/development-plan'
      }
    ],
    startNote: '推荐顺序：01 → 02 → 03。已经明确分工时，可直接跳到对应模块或完整开发计划。',
    startLinks: [
      { text: '产品与决策', link: '/product/definition' },
      { text: '架构与实现', link: '/architecture/' },
      { text: '直接写代码', link: '/delivery/stage-0' }
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
      { no: '0', name: '定义与原型', text: '产品楔子、协议、交互与评测基线', meta: '4 个增量', link: '/delivery/stage-0' },
      { no: '1', name: '本地 MVP', text: '持久内核、Codex 切片、任务卡、审批与恢复', meta: '6 个增量', link: '/delivery/stage-1' },
      { no: '2', name: 'Personal Operator', text: '邮件、日历、文档、网页与数据任务', meta: '6 个增量', link: '/delivery/stage-2' },
      { no: '3', name: 'Computer Operator', text: '桌面 agentd、GUI 执行与人工接管', meta: '4 个增量', link: '/delivery/stage-3' },
      { no: '4', name: '主动个人 Agent', text: 'Trigger、注意力预算、手机 PWA', meta: '5 个增量', link: '/delivery/stage-4' },
      { no: '5', name: 'Memory / Evolution', text: '长期记忆、技能候选、评估与回滚', meta: '4 个增量', link: '/delivery/stage-5' },
      { no: '6', name: 'Personal Agent OS', text: '多设备、离线、迁移与长期运维', meta: '6 个增量', link: '/delivery/stage-6' }
    ],
    notice:
      '项目处于规划与文档阶段。路线图是范围与顺序的事实源；实现尚未开始，开发从 Stage 0 开始。'
  },
  en: {
    startKicker: 'START HERE',
    startTitle: 'New here? Start with these three steps',
    startLead:
      'Understand Hearth, then the system, then the Stage module you will build. You do not need to read everything first, and every step gives you a clear next action.',
    startSteps: [
      {
        no: '01',
        meta: '10 minutes',
        title: 'Understand the project',
        text: 'Positioning, target user, and what Hearth explicitly does not do.',
        action: 'Meet Hearth',
        link: '/en/guide/what-is-hearth'
      },
      {
        no: '02',
        meta: '30 minutes',
        title: 'Understand the system',
        text: 'Seven planes, event flow, durable execution, and executor boundaries.',
        action: 'Read system design',
        link: '/en/architecture/overview'
      },
      {
        no: '03',
        meta: 'Ready to build',
        title: 'Start with a stage module',
        text: 'Use the roadmap for the big picture, then start at Stage 0 with explicit steps and acceptance gates.',
        action: 'Open the plan',
        link: '/en/delivery/development-plan'
      }
    ],
    startNote: 'Recommended: 01 → 02 → 03. If your role is already clear, jump directly to a module or the full development plan.',
    startLinks: [
      { text: 'Product & decisions', link: '/en/product/definition' },
      { text: 'Architecture & delivery', link: '/en/architecture/' },
      { text: 'Start coding', link: '/en/delivery/stage-0' }
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
      { no: '0', name: 'Definition & prototype', text: 'Product wedge, contracts, interaction, and evaluation baseline', meta: '4 increments', link: '/en/delivery/stage-0' },
      { no: '1', name: 'Local MVP', text: 'Durable kernel, Codex slice, task cards, approvals, and recovery', meta: '6 increments', link: '/en/delivery/stage-1' },
      { no: '2', name: 'Personal Operator', text: 'Email, calendar, documents, web, and data tasks', meta: '6 increments', link: '/en/delivery/stage-2' },
      { no: '3', name: 'Computer Operator', text: 'Desktop agentd, GUI execution, and human takeover', meta: '4 increments', link: '/en/delivery/stage-3' },
      { no: '4', name: 'Proactive personal agent', text: 'Triggers, attention budget, and mobile PWA', meta: '5 increments', link: '/en/delivery/stage-4' },
      { no: '5', name: 'Memory / Evolution', text: 'Long-term memory, skill candidates, evaluation, and rollback', meta: '4 increments', link: '/en/delivery/stage-5' },
      { no: '6', name: 'Personal Agent OS', text: 'Multi-device, offline, migration, and long-term operations', meta: '6 increments', link: '/en/delivery/stage-6' }
    ],
    notice:
      'The project is in the planning and documentation phase. The roadmap is the source of truth for scope and sequencing; implementation has not started and begins at Stage 0.'
  }
}

const text = computed(() => (isEnglish.value ? copy.en : copy.zh))
const homeLink = (link: string) => withBase(link)
</script>

<template>
  <div class="home-dashboard">
    <section class="start-section" aria-labelledby="start-title">
      <div class="section-heading start-heading">
        <div>
          <div class="section-kicker">{{ text.startKicker }}</div>
          <h2 id="start-title">{{ text.startTitle }}</h2>
        </div>
        <p>{{ text.startLead }}</p>
      </div>

      <div class="start-grid">
        <a
          v-for="step in text.startSteps"
          :key="step.no"
          class="start-card"
          :href="homeLink(step.link)"
        >
          <span class="start-card__no">{{ step.no }}</span>
          <div class="start-card__body">
            <span class="start-card__meta">{{ step.meta }}</span>
            <strong>{{ step.title }}</strong>
            <span>{{ step.text }}</span>
            <span class="start-card__action">{{ step.action }} <span aria-hidden="true">→</span></span>
          </div>
        </a>
      </div>

      <div class="start-footer">
        <p>{{ text.startNote }}</p>
        <div class="start-links">
          <a v-for="link in text.startLinks" :key="link.link" :href="homeLink(link.link)">
            {{ link.text }}
          </a>
        </div>
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
        <a
          v-for="stage in text.stages"
          :key="stage.no"
          class="stage-row"
          :href="homeLink(stage.link)"
        >
          <span class="stage-row__no">S{{ stage.no }}</span>
          <strong>{{ stage.name }}</strong>
          <span class="stage-row__text">{{ stage.text }}</span>
          <span class="stage-row__meta">{{ stage.meta }} <span aria-hidden="true">↗</span></span>
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
  width: min(1168px, calc(100vw - 48px));
  margin: 0 auto;
  padding: 18px 0 104px;
}

.start-section {
  margin-bottom: 88px;
}

.start-heading {
  margin-bottom: 26px;
}

.start-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: stretch;
  gap: 18px;
}

.start-card {
  position: relative;
  display: flex;
  min-height: 224px;
  flex-direction: column;
  gap: 18px;
  padding: 24px 24px 22px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background:
    linear-gradient(155deg, var(--vp-c-bg-elv), color-mix(in srgb, var(--vp-c-bg-soft) 44%, var(--vp-c-bg-elv))),
    var(--vp-c-bg-elv);
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition: transform 0.22s ease, border-color 0.22s ease, box-shadow 0.22s ease;
}

.start-card::before {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  height: 3px;
  background: linear-gradient(90deg, var(--vp-c-brand-1), var(--vp-c-brand-2), transparent 82%);
  content: '';
  opacity: 0.72;
}

.start-card:hover {
  transform: translateY(-3px);
  border-color: var(--vp-c-brand-2);
  box-shadow: 0 18px 44px rgba(31, 98, 133, 0.12);
}

.start-card__no {
  display: inline-flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.08em;
}

.start-card__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 9px;
}

.start-card__meta {
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.start-card strong {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.4;
}

.start-card__body > span:not(.start-card__meta):not(.start-card__action) {
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 1.75;
}

.start-card__action {
  margin-top: auto;
  color: var(--vp-c-brand-1);
  font-size: 13px;
  font-weight: 650;
}

.start-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-top: 18px;
  padding: 15px 18px;
  border: 1px dashed color-mix(in srgb, var(--vp-c-divider) 78%, var(--vp-c-brand-2));
  border-radius: 12px;
  background: color-mix(in srgb, var(--vp-c-bg-alt) 68%, transparent);
}

.start-footer p {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 12px;
}

.start-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.start-links a {
  padding: 6px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  color: var(--vp-c-text-2);
  font-size: 11px;
  text-decoration: none;
  transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;
}

.start-links a:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-2);
  background: var(--vp-c-brand-soft);
}

.section-kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.16em;
}

.section-kicker::before {
  width: 18px;
  height: 1px;
  background: var(--vp-c-brand-2);
  content: '';
}

.manifesto {
  margin-bottom: 88px;
  padding: 34px 36px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 20px;
  background:
    radial-gradient(circle at 100% 0%, var(--vp-c-brand-soft), transparent 38%),
    color-mix(in srgb, var(--vp-c-bg-elv) 76%, var(--vp-c-bg-alt));
}

.manifesto h2,
.start-section h2,
.feature-section h2,
.flow-section h2,
.stage-section h2 {
  margin: 0;
  color: var(--vp-c-text-1);
  font-size: clamp(28px, 3.4vw, 42px);
  font-weight: 560;
  letter-spacing: -0.035em;
  line-height: 1.22;
}

.manifesto__lead {
  max-width: 820px;
  margin-top: 20px;
  color: var(--vp-c-text-2);
  font-size: 16px;
  line-height: 1.85;
}

.manifesto ul {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 28px 0 0;
  padding: 0;
  list-style: none;
}

.manifesto li {
  position: relative;
  padding: 12px 14px 12px 26px;
  border: 1px solid color-mix(in srgb, var(--vp-c-divider) 78%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--vp-c-bg-elv) 72%, transparent);
  color: var(--vp-c-text-1);
  font-size: 13px;
  line-height: 1.65;
}

.manifesto li::before {
  position: absolute;
  top: 1.22em;
  left: 13px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--vp-c-brand-2);
  content: '';
}

.feature-section,
.flow-section,
.stage-section {
  margin-bottom: 88px;
}

.section-heading {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(260px, 0.8fr);
  gap: 44px;
  align-items: end;
  margin-bottom: 30px;
}

.section-heading p,
.flow-section__lead,
.stage-section__lead {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 1.82;
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: stretch;
  gap: 14px;
}

.feature-card {
  position: relative;
  display: flex;
  min-height: 196px;
  flex-direction: column;
  gap: 12px;
  padding: 24px 22px 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: color-mix(in srgb, var(--vp-c-bg-elv) 88%, var(--vp-c-bg-alt));
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition: border-color 0.22s ease, background 0.22s ease, transform 0.22s ease;
}

.feature-card:hover {
  transform: translateY(-2px);
  border-color: var(--vp-c-brand-2);
  background: color-mix(in srgb, var(--vp-c-bg-elv) 70%, var(--vp-c-brand-soft));
}

.feature-card__no {
  display: inline-flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--vp-c-brand-softer);
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.06em;
}

.feature-card strong {
  font-size: 17px;
  font-weight: 600;
  line-height: 1.4;
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
  padding: 34px 36px 32px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 20px;
  background:
    radial-gradient(circle at 100% 0%, var(--vp-c-brand-soft), transparent 36%),
    color-mix(in srgb, var(--vp-c-bg-alt) 82%, var(--vp-c-bg-elv));
}

.flow-section__lead,
.stage-section__lead {
  max-width: 720px;
  margin-top: 16px;
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
  background: var(--vp-c-bg-elv);
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
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: color-mix(in srgb, var(--vp-c-bg-elv) 86%, var(--vp-c-bg-alt));
}

.stage-row {
  display: grid;
  grid-template-columns: 48px minmax(170px, 0.55fr) minmax(0, 1fr) auto;
  gap: 20px;
  align-items: center;
  padding: 16px 18px;
  border-bottom: 1px solid color-mix(in srgb, var(--vp-c-divider) 82%, transparent);
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition: background 0.2s ease;
}

.stage-row:hover {
  background: var(--vp-c-brand-softer);
}

.stage-row:last-child {
  border-bottom: 0;
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
  line-height: 1.6;
}

.stage-row__meta {
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  white-space: nowrap;
}

.notice {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  padding: 22px 24px;
  border: 1px solid var(--vp-c-divider);
  border-left: 3px solid var(--vp-c-brand-1);
  border-radius: 12px;
  background: color-mix(in srgb, var(--vp-c-brand-softer) 82%, transparent);
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
    width: calc(100vw - 40px);
  }

  .section-heading {
    grid-template-columns: 1fr;
    gap: 18px;
  }

  .feature-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .manifesto ul {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .home-dashboard {
    width: calc(100vw - 32px);
  }

  .manifesto,
  .start-section,
  .feature-section,
  .flow-section,
  .stage-section {
    margin-bottom: 72px;
  }

  .feature-grid,
  .start-grid {
    grid-template-columns: 1fr;
  }

  .manifesto {
    padding: 26px 22px;
  }

  .flow-section {
    padding: 26px 20px;
  }

  .flow__arrow {
    display: none;
  }

  .stage-row {
    grid-template-columns: 42px 1fr;
    gap: 5px 12px;
    padding: 15px 14px;
  }

  .stage-row__text {
    grid-column: 2;
  }

  .stage-row__meta {
    grid-column: 2;
  }

  .start-footer {
    align-items: flex-start;
    flex-direction: column;
  }

  .start-links {
    justify-content: flex-start;
  }
}
</style>

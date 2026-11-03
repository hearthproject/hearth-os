---
title: '交付总览'
description: 'Hearth 的交付总览：Stage 0–6、MVP 位置、推进原则与路线图入口。'
outline: [2, 3]
---

<script setup>
const cards = [
  { no: '01', title: '分阶段产品路线图', text: 'Stage 0–6 的目标、范围、退出条件与明确推迟项。', link: '/delivery/roadmap' },
  { no: '02', title: '从 0 到 100 开发计划', text: 'MVP-1、增量模板、发布序列、范围裁剪与 v1.0 出口。', link: '/delivery/development-plan' },
  { no: '03', title: '工程交付与仓库结构', text: '技术栈、仓库布局、进程模型、CLI、测试与发布迁移。', link: '/delivery/engineering' },
  { no: '04', title: '风险与 Kill Criteria', text: '暂停条件、阶段 Kill Criteria 与不应被 Kill 的东西。', link: '/delivery/risks' },
  { no: '05', title: 'ADR 与关键决策', text: '不可轻易反转的判断，以及 v1.0 的最终出口。', link: '/delivery/decisions' }
]
</script>

<p class="eyebrow">DELIVERY</p>

# 交付：按能力门槛推进

<p class="lead">Hearth 不按日历承诺交付，而是按能力门槛推进。每个阶段都必须同时交付用户可见界面、持久状态、验证证据和恢复路径。</p>

<DocCardGrid :items="cards" :columns="2" />

## 第 26–29 章导读

- 第 26 章给出工程落地方式，第 27 章给出风险与 Kill Criteria。
- 第 28 章汇总 ADR-001–020，第 29 章给出术语、默认清单和最终判断。
- 工程地基、恢复、安全与界面不可为了赶进度而裁剪。

## 阶段总览

| 阶段 | 产品形态 | 核心能力 |
|---|---|---|
| Stage 0 | 可点击端到端原型 | 产品楔子、任务集、协议、交互、评测与安全基线 |
| Stage 1 | 本地个人任务工作台 + MVP | 可恢复内核、Codex、Web 任务卡、审批、产物、恢复 |
| Stage 2 | Personal Operator | 邮件、日历、文档、网页、数据、Context Compiler、Memory v0 |
| Stage 3 | Computer Operator | agentd、GUI、接管、桌面隔离与高风险审批 |
| Stage 4 | Proactive Personal Agent | Trigger、主动循环、注意力预算、手机 PWA、设备配对 |
| Stage 5 | Memory / Evolution OS | 长期记忆、技能评估/晋升/回滚 |
| Stage 6 | Personal Agent OS v1.0 | 多设备、离线队列、撤销、备份迁移、长期运维 |

**MVP 的位置：** MVP 是 Stage 1 的早期出口，位于完整 Stage 1 门槛之前。它不包含邮件、日历、GUI、主动性和多设备，但必须包含真实执行、持久任务状态、Web 任务卡、产物、审批演练和失败恢复。

## 从 0 到 100 一页地图

```text
Stage 0  产品楔子 + 可点击原型 + 协议/评测基线
   ↓
Stage 1  走路骨架 → 第一个真实 Codex 切片 → MVP → 副作用安全 → 第二任务族
   ↓
Stage 2  只读连接器 → 文档/数据 → 浏览器 → 草稿/审批/回执 → 日常操作员
   ↓
Stage 3  设备 agentd → 观察/接管 → 低风险 GUI → 高风险 GUI
   ↓
Stage 4  Trigger/主动收件箱 → 手机 PWA → 安全配对 → 注意力预算
   ↓
Stage 5  Memory Core → 遗忘/导出 → 技能候选/评估 → 晋升/回滚
   ↓
Stage 6  多设备同步 → 离线队列 → 撤销/密钥 → 备份迁移 → v1.0
```

“100%”不是永远不再迭代，而是 Stage 6 的 v1.0 出口：完整产品、可恢复、可审批、可迁移、可撤销、可长期使用。

## 推进原则

- 先证明可靠，再扩大覆盖；
- 前端与后端按纵向切片同步推进；
- 任何自动化能力进入真实副作用前，必须先通过安全与恢复测试；
- 每个阶段都同时有产品门槛和学习门槛；
- 可以停留、试用和回退，但不能跳步。

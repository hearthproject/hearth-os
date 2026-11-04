---
title: '交付总览'
description: 'Hearth 的交付入口：产品路线图作为总纲，七个阶段模块负责具体开发，工程保障负责验证、风险与决策。'
outline: [2, 3]
---

<script setup>
const modules = [
  { no: 'S0', meta: '4 个增量', title: '定义与原型', text: '锁定用户、任务楔子、端到端原型、协议契约与评测基线。', link: '/delivery/stage-0' },
  { no: 'S1', meta: '6 个增量', title: '持久内核与 MVP', text: '走路骨架、第一个 Codex 切片、MVP-1、副作用安全与恢复。', link: '/delivery/stage-1' },
  { no: 'S2', meta: '6 个增量', title: 'Personal Operator', text: '连接器、文档与数据、网页研究，以及需要审批的写入。', link: '/delivery/stage-2' },
  { no: 'S3', meta: '4 个增量', title: 'Computer Operator', text: '桌面 agentd、GUI 观察、人工接管和分级桌面动作。', link: '/delivery/stage-3' },
  { no: 'S4', meta: '5 个增量', title: '主动个人 Agent', text: 'Trigger、主动收件箱、手机 PWA 与注意力预算。', link: '/delivery/stage-4' },
  { no: 'S5', meta: '4 个增量', title: '记忆与进化', text: 'Memory Core、遗忘与导出、技能候选、评估与回滚。', link: '/delivery/stage-5' },
  { no: 'S6', meta: '6 个增量', title: '多设备与长期运行', text: '事件同步、离线队列、设备撤销、备份迁移与长期运维。', link: '/delivery/stage-6' }
]

const safeguards = [
  { no: '01', title: '工程交付与仓库结构', text: '技术栈、仓库布局、进程模型、CLI、测试与评测、发布迁移。', link: '/delivery/engineering' },
  { no: '02', title: '风险与 Kill Criteria', text: '暂停条件、阶段 Kill Criteria，以及哪些基础能力不能被裁掉。', link: '/delivery/risks' },
  { no: '03', title: 'ADR 与关键决策', text: '不可轻易反转的判断，以及最终产品出口的验收口径。', link: '/delivery/decisions' }
]
</script>

<p class="eyebrow">DELIVERY MAP</p>

# 交付路线总览

<p class="lead">产品路线图定义范围、顺序和阶段门槛；“从 0 到 100”把总纲拆成七个可以独立施工和验收的模块；工程保障负责仓库、风险与关键决策。</p>

> **阅读顺序只有一条：** 先读[产品路线图](/delivery/roadmap)，确认当前阶段做什么、不做什么；再进入对应的 Stage 模块；最后查阅[工程保障](#工程保障)与[来源覆盖](/reference/source-map)。

## 第一层：产品路线图是总纲

[产品路线图](/delivery/roadmap)回答四个问题：

1. **为什么现在做这个阶段？** 用能力依赖而不是日历排期来决定顺序。
2. **这一阶段交付什么？** 明确用户可见的产品形态、核心能力和主要风险。
3. **什么时候算完成？** 每个 Stage 都有退出条件和学习门槛。
4. **什么暂时不做？** 把高风险、低价值或会拖垮地基的范围明确推迟。

阶段是能力门槛，不是日期承诺。每个阶段都可以停留、试用和回退，但不能跳过恢复、界面、验证或安全边界。

## 第二层：七个开发模块

《从 0 到 100 开发计划》不是一张笼统的大清单，而是七个连续模块。每个模块都按“前置条件 → 开发步骤 → 增量拆分 → 退出验收 → 本模块不做”组织，开发者可以直接从当前模块开始施工。

<DocCardGrid :items="modules" :columns="2" />

[查看完整开发计划与交付模板](/delivery/development-plan)

## 第三层：工程保障

- 第 26 章给出工程落地方式，第 27 章给出风险与 Kill Criteria。
- 第 28 章汇总 ADR-001–020，第 29 章给出术语、默认清单和最终判断。
- 工程地基、恢复、安全与界面不可为了赶进度而裁剪。

<DocCardGrid :items="safeguards" :columns="3" />

## 阶段推进顺序

| 阶段 | 开发模块 | 阶段出口 | 不能跳过的证据 |
|---|---|---|---|
| Stage 0 | [定义与原型](/delivery/stage-0) | 可点击原型与稳定契约 | 12 个真实任务、完整状态流、评测与审批基线 |
| Stage 1 | [持久内核与 MVP](/delivery/stage-1) | 本地可每天使用的 MVP | 持久状态、真实 Codex 执行、审批、产物与恢复 |
| Stage 2 | [Personal Operator](/delivery/stage-2) | 日常内容工作可委托 | 连接器闭环、引用来源、审批写入与回执 |
| Stage 3 | [Computer Operator](/delivery/stage-3) | 桌面任务可接管执行 | GUI 观察、接管、隔离、桌面验证与高风险审批 |
| Stage 4 | [主动个人 Agent](/delivery/stage-4) | 有限授权下主动工作 | Trigger、注意力预算、手机审批与随时暂停 |
| Stage 5 | [记忆与进化](/delivery/stage-5) | 可解释、可回滚地积累 | 记忆纠正/遗忘/导出，技能评估、晋升与回滚 |
| Stage 6 | [多设备与长期运行](/delivery/stage-6) | 可迁移的个人 Agent OS | 同步、离线恢复、设备撤销、备份迁移与长期审计 |

**MVP 的位置：** MVP-1 是 Stage 1 的早期出口，位于 D1.3，不是 Stage 6 的产物。它必须包含真实执行、持久任务、Web 任务卡、产物、审批演练和失败恢复。

## 开发者应该怎么开始

1. 第一次接触项目：读[认识 Hearth](/guide/what-is-hearth)和[产品定义](/product/definition)。
2. 准备实现：读[系统设计总览](/architecture/)与[持久执行](/architecture/durable-execution)。
3. 开始动手：打开[Stage 0](/delivery/stage-0)，按步骤和增量逐项完成。
4. 准备合并：检查[风险与 Kill Criteria](/delivery/risks)与[默认清单](/reference/checklists)。

需要确认原始材料是否都有对应页面，请直接查看[文档来源与覆盖](/reference/source-map)。

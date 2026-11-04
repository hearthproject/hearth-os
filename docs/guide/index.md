---
title: '开始阅读'
description: 'Hearth 文档入口：项目介绍、阅读路径、文档结构与当前状态。'
outline: [2, 3]
---

<script setup>
const cards = [
  { no: '01', title: '认识 Hearth', text: '一句话定位、目标用户、产品边界，以及它为什么不是另一个 Codex。', link: '/guide/what-is-hearth' },
  { no: '02', title: '阅读指南', text: '三条阅读路径、站点地图和文档约定。', link: '/guide/reading-guide' },
  { no: '03', title: '项目状态', text: '当前处于规格阶段，了解已完成内容、未开始部分和下一步。', link: '/guide/project-status' }
]
</script>

<p class="eyebrow">START HERE</p>

# 从意图到可靠任务

<p class="lead">Hearth 是一个单用户、自托管、长期驻留的个人 Agent OS。文档站按“产品判断 → 系统设计 → 交付路线 → 参考附录”组织，帮助你在最短时间内找到需要的那一层。</p>

<DocCardGrid :items="cards" />

## 先看结论

Hearth 的核心不是“再做一个模型”，而是任务控制、持久执行、记忆、验证、审批、回执和安静的任务卡体验。它把个人数字劳动变成一条可审计、可恢复、可验证的执行链。

当前路线图有三条最重要的原则：

1. **先做最小产品，再做完整 OS。** Stage 1 内部就要出现每天可用的 MVP。
2. **前端从第一天存在。** 每个增量都必须有用户可见路径、验证和恢复。
3. **不按日历排期。** Stage 是能力门槛，不是工期承诺。

## 三条阅读路径

| 路径 | 适合谁 | 建议顺序 |
|---|---|---|
| 产品与决策 | 判断是否继续投入、需要理解范围与风险 | [产品定义](/product/definition) → [路线图](/delivery/roadmap) → [开发计划](/delivery/development-plan) → [风险](/delivery/risks) |
| 架构与技术 | 准备开始实现、需要检查系统边界 | [架构总览](/architecture/) → [领域协议](/architecture/domain-model) → [控制面](/architecture/control-plane) → [执行器](/architecture/executor-model) → [评估](/architecture/evaluation) |
| 直接开工 | 已经准备建仓库、需要找到第一个纵向切片 | [Stage 0](/delivery/stage-0) → [Stage 1](/delivery/stage-1) → [持久执行](/architecture/durable-execution) → [Codex Executor](/architecture/executor-catalog) |

## 文档结构

- **开始**：项目介绍、阅读方式与当前状态。
- **产品**：定义、设计原则、任务覆盖与完成标准。
- **系统设计**：总体架构、领域模型、控制面、执行器、安全、记忆、进化、Token 经济、前端与评估。
- **交付路线**：Stage 0–6、从 0 到 100 的开发计划、工程结构与风险。
- **参考**：自研与集成边界、术语表、默认清单、FAQ、贡献指南和完整路线图归档。

完整主文档保留在[归档页](/reference/full-roadmap)，日常阅读建议使用本文件夹重组后的主题页面。

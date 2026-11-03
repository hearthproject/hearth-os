---
title: '产品总览'
description: 'Hearth 的产品定位、产品楔子与明确不追求的方向。'
outline: [2, 3]
---

<script setup>
const cards = [
  { no: '01', title: '产品定义与边界', text: 'Hearth 是谁的产品、解决什么问题、明确不承诺什么。', link: '/product/definition' },
  { no: '02', title: '设计原则与架构不变量', text: '五个不可妥协的判断、核心设计选择和七条架构不变量。', link: '/product/design-principles' },
  { no: '03', title: '任务覆盖与完成定义', text: '八类任务、自主级别，以及什么才算“真的完成”。', link: '/product/task-coverage' }
]
</script>

<p class="eyebrow">PRODUCT</p>

# 产品：从个人痛点出发

<p class="lead">Hearth 不是面向所有人和所有组织的通用平台。第一版只追求一个真实用户愿意每天使用：单用户、自托管、可控、可恢复、低打扰。</p>

<DocCardGrid :items="cards" />

## 产品楔子

优先选择一个高频、低外部风险、可验证的任务族作为 MVP。它必须能产生用户可见的产物，同时暴露持久状态、审批、恢复和 Token 预算等核心设计问题。

## 不追求的方向

- 不做企业多租户、IAM、组织审计和计费；
- 不追求第一天覆盖全部八类任务；
- 不与底层模型厂商比模型能力；
- 不做无边界的无人值守高风险自动化；
- 不把“像人”当作产品目标。

下一步：阅读[产品定义与边界](/product/definition)，或直接查看[路线图](/delivery/roadmap)。

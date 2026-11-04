---
title: '参考总览'
description: 'Hearth 参考与附录入口：自研边界、术语、清单、FAQ、贡献、文档地图与完整路线图归档。'
outline: [2, 3]
---

<script setup>
const cards = [
  { no: '01', title: '自研与集成边界', text: 'Hearth 自己做核心控制与记忆，直接集成模型、Codex、浏览器、文档解析和 Sandbox 内核。', link: '/reference/build-vs-integrate' },
  { no: '02', title: '术语表', text: '统一 Task、Ticket、Mandate、Run、Receipt、Memory、Skill 等核心术语。', link: '/reference/glossary' },
  { no: '03', title: '默认清单', text: '默认审批清单、默认完成清单与任务覆盖的最终定义。', link: '/reference/checklists' },
  { no: '04', title: '常见问题', text: 'Hearth 与 Coding Agent、Codex 套壳、Stage 1、副作用、进化和多用户的关系。', link: '/reference/faq' },
  { no: '05', title: '参与贡献与文档维护', text: '仓库结构、本地开发、写作约定、PR 检查清单与事实源。', link: '/reference/contributing' },
  { no: '06', title: '文档地图与维护', text: '单一文档源、目录结构、阅读层级、双语规则和更新流程。', link: '/reference/source-map' },
  { no: '07', title: '完整路线图（归档）', text: '完整主文档，保留全部原始细节，适合检索和引用。', link: '/reference/full-roadmap' }
]
</script>

<p class="eyebrow">REFERENCE</p>

# 参考与附录

<p class="lead">这里放的是实现者和维护者会反复查阅的材料：边界、术语、清单、FAQ、贡献方式，以及完整路线图归档。</p>

<DocCardGrid :items="cards" :columns="2" />

## 如何引用

- 讨论产品范围时，优先引用[完整路线图](/reference/full-roadmap)和[产品定义](/product/definition)；
- 讨论工程边界时，优先引用[自研与集成边界](/reference/build-vs-integrate)和[工程交付](/delivery/engineering)；
- 讨论术语时，使用[术语表](/reference/glossary)中的定义，避免同名异义；
- 讨论阶段推进时，使用[路线图](/delivery/roadmap)和[风险](/delivery/risks)中的退出条件。

## 文档与维护

所有正式文档只存放在仓库的 `docs/`，文档站由这里直接构建。README 只负责仓库入口；[文档地图与维护](/reference/source-map)说明目录结构、阅读层级和修改流程。

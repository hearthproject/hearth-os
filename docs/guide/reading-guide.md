---
title: '阅读指南'
description: 'Hearth 文档的三条阅读路径、文档约定、站点地图与单一文档源维护方式。'
outline: [2, 3]
---

<p class="eyebrow">READING GUIDE</p>

# 阅读指南

<p class="lead">这套文档不是一本需要从头读到尾的书。先选择你的角色和目标，再沿着一条路径深入；需要完整细节时，再回到归档的完整路线图。</p>

## 三条阅读路径

### 产品与决策路径

适合第一次了解项目，或需要判断是否继续投入时阅读：

1. [认识 Hearth](/guide/what-is-hearth)
2. [产品定义与边界](/product/definition)
3. [分阶段产品路线图](/delivery/roadmap)
4. [从 0 到 100 开发计划](/delivery/development-plan)
5. [风险与 Kill Criteria](/delivery/risks)

### 架构与技术路径

适合准备开始实现，或需要检查系统边界时阅读：

1. [系统设计总览](/architecture/)
2. [总体架构与数据流](/architecture/overview)
3. [领域模型与协议](/architecture/domain-model)
4. [个人网关](/architecture/gateway)
5. [控制面与自主性](/architecture/control-plane)
6. [持久执行与恢复](/architecture/durable-execution)
7. [执行器模型](/architecture/executor-model)
8. [执行器目录](/architecture/executor-catalog)
9. [人工接管与审批](/architecture/human-takeover)
10. [执行安全](/architecture/execution-safety)
11. [记忆系统](/architecture/memory)
12. [技能进化](/architecture/evolution)
13. [安全与隐私](/architecture/security-privacy)
14. [评估体系](/architecture/evaluation)

### 直接开工路径

适合已经准备建仓库、需要找到第一个纵向切片时阅读：

1. [Stage 0 · 定义与原型](/delivery/stage-0)
2. [Stage 1 · 持久内核与 MVP](/delivery/stage-1)
3. [持久执行与恢复](/architecture/durable-execution)
4. [Codex Executor](/architecture/executor-catalog)
5. [工程交付与仓库结构](/delivery/engineering)

## 文档约定

- **Stage 是能力层级，不是日期。** 每个阶段都可以停留、试用和回退，但不能跳步。
- **MVP 位于 Stage 1 早期出口。** 它不是 Stage 6 的产物，也不是只有 CLI 或 API 的演示。
- **每个增量必须是纵向切片。** 用户结果、界面、持久状态、真实执行、验证、恢复和度量同时出现。
- **完整版是归档。** [完整路线图](/reference/full-roadmap)保留全部细节；本文件夹按主题重组，适合日常阅读和维护。
- **中文与英文保持同构。** 页面路径、章节结构和导航层级一一对应，右上角可一键切换。

## 站点地图

| 区域 | 内容 |
|---|---|
| [开始](/guide/) | 项目介绍、阅读指南、状态 |
| [产品](/product/) | 定义、设计原则、任务覆盖 |
| [系统设计](/architecture/) | 架构、协议、控制面、执行器、安全、记忆、进化、Token、前端、评估 |
| [交付路线](/delivery/) | Stage 0–6、0–100 计划、工程、风险、ADR |
| [参考](/reference/) | 自研边界、术语、清单、FAQ、贡献、完整归档 |

## 文档源与维护

本站与仓库共用同一份文档源：所有正式内容只存放在仓库的 `docs/`，文档站由该目录直接构建。中文页面位于 `docs/`，英文镜像位于 `docs/en/`；README 只作为仓库入口，不复制正文。[文档地图与维护](/reference/source-map)列出目录结构、阅读层级和更新流程。

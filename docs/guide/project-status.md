---
title: '项目状态'
description: 'Hearth 的文档与项目状态、已完成内容、尚未开始部分与下一阶段计划。'
outline: [2, 3]
---

<p class="eyebrow">PROJECT STATUS</p>

# 项目状态

<p class="lead">Hearth 目前处于规格与路线图阶段。仓库已经包含完整的产品、架构、安全、评估和交付计划，但实现尚未开始。</p>

## 文档与项目状态

| 项目 | 状态 |
|---|---|
| 文档位置 | `docs/` 单一文档源，直接构建文档站 |
| 仓库 | `hearthproject/hearth-os` |
| 阶段 | Specification & planning |
| 实现 | 尚未开始 |
| 下一个里程碑 | Stage 0：产品真相、原型、协议与评测基线 |
| 许可证 | Apache-2.0 |

## 已经完成

- 产品定义、非目标与首选用户；
- 八类任务覆盖、自主级别与“完成”的定义；
- 七个平面、领域实体、事件、执行器与回执协议；
- 入口、控制面、持久执行、执行器和人工接管设计；
- 执行安全、记忆、进化、Token 经济、前端与移动体验；
- 安全、隐私、威胁模型和评估体系；
- Stage 0–6 产品路线图与从 0 到 100 的渐进开发计划；
- 工程结构、风险、Kill Criteria、ADR 索引与附录；
- 可部署的中英双语文档站。

## 尚未开始

- 可运行的 `hearthd`、`hearth` CLI 和 Web 界面；
- Stage 0 可点击原型与真实数据契约；
- Codex Executor 的第一个真实切片；
- Connector、Browser、GUI、Document/Data 执行器；
- Memory OS、Evolution OS 与多设备同步。

## 下一步

Stage 0 的目标不是“写更多文档”，而是把产品、交互、协议和验收钉住：

1. 选定第一个高频、低外部风险的任务族；
2. 产出可点击的端到端 Web 原型；
3. 为每个 UI 状态定义投影字段和主动作；
4. 固化 Event、Task、Run、Executor、Approval、Receipt 的 schema v0；
5. 建立评测任务集、验证器和威胁模型基线。

Stage 0 的退出条件、增量清单和验收模板见[开发计划](/delivery/development-plan)。

## 如何跟进

- 阅读[分阶段产品路线图](/delivery/roadmap)了解能力门槛；
- 阅读[从 0 到 100 开发计划](/delivery/development-plan)了解第一段实现顺序；
- 关注仓库提交与 Issue；
- 如果要参与文档或实现，请先读[贡献与文档维护](/reference/contributing)。

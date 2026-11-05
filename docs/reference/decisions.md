---
title: 'ADR 与关键决策'
description: 'Hearth 的 ADR 索引与最终判断。'
outline: [2, 3]
---

<p class="eyebrow">DECISIONS</p>

# ADR 与关键决策

<p class="lead">把不可轻易反转的产品与工程判断固化为可追踪的决策记录。</p>

## ADR 索引

以下是建议的首批架构决策。状态为 `Accepted` 的应尽早写入仓库，后续变更通过新 ADR 记录。

| ADR | 决策 | 状态 | 主要后果 |
|---|---|---|---|
| ADR-001 | Hearth 是单用户、自托管、本地优先的个人 Agent OS | Accepted | 不做企业 IAM；优先本地状态和可迁移 |
| ADR-002 | Event Log 是唯一事实源，UI/索引/记忆是投影 | Accepted | 需要事件 schema、重放和 migration |
| ADR-003 | 早期使用 SQLite WAL 和单写者，不引入微服务 | Accepted | 降低运维；需要 lease 和水平扩展预案 |
| ADR-004 | 采用模块化单体，执行器通过统一协议接入 | Accepted | 边界靠接口和测试保证，而非网络拆分 |
| ADR-005 | 使用 Executor 多执行器模型，不追求单体万能 Agent | Accepted | 需要能力声明、路由和统一结果契约 |
| ADR-006 | Codex 是首个外部执行器，可做代码、研究、文档和 Shell，但不是产品本体 | Accepted | 需要适配器、版本锁定和降级路径 |
| ADR-007 | 自研 Execution Gateway、Policy、Broker；集成 Sandbox/Runtime 内核 | Accepted | 不自研容器/虚拟化；需要统一 Sandbox Provider |
| ADR-008 | 所有外部副作用走类型化 Effect、outbox、幂等键和 Receipt | Accepted | 增加实现复杂度，但避免重复和不可审计 |
| ADR-009 | 高风险动作需要 Mandate 和 Approval；执行器不能扩大权限 | Accepted | 增加交互，但建立信任边界 |
| ADR-010 | 记忆分五类，带来源、置信度、敏感度、预算和遗忘 | Accepted | 需要记忆维护和用户界面 |
| ADR-011 | 自进化只产生候选技能，经 Shadow/Canary/评估/回滚后晋升 | Accepted | 需要评测集和版本管理 |
| ADR-012 | 手机优先 PWA，先做查看/审批/接管/发起/通知 | Accepted | 暂不做完整移动 Agent；降低发布成本 |
| ADR-013 | Token Governor 和 Context Compiler 是核心架构，不是后置优化 | Accepted | 需要统一计量、预算和上下文组装 |
| ADR-014 | 学 OpenClaw/Hermes 的模式，不 fork 其产品底座 | Accepted | 需要自建 Gateway、Memory、Evolution 协议 |
| ADR-015 | Human Executor 和 takeover 是一等能力 | Accepted | 需要实时界面、审计和恢复 |
| ADR-016 | 不做企业多租户、公开 Agent 市场和计费 | Accepted | 聚焦个人体验和自托管 |
| ADR-017 | 当前只接入 Codex，其他外部 Agent 暂不纳入产品范围 | Accepted（临时） | 保留 Executor 接口，避免绑定 |
| ADR-018 | 模型可替换，本地模型可选，不训练基础模型 | Accepted | 需要模型目录、路由和评估 |
| ADR-019 | 采用 MVP-first 的纵向切片交付；前端从第一阶段起进入每个小阶段 | Accepted | 不允许后端先行、最后补界面；阶段验收必须包含浏览器路径 |
| ADR-020 | 路线图只以能力门槛和小阶段顺序推进，不使用周/月排期 | Accepted | 不承诺完成日期；进度以真实任务、恢复和评测证据衡量 |

---

## 最终判断

## 最终判断

回到最初的争论：是只写控制层，把执行交给外部 Agent，还是把 runtime 和 sandbox 也全部自己写？

**产品路线应采用前者，但不是简单的“薄封装”。**

Hearth 自己写：

- 控制面；
- Durable Harness；
- 事件日志；
- 审批与幂等；
- Context Compiler 与 Token Governor；
- Memory OS；
- Evolution OS；
- Execution Gateway；
- Credential Broker；
- 任务卡、审批、产物和手机入口。

Hearth 集成：

- Codex；
- 模型 API 或本地模型；
- 容器/微虚拟机/Sandbox 内核；
- Playwright；
- 文档解析与转换库；
- 邮件、日历、云盘等官方 API。

Hearth 只为学习保留：

- 最小事件循环和 session tree；
- 上下文压缩原型；
- 单机 Sandbox 包装；
- 路由和评估实验。

这样既能深入学习 Agent Runtime、Harness、Sandbox、Gateway、Memory 和 Evolution，又不会把项目生命耗在重新实现容器、虚拟化和模型推理引擎上。

Codex 的定位也应同样清楚：

> **Codex 是 Hearth 目前最强、最通用的外部执行器之一，可以写代码，也可以做调研、长文档、报告、表格和复杂文件工作；但它并不局限于代码，也不是 Hearth 的本体。邮件、日历、网页、桌面、文档确定性处理和人类责任，分别由并列的 Connector、Browser、GUI、Document/Data 和 Human Executor 承担。**

最终，Hearth 的护城河不是“拥有一个更强的模型”，而是：

- 知道什么时候不该调用模型；
- 知道该给执行器什么最小上下文；
- 知道哪些动作必须经过谁的授权；
- 知道如何证明任务真的完成；
- 知道失败后如何恢复；
- 知道什么应该记住，什么应该遗忘；
- 知道什么时候应该停下来，把注意力还给人。

如果这些做成了，Hearth 就不只是一个 Agent 套壳，而是一台真正属于个人的、长期可靠的数字工作系统。

最后是交付判断：

> **先做出一个能在真实浏览器里每天使用的最小产品，再把它逐步长成 Personal Agent OS。**

第一阶段用原型验证产品叙事，并尽早交付 MVP；此后每个小阶段都同时交付界面、后端、验证和恢复。路线图不设开发时间限制，不以“第几周”证明进展，只以真实任务、可恢复性和用户是否愿意继续使用来证明方向正确。

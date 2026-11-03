---
title: '执行器模型与路由'
description: 'Hearth 执行器模型、能力矩阵、路由原则与多个执行器之间的协作方式。'
outline: [2, 3]
---

<p class="eyebrow">EXECUTOR MODEL</p>

# 执行器模型与路由

<p class="lead">执行器不是 Worker 列表，而是拥有明确能力、风险边界和输出契约的并列执行主体。</p>

## Executor 不是 Worker 列表

Hearth 使用并列 `Executor`，而不是把所有东西塞进一个“万能 Agent”：

- **Native Runtime**：内置通用推理与短工具循环；
- **Codex Executor**：高能力工作区执行器，覆盖代码、研究和文档；
- **Connector Executor**：邮件、日历、文档、云盘、IM、Issue Tracker；
- **Browser Executor**：网页、表单、登录态和 SaaS；
- **GUI Executor**：没有 API 的桌面应用；
- **Document/Data Executor**：解析、转换、表格、对账和确定性处理；
- **Human Executor**：审批、判断、接管和高风险责任。

同一任务可由多个执行器协作；执行器之间不共享凭据、文件和隐式上下文。

## 能力矩阵

| 能力 | Native | Codex | Connector | Browser | GUI | Document/Data | Human |
|---|---|---|---|---|---|---|---|
| 代码、测试、Issue、PR | 中 | 强 | 弱 | 弱 | 弱 | 弱 | 审查 |
| 调研与结构化研究 | 强 | 强 | 中 | 强 | 弱 | 弱 | 判断 |
| 文档生成与修改 | 中 | 强 | 中 | 中 | 中 | 强 | 验收 |
| Shell 与文件转换 | 中 | 强 | 弱 | 弱 | 中 | 强 | 否 |
| 邮件/日历 | 弱 | 弱 | 强 | 中 | 中 | 弱 | 审批 |
| 登录与表单 | 弱 | 弱 | 中 | 强 | 中 | 弱 | 接管 |
| 桌面应用 | 弱 | 弱 | 弱 | 弱 | 强 | 弱 | 接管 |
| 常驻事件 | 强 | 弱 | 强 | 弱 | 弱 | 弱 | 否 |
| 长期记忆 | 中 | 弱 | 弱 | 弱 | 弱 | 弱 | 审核 |
| 高风险副作用 | 弱 | 弱 | 强 | 强 | 强 | 弱 | 强 |

矩阵不是固定结论，必须由真实任务和失败数据更新。Codex 可接收 Connector 取回的邮件、日历和文档片段做理解、研究与草稿；真正发送、邀请、删除或发布仍由 Connector、Credential Broker 和审批链路完成。

## 路由原则

不存在“永远先用 Native，最后才用 Codex”的固定顺序。路由是带硬约束的优化：

```text
候选执行器
  → capability 匹配
  → 权限与数据驻留检查
  → 预期成功率
  → Token / 成本 / 延迟
  → 风险与可逆性惩罚
  → 选择最大化用户价值的方案
```

实用判断顺序：

1. 不需要模型：cron、规则、SQL、脚本、文件 diff、官方 API。
2. 需要外部数据或副作用：优先 Connector；没有 API 用 Browser；没有浏览器接口用 GUI。
3. 确定性文档/数据转换：Document/Data。
4. 长链路、多文件、多产物、复杂研究、代码或深度写作：Codex。
5. 高频、短、低风险、隐私敏感或低预算推理：Native + 小模型/本地模型。
6. 价值判断、责任承担或异常接管：Human。

风险、权限和数据驻留是硬约束，不能用高分抵消。

## 执行器协作

典型任务：“查找三份竞品资料，整理成对比表，写进周报，并把关键结论发邮件给团队。”

可能的链：

1. Browser 获取网页；
2. Native 提取归纳；
3. Document/Data 生成表格；
4. Codex 处理长文档、格式和引用；
5. Human 审批邮件；
6. Connector 发送并产生 Receipt；
7. Memory 记录项目背景和承诺；
8. Evolution 观察是否值得沉淀技能。

每一步有独立输入、输出、预算和验证器。

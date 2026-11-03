---
title: '控制面与自主性'
description: 'Hearth Control Plane 的 Trigger、Policy、Mandate、调度、Watchdog、注意力预算与主动循环。'
outline: [2, 3]
---

<p class="eyebrow">CONTROL PLANE</p>

# 控制面与自主性

<p class="lead">谁决定做什么、是否允许、何时打扰、何时暂停。控制面不是执行器，而是任务与授权的判断层。</p>

## Control Plane 与自主性

Control Plane 决定：

- 事件是否值得处理；
- 是否创建 Task；
- 是否需要用户审批；
- 应用哪个 Executor；
- 花多少 Token、时间和金钱；
- 何时通知、何时静默；
- 失败后重试、换路还是转人工。

它不直接调用工具，不直接持有凭据，也不直接写外部服务。

### Trigger

Trigger 是规则、订阅和条件的组合：cron、文件变化、网页变化、邮件到达、日历临近、GitHub Issue/PR、设备上线/离线、任务依赖完成、用户显式订阅和失败重试。

规则命中的可以直接创建 Ticket；只有需要语义判断时才调用小模型。Trigger 不是“让大模型一直观察一切”。

### Policy 与 Mandate

Policy 是长期规则，Mandate 是一次或一段时间的授权实例。

Mandate 至少包含：

- 允许的动作类型；
- 资源范围；
- 联系人/域名/仓库/文件夹范围；
- 风险等级；
- 预算；
- 有效期；
- 是否允许自动执行；
- 是否允许转发或委托；
- 撤销方式。

模型可以提出建议，但不能修改 Mandate、Approval 或自身 capability。

### 调度与 Watchdog

调度器负责优先级、并发上限、设备/Executor 匹配、预算、截止时间、依赖等待和公平性。

Watchdog 独立于 Agent 运行，负责：

- 卡死检测；
- 死循环检测；
- 预算超支；
- 设备失联；
- 凭据失效；
- 外部平台异常；
- 自动降级或转人工。

Watchdog 不是另一个模型，而是一组确定性监督机制。

### 自主性的正确边界

自主性不是“模型想做什么就做什么”，而是：

- 在明确 Mandate 内自主；
- 在预算内自主；
- 在可恢复/可回滚范围内自主；
- 在低风险场景中自主；
- 高风险动作始终保留人类确认。

### 注意力预算

每个任务都有注意力预算，而不只是 Token 预算：

- 最多打断次数；
- 聚合窗口；
- 静默时段；
- 默认动作；
- 升级条件；
- 用户关闭渠道后的行为。

规则：

- 能自动验证的不要求人确认；
- 能安全等待的不即时打扰；
- 能批量审批的不逐条打断；
- 每次打断必须有一个明确动作；
- 同一任务打断超过 2 次且无法下降，退回“只建议不执行”。

### 主动循环

```text
Source Event
  → Trigger / Rule
  → Small classifier
  → Task / Thread
  → Policy + Mandate
  → Budget
  → Executor
  → Verification
  → Notification / Receipt
```

主动模式与建议模式必须可独立开关，并且有对照数据。Stage 4 之前不开放真实主动循环。

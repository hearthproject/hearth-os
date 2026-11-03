---
title: '持久执行与恢复'
description: 'Hearth Durable Harness 的 Run 生命周期、任务图、lease、恢复策略、路由与 MVP 关系。'
outline: [2, 3]
---

<p class="eyebrow">DURABLE HARNESS</p>

# 持久执行与恢复

<p class="lead">长任务必须跨崩溃、休眠、网络中断和执行器失败继续存在。Durable Harness 负责把意图变成可恢复的执行。</p>

## Durable Harness

Harness 是“把一次意图变成可恢复执行”的中间层：

- 承接 Control Plane 的决策；
- 构建任务图；
- 选择执行器；
- 执行预算和 lease；
- 处理取消、重试、恢复；
- 把结果转成 Artifact、Receipt 和 Eval。

它不是模型，也不是 Sandbox。

### Run 生命周期

```text
created
  → authorized
  → queued
  → assigned
  → running
  → verifying
  → completed

异常分支：
  → paused
  → waiting_approval
  → waiting_input
  → retry_wait
  → failed
  → cancelled
  → needs_human
```

每个状态迁移必须：

- 产生事件；
- 有明确触发者；
- 有幂等条件；
- 可以从事件重放；
- 不允许原地覆盖历史。

### 任务图

支持顺序依赖、并行分支、汇合、失败传播、补偿任务、人工审批节点、跨天等待、长任务检查点和子任务预算继承。

第一阶段不引入重型工作流引擎，使用显式状态机、SQLite、outbox、定时器和 lease，加上清晰的中间产物。

### Lease 与单写者

- 每个 Ticket 同一时刻最多一个有效 Assignment；
- Executor 或设备必须持有 lease 才能推进；
- lease 过期后可重新分配；
- 重新分配必须带 fencing token，拒绝旧执行者继续写入；
- 同一 State Root 只有一个写权威；
- 设备本地状态只是缓存；
- 设备离线时任务排队，重新上线按 cursor、lease 和检查点继续；
- 设备丢失必须撤销 lease、capability 和密钥。

### 恢复策略

| 故障 | 恢复方式 |
|---|---|
| 进程崩溃 | 从 Event Log 和检查点恢复 |
| 网络中断 | 保留 outbox；恢复后按幂等键重投 |
| Executor 超时 | 保存 workspace 快照；重试或换 Executor |
| 设备离线 | 进入设备队列；不丢任务 |
| 外部结果不确定 | 标记 uncertain；先对账，不盲目重试 |
| 记忆冲突 | 保留来源；不静默覆盖 |

恢复后必须重新验证，不信任旧的自然语言“完成”。

### 路由

```text
Ticket
  → 能力匹配
  → 风险与权限检查
  → Token / 成本 / 延迟估计
  → 选择 Executor 或 Human
  → 执行
  → 验证失败？
      ├─ 同 Executor 重试
      ├─ 换更合适的 Executor
      ├─ 降级为更小范围
      └─ 人工接管
```

路由不应只由模型决定。规则、历史成功率、成本、权限和设备状态都参与。

### 边界规则

1. Control Plane 不直接执行工具。
2. Harness 不直接读取原始凭据。
3. Executor 不决定“是否允许”。
4. Execution Gateway 不决定业务意图。
5. UI 不能绕过 Policy 写数据库或触发工具。
6. 所有外部副作用经过 outbox、幂等键和 Receipt。
7. 所有 schema 变更带 migration 和兼容测试。

## 与 MVP 的关系

MVP 不需要完整实现 Gateway、Trigger、设备目录和所有恢复策略，但必须具备最小真实链路：

- Web 输入进入 Gateway → Event；
- Control Plane 创建 Task/Ticket；
- Harness 持久化 Run 和状态；
- Codex 执行并产生事件；
- 验证器决定完成；
- Web 从投影展示任务卡和恢复入口。

没有这条链路，就不是 MVP，只是前端演示或后端库。

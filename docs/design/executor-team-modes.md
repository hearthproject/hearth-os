---
title: '执行器原生团队模式（0.9.0）'
description: '一个团队开关，三种执行器各自使用原生团队能力；Hearth 只做任务宿主、能力门控与结果归集。'
outline: [2, 3]
---

# 执行器原生团队模式（0.9.0）

> 状态：已采纳并实现。本文描述 0.9.0 的契约与落点；`docs/design/agent-modes.md` 保留会话级语义的简要说明。

## 结论

保留一个用户可见的“单 Agent / 团队”开关，但把“团队”定义为**用户意图**，不是**统一实现承诺**：

- **Hearth**：Hearth 创建并管理团队，成员只读、有硬上限、事件可审计。
- **Codex**：Codex 使用自己的原生 multi-agent；Hearth 只做版本门控、配置传递和总量统计。
- **DSH**：DSH 使用自己的原生 Team；Hearth 只做团队包安装、patch 注入和会话树事件归集。

三种执行器共享同一个入口、同一套任务/产物/证据外围，但保证程度不同。产品必须把保证程度显示出来，不能用一个“团队”标签暗示三种执行器都会创建同样的成员。

## 为什么不统一编排

Hearth 已经有 `SubagentTaskManager`、事件日志、运行账本、审批和恢复链路。再建一套 Orchestrator 会产生两个事实源：成员状态与任务状态很容易对不上，执行器内部的上下文也无法被外层可靠接管。因此 0.9.0 的原则是：

1. **执行器主权**：Codex、DSH 是完整执行主体，各自负责执行循环和内部协作。
2. **Hearth 是任务宿主**：入口、上下文、工作区、产物登记、运行账本、最终结果归 Hearth。
3. **开关是意图，能力是契约**：`agentMode` 表示用户想要什么，`TeamCapability` 表示当前执行器实际能提供什么。
4. **单 Agent 必须可强制**：Hearth 和 DSH 关闭 base subagent，Codex 关闭 `multi_agent` feature；不能只靠提示词。
5. **失败要降级并解释**：能力不足时退回单 Agent，保留 `degraded` 与 `reason`，不假装团队已生效。

## 状态模型

一次运行的模式解析结果包含七个字段：

| 字段 | 取值 | 含义 |
|---|---|---|
| `requested` | `single` / `team` | 用户在会话里选了什么 |
| `effective` | `single` / `team` | Hearth 实际执行或下发的模式 |
| `executorId` | `native` / `codex` / `deepseek-harness` | 执行主体 |
| `owner` | `hearth` / `codex` / `deepseek-harness` / `none` | 谁负责组队 |
| `guarantee` | `enforced` / `native` / `prompt` / `none` | 保证强度 |
| `capability` | `available` / `unavailable` / `probe_failed` | 能力探测结果 |
| `visibility` | `members` / `session-tree` / `none` | 成员事件可见程度 |

另有 `limits`、`degraded`、`reason`。`degraded: true` 表示请求未被满足；计划模式不再强制降级，是否组队由执行器能力决定。

### 解析顺序

`resolveAgentMode(requested, executorId, { taskMode, capability })`：

1. 执行器能力为 `unavailable` / `probe_failed` 且请求 `team` → 降级 `single`，`degraded: true`，写入 `reason`。
2. 其余情况按执行器映射 owner / guarantee / visibility / limits；`taskMode: "plan"` 只影响执行器侧的只读约束，不改变 `single` / `team` 解析结果。

计划模式保留会话选择的团队策略：Hearth 只注入只读成员工具，Codex 使用只读原生多 Agent，DSH 使用只读原生 Team；写入仍由 Lead 或批准后的执行任务完成。

## 执行器差异

| 维度 | Hearth (`native`) | Codex | DSH |
|---|---|---|---|
| 组队者 | Hearth | Codex | DSH |
| 单 Agent 强制 | 不注入 `agent` 工具 | `features.multi_agent = false` | 禁用 `tool-subagent*`，不插入团队包 |
| 团队启用 | 注入只读成员工具 | `features.multi_agent = true` + `agents.max_threads/max_depth` | 插入 `agent-team` + `tool-agent-team` |
| 成员事件 | `subagent.*`，完整 roster | SDK 无 subagent 类型，`visibility: none` | `subagent.*` / 团队通知，`visibility: session-tree` |
| 用量 | `full` | `total-only` | `total-only` |
| 上限 | 4 并发 / 8 累计 / 深度 2 | 4 线程 / 深度 1 | 8 成员 / 256 任务 |
| 版本门控 | 无 | Codex ≥ `0.124.0` | SDK 与三个团队包都 = `0.2.2-rc.1` |

### Hearth

- 成员类型只暴露 `explore` / `plan` / `review`，`general-purpose` 与隔离写入成员不进入 Team v1。
- Lead 是唯一写者；成员权限只收窄，不继承 `isFullPermission`。
- 前台和后台委派都走 `SubagentTaskManager`，累计上限对两条路径同时生效。
- 达到上限后不再注入新的委派工具，Lead 自己完成剩余工作。

### Codex

- 托管版本 `0.166.0`，门槛 `0.124.0`；`team-capability.ts` 用 `--version` 探测并缓存 10 分钟。
- 配置通过 `CodexOptions.config` 递归拍平成 `--config key=value`：`features.multi_agent`、`agents.max_threads`、`agents.max_depth`。
- SDK `ThreadItem` 没有 subagent 类型，Hearth 拿不到成员事件，因此界面只显示“成员不可见”，不能用成员数推断是否组队。
- Codex 内部成员继承 Codex 权限；Hearth 不审计其成员，也不把成员写进 roster。

### DSH

- 托管 SDK 与团队包版本锁死 `0.2.2-rc.1`：
  - `@deepseek-ai/dsh-experimental-agent-team`
  - `@deepseek-ai/dsh-experimental-tool-agent-team`
  - `@deepseek-ai/dsh-experimental-agent-team-profile`
- 团队包缺失时能力为 `unavailable`，修复动作是 `install-team-runtime`；SDK 版本不一致时是 `update-executor`。
- 安装团队包复用同一 runtime 前缀，但 `allowReset: false`：失败重试不能删掉已装 SDK。
- patch 在 `agentTeam` 传入时先禁用 `tool-subagent-control` / `tool-subagent` / `tool-subagent-fork`，再按需 `insert` `agent-team` 与 `tool-agent-team`；省略 `ui-agent-team`（Hearth 有自己的 roster）。
- 团队配置：`maxMembers: 8`、`maxTasks: 256`、`maxMessageBytes: 65536`、`disposalTimeoutMs: 5000`、`freshProvider: spawn`、`forkProvider: fork`。
- 通知先映射团队事件，再处理 `session.event` 内的 subagent；root session 的心跳不算成员。

## 证据与可解释性

`agent.mode` 在运行前写一条（请求与解析），运行后再写一条（实际结果）。最后一条包含：

```json
{
  "final": true,
  "requested": "team",
  "effective": "team",
  "owner": "deepseek-harness",
  "configApplied": true,
  "degraded": false,
  "observed": { "members": 3, "eventsReceived": true, "source": "deepseek-harness" },
  "usage": "total-only"
}
```

- `configApplied` 表示配置/工具是否真的已下发，不是“代码里支持”。
- `observed.members` 来自实际事件，不从 `requested` 推断。
- 异常路径也写最终事件，带 `failedBeforeOutcome: true`，避免证据只记录成功。
- `run-evidence.json` 的 `agentMode` 取最后一条 `agent.mode`，导出时能区分“想要团队”和“实际发生了什么”。

## 事件与界面

| 事件 | 作用 |
|---|---|
| `agent.mode` | 运行前解析 + 运行后实际结果 |
| `subagent.delegated` | 成员开始，携带 `source` / `parentId` / `depth` |
| `subagent.completed` / `subagent.blocked` / `subagent.failed` | 成员结束，携带状态、耗时、用量、摘要、结构化回执 |
| `subagent.completed`（Codex/DSH） | 外部执行器回传的成员事件，`source` 标明来源 |

界面从事件流派生 roster：

- 按 `source` 分组：`Hearth 成员` / `Codex 内部成员` / `DSH 成员`。
- 团队已启用但未收到成员事件时显示空态：Hearth 说明“未创建成员”，DSH 说明“尚未收到事件”，Codex 说明“成员不可见”。
- `blocked` 与 `failed` 分开展示；`depth > 1` 缩进。
- 执行器选择旁的模式按钮显示 owner：`团队 · Hearth 编排` / `Codex 原生` / `DSH 原生`。
- 能力不可用时按钮带 `unavailable`，note 提供“安装团队运行时”或“更新执行器”。

## 回执与计划步骤

成员默认返回 canonical JSON 回执：

```json
{
  "status": "completed | blocked | failed",
  "summary": "能脱离父上下文独立阅读的结论",
  "evidence": [{ "claim": "结论", "source": "文件:行号 / 命令 / URL", "detail": "可选" }],
  "artifacts": ["产物路径"],
  "unresolved": ["需要 Lead 继续处理的问题"]
}
```

`status: "blocked"` 必须写进 `subagent.blocked`、`report.json` 和界面，不能被当成 completed：

- 只有 `completed` 才 `completePlanStep`。
- `blocked` / `failed` 只 `notePlanStep`，计划步骤保持可恢复。
- 取消（`signal.aborted`）写 `cancelled`，不写 failed。
- 进程重启后 manager 把 running 标 lost，并在下一次读取时补发一次 `subagent.failed`，避免界面永远转圈。

回执不是完成证明。任务是否完成仍由验证器、期望产物和审批/回执链路决定。

## 版本门控与失败处理

| 情况 | 表现 | 修复 |
|---|---|---|
| Codex 版本 < 0.124.0 | 能力 `unavailable`，团队降级 single | 更新执行器 |
| Codex `--version` 解析失败 | `probe_failed`，团队降级 single | 重试探测或检查安装 |
| DSH 团队包缺失 | `unavailable`，团队降级 single | `POST /api/executors/deepseek-harness/team-runtime` |
| DSH SDK 版本不一致 | `unavailable`，`repair: update-executor` | 更新执行器 |
| Codex 配置被 CLI 拒绝 | 运行失败，最终 `agent.mode` 记录 `configApplied` 与错误 | 查看运行证据 |

能力探测缓存 60 秒；执行器设置变更和 bootstrap 会清缓存，避免设置页显示旧状态。

## 非目标

- 不新建第二套 Orchestrator 或消息总线。
- 不伪造 Codex/DSH 的成员事件，不把 `total-only` 用量拆成假成员账单。
- 不暴露写入型成员，不做自动合并。
- 不让成员继承 `isFullPermission`；成员权限只收窄，不扩张。
- 不用团队模式替代审批、对账或完成验证。

## 落点

| 文件 | 职责 |
|---|---|
| `apps/server/src/agent-mode.ts` | 模式解析、提示词、回执 schema |
| `apps/server/src/team-capability.ts` | 版本探测、能力缓存、修复动作 |
| `apps/server/src/executor-installer.ts` | DSH 团队包安装与状态 |
| `packages/codex-executor/src/executor.ts` | Codex multi-agent 配置 |
| `packages/deepseek-executor/src/index.ts` | DSH patch 与成员事件映射 |
| `apps/server/src/executor-adapter.ts` | 三种执行器的团队结果 |
| `apps/server/src/scheduler.ts` | 解析、事件、证据、降级 |
| `apps/server/src/subagents.ts` / `subagent-manager.ts` | 回执状态、计划步骤、lost 补发 |
| `apps/web/src/components/AgentRoster.tsx` | 分组、空态、blocked |
| `apps/web/src/components/ExecutorSettingsPanel.tsx` | 能力徽章与团队运行时安装 |

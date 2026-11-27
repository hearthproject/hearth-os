---
title: '单 Agent 与团队模式'
description: '会话级 agentMode 的语义、执行器能力差异、证据与回执。'
outline: [2]
---

# 单 Agent 与团队模式

<p class="lead">Hearth 不维护第二套 Agent Runtime。单 Agent 与团队模式只是在同一条任务链路上加了一层会话级开关：谁负责组队、谁负责写入、成员做到什么程度、证据落在哪里。完整契约见 <a href="./executor-team-modes.md">执行器原生团队模式</a>。</p>

## 为什么是薄层

Hearth 已经有 `SubagentTaskManager`、事件日志、运行账本、审批和恢复链路。再建一套编排器会产生两个事实源，成员状态与任务状态很容易对不上。

因此 `agentMode` 只影响提示词、工具面、执行器配置和证据目录；任务、运行、审批、恢复仍由现有调度器负责。团队模式失败时可以退回普通重试、交接或用户接管，不需要额外的编排状态机。

## 会话级语义

`ConversationSettings.agentMode` 取 `single` 或 `team`，默认 `single`。它只属于会话，不写进任务记录；断线重连、切换会话后仍按会话设置恢复。

| 请求模式 | Hearth | Codex | DSH |
|---|---|---|---|
| `single` | 不注入 `agent` 工具 | `multi_agent = false` | 禁用 base subagent，不插团队包 |
| `team` | Hearth 编排只读成员 | 原生 multi-agent，成员不可见 | 原生 Team，会话树可见 |
| 计划模式 | 强制 `single` | 强制 `single` | 强制 `single` |

`team` 不是“所有执行器都开同样团队”。三种执行器的保证强度不同，界面按 `owner` 显示“Hearth 编排 / Codex 原生 / DSH 原生”。能力不足时降级为单 Agent，并显示原因。

## 执行器能力

| 维度 | Hearth | Codex | DSH |
|---|---|---|---|
| 单 Agent 强制 | 工具面 | feature flag | 禁用 subagent 工具 |
| 团队启用 | 只读成员 | `features.multi_agent` | `agent-team` 包 |
| 成员可见 | 完整事件 | 否 | 会话树事件 |
| 用量 | 完整 | 仅总量 | 仅总量 |
| 版本门控 | 无 | ≥ 0.124.0 | SDK/包 = 0.2.2-rc.1 |

能力探测与修复动作落在 `team-capability.ts`；DSH 团队包由设置页的“安装团队运行时”按钮安装。

## Team v1 的只读边界

团队模式只有一个写者：Lead。成员只做调查、方案和审查，不能写工作区。

| 类型 | 用途 | 写入 |
|---|---|---|
| `explore` | 找文件、读代码、查资料、定位事实 | 否 |
| `plan` | 给出实现步骤、风险与验证方案 | 否 |
| `review` | 审查 Lead 的产物、找漏洞与回归风险 | 否 |

`general-purpose` 与隔离写入型成员在本版不暴露给 Lead。成员可以再委派一层只读成员（root → L1 → L2），L2 不再获得委派工具。

## 硬上限

| 限制 | 值 | 落点 |
|---|---|---|
| Hearth 单次并发成员 | 4 | `SubagentTaskManager` 与工具参数 |
| Hearth 单任务累计成员 | 8 | 事件计数 + manager 容量 |
| Hearth 委派深度 | 2 | 运行时 `agent` 工具 |
| Codex 线程 | 4 | `agents.max_threads` |
| Codex 深度 | 1 | `agents.max_depth` |
| DSH 成员 | 8 | `agent-team.maxMembers` |

前台和后台委派都走同一个 `SubagentTaskManager`；达到上限后不再注入新的委派工具。

## 结构化回执

每个成员默认收到 canonical JSON Schema：

```json
{
  "status": "completed | blocked | failed",
  "summary": "能脱离父上下文独立阅读的结论",
  "evidence": [{ "claim": "结论", "source": "文件:行号 / 命令 / URL", "detail": "可选" }],
  "artifacts": ["产物路径"],
  "unresolved": ["需要 Lead 继续处理的问题"]
}
```

`blocked` 是真实状态：写 `subagent.blocked`、`report.json` 和界面，不完成计划步骤。只有 `completed` 才 `completePlanStep`；`failed` / `blocked` 只写 note，保留恢复空间。

回执不是完成证明。任务是否完成仍由验证器、期望产物和审批/回执链路决定。

## 证据目录

团队证据固定在任务根下：

```text
<taskRoot>/.hearth/agents/<childId>/
  transcript.jsonl
  checkpoint.json
  journal.jsonl
  report.json
  out/
```

运行级 `run-evidence.json` 的 `agentMode` 取最后一条 `agent.mode`：

```json
{
  "requested": "team",
  "effective": "team",
  "executorId": "deepseek-harness",
  "owner": "deepseek-harness",
  "configApplied": true,
  "observed": { "members": 3, "eventsReceived": true, "source": "deepseek-harness" },
  "usage": "total-only"
}
```

`observed` 来自实际事件，不从请求推断；异常路径也会写最终事件，带 `failedBeforeOutcome: true`。

## 事件与界面

| 事件 | 作用 |
|---|---|
| `agent.mode` | 运行前解析 + 运行后实际结果 |
| `subagent.delegated` | 成员开始，携带 `source` / `parentId` / `depth` |
| `subagent.completed` / `subagent.blocked` / `subagent.failed` | 成员结束，携带状态、耗时、用量、摘要、结构化回执 |

界面从事件流派生 roster，按 `source` 分组；团队已启用但无成员时显示空态。Codex 成员不可见，只显示总量统计，不能用成员数推断是否组队。

## 计划步骤联动

`agent` 工具支持可选 `stepId`：

- 开始：步骤置为 `in_progress`，owner 记为成员 childId；
- 完成：步骤置为 `completed`，可附 note；
- `blocked` / `failed`：只写 note，不把步骤改成失败态。

成员失败不等于计划步骤失败，Lead 可能重试、换人或自己补做。

## 非目标

- 不新建第二套 Orchestrator 或消息总线。
- 不伪造外部队员事件，不把总量用量拆成假成员账单。
- 不暴露写入型成员，不做自动合并。
- 不让成员继承 `isFullPermission`；成员权限只收窄，不扩张。
- 不用团队模式替代审批、对账或完成验证。

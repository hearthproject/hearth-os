---
title: '单 Agent 与团队模式'
description: '会话级 agentMode 的语义、团队边界、证据与回执，以及执行器差异。'
outline: [2]
---

# 单 Agent 与团队模式

<p class="lead">Hearth 不维护第二套 Agent Runtime。单 Agent 与团队模式只是在同一条任务链路上加了一层会话级开关：谁负责写入、谁可以被委派、成员做到什么程度、证据落在哪里。</p>

## 为什么是薄层

调研里常见的做法是新增一个 Orchestrator：单独维护成员列表、消息总线、任务图和合并流程。Hearth 已经有 `SubagentTaskManager`、事件日志、运行账本、审批和恢复链路；再建一套编排器会带来两个事实源，成员状态与任务状态很容易对不上。

因此 v1 的选择是：`agentMode` 只影响提示词、工具面和证据目录，任务、运行、审批、恢复仍由现有调度器负责。团队模式失败时可以退回普通重试、交接或用户接管，不需要额外的编排状态机。

## 会话级语义

`ConversationSettings.agentMode` 取 `single` 或 `team`，默认 `single`。它只属于会话，不写进任务记录；断线重连、切换会话后仍按会话设置恢复。

| 请求模式 | Native | Codex / DeepSeek Harness |
|---|---|---|
| `single` | Hearth 单 Agent 执行，不注入委派工具 | 标记为 `executor-managed`，由执行器自行决定 |
| `team` | Hearth 作为 Lead 编排只读成员 | 标记为 `executor-managed`，Hearth 不编排、不审计 |

`team` 不是“所有执行器都开多 Agent”。非 Native 执行器有自己的内部子代理能力，Hearth 不会硬改它们的协议，也不会声称自己创建了团队；界面会明确提示“该执行器自行管理多 agent，Hearth 编排仅对 Native 生效”。

## Team v1 的只读边界

团队模式只有一个写者：Lead。成员只做调查、方案和审查，不能写工作区。

| 类型 | 用途 | 写入 |
|---|---|---|
| `explore` | 找文件、读代码、查资料、定位事实 | 否 |
| `plan` | 给出实现步骤、风险与验证方案 | 否 |
| `review` | 审查 Lead 的产物、找漏洞与回归风险 | 否 |

`general-purpose` 与隔离写入型成员在本版不暴露给 Lead。原因是缺少稳定的集成/合并路径：多个写入者的分支、冲突和最终验证都需要额外协议，v1 不把复杂度伪装成能力。

成员也可以再委派一层只读成员（root → L1 → L2）。L2 成员不再获得委派工具；写死深度上限 2 是为了给后续扩展留下协议位，但 Team v1 建议把大多数任务控制在一层，避免为了并行而并行。

## 硬上限

| 限制 | 值 | 落点 |
|---|---|---|
| 单次并发成员 | 4 | `SubagentTaskManager` 与工具参数 |
| 单任务累计成员 | 8 | 事件计数 + manager 容量 |
| 委派深度 | 2 | 运行时 `agent` 工具 |
| 单轮工具并发 | 4 | Native Runtime `maxParallelTools` |

前台和后台委派都走同一个 `SubagentTaskManager`。此前前台委派可以绕过 manager，导致 `maxTotal` 只约束后台任务；现在两条路径共用容量，累计上限才真正生效。

达到上限后不再注入新的委派工具，Lead 只能自己完成剩余工作，避免“为了并行而并行”。

## 结构化回执

每个成员默认收到一份 canonical JSON Schema：

```json
{
  "status": "completed | blocked | failed",
  "summary": "能脱离父上下文独立阅读的结论",
  "evidence": [{ "claim": "结论", "source": "文件:行号 / 命令 / URL", "detail": "可选" }],
  "artifacts": ["产物路径"],
  "unresolved": ["需要 Lead 继续处理的问题"]
}
```

Lead 可以在单次委派里覆盖 schema，但默认契约保证回执至少包含状态、摘要和证据。调度器把回执写进 `report.json`，界面显示摘要、证据路径和未决项；Lead 必须核对 evidence 才能采用成员结论。

回执不是完成证明。任务是否完成仍由现有验证器、期望产物和审批/回执链路决定。

## 证据目录

团队证据不再散落在临时目录，而是固定在任务根下：

```text
<taskRoot>/.hearth/agents/<childId>/
  transcript.jsonl
  checkpoint.json
  journal.jsonl
  report.json
  out/
```

每个成员有独立 `out/`，避免多个成员同时写 `executing.json` 或覆盖彼此产物。只读成员的输出仍留在自己的 agent 目录，不进入父任务的发布产物。

运行级 `run-evidence.json` 增加 `agentMode`：

```json
{
  "requested": "single | team",
  "effective": "single | team | executor-managed",
  "executorId": "native"
}
```

这样导出证据时能区分“用户想要团队模式”和“实际由谁编排”。

## 事件与界面

新增三类事件：

| 事件 | 作用 |
|---|---|
| `agent.mode` | 记录本次运行请求/生效模式与执行器 |
| `subagent.delegated` | 成员开始，携带 childId、类型、标题、模式 |
| `subagent.completed` / `subagent.failed` | 成员结束，携带状态、耗时、用量、摘要、报告路径 |

界面从事件流派生 roster，不另存成员状态。执行器选择旁有“单 Agent / 团队”开关；`InlineRun` 在待办清单后显示成员行，包含状态、类型、标题、耗时、token、摘要与报告路径。

## 计划步骤联动

`agent` 工具新增可选 `stepId`。Lead 委派时如果对应计划步骤存在：

- 开始：步骤置为 `in_progress`，owner 记为成员 childId；
- 成功：步骤置为 `completed`，可附 note；
- 失败：只写 note，不把步骤改成失败态。

失败不改状态是刻意选择：成员失败不等于计划步骤失败，Lead 可能重试、换人或自己补做；把步骤直接判死会让计划失去恢复空间。

## 非目标

- 不新建第二套 Orchestrator 或消息总线。
- 不改 Codex 的 `multi_agent` 配置，不挂 DeepSeek Harness Team。
- 不暴露写入型成员，不做自动合并。
- 不让成员继承 `isFullPermission`；成员权限只收窄，不扩张。
- 不用团队模式替代审批、对账或完成验证。

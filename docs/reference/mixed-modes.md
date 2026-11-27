# 混合模式与执行器矩阵

Hearth 的组合空间有三个执行器、三种工作流和两档 Agent 模式。这里的“工作流”指普通构建、计划、目标；“Agent 模式”指单 Agent 或团队。

## 3 × 2 × 3 主矩阵

| 执行器 | 工作流 | 单 Agent | 团队 |
|---|---|---|---|
| Hearth / `native` | 构建 | 支持 | 支持托管团队 |
| Hearth / `native` | 计划 | 支持只读调查 | 支持只读托管团队，Lead 仍唯一写入者 |
| Hearth / `native` | 目标 | 支持 | 支持托管团队 |
| Codex / `codex` | 构建 | 支持 | 支持原生多 Agent（需 ≥ 0.124） |
| Codex / `codex` | 计划 | 支持只读沙箱 | 支持只读原生多 Agent |
| Codex / `codex` | 目标 | 支持 | 支持原生多 Agent |
| DSH / `deepseek-harness` | 构建 | 支持 | 支持原生团队（需团队运行时） |
| DSH / `deepseek-harness` | 计划 | 支持只读沙箱 | 支持只读原生团队 |
| DSH / `deepseek-harness` | 目标 | 支持 | 支持原生团队 |

当执行器团队能力探测为 `unavailable` 或 `probe_failed` 时，团队请求会明确降级为单 Agent 并记录原因，不会伪装成团队成功。

## Plan 与执行分开选执行器

计划先由 `planningExecutorId` 执行只读调查；批准时可以用 `executorId` 指定真正执行构建的执行器，`planningExecutorId` 保持不变。

| 规划执行器 \ 执行执行器 | Hearth | Codex | DSH |
|---|---|---|---|
| Hearth | 支持 | 支持 | 支持 |
| Codex | 支持 | 支持 | 支持 |
| DSH | 支持 | 支持 | 支持 |

## Goal 跨轮切换执行器

目标在每一轮之间可以切换执行器；当前轮结束后才允许切换，旧轮迟到结果会被执行围栏拒绝。

| 起始执行器 \ 下一轮执行器 | Hearth | Codex | DSH |
|---|---|---|---|
| Hearth | 支持 | 支持 | 支持 |
| Codex | 支持 | 支持 | 支持 |
| DSH | 支持 | 支持 | 支持 |

## 明确拒绝的组合

- 计划 + 目标同一轮开启：返回 `MODE_CONFLICT`。
- 会话已有未结束计划时开启目标：返回 `GOAL_PLAN_CONFLICT`。
- 会话已有未结束目标时开启计划：返回 `PLAN_GOAL_CONFLICT`。
- 团队开关在计划、构建、目标中都可以保留；团队不可用时按能力降级，不会静默改变工作流。

## 代码契约

- `PlanRecord.planningExecutorId` 记录规划执行器；缺省时回落到执行配置的执行器。
- `POST /api/plans/:id/actions` 的 `approve` 可携带 `executorId`，只改执行执行器，不改规划执行器。
- 计划任务的 `mode` 固定为 `plan`，执行任务固定为 `build`；两者使用不同工作目录。
- 原生计划工具允许只读调查和只读团队成员控制工具，不允许 `write_file`、`apply_patch`、`finish_task` 等写入或结束工具。
- Codex 计划始终使用 `read-only` 沙箱且关闭网络；DSH 计划始终使用 `read-only` 权限和 `planMode`。
- 目标与计划互斥在 Chat 入口和 `/api/plans`、`/api/goals` 入口同时校验。

## 验证入口

```bash
npx vitest run apps/server/src/mode-matrix.test.ts
npx vitest run apps/server/src/chat-routes.test.ts apps/server/src/plans.test.ts apps/server/src/goals.test.ts
npm run typecheck
```

`mode-matrix.test.ts` 覆盖 18 个主组合、9 个 Plan 执行器切换组合和 9 个 Goal 跨轮切换组合；外部执行器的团队/只读参数由假 Runner 验证。

## Live 验收记录

2026-11-27 在本机用真实二进制和真实模型补做了以下验收：

- Codex SDK `0.166.0` / CLI `0.163.0`：`read-only` + 关闭网络 + `features.multi_agent=true` 下真实模型通过 `spawn_agent` 启动一个子线程；子线程在只读沙箱内统计 README 行数，经 `wait` 回传 `TEAM_CHILD_OK 3`，整轮约 25 秒，主/子会话均无写操作。
- DSH 托管 SDK `0.2.2-rc.1`：Plan + Team 跑通，返回可提交的计划正文；Build + Team 跑通，`explore` 队友完成调查并通过 `onTeamMember` 回调上报。
- DSH 连续两次真实调用均成功；每次调用前会清理上一个已退出进程留下的 `.credentials.yaml.lock*`，避免下一次初始化把预算耗在死锁抢占上。
- 仍建议在发布前从 UI 走一遍 Codex / DSH 的 Plan → 改执行执行器 → 批准，以及 Goal 跨轮换执行器的完整点击链路；本记录是执行器层 live 验收，不替代浏览器 E2E。

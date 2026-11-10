# Hearth 第一阶段评测任务

状态：已批准（2026-11-05）。按本目录任务进入执行。

本目录是第一阶段 MVP 的固定验收基线。MVP 不要求覆盖所有职业或所有工作，但必须在这 15 个具体任务中至少通过 10 个，并证明任务创建、执行、审批、产物保存和失败恢复使用同一套机制。

## 目录

- `mvp-task-catalog.md`：15 个任务、公共验收基线 G1–G9、专项验收标准和评分表。
- `inputs/`：每个任务的固定输入、来源 URL、GitHub 对象和原始数据。
- `runs/`：执行产物目录；每次执行写入 `runs/<任务 ID>/`，不得覆盖原始输入。验收产物纳入版本控制，用于复核和审计。

## 运行约定

1. 从 `mvp-task-catalog.md` 选择任务，先创建可持久化的任务记录，再开始执行。
2. 输入只读；输出只写入该任务指定的 `eval/runs/<任务 ID>/` 路径。
3. 任务状态必须覆盖排队、执行中、等待输入、等待审批、完成、失败、恢复和取消，并能在刷新或服务重启后重建。
4. 外部写入、发送、推送、发布和评论必须先展示影响并取得审批；审批绑定真实参数，只执行一次。
5. 信息不足、来源不可达或解析失败时必须明确失败或标记未知，不得编造内容。
6. 单项任务只有在公共基线 G1–G9 和专项标准全部满足时才计为通过。

## GitHub 对象

- T07 的真实 Issue：[JasonBuildAI/GoldMind#16](https://github.com/JasonBuildAI/GoldMind/issues/16)
- T08 的评审对象：[JasonBuildAI/GoldMind#15](https://github.com/JasonBuildAI/GoldMind/pull/15)
- T09 的复现对象：[JasonBuildAI/GoldMind#14](https://github.com/JasonBuildAI/GoldMind/pull/14)

当前只读检查可以使用 GitHub API。T07 推送分支或创建 PR、T08 发布评审评论之前，必须单独取得用户审批；不得自动合并、关闭 PR 或修改无关代码。

## 验收记录

每次执行至少记录：任务 ID、输入版本、开始和结束时间、状态迁移、人工耗时、产物路径、外部副作用、失败原因、恢复方式，以及最终“通过/失败/阻塞”结论。最终报告依据 `mvp-task-catalog.md` 的评分表汇总，硬门槛为至少 10/15。

## 第一阶段验收结果

验收日期：2026-11-05。15 项任务均已创建并执行；T01–T06、T09–T15 共 13 项完成并通过验收，已达到至少 10/15 的硬门槛。T08 产物已完成，但发布 PR #15 评论仍在等待用户批准；T07 因存在未提交测试文件未通过交付校验，按用户指示暂停重试，未推送分支或创建 PR。逐项证据、T07/T08 的边界和运行方式见 [`phase-1-acceptance.md`](./phase-1-acceptance.md)。

## 个人 Agent 场景回归（5.11）

`eval/scenarios/scenarios.json` 定义 30 个本地可重复场景，覆盖审批、动作绑定、效果对账、目标完成、崩溃恢复、记忆、技能、主动提醒、调度、连接一致性，以及 Personal Agent 专项的歧义指代、跨会话恢复、陈旧状态、来源冲突、注意力预算、本体遗忘、提示注入、四周连续性、任务图汇聚和异步工具中断。每个场景默认重复 3 次，用于观察通过率、中位数和离散度，而不是用单次演示下结论。

运行全部场景：

```powershell
npm run eval:scenarios
```

只运行指定场景，便于复现单个失败：

```powershell
npx tsx apps/server/src/scenarios/run-scenarios.ts --only approval-rejected-stops,unknown-effect-reconcile
```

场景使用 `HearthStore(":memory:")` 或临时 SQLite / 临时目录、假用户、假偏好、假秘密和可控时钟；不读取或修改真实账户与真实 `.hearth` 数据。P0 机制均有故障注入覆盖：

- `action_resolver`：审批拒绝、动作绑定篡改、非交互高危拒绝；
- `effect_outbox`：重复发送、未知效果对账；
- `goal_judge`：删除产物或篡改字段后拒绝完成；
- `failure_recovery`：崩溃后从已证明检查点继续；
- `sensitive_info`：秘密不进入日志、通知或模型上下文。

每次运行的产物写入：

- `eval/scenario-runs/<timestamp>/report.json`：逐次断言、机制汇总、通过率、中位数和离散度；
- `eval/scenario-runs/<timestamp>/summary.md`：人类可读摘要；
- `eval/scenario-runs/<timestamp>/<scenario>/run-N/evidence.json`：单次运行的输入、断言和证据。

任一场景失败时命令以非零状态退出。`eval/scenario-runs/` 是生成物，不纳入版本控制。2026-11-10 在本地隔离环境运行完整场景包，30 个场景共 90 次运行全部通过；这只证明当前代码路径和故障边界，不替代真实模型、真实设备、真实账户和长期运行验收。

# Hearth 0.5.0 人类可执行计划（工程师版）

## 目的

这份计划记录 Hearth 0.5.0 的实现与验证方式，供工程师复核。它覆盖：会话级 Plan 模式、输入框上方重复状态条修复、Agent 自主搜索并安装 Skill、移除 Hearth 自身的预算/轮次/时间/调用次数/文件产物与权限上限，以及可维护的提示词系统。

这个问题机制同时适用于普通对话与 Plan 模式。普通对话创建的是 `mode: "build"` 任务，直接走同一套执行契约；Plan 模式创建的是 `mode: "plan"` 规划任务，只读调查后生成计划，批准后再创建新的 `mode: "build"` 执行任务。两条路径共享同一套任务、调度、权限、提示词和 Skill 工具，不存在“聊天里能用、计划里不能用”的分叉。

## 设计

### 1. Plan 领域模型与持久化

- `packages/core/src/types.ts` 增加 `TaskMode`、`CollaborationMode`、`PlanRecord`、`PlanView`、`PlanStage`、`PlanActionName`、`PlanExecutionProfile`，并给 `TaskRecord` 增加 `mode` 与 `planId`。
- `packages/core/src/plan-state.ts` 定义 `planning → awaiting_approval → executing → completed/failed/cancelled` 状态机、动作阶段约束、版本递增和 `PlanStateError`。
- Eventlog schema 升到 42：`tasks` 增加 `mode`、`plan_id`，新增 `plans` 表；所有迁移只加列/加表。
- `PlanService` 负责创建计划、绑定规划任务、继续规划、批准后创建执行任务、完成/失败/重试/重规划/取消，以及启动恢复。

### 2. 调度与只读边界

- 规划任务强制 native，`mode: "plan"`；工具面只保留读文件、列目录、搜索、只读 shell、`fetch_url`、`ask_user`、`submit_plan` 等。
- 只读命令限制在 `git status/diff/log`、列目录、读取、查看版本；`submit_plan` 是唯一写入例外，只写 `.hearth/plans/*.md`。
- `submit_plan` 返回 `action: "plan"` 和真实计划路径；调度器捕获后把 Plan 置为 `awaiting_approval`。
- 用户批准后创建新的 `mode: "build"` 任务，注入原目标 + 已批准计划正文 + 执行协议；计划进入 `executing`。
- 执行失败可 retry，重规划回到只读 planning；取消会结束计划并关闭规划/执行任务。
- 重启时 `executing` 回到 `awaiting_approval`，旧执行任务取消；不会自动执行未批准计划。

### 3. 聊天与 Web 界面

- `ChatPage` 删除输入框上方仅因 `isWorking` 就渲染的“Hearth 正在执行任务 / 可继续输入并排队”状态条及其 CSS。
- 会话设置增加 `collaborationMode`；聊天请求支持 `planMode`、`planId`。
- 新计划以 plan mode 创建规划任务；已有 planning/awaiting_approval 计划时，继续消息复用同一规划任务，不新建任务。
- 新增计划栏和计划对话框，展示阶段、版本、正文、批准/重试/重规划/退出；支持 `/plan`、`/plan status|approve|cancel|replan|retry`、输入框计划按钮和 Shift+Tab。

### 4. Skill 自主闭环

- `search_skills` 先查已安装技能，再用 GitHub Search API 找包含 `SKILL.md` 的仓库，返回仓库、树路径、默认分支。
- `install_skill` 接受 GitHub URL、本地目录或名称；名称会先发现候选，再按顺序安装，最多尝试 5 个。
- 技能意图强制路由为 native task，任何普通任务都注入 Skill 工具；Agent 不再要求用户提供仓库地址。
- 未找到候选时明确报告失败和已尝试来源，不把“请提供地址”当默认下一步。

### 5. 完全访问与移除产品级上限

- 任务创建统一写入 `fullAccess: true`、`approvalMode: "full"`、`networkMode: "open"`、`danger-full-access`；显式传入的 read-only 也会被归一化。
- native full permission 注入全部内置工具 + 额外工具，读写根包含系统根目录，网络全开；`authorizeNativeTool` 在 full 下无条件放行，GitHub/评论类动作不再要求审批。
- Codex 在 full 下强制 `networkAccessEnabled`；DeepSeek Harness 继承 full。
- 执行 profile、`withBudgetDefaults`、`scheduler.effectiveBudget` 返回空预算；Goal 不写/不执行 `budget`、`deadline`、`maxRounds`；重启保留进行中目标的 `armed` 并继续。
- 保留的只有进程崩溃恢复、单次工具调用的物理超时（返回错误而不终止任务）、用户主动暂停/取消、用于审计的操作账本。

### 6. Prompt Registry 与结果契约

- `packages/agent-runtime/src/prompts.ts` 提供可注册、可移除、按 priority 组合的 `PromptRegistry`。
- 任务提示词拆分为 identity、autonomy、investigation、skills、completion、task、goal、profile、extensions 九段；Skill 路由和完成要求各自独立。
- 自主执行契约明确：默认已授权、直接完成、不问“是否继续”、失败先诊断重试、没有产品级预算/权限限制、只在最后返回结果、不为了形式生成 `result.md`。
- 任务提示词不再强制输出目录/行数/`result.md`；`finish_task` 仍负责提交最终结果。普通文档任务与 Plan 规划任务使用同一套规则，Plan 额外受只读工具面约束。

## 测试

### 单元与服务测试

- `packages/core/src/plan-state.test.ts`：状态转换、动作阶段约束、终止状态、版本递增。
- `apps/server/src/plans.test.ts`：创建规划任务、计划正文持久化、批准生成 build 任务、完成、失败重试、重启恢复、继续规划复用任务。
- `apps/server/src/app.test.ts`：`POST/GET /api/plans`、非法批准 409、取消、列表过滤。
- `packages/agent-runtime/src/prompts.test.ts`：注册表排序/替换/移除、执行契约、Skill 路由、任务上下文组合。
- `apps/server/src/skill-tools.test.ts`：已安装技能命中、GitHub 仓库发现、按名称安装第一候选。
- 既有 `goal-state/goals/goal-verifier/scheduler/service/workspace/task-intent/native-executor/app` 测试更新为无预算、无审批、重启继续、无强制 `result.md` 的新行为。

### 全量门禁

1. `npm run typecheck`：0 error。
2. `npm test`：全绿。
3. `npm run build`：通过。
4. `npm run docs:build`：通过，Plan 文档与侧边栏无死链。
5. `npm run version:check`：根、workspace、Cargo.toml、tauri.conf.json、lockfile 均为 0.5.0。

### 手动验收

- 普通对话：输入“下载 grill-me 技能”，任务应自行搜索 GitHub、安装并返回结果，不要求用户提供仓库地址。
- Plan 模式：`Shift+Tab` 或 `/plan <目标>` 创建计划；规划阶段不改工作区；计划栏显示待批准；批准后才创建执行任务。
- 重启：执行中的计划回到待批准，不会自动执行；进行中的目标保留并继续。
- 状态条：输入框上方不再出现“Hearth 正在执行任务 / 可继续输入并排队”。

## 提交

- 全部改动在 `main` 上完成，不建 feature branch。
- 英文 Conventional Commits；实现、测试、文档和版本随对应 commit 提交。
- 只按明确路径暂存本次改动，排除工作区已有的无关文件。
- 推送 `https://github.com/hearthproject/hearth-os.git` 的 `main`。

# Hearth 第一阶段验收报告

- 验收日期：2026-11-05
- 验收范围：第一阶段 MVP、15 个跨行业真实任务、原生 Codex 执行器、TS + React 本机控制面
- 结论：**达到第一阶段硬门槛。15 项任务均已创建并执行；T01–T06、T09–T15 共 13 项完成并通过验收；T08 产物通过、等待用户批准外部评论；T07 未通过，按用户指示不再重试。**

第一阶段要求至少 10/15 项通过。当前有 13 项无外部审批依赖的完成记录，已达到门槛；T08 和 T07 不用于凑数。

## 运行环境与执行器

- 操作系统：Windows，PowerShell
- Node.js：`v26.11.1`
- npm：`11.20.0`
- 控制面：Fastify + TypeScript；前端：React + Vite；本机地址：`http://127.0.0.1:4317`
- Codex CLI 登录状态：`Not logged in`
- 实际执行器配置：`OpenDesign / deepseek-v4.1-flash`
- 认证来源：`provider-env`，密钥由启动 Hearth 的终端环境提供，不写入浏览器
- 健康检查：`GET /api/health` 返回 `canRun: true`、`authSource: "provider-env"`、`issues: []`

因此，**不需要先执行 `codex login`**。只要 `~/.codex/config.toml` 配置了 `model_provider` 和对应的 `env_key`，并且启动 Hearth 的终端存在该环境变量，Codex 就能作为原生执行器运行。设置页会显示 Provider、模型和认证来源。

## 验收方法

每项任务使用固定输入和固定输出目录，经过“创建任务 → 排队/执行 → 生成产物 → 保存运行清单 → 用户核对 / 外部动作审批”的同一套机制：

1. 任务记录保存目标、输入来源、输出目录、状态、当前运行和下一步动作。
2. 执行器使用隔离工作区；原始输入只读，产物写入 `eval/runs/<任务 ID>/`。
3. 运行清单记录任务 ID、运行 ID、输入 SHA-256、期望产物、实际产物 SHA-256、执行器配置和生成时间。
4. 外部写入（GitHub 推送、创建 PR、发布评论）不会自动执行，必须先生成预览并等待用户批准。
5. SQLite 事件日志持久化任务、运行、审批、效果和产物；刷新页面或重启服务后可以恢复。
6. 失败任务进入可恢复状态并显示原因，不伪造成功，也不自动重复外部动作。

自动校验命令：

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build -w @hearth/web
```

最终结果：`npm.cmd test` 通过 51 项测试；TypeScript 类型检查通过；Web 生产构建通过。

## 15 项任务结果

| ID | 结果 | 已保存的证据 | 验收说明 |
|---|---|---|---|
| T01 | 通过 | `runs/T01/meeting-notes.md`、`run-manifest.json` | 会议转写转行动纪要，保留行动项、负责人、日期、待确认项和来源索引。 |
| T02 | 通过 | `runs/T02/clause-checklist.md`、`run-manifest.json` | 合同条款、义务、页码、缺失附件和金额可核对，未补造缺失信息。 |
| T03 | 通过 | `runs/T03/executive-summary.md`、`run-manifest.json` | 多报告合并时保留冲突和来源，不把矛盾结论强行统一。 |
| T04 | 通过 | `runs/T04/pages/`、`manifest.json`、`verification.md`、`run-manifest.json` | 3 个 URL 均有状态、最终 URL、抓取时间、HTTP 状态和 SHA-256；WCAG 页面访问失败被如实保留。 |
| T05 | 通过 | `runs/T05/competitor-comparison.md`、`run-manifest.json` | 竞品价格和功能有来源，未公开项标记未知而非推测。 |
| T06 | 通过 | `runs/T06/policy-update-digest.md`、`run-manifest.json` | 政策更新只使用官方来源，日期和变更类型可追溯。 |
| T07 | **未通过** | `runs/T07/report.md`、`pr-preview.json`、`run-manifest.json` | 最后一次运行被交付校验拦截：`backend/tests/unit/test_health_no_secrets.py` 未提交；未推送分支、未创建 PR。按用户要求不重试。 |
| T08 | 产物通过，**等待用户批准** | `runs/T08/pr-review.md`、`run-manifest.json` | 已固定 PR #15 head `c007c4ed55345682689ac50bbafb090c5934c31a`，生成 13 KB 分级评审；评论审批 `fe36e73f-4266-4c2d-8b25-8073e3871511` 状态为 `pending`，`effectId` 为 `null`，当前没有任何外部评论。 |
| T09 | 通过 | `runs/T09/bug-reproduction.md`、`pytest-output.txt`、`pytest-focused.txt`、退出码与路由证据文件 | 复现 PR #14 的 8 个后端失败，保留环境差异、临时目录问题和未验证项。 |
| T10 | 通过 | `runs/T10/cleaned-sales.csv`、`exceptions.csv`、`change-log.md`、`summary.md` | 20 行销售数据清洗，重复、缺失和异常均可追溯，原文件未修改。 |
| T11 | 通过 | `runs/T11/expense-reconciliation.md`、`run-manifest.json` | 7 行逐笔匹配，2640.00 合计复核，异常完整。 |
| T12 | 通过 | `runs/T12/triage.csv`、`reply-drafts.md`、`escalations.md`、`kb-draft.md` | 8 个工单完成分类、脱敏、升级和回复草稿；未自动发送。 |
| T13 | 通过 | `runs/T13/job-description.md`、`interview-kit.md` | JD 无歧视项；面试工具包覆盖 6 个能力维度、评分锚点和追问。 |
| T14 | 通过 | `runs/T14/lesson-plan.md`、`quiz.md`、`answer-key.md` | 45 分钟教案、8 题测验和答案解析完整，三个常见误区均被纠正。 |
| T15 | 通过 | `runs/T15/campaign-brief.md`、`asset-checklist.md` | 营销主张有输入依据，三渠道素材和审批状态完整；未发布、未投放。 |

## 公共验收基线映射

| 基线 | 证据 |
|---|---|
| G1 输入范围明确 | 任务模板和任务记录包含目标、输入路径/URL、输出目录；运行清单记录输入来源和 SHA-256。 |
| G2 状态可见 | 状态机覆盖 `queued`、`running`、`waiting_input`、`waiting_approval`、`completed`、`failed`、`recoverable`、`cancelled`，界面以状态标签和下一步动作展示。 |
| G3 结果持久 | 任务、运行、审批、效果、事件和产物索引写入 `.hearth/hearth.sqlite`；服务重启后仍可查询。 |
| G4 产物可追溯 | 每个 `run-manifest.json` 记录任务/运行 ID、输入摘要、执行器、生成时间和产物 SHA-256。 |
| G5 外部动作受控 | GitHub 推送、创建 PR 和评论先生成审批预览；T08 当前审批尚未执行，无效果记录。 |
| G6 不伪造 | T04 访问挑战、T08 缺失 CI 日志、T09 宿主临时目录问题均明确标记未知或失败。 |
| G7 失败可恢复 | T07 以 `recoverable` 结束，显示具体未提交文件，并保留工作区；用户可以选择恢复或放弃。 |
| G8 权限最小化 | 服务只接受本机回环地址，阻止跨站写请求；外部写入需要绑定参数指纹的一次性审批。 |
| G9 用户可核对 | 待办、任务详情、审批预览、产物预览和应用内时间线均可直接查看，不需要阅读内部日志。 |

## T07 未通过说明

- 任务：`T07-mw3gav04-3e3d51`
- 运行：`07697f49-d274-416e-a328-49ace93d1433`
- 状态：`recoverable`
- 原因：运行结束后仓库仍有未提交文件 `backend/tests/unit/test_health_no_secrets.py`，不满足“本地提交后可评审”的交付条件。
- 外部副作用：无。没有推送分支，没有创建 PR。
- 处理：本轮按用户要求停止重试。保留失败证据和恢复入口；后续可在确认工作区状态后人工继续，或重新执行该任务。新的交付校验会要求执行器在结束前自动清理未提交改动、核对分支和本地提交。

## T08 待审批说明

- 任务：`T08-mw3ib5h3-3e1381`
- PR：`JasonBuildAI/GoldMind#15`
- 固定 head：`c007c4ed55345682689ac50bbafb090c5934c31a`
- 审批：`fe36e73f-4266-4c2d-8b25-8073e3871511`
- 状态：`pending`；`effectId` 为 `null`；效果记录为空
- 评论正文：`runs/T08/pr-review.md` 中 `HEARTH_COMMENT_START` 与 `HEARTH_COMMENT_END` 之间的内容

用户批准后，控制面才会执行一次 GitHub 评论；拒绝则不会产生外部写入。评论正文绑定固定 head 和参数指纹，PR 更新后必须重新评审。

## 控制面能力

- **任务**：从模板创建任务，查看今日任务、待处理任务、全部任务和任务详情。
- **执行**：原生 Codex 执行器在隔离工作区运行，实时写入事件和应用内时间线。
- **审批**：外部动作在审批卡片中展示完整影响和正文预览，批准与参数指纹绑定，重复执行被阻止。
- **产物**：Markdown、JSON、CSV、文本和图片可在浏览器中预览或下载，并保留 SHA-256。
- **停止与恢复**：侧边栏全局停止会中止活动运行并保留队列和审批，恢复后继续调度。
- **备份与导出**：设置页可下载 SQLite 一致性备份，并导出全部任务记录 JSON。

## 启动方式

```powershell
npm.cmd ci
npm.cmd run dev
```

打开 `http://127.0.0.1:5173`。生产式本机运行：

```powershell
npm.cmd run build
npm.cmd start
```

打开 `http://127.0.0.1:4317`。

启动前确认终端中存在 `~/.codex/config.toml` 所引用 Provider 的 `env_key`。当前验证使用的 Provider 是 `OpenDesign`，执行器会显示为 `provider-env`，不需要 Codex 登录。

## 数据与备份

- 控制面数据库：`.hearth/hearth.sqlite`
- 隔离工作区：`.hearth/workspaces/`
- 验收产物：`eval/runs/`
- 完整归档：下载数据库备份后，同时复制 `.hearth/artifacts/` 和 `eval/runs/`

## 已知限制

- T07 尚未交付 PR；当前只完成了失败记录和本地恢复证据。
- T08 的 GitHub 评论仍需用户明确批准，尚未产生外部副作用。
- T04 的 WCAG 页面遇到访问挑战，没有可提取正文；系统按 G6 保留失败证据而不是编造。
- T08/T09 的本地依赖或临时目录限制已在各自报告中标注，未将无法验证的内容写成事实。
- 第一阶段控制面只面向本机单用户，不包含邮件发送、日历写入、桌面操作、移动端、多设备或主动循环。

## 结论

第一阶段 MVP 的工程闭环已经可运行：任务可创建、执行、持久化、审批、产出可核对文件、失败后恢复，且外部副作用受控。13 项任务完成并通过验收，超过 10/15 的硬门槛。T07 仍是一个明确的未完成项，T08 仍等待用户审批；两者都没有被虚报为成功。

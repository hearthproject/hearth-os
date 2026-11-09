---
title: '评测 Agent'
description: 'Hearth 独立评测 Agent 的任务集、架构、启动方式、评分流程、人工复核与安全边界。'
outline: deep
---

# 评测 Agent

<p class="lead">Hearth 的评测不是一组散落的脚本，而是一个与主 Agent 解耦的独立控制面：它把任务目录、实验编排、运行轨迹、自动评分、模型评委、人工复核、产物浏览和实验对比串成完整闭环。主服务只提供受控的任务创建与裁判接口，评测服务负责调度和记录，评测前端负责让全周期一眼可见。</p>

## 目标与边界

评测 Agent 要回答的问题不是“界面能不能演示”，而是“同一组真实任务在不同执行器、重复次数和运行模式下，成功率、质量分、耗时、token 与审批次数发生了什么变化”。因此它坚持三条边界：

- **可复现**：case 有版本和内容哈希；实验保存执行器、模式、重复次数、并发、评委模型和 Hearth schema 等环境快照。
- **可追溯**：每次运行保留 Hearth 任务 ID、事件流、评分证据和产物目录，结果不是一张孤立分数表。
- **可纠偏**：有 blocker、评委不可用或置信度不足时，系统不会假装通过，而是进入人工复核队列。

评测 Agent 不替代产品自身的单元、集成和端到端测试。测试是每次提交的确定性门槛；评测是带任务集、基线和重复测量的质量观测。

## 当前任务集

`eval/cases/` 当前包含 **60 个 case，覆盖 8 个任务族**。每个 case 使用独立的 `case.json` 描述目标、输入、期望产物、grader、评分标准和人工复核规则。

| 任务族 | case 数 | 关注点 |
|---|---:|---|
| `documents` | 9 | 文档生成、结构化改写、交付物完整性 |
| `email` | 8 | 邮件分类、草拟、回复与信息抽取 |
| `research` | 8 | 多来源检索、归纳、引用与不确定性表达 |
| `code` | 8 | 代码修改、测试、失败诊断与边界处理 |
| `web` | 8 | 网页信息读取、表单与浏览器任务 |
| `calendar` | 7 | 日程解析、冲突处理与时区边界 |
| `cross-app` | 7 | 跨应用信息流转与状态一致性 |
| `desktop` | 5 | 桌面观察、受控输入与本地操作 |

当前难度分布为 `normal` 24、`edge` 25、`adversarial` 6、`failure` 5；运行模式包含 57 个可离线 case、3 个 `live-optional` 和 3 个 `live-only`。评分项当前包含 120 个确定性项、60 个模型评委项和 60 个人工项。

> 这些数字来自当前 `eval/cases/` 目录。新增 case 后，评测服务启动时会重新校验并同步目录；目录名必须与 manifest 的 `id` 一致，输入和 golden 产物也必须通过路径与内容检查。

## 架构与端口

```text
┌──────────────────────────┐      /api/eval/tasks       ┌──────────────────────────┐
│ Hearth 主服务             │ <───────────────────────── │ 评测服务                  │
│ Fastify · 4317            │      /api/eval/judge       │ Fastify · 4318            │
│ 任务、执行器、模型、审批   │ ─────────────────────────> │ 实验编排、评分、存储、API  │
└──────────────────────────┘                            └─────────────┬────────────┘
                                                                      │
                                       ┌──────────────────────────────┴──────────────────────────────┐
                                       │ SQLite：.hearth/eval/eval.sqlite                            │
                                       │ 产物：.hearth/eval-artifacts/<experiment>/<case>/<executor>/r<n> │
                                       └──────────────────────────────┬──────────────────────────────┘
                                                                      │ /api/*
                                                         ┌────────────▼────────────┐
                                                         │ 评测前端                 │
                                                         │ React/Vite · 5174        │
                                                         └─────────────────────────┘
```

| 入口 | 默认地址 | 作用 |
|---|---|---|
| Hearth 主服务 | `http://127.0.0.1:4317` | 创建真实任务、提供执行器健康信息、调用模型评委 |
| 评测服务 | `http://127.0.0.1:4318` | 编排实验、存储运行、评分、复核和对比 API |
| 评测前端开发服务器 | `http://127.0.0.1:5174` | React 控制台，开发时把 `/api` 代理到 `4318` |
| 评测前端生产入口 | `http://127.0.0.1:4318` | 评测服务直接托管构建后的 SPA |

## 启动方式

### 本地开发

先在仓库根目录安装依赖，再分别启动主服务和评测栈：

```bash
npm install
npm run dev          # Hearth 主服务 4317 + 主 Web
npm run dev:eval     # 评测服务 4318 + 评测前端 5174
```

也可以只启动其中一部分：

```bash
npm run dev:eval-server
npm run dev:eval-web
```

评测服务启动时只会加载并校验 case 目录、同步 case 版本、恢复上次中断的运行，然后等待用户创建实验。**启动评测服务本身不会自动执行任何评测任务。**

主服务不在线时，评测前端仍可浏览目录和历史数据，但“系统”页会显示 Hearth 不可达，执行器列表为空，前端无法完成创建；直接调用 API 创建实验虽然能落库，但运行会因 Hearth 不可达而失败并留下错误证据。

### 生产构建

```bash
npm run build:eval-web
npm run start:eval
```

构建产物位于 `apps/eval-web/dist/`。评测服务检测到 `index.html` 后会在 `4318` 同时托管控制台；非 `/api` 的 GET 路由回退到 SPA，`/api/*` 缺失路由仍返回 JSON 404。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HEARTH_EVAL_HOST` | `127.0.0.1` | 评测服务监听地址 |
| `HEARTH_EVAL_PORT` | `4318` | 评测服务监听端口 |
| `HEARTH_URL` | `http://127.0.0.1:4317` | Hearth 主服务地址 |
| `HEARTH_EVAL_DATA_DIR` | `.hearth/eval` | 评测 SQLite 数据目录 |
| `HEARTH_EVAL_ARTIFACT_ROOT` | `.hearth/eval-artifacts` | 评测产物根目录 |
| `HEARTH_EVAL_CASES_DIR` | `eval/cases` | case 目录 |

## 完整评测周期

评测前端把一次实验的全周期放在同一条轨迹上：

| 阶段 | 用户看到什么 | 数据来源 |
|---|---|---|
| 排队 | 实验处于 `queued`，运行尚未创建 Hearth 任务 | 实验记录与运行记录 |
| 创建任务 | 每次运行生成稳定的 `externalRef`，向主服务提交受控任务 | `POST /api/eval/tasks` |
| Agent 执行 | Hearth 执行器运行，评测服务轮询任务状态 | `GET /api/tasks/:id` |
| 等待处理 | 任务仍在等待、审批或历史状态收敛 | Hearth 任务视图 |
| 自动评分 | 确定性 grader、模型评委、分数投影与复核触发 | grader 结果与评分器 |
| 人工复核 | blocker、低置信度、评委冲突、失败样本或抽样运行进入队列 | `/api/reviews` |
| 完成 | 实验汇总通过率、平均分、耗时、token、重试、审批和任务族差异 | 实验 summary |

运行状态包括 `queued`、`created`、`running`、`waiting`、`grading`、`needs_review`、`passed`、`failed`、`blocked`、`cancelled`、`error`。实验状态在上层聚合为 `queued`、`running`、`grading`、`needs_review`、`completed`、`failed`、`cancelled`。

### 创建实验

在评测前端打开“新建实验”，依次选择：

1. **case**：按任务族、难度、运行模式或搜索过滤；可批量选择当前筛选结果。
2. **执行器**：只列出 Hearth 当前检测到的执行器，不可用执行器会显示原因。
3. **运行参数**：重复次数 1–5、最大并发 1–8、离线或在线模式。
4. **评分选项**：是否自动调用模型评委、评委临时失败时是否自动重试。
5. **基线实验**：可选，用于后续对比，不会自动把结果变成“改进”。

运行总数等于 `case 数 × 执行器数 × 重复次数`。提交后前端会立即进入实验详情；按钮文案会明确提示这会开始真实执行。

### 查看轨迹与产物

运行详情页展示：

- 运行状态、分数、耗时、重试与审批次数、错误和复核原因；
- Hearth 任务状态与原始任务视图；
- 完整事件流，从任务创建、执行、评分到复核；
- 每个 grader 的来源、通过情况、得分、理由、置信度和证据；
- 产物目录树、文本预览和文件大小；
- 人工复核表单与历史决定。

产物预览只能读取该运行自己的产物目录，且必须同时位于配置的 artifact root 内；符号链接、目录穿越和越界文件都会被拒绝。

### 人工复核

复核队列聚合所有尚未人工确认、但需要人判断的运行。进入队列的典型原因：

- `blocker_anomaly`：确定性 blocker 结果缺失或异常；
- `failed_sample`：运行失败，需要确认失败是否真实；
- `judge_unavailable`：需要模型评委但模型不可用；
- `judge_conflict`：确定性与模型评委结论冲突；
- `low_confidence`：评委置信度低于阈值或人工选择了 `unknown`；
- `sampled`：按 case 的抽样率命中人工复核。

复核决定是 `pass`、`fail` 或 `unknown`。`pass` 和 `fail` 会重新计算运行状态并清除复核触发；`unknown` 会保留待复核状态。复核记录保存 reviewer、决定、分数、备注和更新时间。

## 评分模型

每个 case 的 criteria 分为三类：

- **deterministic**：文件存在、内容包含、JSON/CSV 结构、产物数量等，可重复验证；
- **judge**：需要模型按 rubric 判断质量、完整性和表达，返回逐项结论与置信度；
- **human**：需要人确认的判断，复核后写入 human grader 结果。

默认权重是确定性 60、模型评委 30、人工 10。最终分数会按可用权重归一化；通过阈值是 **80 分**。任一 blocker 失败会直接得到 `failed` 和 0 分，而不是用平均分掩盖。

模型评委不可用时，运行不会被伪造成通过：如果实验启用了自动评委且 case 需要 judge 项，结果进入 `needs_review`。自动重试只处理评委临时失败，不改变 case 标准。

## 主服务评测契约

评测服务只能通过两个专用接口访问主服务：

### `POST /api/eval/tasks`

请求包含 `externalRef`、标题、目标、输入、期望产物、执行器、运行模式、网络白名单、输出目录和超时。关键约束：

- 输入文件必须位于仓库 `eval/` 下；离线模式禁止 URL 输入；
- 输出目录必须是 `.hearth/eval-artifacts/` 下的仓库相对路径；
- 期望产物必须是安全的相对路径，不允许绝对路径或 `..`；
- 同一个 `externalRef` 重复提交同一请求时幂等返回原任务；请求内容变化时返回 `409 EVAL_REQUEST_CONFLICT`；
- 任务记录保存 `externalRef` 和请求哈希，服务重启后仍可去重。

### `POST /api/eval/judge`

请求包含任务 ID、judge criteria、确定性结果和 locale。主服务读取该任务已登记的文本产物，构造严格 JSON 输出提示，调用已配置的聊天模型并返回模型、prompt 哈希、逐项结论、总体置信度与 token 用量。模型未配置时返回 `503 JUDGE_UNAVAILABLE`，调用失败返回 `502 JUDGE_FAILED`。

## 控制面 API

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/health` | 评测服务存活与 case 数 |
| `GET` | `/api/system` | Hearth 连通性、评委模型、执行器健康、数据目录 |
| `GET` | `/api/dashboard` | 首屏汇总、最近实验、待复核与运行中数量 |
| `GET` | `/api/cases` | case 目录，可按 family、difficulty、runMode、search 过滤 |
| `GET` | `/api/cases/:caseKey` | case 详情、完整 manifest 与 golden 存在性 |
| `GET` | `/api/experiments` | 实验列表 |
| `POST` | `/api/experiments` | 创建并启动实验 |
| `GET` | `/api/experiments/:id` | 实验、运行、summary 与事件 |
| `POST` | `/api/experiments/:id/cancel` | 取消排队或执行中的实验 |
| `GET` | `/api/runs/:id` | 运行、case、grader、复核、事件、产物和 Hearth 任务 |
| `GET` | `/api/reviews` | 待人工复核队列 |
| `POST` | `/api/runs/:id/review` | 提交人工复核 |
| `GET` | `/api/compare` | 两个实验的汇总与任务族差异，带对齐警告 |
| `GET` | `/api/events` | 增量事件流，支持 experimentId、runId、after、limit |
| `GET` | `/api/runs/:id/artifacts/*` | 受控产物预览 |

对比不会只看平均分：如果运行模式、重复次数、执行器集合或 case 集合不同，会返回 `aligned: false` 和明确警告；任务族通过率差异单独列出，避免把不可比实验包装成“提升”。

## 数据与安全边界

| 路径 | 内容 |
|---|---|
| `.hearth/eval/eval.sqlite` | case 版本、实验、运行、grader、人工复核和事件 |
| `.hearth/eval-artifacts/<experiment>/<case>/<executor>/r<n>` | 单次运行的产物与证据 |
| `eval/cases/<caseId>/` | 输入、`case.json`、`golden/` 与可选 live 输入 |

评测服务不接收任意本地输入路径，不写仓库外目录，不把评测产物混入主任务产物。离线模式不使用网络；在线模式也只传递 case 声明的主机白名单。服务恢复时会标记中断运行，而不是把未完成的运行当作通过。

## 验证与验收

开发验证不会自动创建实验：

```bash
npx vitest run packages/eval-core/src
npx vitest run apps/eval-server/src
npx tsc -p apps/eval-web/tsconfig.json --noEmit
npm run build:eval-web
```

评测 Agent 的首屏、任务目录、实验详情、运行详情、复核队列、对比、活动流和系统页已经接入。真实任务集的通过率、执行器差异和成本数据必须由用户在实际运行实验后产生；**本文档对应的代码提交没有执行真实评测，也没有把任何实验标记为通过。**

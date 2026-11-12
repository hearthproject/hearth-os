<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/brand/hearth-os-logo-reverse.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/public/brand/hearth-os-logo.png">
    <img src="docs/public/brand/hearth-os-logo.png" alt="Hearth OS" width="420">
  </picture>
</p>

<p align="center">
  <strong>让数字劳动成为持久、可审计、可恢复的任务</strong><br>
  单用户 · 自托管 · 长期驻留的个人 Agent OS
</p>

<p align="center">
  <a href="https://hearthproject.github.io/hearth-os/"><strong>文档站</strong></a> ·
  <a href="#界面一览">界面截图</a> ·
  <a href="#现在能做什么">能力</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#当前进度">当前进度</a> ·
  <a href="#架构图">架构图</a> ·
  <a href="#验证">验证</a>
</p>

<p align="center">
  <img alt="Phase 1 MVP accepted" src="https://img.shields.io/badge/phase%201-MVP%20accepted-b8471d">
  <img alt="725 tests passing" src="https://img.shields.io/badge/tests-725%20passing-2f7d4f">
  <img alt="Node.js 22.13+" src="https://img.shields.io/badge/node-22.13%2B-3c8773">
  <img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-1b1815">
  <img alt="Local first" src="https://img.shields.io/badge/local--first-yes-8d3412">
</p>

---

Hearth 不是另一个聊天壳，也不是只服务于代码的 Agent。它是一个**以任务为中心的个人控制面**：用户提出意图，系统保存目标、分配执行器、约束权限、记录证据，并在外部动作发生前要求明确审批。

模型可以更换，执行器可以替换，界面可以重写，但任务状态、授权范围、完成证据、产物摘要和外部回执必须留下来。Hearth 要回答的不是“模型能不能写出一段话”，而是“这件事有没有真正完成，失败后能不能接着做，外部动作能不能被核对”。

> **当前状态（2026-11-12）：** 第一阶段 MVP 已验收；第二阶段至第六阶段已形成可运行的代码闭环和自动测试；原生执行器已在独立评测仓库完成 30 个离线 case 的测量，最好完整单轮为 18/30，累计定向确认 19/30，但最终提交尚未连续复测。真实账户、真实设备、真实长期使用和 v1.0 整体验收仍未完成。本文不把代码闭环或评测分数写成产品验收完成。

## 界面一览

<p align="center">
  <img src="docs/public/screenshots/chat.png" alt="Hearth 聊天工作台" width="100%">
  <br>
  <sub>聊天工作台：一句意图即可生成任务提案；执行器、阶段、Token、耗时与审批入口都在同一处。</sub>
</p>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/public/screenshots/tasks.png" alt="任务列表" width="100%">
      <p align="center"><sub><strong>任务列表</strong><br>运行中、等待审批、已完成与需要处理的任务一屏可读。</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/public/screenshots/task-detail.png" alt="任务详情" width="100%">
      <p align="center"><sub><strong>任务详情</strong><br>目标、验收条件、执行器、预算、证据、产物和最终结果完整留档。</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/public/screenshots/inbox.png" alt="主动收件箱" width="100%">
      <p align="center"><sub><strong>需要你</strong><br>主动建议进入收件箱，可以接受、忽略、稍后提醒或转为任务。</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/public/screenshots/memory.png" alt="记忆管理" width="100%">
      <p align="center"><sub><strong>记忆</strong><br>记忆候选、来源、可信度、召回、纠正、遗忘与导出都有明确边界。</sub></p>
    </td>
  </tr>
  <tr>
    <td colspan="2" align="center">
      <img src="docs/public/screenshots/settings.png" alt="设置与执行器" width="82%">
      <p align="center"><sub><strong>设置与执行器</strong><br>统一管理模型档案、执行器安装、健康检测、协议兼容与默认路由。</sub></p>
    </td>
  </tr>
</table>

## 现在能做什么

| 能力 | 当前实现 |
|---|---|
| **目标契约与完成判定** | 目标保存验收条件、约束、禁止动作、证据要求、预算、截止时间、停止条件和复核策略；完成判定支持命令、文件、schema、Git、人工和模型复核，结果以证据报告保存，不能只凭模型说“完成” |
| **聊天优先的控制面** | React + Vite 单页应用，对话中生成任务提案；任务详情展示执行器、阶段、Token、耗时、验收条件、证据、产物与最终结果；`Ctrl/Command + K` 快速跳转页面和任务 |
| **原生 Agent Runtime** | 自研通用执行内核，支持 OpenAI Chat、OpenAI Responses、Anthropic Messages、Gemini 四种协议；读取、文档、glob/grep、写入、原子编辑、补丁、命令、联网搜索、技能、委派、本地 MCP、询问用户和完成工具共享同一条预算、检查点、审批与恢复链路 |
| **项目、子代理与 MCP** | 注册本地 Git 项目后，任务在独立 `hearth/<task-id>` Worktree 中执行；子代理使用新上下文、只读或隔离写、单层串行且最多两个；本地 stdio MCP 服务器支持启动探测、工具发现、JSON Schema 校验、逐次审批、超时和崩溃隔离 |
| **上下文与办公产物** | 模型窗口默认 128K、最大输出默认 8K；只在完整回合边界做 Token 感知压缩，压缩后写检查点；可生成 XLSX/CSV/DOCX，Shell 完整输出写入任务日志、只回填尾部并杀死超时进程树 |
| **七个执行器** | 三个一等执行器（`deepseek-harness`、`codex`、`native`）和四个外部执行器（`hermes`、`qoder`、`workbuddy`、`kimi`）共用注册表、启动解析、健康检测、模型绑定、上下文采集和设置界面 |
| **统一模型注册表** | SQLite 模型档案与执行器绑定取代私有 JSON；各执行器按协议兼容性选择模型，Codex 固定使用 OpenAI Responses，本地模型不进入统一管理 |
| **持久任务执行** | 状态机、预算、检查点、等待输入、恢复与重试；只追加 SQLite 事件日志保存全部事实；运行中可“轮后继续”或中止当前轮并带补充重跑 |
| **委派、交接与沙箱** | 单层持久委派任务通过调度器推进，保留预算、工作区策略、租约和失败状态；执行器交接包带目标、下一步、验收项、证据、权限子集和上下文水位；沙箱检查路径、网络、进程和凭据边界 |
| **审批与回执** | 外部动作先生成预览，一次性审批绑定动作参数指纹；批准后由效果账本执行并留下回执；拒绝、过期、复用和参数变化都会失效；不确定效果进入显式对账队列 |
| **个人上下文与注意力** | 实体、别名、关系、状态、决定和承诺组成个人本体；Context Broker 按 `must_know`、`relevant`、`recallable`、`omitted` 组装上下文；标准意图、心跳和注意力预算共同决定何时打扰 |
| **首次运行与导航** | 全新实例四步向导：服务商选择、连接测试、聊天模型保存、原生执行器绑定；主导航暴露聊天、任务、需要你、记忆、技能、定时任务、邮件、设备和设置 |
| **飞书消息入口** | 企业自建应用长连接、open_id 白名单、文本/图片/文件消息、任务状态、审批摘要与 `/approve`、`/reject` 文本命令；入站消息带幂等记录，不需要公网回调 |
| **邮件工作台** | SMTP 发送复用审批与效果账本，批准后发送并保存回执；IMAP 只读同步最近邮件到来源，不标记已读；账户和口令加密保存 |
| **定时任务与技能** | 有界补跑、失败冷却、定时触发、任务模板、技能页面与可复用方法；技能包支持导出、导入、权限范围、归档、恢复和过期清理回退 |
| **来源与文档** | 本地文件、知识库、公开网页，以及 TXT/Markdown/CSV/JSON/HTML/PDF/DOCX/XLSX 文本提取 |
| **Windows 桌面控制** | 六位配对码、逐项能力审批、截图观察、暂停/接管/交还、低风险点击输入与 UIAutomation |
| **主动服务与记忆** | 主动触发器、主动收件箱、注意力评分与反馈、噪音预算；记忆候选、来源与可信度、召回、纠正、合并、遗忘传播与导出 |
| **方法进化** | 从终态任务轨迹生成候选方法，记录基线/试跑证据，评估、晋升、拒绝、回退，并可导出为技能包 |
| **多设备与安全** | 事件增量同步、对端认证、任务租约与 epoch fencing、设备撤销、令牌轮换、全局 kill switch；连接运行时用 generation 隔离旧写、离线 outbox 和缓存投影 |
| **备份与运维** | AES-256-GCM 加密备份与回滚式恢复、健康快照、周期维护、脱敏诊断 |
| **移动端壳与 PWA** | 可安装 Manifest、应用图标、移动底部导航和离线应用壳；尚未完成 iOS/Android 真机安装、手机配对、系统推送和远程接管验收 |

## 当前进度

Hearth 已经越过**第一阶段（MVP）**的硬门槛：15 个跨行业真实任务全部执行，13 个通过验收。阶段二至六已经形成可运行的代码闭环与自动测试，但**尚未完成真实用户、真实设备和长期运行验收**，因此不宣称整体交付。

| 阶段 | 状态 | 已经跑通 | 仍然留空 |
|---|---|---|---|
| 一 · 最小完整 MVP | **已验收** | 15 项任务、13 项通过；任务、审批、产物、恢复、备份闭环 | T07 未交付 PR；T08 外部评论等待用户批准 |
| 二 · 日常内容工作 | 部分完成 | 来源、提取、草稿、审批、本地发件箱；SMTP 真实发送与 IMAP 只读同步代码闭环 | 真实邮件账户、退信与垃圾邮件语义未验收；日历账户未接入；邮件附件 UI 未实现 |
| 三 · 桌面操作 | 部分完成 | Windows 配对、观察、接管、低风险输入、UIA 动作、动作绑定当前观察帧 | 敏感区域遮罩、隔离桌面、高风险补偿未实现 |
| 四 · 主动服务与手机 | 部分完成 | 触发器、收件箱、注意力预算、应用内通知、飞书长连接与文本审批；可安装 PWA 壳和移动底部导航 | 真实飞书租户、iOS/Android 真机安装、手机配对、系统推送、远程接管未验收 |
| 五 · 记忆与进化 | 部分完成 | 记忆来源/可信度/合并/遗忘传播/导出、方法评估/晋升/回退；持久委派、可审阅交接与沙箱边界代码闭环 | 真实长期使用、错误记忆/错误方法演练、方法采用前后的生产对照未完成 |
| 六 · 多设备与长期运行 | 部分完成 | 增量同步、租约、撤销、令牌轮换、加密备份、健康维护；连接运行时 generation、离线 outbox 与缓存投影 | 真实双设备切换、真实远程节点、断网恢复、设备丢失演练、数周运行未完成 |

逐项能力矩阵、验证证据和未完成验收见[阶段二至六交付状态](https://hearthproject.github.io/hearth-os/delivery/status.html)。

## 评测结果

评测栈已拆分到独立仓库 **<https://github.com/hearthproject/hearth-eval>**。主仓库只保留 `/api/eval/tasks`、`/api/eval/judge`、`HEARTH_EVAL_INPUT_ROOT` 与 `.hearth/eval-artifacts/` 桥接，case、实验编排、评分、复核、对比和控制台都由评测仓库维护。

2026-11-11 至 11-12 使用 30 个离线 case（8 个任务族均匀分布）、仅 `native` 执行器、重复 1 次、自动评分与自动重试开启、并发 4 进行测量：

| 指标 | 结果 |
|---|---:|
| 最好完整单轮 | **18/30 通过（60%）**，平均分 88.89，实验 `EXP-20261111145332-7a95ea` |
| 累计定向确认 | **19/30** 个 case 曾达到 100 分；不是一次连续实验 |
| 最近完整单轮 | 12/30 通过（40%），平均分 73.33，实验 `EXP-20261112003215-b1172b` |
| 最终修复提交 | `eb32ad5`；尚未做不中断的完整 30 题复测 |

最近完整单轮受到 provider 慢响应、评分 JSON 截断和任务超时影响，且早于最后四个归一化修复，不能直接等同于最终代码能力。CAL01、WEB01 等 case 还存在输入与评分 rubric 的语义歧义；T02、T11、WEB03 虽得到 100 分，但因 `sampled` 标记未计为正式通过。

详细报告：[最终评测报告](https://hearthproject.github.io/hearth-os/evaluation/native-30-final-report-2026-11-12.html) · [基线报告](https://hearthproject.github.io/hearth-os/evaluation/native-30-baseline-2026-11-11.html) · [评测文档站](https://hearthproject.github.io/hearth-eval/)。

## 架构图

[![Hearth 本地代理操作系统架构](https://media.githubusercontent.com/media/hearthproject/hearth-os/main/assets/Hearth-Architecture-Light.png)](https://media.githubusercontent.com/media/hearthproject/hearth-os/main/assets/Hearth-Architecture-Light.png)

<sub>当前架构：单进程 Fastify 控制平面 + SQLite 事件账本 + 可插拔执行器；覆盖触点与入口、本地控制平面、执行平面、事实层及边界约束。点击图片可查看原图。</sub>

### 运行时数据流

简化版：

[![Hearth 任务流程图 · 简化版](https://media.githubusercontent.com/media/hearthproject/hearth-os/main/assets/Hearth-Flow-Simple-Light.png)](https://media.githubusercontent.com/media/hearthproject/hearth-os/main/assets/Hearth-Flow-Simple-Light.png)

<sub>简化版：从输入到结果压缩为 4 步主链（分流 → 任务落账 → 调度执行 → 结果判定）、4 类去向和 3 类外部副作用；底部统一说明事件账本、SSE 与界面刷新。点击图片可查看原图。</sub>

详细版：

[![Hearth 端到端任务流程](https://media.githubusercontent.com/media/hearthproject/hearth-os/main/assets/Hearth-Flow-Light.png)](https://media.githubusercontent.com/media/hearthproject/hearth-os/main/assets/Hearth-Flow-Light.png)

<sub>详细版：一条请求从聊天、飞书、定时任务、主动建议或邮件进入，经 planExecution 与 decideRoute 分流；任务以 lease + epoch 调度，执行中可等待输入或审批，外部副作用只在审批后发生，最终经 SQLite 事件账本、SSE 与前端缓存投影回界面。点击图片可查看原图。</sub>

同一流程的 Mermaid 版本：

```mermaid
flowchart TB
  U["用户<br/>聊天 · 任务 · 审批 · 设备"] --> W["Web 控制面<br/>React + Vite · PWA 壳"]
  W --> A["本地 API<br/>Fastify · SSE"]
  A --> G["目标契约<br/>验收条件 · 预算 · 完成判定"]
  A --> S["任务与调度<br/>状态机 · 检查点 · 租约"]
  S --> N["原生 Agent Runtime<br/>4 种模型协议 · 通用工具内核"]
  N --> PJ["本地项目与 Worktree<br/>隔离分支 · 恢复复用"]
  N --> SA["有界子代理<br/>新上下文 · 单层串行"]
  N --> MCP["本地 stdio MCP<br/>探测 · Schema 校验 · 逐次审批"]
  S --> H["DeepSeek Harness<br/>官方 SDK/JSON-RPC · 会话恢复"]
  S --> C["Codex 执行器<br/>代码与仓库任务"]
  S --> X["外部执行器<br/>Hermes · Qoder · WorkBuddy · Kimi"]
  S --> DG["委派与交接<br/>沙箱 · 租约 · 交接包"]
  S --> D["Windows 桌面助手<br/>配对 · 观察 · 接管"]
  A --> F["来源与文档<br/>文件 · 网页 · PDF/DOCX/XLSX"]
  A --> M["邮件与飞书<br/>SMTP · IMAP · 长连接"]
  A --> P["审批与效果账本<br/>参数指纹 · 回执 · 对账"]
  A --> K["个人上下文<br/>本体 · Context Pack · 注意力"]
  A --> E["只追加事件日志<br/>SQLite WAL · 投影"]
  P --> O["本地发件箱 / GitHub / 桌面动作"]
  E --> W
```

评测 Agent 已拆分到独立仓库 **<https://github.com/hearthproject/hearth-eval>**。评测前端、评测服务、评测核心、case、场景运行器和评测文档都在该仓库维护；主仓库只保留 `/api/eval/tasks`、`/api/eval/judge`、`HEARTH_EVAL_INPUT_ROOT` 与 `.hearth/eval-artifacts/` 这组最小桥接。

核心约束只有一句话：**界面状态来自可重建的记录，每个状态只有一个写权威，外部副作用必须经过审批或明确豁免，并留下可核对回执。**

## 快速开始

要求 **Node.js 22.13+**（服务端使用内置 `node:sqlite`）和 npm。

```bash
git clone https://github.com/hearthproject/hearth-os.git
cd hearth-os
npm ci
npm run dev
```

打开 <http://127.0.0.1:5173>。Vite 会把 `/api` 代理到本机 `127.0.0.1:4317`。

生产式本机运行：

```bash
npm run build
npm start
```

打开 <http://127.0.0.1:4317>。

### 接入模型

在 **设置 → 模型** 中创建模型档案：选择预设服务商（DeepSeek、阿里云百炼、智谱、Kimi、火山方舟、OpenAI、Anthropic、Gemini）或自定义服务，然后在 **设置 → 执行器** 中把档案绑定到执行器。档案保存在 `.hearth/hearth.sqlite`，API Key 通过本机 `.hearth/master.key` 以 AES-256-GCM 加密，设置页只显示掩码。本地模型地址不进入统一管理。

### 使用 Codex

Codex 执行器优先使用统一模型绑定；没有绑定时读取现有的 `~/.codex/config.toml`。绑定会生成隔离的 `.hearth/executors/codex/config.toml`，固定 `wire_api = "responses"` 并通过环境变量注入密钥，因此 Codex 只能使用 OpenAI Responses 协议。配置了 `model_provider` 和对应 `env_key` 时不需要 `codex login`。设置页会显示当前 Provider、模型和认证来源。

### 使用更多执行器

在 **设置 → 执行器** 中统一完成安装、健康检测、命令或脚本路径、并发数和模型绑定。对话输入框只有一个执行器选择器：对话级选择覆盖全局默认执行器；当选择被关闭、不可用、缺少任务能力或没有有效模型绑定时，路由先回到任务匹配的执行器，再寻找其他可用项。

| 执行器 | Hearth 如何接入 |
|---|---|
| `native` | 内置；使用当前聊天模型或自己的模型绑定 |
| `deepseek-harness` | 官方 `@deepseek-ai/dsh-sdk-client` SDK/JSON-RPC；原生工具、会话恢复和完整事件流 |
| `codex` | 统一 Responses 模型绑定，或现有 Codex Profile 与认证 |
| `hermes` | `PATH` 中的 `hermes` 命令，或设置中的自定义命令 |
| `qoder` | 托管安装 `@qoder-ai/qoder-agent-sdk`；复用本机 qodercli 登录或 PAT |
| `workbuddy` | 托管安装 `@tencent-ai/codebuddy-code`；复用本机 CodeBuddy/WorkBuddy 登录 |
| `kimi` | 托管安装 `@moonshot-ai/kimi-code`；以 stream-json 非交互模式运行 |

托管包和执行器运行目录位于 `.hearth/executors/<id>/`。模型档案、执行器绑定、目标契约、默认路由和任务状态保存在 SQLite；旧 `.hearth/model-settings.json` 与 `.hearth/executor-settings.json` 会在启动时导入，备份到 `.hearth/backups/legacy-dev/` 后保留为迁移来源。

## 数据与备份

| 路径 | 内容 |
|---|---|
| `.hearth/hearth.sqlite` | 任务、目标、运行、审批、效果、对账、记忆、方法、技能、同步、连接、上下文、设置、模型档案与事件 |
| `.hearth/master.key` | 本机 AES-256-GCM 密钥，用于加密设置字段 |
| `.hearth/context/blobs/` | 超过内联阈值的上下文正文，以 SHA-256 命名 |
| `.hearth/executors/` | 托管执行器安装目录与隔离的 Codex/DeepSeek Harness 运行目录 |
| `.hearth/workspaces/` | 隔离的任务工作区与检查点 |
| `.hearth/artifacts/` | 受管产物 |
| `.hearth/outbox/` | 本地发件箱与回执 |
| `.hearth/backups/` | 加密备份归档与旧设置迁移备份 |
| `.hearth/eval-artifacts/` | 独立评测 Agent 经桥接写入的受管评测产物 |

服务端提供 AES-256-GCM 加密备份创建与恢复，恢复前校验 schema 与 `integrity_check`。聊天优先界面暂未接回备份入口，具体边界见[存储与上下文架构](https://hearthproject.github.io/hearth-os/design/storage.html)。备份包含数据库与必要元数据，但**不包含产物正文、工作区、来源正文和外部附件**；完整归档需要一并复制 `.hearth/artifacts/`、`.hearth/workspaces/` 和可选的 `.hearth/eval-artifacts/`。评测数据库、case 和场景证据由独立评测仓库管理。

## 📁 目录结构

```text
hearth-os/
├── apps/                                             # 应用入口
│   ├── server/                                       # Fastify 单进程控制平面
│   │   ├── src/                                      # 192 个源文件；实现与同名 *.test.ts 并列
│   │   │   ├── index.ts / app.ts                     # 进程入口与 **buildServer** 组装（REST + SSE）
│   │   │   ├── service.ts / scheduler.ts             # **任务写权威** / 租约、预算、检查点与恢复
│   │   │   ├── chat.ts / chat-routes.ts              # 意图分流与执行计划
│   │   │   ├── approvals.ts / effects.ts             # 参数指纹审批与效果账本
│   │   │   ├── reconcile.ts / security.ts            # 不确定效果对账 / 全局 kill switch
│   │   │   ├── executors.ts / native-executor.ts     # 执行器注册表与通用内核桥接
│   │   │   ├── external-executor.ts / model-client.ts # 外部 CLI 适配与模型协议
│   │   │   ├── context*.ts / memory.ts / methods.ts  # 上下文投影、记忆与方法治理
│   │   │   ├── skills*.ts / ontology*.ts             # 技能包治理、个人本体与标准意图
│   │   │   ├── proactive.ts / feishu*.ts             # 主动收件箱与飞书长连接
│   │   │   ├── email.ts / desktop.ts                 # 邮件收发与 Windows 桌面边界
│   │   │   ├── mcp-*.ts / subagents.ts               # 本地 stdio MCP 与有界子代理
│   │   │   ├── worktrees.ts / sources.ts             # 任务隔离 Worktree 与来源提取
│   │   │   ├── backups.ts / leases.ts                # 加密备份与租约 fencing
│   │   │   ├── eval-routes.ts                        # 通往独立评测仓库的最小桥接
│   │   │   ├── test-fixtures/                        # 服务端测试夹具
│   │   │   └── *.test.ts                             # 91 个测试文件，与实现并列
│   │   └── package.json                              # @hearth/server：依赖全部 workspace 包
│   ├── web/                                          # React + Vite 聊天优先控制面（PWA）
│   │   ├── src/App.tsx                               # 路由、首跑向导与事件驱动缓存失效
│   │   ├── src/pages/                                # 16 个页面：Chat / Tasks / TaskDetail / Inbox / Memory …
│   │   ├── src/components/                           # 14 个组件：AppShell / ApprovalCard / CommandPalette …
│   │   ├── src/lib/                                  # 9 个文件：api.ts / types.ts / notifications.ts …
│   │   ├── public/                                   # manifest.webmanifest、sw.js 与 icons/
│   │   └── index.html / vite.config.ts               # SPA 入口与 /api 代理
├── packages/                                         # 可复用 workspace 包，依赖方向自下而上
│   ├── core/                                         # 领域类型、DTO 与状态机
│   │   └── src/                                      # types.ts / state.ts / dto.ts / personal-agent.ts
│   ├── eventlog/                                     # **只追加事件账本**：SQLite WAL 与投影
│   │   └── src/                                      # database.ts / index.ts / database.test.ts
│   ├── agent-runtime/                                # **通用 Agent 内核**：工具循环、预算、压缩
│   │   └── src/                                      # runtime.ts / tools.ts / compaction.ts / web-fetch.ts / documents.ts
│   ├── codex-executor/                               # Codex 适配器与 Profile 探测
│   │   └── src/                                      # executor.ts / profile.ts / index.ts
│   ├── deepseek-executor/                            # DeepSeek 适配器
│   │   └── src/                                      # index.ts
│   ├── templates/                                    # 任务模板与产品示例输入
│   │   └── src/                                      # index.ts
├── docs/                                             # 中英双语 VitePress 文档站
│   ├── design/                                       # 15 篇模块设计 + index.md
│   ├── delivery/                                     # 六阶段、24 个小阶段与验收状态
│   ├── evaluation/                                   # native 30 题基线与最终报告
│   ├── log/                                          # Day01–Day08 开发日志
│   ├── reference/                                    # 工程、决策、风险、术语与 source-map
│   ├── en/                                           # design / delivery / reference / log 英文镜像
│   ├── public/                                       # hero、brand/ 与 screenshots/
│   ├── brand/                                        # Logo、图标与品牌板源文件
│   ├── .vitepress/                                   # config.mts、delivery-sidebar.mjs 与主题
│   └── index.md                                      # 文档站首页
├── scripts/                                          # E2E、README 截图、交付页生成与覆盖率检查
│   └── delivery-data/                                # s0–s6 阶段交付数据 JSON
├── tools/windows-helper/                             # helper.mjs 与 windows.ps1 桌面助手
├── assets/                                           # 架构图与流程图（3 张 PNG）
├── package.json / package-lock.json                  # npm workspaces 与 dev / build / test / docs 脚本
├── tsconfig*.json / vitest.config.ts                 # 类型检查与 Vitest（单测超时 20s）
├── .gitignore / .gitattributes                       # 忽略规则与文本换行约定
└── README.md / LICENSE                               # 中文主文档与 Apache-2.0
```

> 运行时数据目录 `.hearth/`（SQLite、密钥、工作区、产物）由程序在本地生成，不纳入版本控制，不在上方仓库结构中。

## 文档

完整文档发布在 **<https://hearthproject.github.io/hearth-os/>**。中文是默认语言，每个页面都有英文镜像。

- [产品设计](https://hearthproject.github.io/hearth-os/design/) — 产品定位、任务链路、技术选型与模块边界。
- [目标、完成判定与证据](https://hearthproject.github.io/hearth-os/design/goals-and-evidence.html) — 目标契约、预算、停止条件、验证器和完成报告。
- [委派、交接与沙箱](https://hearthproject.github.io/hearth-os/design/delegation-and-sandbox.html) — 单层持久委派、交接包、租约、路径/网络/凭据边界。
- [个人上下文与注意力](https://hearthproject.github.io/hearth-os/design/personal-context.html) — 个人本体、Context Pack、记忆召回、标准意图和打扰预算。
- [存储与上下文](https://hearthproject.github.io/hearth-os/design/storage.html) — SQLite 数据域、上下文生命周期、备份与恢复边界。
- [交付与进度](https://hearthproject.github.io/hearth-os/delivery/) — 已验收能力、明确留空项与剩余路线。
- [阶段二至六状态](https://hearthproject.github.io/hearth-os/delivery/status.html) — 当前能力矩阵、验证证据与未完成验收。
- [评测与结果](https://hearthproject.github.io/hearth-os/evaluation/) — native 30 题基线、最终报告与评测边界。
- [开发日志](https://hearthproject.github.io/hearth-os/log/day-08.html) — 通用执行内核升级、评测拆分与 native 30 题结果。
- [评测 Agent（独立仓库）](https://hearthproject.github.io/hearth-eval/) — 场景、case、独立控制台、全周期轨迹、评分、复核与对比。
- [参考](https://hearthproject.github.io/hearth-os/reference/) — 工程、风险、决策、术语、清单与维护资料。

## 已知边界

- 邮件默认写本机发件箱；配置 SMTP 账户后可提交真实发送审批，但真实账户、退信和垃圾邮件语义尚未人工验收。日历账户未接入，邮件附件 UI 未实现。
- Windows 助手只支持同机、前台聚焦操作；敏感区域遮挡、隔离桌面和高风险动作补偿尚未实现。当前本地沙箱是路径、网络和进程策略检查，不是强隔离容器或虚拟机。
- 飞书长连接提供手机消息与文本审批，但不是手机 PWA、系统级推送或完整远程接管；页面关闭后不会推送。
- PWA 壳、移动底部导航和离线应用壳已存在，但手机配对、iOS/Android 真机安装、系统推送和远程接管未验收。
- 多设备同步只同步过滤后的事件投影，不同步产物正文、工作区或敏感记忆；连接运行时也未接入真实远程节点或手机。
- 当前主导航暴露聊天、任务、需要你、记忆、技能、定时任务、邮件、设备和设置；同步、安全、运维仍有 API 与页面组件，但尚未全部接回主导航。
- 评测 case、场景和实验已迁到独立仓库；主仓库的测试不代表真实评测实验已经运行。native 30 题的最终提交 `eb32ad5` 尚未完成连续复测，18/30 与累计 19/30 都不是最终官方单轮成绩。
- 原生运行时仍不支持远程 MCP、OAuth、浏览器自动化搜索、图片/扫描件视觉理解、PPTX、LSP、格式化器、Shell 后台会话或自动 cherry-pick。
- 这是一个阶段一已验收、阶段二至六部分完成的工作版本，不是 v1.0 正式发布。

## 验证

2026-11-12 在当前分支运行：

```bash
npm test              # 100 个测试文件、725 个测试全部通过
npm run typecheck     # TypeScript 类型检查
npm run build         # 构建 Web 控制面
npm run docs:build    # 构建 VitePress 文档站
npm run test:e2e      # 浏览器 E2E；使用隔离数据目录
npm run screenshots:readme  # 重新生成 README 与文档站截图
```

E2E 会在随机本地端口启动服务，并使用临时 `HEARTH_DATA_DIR`，不会触碰真实 `.hearth` 数据。可用 `HEARTH_E2E_MODEL_SETTINGS` 指定其他模型配置，`HEARTH_E2E_OFFLINE=1` 跳过在线聊天，`HEARTH_E2E_KEEP=1` 保留临时数据用于排查。

`vitest.config.ts` 将单个测试的超时设为 20 秒，避免 Windows 上 Git、Worktree 和 MCP 探测测试被默认 5 秒超时误判。测试覆盖服务层、API、模型协议、原生工具循环、glob/grep、原子补丁、Shell 进程树超时、办公文件读写、上下文压缩、瞬态重试、循环检测、显式完成、技能按需加载、项目与 Worktree、子代理边界、MCP 管理/调用/审批、搜索适配器、预算、权限、检查点、目标契约、完成判定、审批参数绑定、效果对账、执行器交接、委派、沙箱、记忆/技能治理、个人本体、Context Broker、标准意图、注意力、连接运行时、桌面边界、同步与备份。测试通过不等于真实验收完成；阶段一逐项证据见 [hearth-eval 的第一阶段验收报告](https://github.com/hearthproject/hearth-eval/blob/main/eval/phase-1-acceptance.md)。

独立评测仓库当前有 11 个测试文件、42 个测试；`npm run typecheck`、`npm run typecheck:scenarios`、`npm run build` 与 `npm run docs:build` 均通过。自动测试不执行真实评测实验。

## 许可

Apache-2.0。见 [LICENSE](LICENSE)。

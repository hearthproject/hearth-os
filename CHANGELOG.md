# Changelog

## 0.3.6 - 2026-11-23

### 抓取与任务稳定性

- 修复打包版 `fetch_url` 全线失败：`turndown-plugin-gfm` 的 CJS/ESM 互操作会让插件变成 `undefined`，现在兼容多种导出形态，插件不可用时仍返回正文，不再让整页抓取报 `plugin must be a Function`。
- `fetch_url` 支持 JSON、纯文本、Markdown 与 XML/RSS，JSON 以带标题的代码块返回；单次结果截断到 200k 字符。
- 工具熔断改为按轮计数：同一轮并行抓取多个来源全部失败只记一次，连续 5 轮失败才停止；未配置网页搜索时不再向模型暴露 `web_search`。
- 发布产物跳过 `out/.hearth` 与 `.git` 内部状态，checkpoint 不再被误算成交付文件，不再出现“产物文件过多：2554 > 1000”。

### 对话与界面

- “新对话”立即创建无项目会话并出现在侧边栏“最近”，不再自动继承上一个项目；已存在的空会话会被复用。
- 侧边栏不再直接显示 Git 分支，分支名移到具体会话标题旁，并支持长名称省略。
- 最终回答强制使用结构化 Markdown：结论先行、短标题分节、列表和表格；渲染层新增分级标题、表格容器、代码块语言栏与复制按钮，并把内容列收窄到 900px。
- 输入框默认高度从 74px 收紧到约 48px，单行垂直居中，随内容增高并在 132px 封顶后内部滚动。
- 设置新增“外观”页：浅色、深色、跟随系统三种模式，立即生效、持久化，并在启动前进应用主题避免闪白。

### 主线同步

- 合入结构化工具审批展示：批准卡片直接呈现工具名、参数摘要与风险提示。
- 合入项目范围的记忆召回：回忆只读取与当前项目关联的资料。
- 合入任务暂停与检查点续跑：聊天与任务时间线新增暂停/继续入口，停止仍是取消。
- 合入从项目会话直接退出到独立新对话的入口，不删除原项目聊天。
- 修复“等待预算”和“已暂停”共用同一个中文标签的问题，并补齐暂停状态的标签测试。

### 验证

- 全量 `npm test`：143 个测试文件、963 项通过、15 项跳过。
- `npm run typecheck` 与 0.3.6 桌面端发布构建通过；打包后的 HTML→Markdown 实测可输出 GFM 表格，不再触发插件错误。

## 0.3.5 - 2026-11-23

### 更轻的前端

- 删除不可达的组件与页面状态模块（`BrowserPanel`、`EmptyState`、`lib/memory`、`lib/task-read-state` 及其测试和 `browser.css`），用入口可达性分析与 `knip` 复核，不改动仍在业务链路上的页面。
- 客户端 API 表面从 200 个方法裁到 106 个，只保留界面真正调用的接口；`api.ts` 从 41KB 降到 25.7KB。后端能力保持不变。
- 合并状态组件与标签表：审批结果标签收进 `ApprovalCard`，删除只服务旧页面的来源、设备、桌面、发件箱、配对等标签；顺带清掉各页面已有的未使用导入和变量。

### 更快、更安静

- 首页只同步加载聊天，连接、上下文、邮件、资料库、引导、设置、计划页改为按需加载；导航悬停或聚焦时预热对应分块。
- 流式回答期间不再逐字重解析整段 Markdown，结束后再加载 Markdown 渲染器；首屏主包从 643KB（gzip 199KB）降到约 315KB（gzip 102KB）。
- 会话、项目、任务的后台轮询改为 30–60 秒，并继续由事件桥失效刷新；空闲时的重复请求明显减少。

### 更清楚的界面

- 输入区移除常驻的“完全权限”徽标；上下文用量只在真正占用后显示百分比。
- 模型思考强度从三档扩展为五档：极简、低、中、高、极高，每一档附一行说明；模型弹层在输入区右侧完整展开。
- 流式请求现在真正携带 `reasoning_effort`（Chat Completions）与 `reasoning.effort`（Responses），聊天不再忽略界面档位。
- 模型档案把上下文窗口和单次最大输出收进“高级参数”；数据设置的存储位置明细默认折叠。
- 新增统一的淡入、弹出、滑入、呼吸与 shimmer 动画，并在 `prefers-reduced-motion` 下全部关闭。

### 验证

- 全量 `npm test`：140 个测试文件、949 项通过、15 项跳过。
- `npm run typecheck`、Web 生产构建通过；Playwright 截图复核首页、模型弹层、设置页、对话与工作区面板。

## 0.3.4 - 2026-11-23

### 运行时稳定

- 恢复轮次、工具调用、Token、时长预算：默认按执行模式设上限，显式传入的预算仍优先；`unlimited` 不再作为产品默认。
- 持久目标的 `maxGoalRounds` 到顶后进入 `waiting_input`，不再静默继续或直接失败。
- 修复 Codex 子进程环境过滤：只有当前 provider 的密钥可以跨边界，其他 `*_API_KEY` / `*_TOKEN` 不再泄漏。
- 工具副作用拆成业务结果与物理清理两条账：`settled` 不再等于“已经清干净”，终态 run 会真正终止已登记的 shell 进程并把结果写回 `run_operations`。
- 恢复闸门会沿父 run 链检查 prepared/dispatched 操作、运行中后台进程和 checkpoint proof；未知副作用不再自动重放。
- 模型响应被截断且携带工具调用时，整批工具调用丢弃，连续 3 次失败；工具入参按 JSON Schema 校验，非法参数只产生 `tool.rejected`，不写操作账本。
- checkpoint proof 增加 `toolsDigest`，工具集变化在恢复时可见。

### 持久操作账本

- 工具调用增加 T1/T2 持久操作合同：`prepare → dispatch → settle`，未结算的操作在下一进程拒绝自动重放。
- 服务端使用 SQLite `run_operations`（最终 schema v40）作为操作事实源；standalone/评测使用 JSONL ledger。
- 工具超时或任务中止会先触发取消；Windows shell 先枚举并终止子进程树，再返回 `unknown`，避免幽灵副作用。
- 本地写记录执行前文件摘要；外部写必须带回执，缺回执按未知处理并停止 run，等待人工核对。

### 单一事件日志

- 服务端 runtime 不再写 JSONL journal；消息、工具结算、checkpoint 和 run 边界统一写入 SQLite `events`（最终 schema v40）。
- checkpoint 文件降级为物化视图：先写 `runtime.checkpoint.snapshot` 事件，`run_checkpoints.event_seq` 记录快照位置；文件损坏时从事件日志重建。
- 恢复时从 checkpoint 的 `event_seq` 之后回放 runtime 消息，旧版 JSONL checkpoint 仍按原路径兼容。

### 宿主生命周期

- 新增 `HostKernel`：宿主租约、`recovering` 阶段和 `draining` 关闭顺序统一管理；恢复完成前 `/api/ready` 返回 503，任务写路由返回 `HOST_NOT_READY`。
- 宿主租约记录 PID 与进程创建时间，避免 PID 复用导致旧锁误判；`/api/health` 暴露当前启动阶段和租约信息。

### Windows 原生沙箱

- 新增 `hearth-native.exe`（C# 编译，无第三方运行时）：AppContainer package SID、workspace/temp ACL 白名单、kill-on-close Job Object、父进程 watchdog。
- `WindowsNativeSandboxProvider` 取代 ACL runner：默认网络拒绝，子进程只能读写工作区与私有 temp；声明 `networkHosts` 时 fail-closed，helper 缺失时同样 fail-closed。
- 移除服务端旧 `windows-acl` runner 与测试；新增 `npm run test:sandbox` 与 Windows CI 门禁。
- 打包脚本把 helper 复制到桌面资源目录；Windows 沙箱测试最终扩到 12 项，覆盖越界写、只读、junction 逃逸、密钥过滤、网络拒绝、Job 关闭杀子进程和 PTY。

### ConPTY 交互式 shell

- `hearth-native.exe` 新增 `pty` 子命令：在 AppContainer 内用 `CreatePseudoConsole` 启动子进程，保留 Job Object 与父进程 watchdog。
- `shell` 支持 `pty: true`、`cols` / `rows`；新增 `shell_input` 与 `shell_resize`，可向运行中的交互式命令输入、回车和调整控制台尺寸。
- 修复 ConPTY 输入抢占：子进程使用 `STARTF_USESTDHANDLES` + `INVALID_HANDLE_VALUE` 且不继承句柄，整行命令和逐字符输入均可靠。

### 持久后台任务

- 新增 SQLite `background_processes`：记录 session、PID、真实进程创建时间、命令、日志路径、task/run、状态与退出码。
- 宿主启动时扫描 `running` 记录：PID + 创建时间匹配才杀进程树，否则按 PID 复用处理；全部标记 `lost`，不留下幽灵后台任务。
- `shell_output` / `shell_wait` / `shell_kill` 在内存会话不存在时回退到持久注册表与日志文件，并向模型明确报告 `lost`。

### 网络与存储

- 网络权限改为显式 `deny | open`：`deny` 默认拒绝；`open` 在 Windows AppContainer 中加入 `internetClient` capability，并写审计事件与 proof。移除了只会失败的 `--network allow` 死参数。
- 重试不再复制整个 `.hearth`，只继承已发布产物与 checkpoint 引用的 tool-results。
- 新增 `npm run storage:prune`：默认预演，按保留期、活跃 run、未结算操作、checkpoint 引用等 pin 规则回收旧 run 和未引用工具输出；设置页可查看最近一次回收路径。
- `background_processes` 收进 schema v40，迁移与备份不再漏表。

### 证据与评测

- 每个终态 run 输出 `run-evidence.json`，包含 task/run/usage、checkpoint 引用、恢复决策、operations/cleanup、artifacts 和 run 链。
- 长跑矩阵从 12 扩到 18：新增 after-prepare、after-dispatch、mid-tool、after-settle、after-checkpoint、after-cleanup 六个崩溃点，各重复 3 次。
- Windows CI 增加长跑门禁。

### 工程

- 版本统一为 0.3.4；新增跨进程 operations、cleanup 单调性和 Windows 沙箱清理稳定性测试。
- 任务列表、任务详情和“需要你”收件箱页面下线，执行轨迹改为对话内联运行卡；主导航收缩为聊天、资料库、Context。
## 0.3.3 - 2026-11-22

### 执行稳定性

- 原生运行时为 shell、读取等工具引入逐工具超时默认值；失败调用按指数退避自动重试，连续 5 次失败后熔断停止，重试次数与总耗时写入工具事件。
- 重试策略与熔断阈值可在执行器配置中调整；支持 `threshold` 别名；工具报错信息在结果为空时不再丢失。
- 降低默认重试数量并修复停止响应：中止当前轮立即生效，聊天界面显示"停止中"指示。

### 原生执行器

- 任务未声明权限时回退到内置工具集，不再因空权限拒绝执行。
- 支持经审批读取工作区之外的文件；调度器直接读文件不再误发产物发布事件。

### 会话

- 运行轨迹中的交付内容只完整展示一次，不再重复刷屏。
- 任务产物预览新增“另存到”：桌面版可用原生文件夹选择框，把产物保存到桌面或任意目录（执行器写入仍限于任务工作区）。

### 首跑验证

- 新增 `npm run first:run`：用当前配置的模型跑一次真实的"读文件 → 写答案 → 跑测试"最小任务，`--fake` 提供离线自检；配套文档《首次运行验证》。

### 工程与发版

- CI 分层：PR 快速门禁、Windows 编译门禁与夜间长稳测试分开调度。
- 新增单一版本真源脚本 `npm run version:sync`，workspace、Cargo、Tauri 与 lockfile 版本自动对齐。
- 0.3.3 起以 GitHub Pre-release 形式发布安装包、便携包与 SHA256 校验和。

### 桌面版首启

- 移除首启数据目录对话框里写死的开发者私有路径；未设置 `HEARTH_EXISTING_ROOT` 时改为原生文件夹选择框，可浏览选择已有数据根目录，或用默认目录新建。
- 移除 Codex 探测的开发机兜底路径；探测顺序为 `HEARTH_CODEX_PATH` → 系统 PATH。

## 0.3.2 - 2026-11-21

### 会话布局

- 会话区域改为 Codex 式全宽居中布局，输入框整合为一张大卡片，权限、执行器、模型与上下文固定在卡片底部。
- 顶部标题栏增加项目图标和产物入口；右侧窄产物栏改为按需覆盖面板，不再永久占用会话宽度。
- 用户消息改为右对齐圆角块，隐藏旧消息时间戳，减少视觉噪音。

### 执行稳定性

- 修复仓库本身有未提交改动时，原生执行器被误判为“修改了代码”而反复运行测试、无法结束的问题。
- 任务未声明期望产物时默认使用 `result.md`，不再因空产物列表在收尾阶段失败。
- 启动时自动恢复因旧预算或任意未知事件类型失败的任务。

### 清理

- 旧任务里的“执行预算 24/24”、预算错误与 `Unknown event type: job.registered` 不再显示在会话中。

## 0.3.1 - 2026-11-21

### 修复

- 原生执行器不再因数 `job.registered` / `job.settled` 事件解析失败；旧任务会自动重新排队继续。
- 彻底关闭自动执行器切换；失败后只提示手动选择，不再静默改用 Codex。
- 移除会话记录中旧预算进度，历史上 `24/24` 的“执行预算”块不再显示。
- 会话布局对齐 Codex：用户消息靠右，执行轨迹铺满内容区，模型与推理信息固定在输入框右下。
- 输入框左下常显“完全权限”。

## 0.3.0 - 2026-11-21

### 完全权限与稳定执行

- 所有任务默认使用完全权限与 `danger-full-access`，原生工具、外部命令、文件读写和网络不再等待审批。
- 移除预算、轮次、Token 上限和时长限制；旧的 `waiting_budget` / `waiting_approval` 任务会自动重新排队。
- 修复中断后“外部副作用状态未知”导致任务永久失败的问题：现在会核对后继续执行。
- 执行器固定为手动选择，默认原生；切换一次后对所有对话生效，不再自动匹配。

### 会话界面

- 会话区加宽到 1120px 并保持居中。
- 显示当前模型名、推理强度和实时上下文占用；推理强度可即时调整并写入模型请求。
- 思考默认开启，上下文窗口默认 328k。
- 移除“不绑定项目”“新建项目”快捷项。
- 项目浏览改为 Windows 原生文件夹对话框，不再使用应用内目录浏览器。

## 0.2.0 - 2026-11-20

### 可信执行

- 任务详情新增逐轮时间线：文件、增删行数、测试、诊断和失败原因。
- 新增按轮回退；回退前校验文件哈希，用户手改默认拒绝，`force` 才覆盖。
- 新增 `workspace` 审批模式：工作区内可逆文件写入自动执行，外部动作仍需审批。

### 浏览器

- 独立 Chrome profile、多标签页、页面快照、稳定元素 ID。
- 打开、读取、点击、输入、按键、等待、提交、标签页、截图、上传、下载、断言和站点配方共 16 个工具。
- 危险提交单独确认；每次动作保存前后截图和页面摘要；完成前必须有通过的页面断言。
- 新增浏览器面板、设置页、域名授权和本地 fixture 端到端测试。

### 记忆与日常使用

- 项目档案 `PROJECT.md` 与工作方式 `WORKSTYLE.md` 自动注入 coding 提示词。
- 新增“需要你”收件箱和每日回顾；22:00–08:00 不生成新通知。
- 新增本地 dogfood 报告和运行控制台 7 天汇总。

### 首次运行与发布

- 首次启动可跑一个真实工具任务；通过后才标记完成，跳过会保留警告。
- Tauri updater 作为可选 feature；签名变量不全时禁用，不产出坏包。
- 发布脚本生成安装包、便携 zip、发布说明、SHA256 校验和和可选 `latest.json`。
- 0.2.0 NSIS 安装包构建通过（30.5 MiB），打包后的服务端通过 `/api/ready` 启动检查。
- 修复打包：Playwright 未声明的 BiDi 依赖改为惰性桩；sandbox 依赖树改为扁平布局，避开 Windows 路径长度限制；构建前清理 Tauri 暂存资源，避免旧的 `server/node_modules` 进入安装包。
- 文档重写、架构图重绘、CI、commitlint、husky 和 PR 模板。

### 已知限制

- 当前模型 key 无权限，真实模型首跑未验收。
- 日常 Chrome 扩展桥未实现；使用独立 Chrome profile。
- 未做干净机安装/卸载、真实飞书/邮件账户验收和 Windows 代码签名。
- 已签名自动更新未实际发布。

## 0.1.0

首个本地优先 MVP：聊天工作台、任务、审批与效果账本、原生/codex/deepseek-harness 执行器、记忆、邮件、飞书、桌面、定时任务、备份和加密恢复。


# Hearth OS v0.2 一次性完成计划（工程师版）

## 适用说明

本计划同时适用于普通对话与 Plan Mode。Plan Mode 只是“先审后做”的流程控制，不改变执行规则：仍然是 `main` 直改、一个闭环一个 commit、每个 commit 带测试、行为变化同步文档。普通对话中直接执行；Plan Mode 中先提交本计划、等待批准，再按同一套规则执行。

## 1. 设计

### 1.1 目标

把 Hearth 从“能力很多但缺少真实使用验证的 Agent 框架”推进到“每天能用、出事能倒带、浏览器能替人办事的个人 Agent”。

六个可验证结果：

1. 浏览器可打开、读取、点击、输入、切标签、上传下载、等待、断言、接管、录制回放站点流程；高风险动作逐次审批，动作有截图与回放证据。
2. 任务详情有逐轮时间线：第几轮、改了哪些文件、增删行数、跑了什么测试、诊断结果、能否回退；一键 rewind。
3. coding 任务在 `workspace-write` 沙箱内自动执行；shell、邮件、桌面、陌生域名仍按风险审批。
4. 每个项目一页档案，外加一页“我的工作方式”，自动编译并注入 coding prompt。
5. 固定模型/预算的 harness bench + 每版回归 + 公开报告；harness 分与 model 分分开。
6. 首次启动跑一个真实示例任务；Tauri 自动更新；长任务状态推送；每周 dogfood 报告。

### 1.2 非目标

- 自研推理引擎 / PolyStrata 式模型-硬件协同。
- 多人 Rooms / 账号体系 / 多租户。
- 语音会议、手机真机推送。
- 继续扩张执行器数量。

### 1.3 架构决策

- **原生运行时保持双 profile**：`general` 维持办公/文档行为；`coding` 启用仓库提示、较大预算、编辑/搜索/shell/计划/验证/快照。
- **浏览器作为原生工具面的一等公民**：独立 Chrome 配置目录，`playwright-core` 驱动；模型只看到压缩后的可交互元素清单与稳定 ID，不接触 cookie/密码/整页 HTML。
- **浏览器动作纳入现有治理链**：新增 `browser` action kind，走 `action-resolver`、审批、效果账本、证据事件；高风险动作逐次审批，页面变化使旧审批失效。
- **审批模式增加 `workspace`**：工作区内可逆写自动放行并留痕；shell、external、high risk 仍请求审批。避免用 `full` 一刀切导致外部动作失控。
- **逐轮历史复用现有快照**：`out/<runId>/.hearth/file-history/turn-N/manifest.json` 与 `snapshots/` 作为唯一事实源；服务端只读解析，rewind 前做 `afterHash` 漂移校验。
- **档案用文件而非新数据库表**：项目档案写 `DATA_DIR/dossiers/<projectId>/PROJECT.md`，工作方式写 `DATA_DIR/profile/WORKSTYLE.md`；可读、可编辑、可版本化。
- **数据库只做 additive migration**：`CURRENT_SCHEMA_VERSION` 33 → 34，新增 `browser_grants` 等表；不删除/重命名已有列。

### 1.4 新文件地图

```text
apps/server/src/
  browser-service.ts          Chrome 启动、profile、健康检查
  browser-session.ts          每任务页面、标签页、接管、空闲回收
  browser-snapshot.ts         可访问性树/交互元素 → 稳定 ID、脱敏、截图
  browser-tools.ts            browser_open/read/click/type/key/wait/tabs/upload/download/assert/submit
  browser-evidence.ts         截图、页面摘要、动作指纹、保留策略
  browser-recipes.ts          站点配方录制/回放
  browser-bridge.ts           日常 Chrome 扩展的本地 WebSocket 桥
  task-history.ts             逐轮 manifest 解析、验证汇总、rewind
  dossier.ts                  项目档案编译与存储
  workstyle.ts                我的工作方式档案
apps/web/src/
  components/TurnTimeline.tsx
  components/BrowserPanel.tsx
  pages/DossierPage.tsx
  pages/BrowserPage.tsx
apps/browser-bridge/          未打包 Chrome 扩展（MV3）
scripts/
  dogfood-report.ts
  release.mjs
docs/
  scope.md
  design/browser.md
  evaluation/harness.md
.github/workflows/
  ci.yml
  bench.yml
```

### 1.5 提交序列

#### A 基线门禁（3 个 commit）

| # | Commit | 改动 | 验收 |
|---|---|---|---|
| A0 | `chore(repo): commit the in-flight de-scoping changes` | 先看工作区：当前未提交的 templates 删除、scheduler/workspace 简化。若自洽，合成一个 `refactor(templates): remove task templates`；若不自洽，先 stash，回到干净 `c912252` 再逐项重做。 | `git status` 干净；`npm ci` 后 `npm run typecheck` 和 `npm test` 通过。 |
| A1 | `fix(build): clear typecheck and test debt left by de-scoping` | 清理被删模块的残留 import/测试/依赖：`@hearth/templates`、`methods`、`skills`、`sync`、`connections`、`eval-routes`、外部执行器。修掉 pdfjs 类型和 MCP 隐式 any。 | `npm run typecheck` 0 error；`npm test` 全绿；无 skipped。 |
| A2 | `chore(ci): add typecheck, test, build and docs workflow` | `.github/workflows/ci.yml`：Node 22、`npm ci`、`npm run typecheck`、`npm test`、`npm run build`、`npm run docs:build`；并发取消、npm 缓存、失败上传日志。 | GitHub Actions 在 main 上绿；单次 < 15 分钟。 |

#### A 真相与文档（4 个 commit）

| # | Commit | 改动 | 验收 |
|---|---|---|---|
| A3 | `docs(readme): rewrite the capability table for the current code` | README 按现存模块重写：聊天工作台、general/coding 双 profile、goal/evidence、approval/effect、knowledge、memory、browser、mail、Feishu、desktop、schedules、backups。删掉 7 执行器/技能包/方法进化/多设备同步/评测桥接。重画架构与流程图。 | README 不再出现已删能力；图片链接可用；快速开始可复现。 |
| A4 | `docs(site): archive removed subsystems and publish the current scope` | 新增 `docs/scope.md`；把讲已删能力的文档移到 `docs/archive/` 并写索引；更新 `.vitepress/config.mts` 侧边栏；更新 `docs/delivery/status.md`。 | `npm run docs:build` 通过；侧边栏无死链；archive 索引完整。 |
| A5 | `docs(architecture): regenerate diagrams for the two-profile runtime` | 更新 `assets/*.svg`、`scripts/render-*.cjs`、README mermaid：去掉外部执行器/同步，加入 coding harness、browser、turn history。 | 三张图可渲染；图中无已删模块。 |
| A6 | `chore(git): enforce conventional commits and add a PR checklist` | `commitlint.config.mjs`、`.husky/commit-msg`、`.github/pull_request_template.md`；PR 模板含测试命令、数据迁移、安全影响。 | 非法 commit message 被拒；模板出现在新 PR。 |

#### B 可信执行界面（7 个 commit）

| # | Commit | 改动 | 验收 |
|---|---|---|---|
| B1 | `feat(history): parse per-turn file manifests into task turn views` | 新增 `task-history.ts` 与 core 类型 `TaskTurnView`/`TaskTurnFile`；扫描 `out/<runId>/.hearth/file-history/turn-*/manifest.json`，输出 run、attempt、turn、文件、增删行、created、snapshot 可用性。 | 单元测试覆盖正常、空 manifest、缺失快照、跨 run。 |
| B2 | `feat(native): persist tool metadata in native events` | `captureNativeEvent` 的 `tool.finished` provenance 增加 `failedTests`、`diagnostics`、`exitCode`、`filesChanged`、`insertions`、`deletions`、`snapshotIds`、`browserAssertions`。 | 事件写入测试；旧事件读取不受影响。 |
| B3 | `feat(api): add GET /api/tasks/:id/turns` | 路由返回 `{ runs, turns }`；turn 内合并文件历史 + 测试/诊断 + 失败信息；限制最多 100 轮。 | API 测试：无任务 404、空任务空列表、正常任务字段完整。 |
| B4 | `feat(rewind): add server-side turn rewind with drift guard` | `rewindTaskTurn(taskId, runId, turn, { force })`：读 manifest；逐文件校验当前 hash 是否等于 `afterHash`；漂移时 409；`force` 才覆盖；创建的文件按 afterHash 校验后删除；写 `task.turn.rewound` 事件。 | 测试：正常回退、用户改动拒绝、force 覆盖、快照缺失、部分失败报告。 |
| B5 | `feat(api): add POST /api/tasks/:id/rewind` | 请求体 `{ runId, turn, force? }`；返回回退报告与刷新后的 turn；错误码 `TURN_NOT_FOUND`、`HISTORY_DRIFT`、`SNAPSHOT_MISSING`。 | API 测试覆盖三种错误码。 |
| B6 | `feat(web): add a turn timeline with one-click rewind` | `TurnTimeline.tsx`；TaskDetail 在「结果」和「执行过程」之间插入；每轮显示文件、+/-、测试、诊断、失败；回退按钮二次确认；漂移时提示「文件已被改动」。 | 组件测试或 E2E：渲染、展开文件、回退成功、漂移提示。 |
| B7 | `feat(web): show a task outcome card in chat` | Chat 任务卡显示 verdict、变更文件数、测试状态、耗时/token、打开详情、回退入口。 | E2E：完成一个 fixture 任务后卡片字段正确。 |

#### C 默认值与审批（4 个 commit）

| # | Commit | 改动 | 验收 |
|---|---|---|---|
| C1 | `feat(policy): add workspace approval mode for reversible in-workspace actions` | `ApprovalMode` 增加 `workspace`；`approvalModeForTask` 映射为 permissionMode `workspace`；`authorizeNativeTool` 解析 action 后：低风险/工作区内写自动放行并记 `approval.auto_approved`，shell/external/high risk 仍请求审批。 | 测试：工作区写自动、shell 审批、external 审批、full 仍全自动、read-only 拒绝。 |
| C2 | `feat(tasks): default coding and workspace tasks to workspace approval` | 创建 workspace/coding 任务时 `permissions.approvalMode = "workspace"`；聊天计划与任务提案同步；scheduled/delegated 保持 necessary，除非显式预授权。 | 测试：新 workspace 任务默认 workspace；scheduled 任务仍 necessary；旧记录不受影响。 |
| C3 | `feat(web): explain approval and sandbox modes in plain language` | TaskDetail/Chat 头部 badge：`沙箱：工作区可写`、`审批：工作区自动/必要/完全`；tooltip 写明「不会自动发邮件/动桌面/访问新域名」。 | 组件测试；截图检查。 |
| C4 | `test(policy): cover workspace approval boundaries` | 新增/扩充 `action-resolver.test.ts`、`approvals.test.ts`、`scheduler.test.ts`：越界路径、非交互 scheduled、preauthorized、参数变化后失效。 | 全绿；不降低现有审批覆盖。 |

#### D 浏览器自动化（17 个 commit）

| # | Commit | 改动 | 验收 |
|---|---|---|---|
| D1 | `chore(browser): add playwright-core and browser data paths` | `apps/server/package.json` 加 `playwright-core`；`config.ts` 加 `BROWSER_DIR`、`BROWSER_PROFILE_DIR`、`BROWSER_EVIDENCE_DIR`、`BROWSER_RECIPE_DIR`、`BROWSER_BRIDGE_PORT`；`.env.example` 加 `HEARTH_BROWSER`、`HEARTH_BROWSER_BRIDGE`。 | 依赖安装成功；默认路径在 `.hearth/browser/` 下。 |
| D2 | `feat(browser): add BrowserService with an isolated Chrome profile` | `browser-service.ts`：探测 Chrome/Edge/Chromium；`launchPersistentContext(profileDir, { channel:"chrome", headless:false })`；启动/健康/关闭；日志脱敏。 | 单测用 fake launcher；真实 smoke：`npx tsx` 启动窗口并关闭。 |
| D3 | `feat(browser): add per-task sessions and idle lifecycle` | `browser-session.ts`：每任务一个 page；tab 所有权；最多 4 个并发 session；空闲 10 分钟关闭；任务取消/结束关闭；应用退出清理。 | 单测：复用、上限、超时回收、异常关闭。 |
| D4 | `feat(browser): add compact page snapshots with stable element refs` | `browser-snapshot.ts`：URL、title、可访问性树、交互元素（`e1`…）、role/name/value/disabled/checked/bbox；password 值脱敏；页面摘要 digest；截图可选；12k 字符上限。 | 单测 fixture HTML：元素 ID 稳定、密码不泄露、超长截断。 |
| D5 | `feat(browser): add open, read, click, type, key and wait tools` | `browser-tools.ts` 核心 6 个工具；`browser_open` 域名检查；`browser_click` 识别 submit/pay/delete/send 类元素时拒绝，要求 `browser_submit`；`browser_type` 拒绝 password 字段；`browser_wait` 支持 element/text/idle。 | 单测：正常点击、危险元素拒绝、密码拒绝、等待超时。 |
| D6 | `feat(browser): add tabs, screenshot, upload and download tools` | `browser_tabs`（list/new/activate/close）、`browser_screenshot`、`browser_upload`（只允许工作区内路径）、`browser_download`（落到 `out/browser-downloads/`）。 | 单测：标签页切换、上传越界拒绝、下载落盘。 |
| D7 | `feat(browser): add page assertions and require them before finish` | `browser_assert` 支持 text/url/element/no-element；结果写 metadata；浏览器任务 `finish_task` 前至少一次断言通过，失败断言阻止完成。 | 单测：断言通过/失败；finish 校验拒绝。 |
| D8 | `feat(policy): add browser action kind and risk mapping` | `action-resolver.ts`：`browser` 加入 `ACTION_KINDS`；`BrowserTarget` 含 url/tabId/elementId/action/inputDigest/pageDigest/screenshotDigest；只允许 http/https；`defaultRisk`：read低、open/type/click中、submit/upload高；`buildPreview`。 | 单测：非法 scheme 拒绝、风险分级、digest 稳定。 |
| D9 | `feat(browser): require approval for new domains and irreversible submits` | `tool-policy.ts` 把 `browser_open`、`browser_submit`、`browser_upload` 加入审批；`browser_grants` 表（migration 34）存 domain/scope/expiresAt/maxUses；审批卡片支持「仅本次/该域名始终允许」；页面变化使旧审批失效。 | 测试：新域名审批、授权复用/过期、页面变化后拒绝、submit 每次审批。 |
| D10 | `feat(browser): record screenshot evidence for every mutating action` | `browser-evidence.ts`：动作前后截图、URL、pageDigest、actionDigest、结果；写 `browser.evidence` 事件；`GET /api/tasks/:id/browser/evidence/:name` 做路径校验；保留 7 天/500 张。 | 测试：事件字段、路径穿越拒绝、清理策略。 |
| D11 | `feat(web): add a browser panel and screenshot approval preview` | `BrowserPanel.tsx`：当前标签、URL、最后截图、打开/关闭、暂停/继续、接管；ApprovalCard 显示截图 + 目标元素 + 域名 + 风险。 | E2E：fixture 站点打开、点击、审批卡出现截图。 |
| D12 | `feat(browser): add takeover and resume` | 服务端 pause/resume 状态；暂停时工具返回「等待用户接管」；用户操作真实 Chrome 窗口；resume 重新 snapshot；写事件。 | 单测：暂停阻塞、恢复同步；E2E：接管按钮。 |
| D13 | `feat(browser): add recordable site recipes` | `browser-recipes.ts`：成功流程可保存为 `{domain, steps, assertions}`；`browser_recipe` 工具按参数回放；失败时逐步截图；UI 列表与删除。 | 单测：录制/回放/选择器回退；E2E：同一表单第二次用 recipe。 |
| D14 | `feat(browser): add a parallel tab pool with per-task isolation` | 单 Chrome context 多 page；任务队列；每个任务只操作自己的 page；上限 4；任务结束释放。 | 单测：两个任务互不串页；并发上限；取消释放。 |
| D15 | `feat(browser-bridge): add a Chrome extension bridge for the daily profile` | `apps/browser-bridge/` MV3 扩展 + `browser-bridge.ts` 本地 WebSocket；token 鉴权；支持 tabs/snapshot/click/type/screenshot；设置页显示安装步骤与 token；不读取 cookie。 | 单测：协议握手、token 拒绝、命令映射；手动：加载未打包扩展连上日常 Chrome。 |
| D16 | `feat(browser): add domain policy settings and per-site rules` | 设置页：启用浏览器、允许域名、只读域名、高风险站点（支付/邮箱/后台）永远人工、每任务覆盖；域名匹配支持子域；默认拒绝。 | 单测：域名匹配、子域、策略优先级；设置持久化。 |
| D17 | `test(browser): add a fixture-site end-to-end suite` | `e2e/browser-fixture/` 本地 HTML：登录表单、列表、上传、下载、提交成功页；Playwright 跑 open/read/click/type/upload/download/assert/submit/rewind；不访问外网。 | `npm run test:e2e` 全绿；无网络依赖。 |

#### E 项目档案与工作方式（5 个 commit）

| # | Commit | 改动 | 验收 |
|---|---|---|---|
| E1 | `feat(memory): add project dossier storage and schema` | `dossier.ts`：`DATA_DIR/dossiers/<projectId>/PROJECT.md` + `dossier.json`；分节：概览、技术栈、命令、约定、决策、未完成任务、坑、证据链接。 | 单测：创建、读取、损坏文件回退。 |
| E2 | `feat(memory): compile dossiers from tasks and repository memory` | 任务完成后与每日维护时增量编译；来源：task 结果、goal 决策、repo `.hearth/memory`、项目文件；每条带来源与时间；无模型也能跑，模型只做可选摘要。 | 单测：增量去重、来源保留、预算上限。 |
| E3 | `feat(memory): add a work-style profile` | `workstyle.ts`：`DATA_DIR/profile/WORKSTYLE.md`；分节：沟通偏好、提交习惯、验证命令、不要动的目录、工具偏好；API `GET/PUT /api/profile/workstyle`。 | 单测：读写、长度限制、注入版本。 |
| E4 | `feat(runtime): inject dossier and work style into the coding prompt` | coding prompt 增加 `project dossier` 与 `work style` 两节；按 token 预算裁剪；只注入当前项目；优先级低于目标/约束，高于普通历史。 | prompt 单测：节顺序、预算裁剪、无档案时不出现空节。 |
| E5 | `feat(web): add a dossier page and work-style editor` | `DossierPage.tsx`：项目选择、分节展示、来源链接、重新编译、编辑工作方式；导航加入「档案」。 | E2E：打开项目档案、编辑保存、重新编译。 |

#### F 基准与公开成绩单（4 个 commit）

| # | Commit | 改动 | 验收 |
|---|---|---|---|
| F1 | `feat(bench): add harness score schema, baseline and regression threshold` | `scripts/bench/aci-bench.ts` 输出固定 schema；`eval/aci/baseline.json`；`npm run bench:aci -- --check` 超过阈值失败；报告写 commit/model/budget。 | 本地跑通；阈值测试。 |
| F2 | `feat(bench): add public suite metadata and resumable runner` | `run-suite.ts` 增加 model、commit、contextWindow、budget、per-task timeout、resume；输出 JSON + Markdown；失败任务单独列出。 | 单测：resume、超时、报告字段。 |
| F3 | `ci(bench): add manual and weekly benchmark workflow` | `.github/workflows/bench.yml`：`workflow_dispatch` + 每周；secret 注入；artifact 上传；不在 PR 上烧钱。 | 手动触发成功；报告可下载。 |
| F4 | `docs(eval): publish harness methodology and the latest scorecard` | `docs/evaluation/harness.md`：测试方法、模型/预算、harness vs model 分离、失败项、复现命令；README 放最新成绩 badge。 | 文档构建通过；数字与报告一致。 |

#### G 首跑、更新与分发（4 个 commit）

| # | Commit | 改动 | 验收 |
|---|---|---|---|
| G1 | `feat(onboarding): add a first-task verification endpoint` | `POST /api/onboarding/verify`：用内置 fixture 让当前模型改一个文件、跑一次测试、返回 diff 和结果；跑通才写 `onboarding.v1` 完成；失败返回可操作原因。 | 用 fake model 测成功/失败；真实模型手动 smoke。 |
| G2 | `feat(web): rebuild onboarding around the first real task` | OnboardingPage：服务商 → 模型 → 跑示例 → 看 diff/测试 → 完成；失败给「换模型/换执行器/跳过」三条路；跳过要明确警告。 | E2E：成功路径、失败路径、跳过路径。 |
| G3 | `feat(desktop): enable Tauri updater and signed artifacts` | `tauri.conf.json` 加 updater 插件、pubkey、endpoints、`createUpdaterArtifacts: true`；`build-tauri.mjs` 注入签名环境变量；没有证书时明确警告并禁用 updater，不产出坏包。 | 配置 schema 校验；`npm run tauri:build` 成功；无证书时不声称可更新。 |
| G4 | `feat(release): add checksums, portable zip and release notes` | `scripts/release.mjs` 生成 `SHA256SUMS.txt`、portable zip、release notes 模板；README 安装说明同步。 | 本地生成校验和；zip 可解压运行。 |

#### H 主动监督与 dogfood（5 个 commit）

| # | Commit | 改动 | 验收 |
|---|---|---|---|
| H1 | `feat(proactive): add task supervision triggers` | 新增触发器：`task.long_running`、`task.budget_near_limit`、`task.waiting_approval_too_long`、`task.failed`；去重、冷却、安静时段；接入 attention governor。 | 单测：触发/去重/安静时段/预算。 |
| H2 | `feat(proactive): add a daily digest` | 每天 08:00 汇总昨日完成任务、未完成任务、待审批、失败任务；最多 3 条建议；可关闭。 | 单测：时区、空数据、上限。 |
| H3 | `feat(web): add a notification center and digest card` | Inbox/首页显示未读、标记已读、稍后、忽略；digest 卡片。 | E2E：生成、标记、消失。 |
| H4 | `feat(dogfood): add a usage report generator` | `scripts/dogfood-report.ts` 用 `node:sqlite` 读事件/任务/运行：任务数、成功率、首次通过率、人工接管、平均轮次/工具/token、回滚次数、最常失败工具；输出 Markdown + JSON。 | fixture DB 单测；真实库手动生成。 |
| H5 | `feat(dogfood): add a usage dashboard and weekly ritual doc` | `/api/stats/dogfood` + Operations 卡片；`docs/log/dogfood-baseline.md` 写清指标定义和每周五更新流程。 | API 测试；页面渲染；文档链接。 |

#### I 最终验收（3 个 commit）

| # | Commit | 改动 | 验收 |
|---|---|---|---|
| I1 | `test(e2e): extend the suite for timeline, rewind, onboarding and browser` | `scripts/e2e.mjs` 增加四个场景：turn timeline、rewind 漂移拒绝、onboarding 示例任务、浏览器 fixture。 | `npm run test:e2e` 全绿。 |
| I2 | `docs(release): add the v0.2 acceptance report and known limits` | `docs/delivery/acceptance-2026-11.md`：测试矩阵、手动检查、未完成项、风险；README 状态更新。 | 文档构建通过；内容与实测一致。 |
| I3 | `chore(release): bump version to 0.2.0` | 根/各 workspace/tauri 版本；CHANGELOG；README badge。 | `npm run build`、`npm run tauri:build` 通过。 |

### 1.6 执行顺序

- 串行主干：A0 → A1 → A2 → A3 → A4 → A5 → A6 → B1…B7 → C1…C4 → D1…D17 → E1…E5 → F1…F4 → G1…G4 → H1…H5 → I1…I3。
- 文档类只读工作可在 A2 后并行起草，但按顺序提交。
- 浏览器 D 段最长：D1–D10 完成后再动 D11–D17，避免界面反复改。
- 每完成一个 workstream 跑一次全量 `npm test` 并记录通过数。

## 2. 测试

### 2.1 每个 commit 的门禁

- `npm run typecheck` 0 error。
- `npx vitest run <相关测试文件>` 全绿。
- 涉及前端时 `npm run build` 通过。
- commit message 符合 Conventional Commits；正文写 why + 测试命令。

### 2.2 全量门禁

- `npm test` 全绿，记录测试文件/用例数。
- `npm run typecheck` 0 error。
- `npm run build` 通过。
- `npm run docs:build` 通过。
- `npm run test:e2e` 通过（含浏览器 fixture）。
- `npm run bench:aci -- --check` 不低于 baseline 阈值。

### 2.3 分工作流测试

- **A 基线/文档**：CI 在 main 上绿；README 无已删能力；docs 侧边栏无死链；commitlint 拒绝非法 message。
- **B 可信执行**：manifest 解析正常/空/缺失/跨 run；rewind 正常/漂移拒绝/force/快照缺失/部分失败；turns API 字段完整；时间线渲染与回退；Chat 结果卡字段。
- **C 审批**：workspace 写自动、shell 审批、external 审批、full 全自动、read-only 拒绝；scheduled 非交互仍审批；参数变化使审批失效。
- **D 浏览器**：元素 ID 稳定、密码脱敏、危险点击拒绝、上传越界拒绝、下载落盘、断言阻断 finish、非法 URL 拒绝、风险分级、域名授权复用/过期、页面变化失效、证据路径穿越拒绝、暂停阻塞/恢复同步、配方回放、并行隔离、扩展桥 token 拒绝、fixture E2E。
- **E 档案**：创建/读取/损坏回退；增量去重/来源保留/预算；workstyle 读写/长度；prompt 节顺序/裁剪/无档案不出现空节；页面打开/编辑/重编译。
- **F 基准**：schema/阈值；resume/超时/报告字段；workflow 手动触发；文档数字一致。
- **G 首跑**：verify 成功/失败；onboarding 三条路径；tauri 配置校验；checksums/zip。
- **H 监督**：触发/去重/安静时段/预算；digest 时区/空数据/上限；通知已读/忽略；dogfood 指标定义与 fixture DB。
- **I 验收**：E2E 四场景；文档与实测一致；版本/CHANGELOG/构建。

### 2.4 手动验收

- 浏览器：打开 fixture → 读取 → 点击 → 输入 → 上传 → 下载 → 断言 → 提交审批 → 截图证据可查。
- 浏览器：新域名审批一次/始终允许；页面变化后旧审批失效。
- 浏览器：接管按钮可用，用户点完后 resume 能继续。
- 浏览器：站点配方第二次回放成功。
- 任务详情：逐轮时间线、+/-、测试结果、rewind、漂移拒绝。
- coding 任务默认 workspace 审批；shell 不反复弹窗；外部动作仍弹窗。
- 首次启动：示例任务跑通、看到 diff、完成 onboarding。
- 长任务：完成/失败/预算将尽/等待审批有通知。
- dogfood 报告能生成并包含 7 个核心指标。

### 2.5 安全验收

- 页面快照不含 cookie/密码/localStorage。
- 证据路径不能穿越到 `.hearth/browser` 之外。
- `HEARTH_BROWSER=0` 时浏览器工具不出现。
- kill switch 仍然阻断所有任务。
- 浏览器高风险管理动作逐次审批，审批参数变化失效。

## 3. 执行约定

- 只改 `main`，不建 feature branch。
- 一个闭环一个 commit；实现、测试、必要文档同 commit。
- 数据库只做 additive migration：`CURRENT_SCHEMA_VERSION` 33 → 34。
- API 只新增，不改已有响应字段语义。
- 行为变化必须同 commit 更新 README/docs。
- 每个 workstream 完成后更新任务状态；最终全部任务完成后交付验收报告。

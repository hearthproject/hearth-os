# Hearth OS 桌面版 v0.1 修改计划

> 状态：Tauri 版已构建并完成安装验证  
> 分支：`feat/desktop-tauri`  
> 基线：Windows x64，先自用，后续演进为可公开下载的正式版

---

## 0. 当前状态

桌面外壳已从 Electron 迁移到 **Tauri + 独立 Node 运行时 + 精简服务端**。Electron 版本的 `feat/desktop-v0.1` 保留作为回退，不再继续开发。

当前已落地：

- Tauri 2 主进程：单实例、splash、拉起 Node 子进程、`/api/ready` 就绪探针、关窗进托盘、托盘退出、日志、退出清理；
- 独立 `node.exe` 运行时，保留 `process.execPath` 语义，外部执行器子进程可继续工作；
- 服务端继续使用现有 Fastify，固定 `127.0.0.1:4317`；
- 打包服务端依赖，保留 native、Codex、DeepSeek Harness、Hermes、Qoder、WorkBuddy、Kimi 适配器；
- 打包 npm 运行时，托管执行器安装不再依赖用户系统 Node/npm；
- 桌面导航放行只允许 loopback `GET /`，其余跨站请求仍按原安全策略拒绝；
- NSIS 安装包已构建：`Hearth_0.1.0_x64-setup.exe`，约 **40.6 MiB**；
- 已安装到测试目录并通过 `/api/ready`、`/`、`/api/executors` 验证。

当前体积事实：

| 项目 | 体积 |
| --- | --- |
| NSIS 安装包 | 40.6 MiB |
| 安装后原始占用 | 约 280 MiB |
| Tauri 主程序 | 8.9 MiB |
| Node 运行时 | 约 83 MiB |
| 服务端 + npm | 约 187 MiB |
| Web 静态资源 | 3.7 MiB |

“100MB 以内”目前对**安装包**成立；安装后原始占用仍高于 100MB，主要来自 Node 运行时和完整服务端依赖。若要求安装后也低于 100MB，必须进一步裁剪依赖或改为运行时按需下载，详见第 8 节。

---

## 1. 目标

把 `D:\App\hearth-os` 现有能力装进一个 Windows 桌面应用，满足这一条黄金路径：

> 下载安装包 → 双击安装（不弹 UAC）→ 桌面图标启动 → 10 秒内出窗口 → 直接看到现有会话和任务 → 发一句话能正常回复 → 关窗进托盘、服务端继续跑 → 再次打开状态还在。

v0.1 的“完成”不是“能打开一个窗口”，而是：

1. 打包后的应用不再依赖仓库目录、`tsx`、`npm run dev`；
2. 现有 `.hearth` 数据、`master.key`、模型配置、任务都能继续用；
3. 关窗不杀服务，托盘退出才杀；异常退出后能重启；
4. 安装包可重复安装/卸载，不破坏数据；
5. native 与 Codex 能用；Qoder/WorkBuddy/Kimi/DSH/Hermes 的适配器与安装入口保留。

---

## 2. 已锁定决策

| 项目 | 结论 |
| --- | --- |
| 平台 | 只做 Windows x64 |
| 外壳 | Tauri 2 + WebView2 |
| 服务端 | 现有 Fastify，独立 `node.exe` 子进程运行 |
| 端口 | 固定 `127.0.0.1:4317`，不做动态 fallback |
| 数据目录 | 默认 `%LOCALAPPDATA%\Hearth`；开发/迁移时可用 `HEARTH_ROOT` 就地使用现有目录 |
| 安装方式 | NSIS 按用户安装（免 UAC） |
| 生命周期 | 单实例、关窗进托盘、服务端常驻、托盘退出时清理子进程与锁 |
| 执行器 | native、Codex、DSH、Hermes、Qoder、WorkBuddy、Kimi 适配器全部保留；Codex SDK JS 内置，平台二进制按需 |
| 签名/自动更新 | v0.1 不做；正式版再补 |
| 验收 | 以黄金路径为准，不以“开发模式能跑”为准 |

### 2.1 为什么不是 Electron / 不是纯 Node SEA

- Electron 安装后约 552MB，且 `ELECTRON_RUN_AS_NODE` 的 `process.execPath` 语义与独立 Node 不同；继续压缩空间有限。
- 纯 Node SEA 的 `process.execPath` 是 SEA 主程序，不能直接当 `node.exe` 执行任意 Node 脚本；Qoder、WorkBuddy、Kimi、DSH、Hermes 等外部执行器会因此失效。
- 因此选择 Tauri 壳 + 独立 Node 运行时：外壳小、启动快，服务端与执行器保持 Node 语义。

### 2.2 安全取舍

- 保留 loopback Host 校验与跨站写请求拦截；
- 仅对桌面壳顶层导航放行 `GET /`（loopback），用于 Tauri 从 splash 跳转；
- 不通过关闭 Origin 校验来换兼容性。

---

- 代码签名、EV 证书、Azure Trusted Signing；
- 内置 Git / gh / MinGit；
- 首次启动自动复制旧数据；
- 把 Codex/DeepSeek 的平台二进制塞进安装包；
- 把开发依赖（VitePress、Mermaid、Playwright、Vite）打进安装包；
- 重写前端或后端架构。

---

## 4. 运行时布局

### 4.1 安装目录

```text
%LOCALAPPDATA%\Programs\Hearth\
  Hearth.exe
  resources\
    app.asar                 # main / preload / 桌面壳代码
    web\                     # apps/web/dist 的构建产物
      index.html
      assets\...
    server\
      server.mjs             # esbuild 打出的服务端入口
      node_modules\          # 仅核心运行时依赖
    helper\
      helper.mjs
      windows.ps1
      helper.cmd
```

### 4.2 数据与配置

```text
数据目录（默认就地使用）:
  D:\App\hearth-os\.hearth\
    hearth.sqlite
    hearth.sqlite-wal
    master.key
    model-settings.json
    executor-settings.json
    workspaces\
    worktrees\
    artifacts\
    ...

桌面配置:
  %LOCALAPPDATA%\Hearth\desktop.json

日志:
  %LOCALAPPDATA%\Hearth\logs\main.log
  %LOCALAPPDATA%\Hearth\logs\server.log
```

`desktop.json` 只存桌面壳自己的选择，不存业务配置：

```json
{
  "version": 1,
  "root": "D:\\App\\hearth-os",
  "dataDir": "D:\\App\\hearth-os\\.hearth",
  "lastLaunchAt": "2026-11-18T10:00:00.000Z"
}
```

---

## 5. 环境变量与启动不变量

### 5.1 新增/使用的环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `HEARTH_ROOT` | 仓库根（开发）/ 数据根（打包后） | 所有相对路径的锚点 |
| `HEARTH_DATA_DIR` | `HEARTH_ROOT\.hearth` | SQLite、密钥、工作区、产物 |
| `HEARTH_WEB_DIST` | 开发：`HEARTH_ROOT\apps\web\dist`；打包：`resources\web` | 静态前端 |
| `HEARTH_PORT` | `4317` | 固定端口；桌面壳强制传 4317 |
| `HEARTH_DESKTOP` | 未设置 | 桌面模式标记，前端据此禁用 Service Worker、改文案 |
| `HEARTH_CODEX_PATH` | 空 | 系统 `codex.exe` 路径；不传则 Codex 不可用 |

### 5.2 启动不变量

在 `apps/server/src/config.ts` 里集中校验，启动即失败并给出中文错误：

1. `HEARTH_DATA_DIR` 必须严格等于 `path.join(HEARTH_ROOT, ".hearth")`。
   - 原因：历史任务的 `task.outputDir` 存的是 `.hearth/artifacts/<id>`；如果数据目录改成 `data` 或别的名字，旧任务路径全部失效。
2. `HEARTH_DATA_DIR` 必须位于 `HEARTH_ROOT` 内，禁止 `..` 逃逸。
3. `HEARTH_WEB_DIST\index.html` 必须存在；否则启动时报“前端未构建”，不要静默返回 404。
4. 同一数据目录同时只允许一个 Hearth 进程（C4 加锁）。
5. 端口固定 4317；被占用时桌面壳提示，不自动换端口。

---

## 6. 提交序列

原则：

- 每个 commit 是一个闭环：能单独构建、能单独验收、能单独回滚；
- 不把“重构”和“行为变更”混在一个 commit；
- 每个 commit 至少通过 `npm run typecheck` + 对应测试；
- 提交信息用约定式前缀：`feat` / `fix` / `refactor` / `build` / `test` / `docs`；
- 如果某个闭环验收后发现缺陷，新增一个 `fix` commit，不改写已合并历史。

分支：

```powershell
git switch -c feat/desktop-tauri
```

Tauri 提交图：

```text
T1 Tauri 壳 + Node 服务端监管
 └─ T2 轻量就绪探针
     └─ T3 资源路径/桌面导航放行
         └─ T4 Tauri 构建流水线 + npm 运行时
```

> 第 6 节下半部分 C1–C12 是 Electron 阶段的历史记录，保留用于回退和对照；当前 Tauri 实现以 T1–T4 为准。

---

### C1 — `feat(server): 引入 HEARTH_ROOT 与数据根不变量`

**闭环定义**：服务端可以在“仓库根”和“打包根”两种布局下启动，开发模式行为不变。

**主要改动**

- `apps/server/src/config.ts`
  - 新增 `HEARTH_ROOT`：默认由 `import.meta.url` 推导，支持 `HEARTH_ROOT` 覆盖；
  - `DATA_DIR` 改为 `HEARTH_DATA_DIR` 或 `join(HEARTH_ROOT, ".hearth")`；
  - `WEB_DIST` 改为 `HEARTH_WEB_DIST` 或 `join(HEARTH_ROOT, "apps/web/dist")`；
  - 新增 `assertRootLayout()`：校验 `.hearth` 精确匹配、目录不逃逸、`index.html` 存在；
  - 启动时调用，失败直接抛出中文错误。
- `apps/server/src/app.ts`
  - 产物删除路径 `resolve(REPO_ROOT, ".hearth", "artifacts", task.id)` 改为 `resolve(ARTIFACT_DIR, task.id)`；
  - 其余 `REPO_ROOT` 用法保持不变，因为 `HEARTH_ROOT` 已经替代了它的语义。
- `apps/server/src/config.test.ts`（新增）
  - 默认开发根 = 仓库根；
  - `HEARTH_ROOT` + `HEARTH_WEB_DIST` 覆盖生效；
  - `HEARTH_DATA_DIR` 不在根内 / 不是 `.hearth` 时抛错；
  - Windows 路径分隔符和 `..` 逃逸用例。

**测试**

```powershell
npx vitest run apps/server/src/config.test.ts
npm run typecheck
```

**验收**

1. `npm run dev` 仍能用 `D:\App\hearth-os\.hearth` 启动；
2. 用临时数据目录、`HEARTH_PORT=4318` 从桌面目录启动服务端，`/api/health` 返回 ok，`/` 返回 200；
3. 删除一个任务的产物路径解析仍落在 `.hearth/artifacts/<id>`，不落到仓库根。

**回滚**：`git revert C1`。默认路径与旧行为一致，回滚不影响数据。

**风险**：现有 `task.outputDir` 是相对 `.hearth` 的字符串；C1 只改锚点，不做路径迁移。

---

### C2 — `feat(desktop): Electron 壳与开发模式服务端启动`

**闭环定义**：`npm run desktop:dev` 能打开一个 Electron 窗口，加载现有 Hearth UI；关闭窗口时子进程被回收。

**主要改动**

- 新增 `apps/desktop/package.json`
  - `"main": "dist/main.js"`
  - 只放桌面壳自己的依赖；Electron / electron-builder / esbuild 放根目录 devDependencies。
- 新增 `apps/desktop/tsconfig.json`，继承根 `tsconfig.base.json`
  - `outDir: "dist"`、`rootDir: "src"`、`module: "NodeNext"`、`moduleResolution: "NodeNext"`、`target: "ES2022"`。
- 新增 `apps/desktop/src/main.ts`
  - `app.whenReady()` 后创建 `BrowserWindow`；
  - 窗口参数：1280×860，最小 960×640，`show: false`，`ready-to-show` 再显示；
  - 加载 `http://127.0.0.1:4317`；
  - 关闭窗口时先停子进程再退出（C5 再改成进托盘）。
- 新增 `apps/desktop/src/server-process.ts`
  - 解析 `process.execPath`（Electron 可执行文件）；
  - 开发模式命令：`electron.exe` + `ELECTRON_RUN_AS_NODE=1` + `node_modules/tsx/dist/cli.mjs apps/server/src/index.ts`；
  - 环境变量：`HEARTH_ROOT`、`HEARTH_DATA_DIR`、`HEARTH_WEB_DIST`、`HEARTH_PORT=4317`、`HEARTH_DESKTOP=1`；
  - `stdio: ["ignore", "pipe", "pipe"]`，stdout/stderr 先写控制台；
  - 退出时 `child.kill()`，C3 再加进程树强杀。
- 根 `package.json` 增加：
  - `"desktop:build:shell": "tsc -p apps/desktop/tsconfig.json"`；
  - `"desktop:dev": "npm run desktop:build:shell && npm run build -w @hearth/web && electron apps/desktop/dist/main.js"`（先编译桌面壳和前端，避免加载空页面）；
  - `"desktop:typecheck": "tsc -p apps/desktop/tsconfig.json --noEmit"`。
- `.gitignore` 增加 `apps/desktop/dist/`、`apps/desktop/release/`、`apps/desktop/resources/`。

**测试**

- `apps/desktop/src/server-process.test.ts`：命令拼装、环境变量、开发/生产入口选择；
- 手动：`npm run desktop:dev`。

**验收**

1. 先停掉现有 4317 开发服务端；
2. `npm run desktop:dev` 启动后 10 秒内出现窗口；
3. 页面显示现有会话列表和任务列表；
4. 关闭窗口后 `Get-Process` 里没有遗留的服务端子进程；
5. 不要求安装 Node，Electron 自带 Node 语义。

**回滚**：删除 `apps/desktop` 和根脚本即可；不影响服务端。

**风险**：`tsx` CLI 在 ESM 下的解析路径；用 `createRequire(import.meta.url).resolve("tsx/cli")`，不要硬编码。

---

### C3 — `feat(desktop): 服务端监管、健康检查与固定端口`

**闭环定义**：桌面壳自己把服务端拉起来、等健康检查通过再加载页面；服务端崩溃能自动重启；端口冲突有明确提示。

**主要改动**

- `apps/desktop/src/server-process.ts`
  - `waitForHealth(timeoutMs = 30_000)`：轮询 `GET /api/health`，间隔 500ms；
  - 启动前 `checkPort(4317)`：先请求 `/api/health`，如果返回 Hearth 标识则提示“另一个 Hearth 正在运行”；否则提示端口被占用；
  - 重启退避：1s、2s、5s、10s、30s，最多 5 次；
  - 退出/重启用 `taskkill /PID <pid> /T /F`，避免 `tsx` 子进程残留；
  - 服务端 stdout/stderr 落 `%LOCALAPPDATA%\Hearth\logs\server.log`。
- 新增 `apps/desktop/src/logs.ts`
  - 主进程日志 `main.log`；
  - 5MB 轮转，保留 3 份；
  - 日志目录启动时创建。
- `apps/desktop/src/main.ts`
  - 先启动服务端，健康检查通过后再 `loadURL`；
  - 健康检查失败显示错误页/对话框，不显示空白窗口；
  - 窗口加载失败提供“重试启动服务”按钮（原生对话框即可）。

**测试**

- `waitForHealth` 超时、成功、连接拒绝；
- 退避序列纯函数；
- 日志轮转；
- 手动杀服务端进程，观察自动重启。

**验收**

1. `npm run desktop:dev` 不依赖手工先开服务端；
2. 任务管理器杀掉服务端子进程，5 秒内自动重启，页面恢复；
3. 先占用 4317 再启动，出现明确提示，不自动换端口；
4. 退出应用后 4317 释放；
5. 连续崩溃 5 次后停止重启并提示看日志。

**回滚**：回滚到 C2 的“手工启动服务端”模式。

**风险**：Windows 下 `taskkill` 对进程树的处理；`child.kill()` 对 `tsx` 子进程不够，必须用进程树强杀。

---

### C4 — `feat(desktop): 就地数据目录、首启选择与数据目录锁`

**闭环定义**：应用默认直接使用 `D:\App\hearth-os\.hearth`，不复制；首次启动可选择“使用现有数据/新建数据目录”；同一数据目录不能被两个进程同时写。

**主要改动**

- 新增 `apps/desktop/src/data-root.ts`
  - 读取 `%LOCALAPPDATA%\Hearth\desktop.json`；
  - 首次启动检测候选：
    1. `D:\App\hearth-os\.hearth\hearth.sqlite` 存在且非空；
    2. `%LOCALAPPDATA%\Hearth\.hearth`；
  - 弹原生选择框：
    - “使用现有数据（推荐）”：`root=D:\App\hearth-os`，`dataDir=D:\App\hearth-os\.hearth`；
    - “新建数据目录”：`root=%LOCALAPPDATA%\Hearth`，`dataDir=%LOCALAPPDATA%\Hearth\.hearth`；
  - 写入 `desktop.json`，后续启动不再询问；
  - 数据目录被移动/删除时提示重新选择，不静默建新库。
- 新增 `apps/server/src/data-lock.ts`
  - 在 `apps/server/src/index.ts` 打开数据库前获取 `<dataDir>\hearth.lock`；
  - 锁内容：PID、启动时间、端口；
  - 锁存在且 PID 仍存活 → 抛 `DATA_DIR_IN_USE`；
  - PID 不存在 → 视为陈旧锁，清理后获取；
  - `SIGINT` / `SIGTERM` / 正常关闭时释放。
- `apps/desktop/src/server-process.ts` 传入选定的 `HEARTH_ROOT` / `HEARTH_DATA_DIR`。
- 启动前检查：数据库文件存在、`master.key` 存在、`model-settings.json` 存在；缺哪个给对应提示。
- 不在 v0.1 做复制/迁移工具。

**测试**

- `data-root` 纯函数：已保存配置、现有数据、全新数据、目录丢失；
- `data-lock`：正常获取、重复获取失败、陈旧锁清理、释放；
- 手动：用现有数据启动，确认任务数 360、可恢复 32。

**验收**

1. 首次启动选择“使用现有数据”，窗口直接显示现有会话/任务；
2. `git status` 不因启动产生新文件（`hearth.lock` 在 `.hearth` 内，属于运行时文件）；
3. 现有 worktree 仍可用（路径没有变）；
4. 同时开一个 `HEARTH_PORT=4318` 的服务端指向同一 `.hearth`，第二个被拒绝；
5. 选择“新建数据目录”时能进入首次配置流程，不碰旧库。

**回滚**：删除 `desktop.json` 和 `data-lock.ts`；旧库不受影响。

**风险**：600MB 数据库首次打开可能慢；不要做全量 `integrity_check`，用 `quick_check` 或直接打开。

---

### C5 — `feat(desktop): 单实例、托盘与优雅退出`

**闭环定义**：关窗不杀服务，托盘可恢复；托盘退出才真正停止服务；重复双击只激活已有窗口。

**主要改动**

- `apps/desktop/src/main.ts`
  - `app.requestSingleInstanceLock()`；第二个实例聚焦已有窗口后退出；
  - `window-all-closed` 不调用 `app.quit()`；
  - `before-quit` 设置 `isQuitting`，先停服务端并等待退出（最多 10 秒），再真正退出；
  - `will-quit` 兜底强杀。
- 新增 `apps/desktop/src/tray.ts`
  - 托盘图标；
  - 菜单：打开主窗口、数据目录、日志目录、环境体检（C10 接）、桌面助手（C11 接）、退出；
  - 关闭窗口时 `win.hide()`，托盘提示“仍在后台运行”。
- 窗口再次显示时 `win.show()` + `win.focus()`。
- 托盘退出流程：停止调度器 → 关闭 Fastify → 释放数据锁 → 退出。

**测试**

- 单实例锁：启动第二个进程，确认退出并聚焦第一个；
- 手动：关窗后任务仍能按计划执行（可建一个 1 分钟后的任务验证）；
- 托盘退出后 4317 释放、无 `Hearth.exe` / 服务端子进程残留。

**验收**

1. 双击第二次只出现一个窗口；
2. 点 X 后窗口消失、托盘图标还在、服务端仍监听 4317；
3. 托盘“退出”后 4317 释放，任务进程结束；
4. 关机/注销时服务端能收到退出信号，数据锁释放。

**回滚**：回到 C4 的“关窗即退出”。

**风险**：托盘退出时 SQLite WAL 需要正常关闭；不能直接 `taskkill` 主进程。

---

### C6 — `feat(desktop): 渲染器安全加固与桌面模式`

**闭环定义**：渲染器没有 Node 权限，外部导航被拦截，Service Worker 在桌面模式不注册；现有 loopback + Origin 校验保持生效。

**主要改动**

- `apps/desktop/src/preload.ts`（新增）
  - `contextBridge.exposeInMainWorld("hearthDesktop", { isDesktop: true, platform: process.platform })`；
  - v0.1 不暴露任意 IPC；C11 再加 `helper:start`。
- `apps/desktop/src/main.ts`
  - `webPreferences`: `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webviewTag: false`、`spellcheck: false`、`devTools: !app.isPackaged`；
  - `will-navigate`：只允许 `http://127.0.0.1:4317`；
  - `setWindowOpenHandler`：`deny`，http/https 用 `shell.openExternal`；
  - `will-attach-webview`：阻止；
  - `session.setPermissionRequestHandler`：全部拒绝；
  - `session.defaultSession.webRequest.onHeadersReceived` 注入 CSP：
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:;`
- `apps/web/src/main.tsx`
  - Service Worker 注册条件增加 `!window.hearthDesktop?.isDesktop`；
  - 保留 `import.meta.env.PROD` 条件。
- `apps/web/src/types` 或全局声明增加 `window.hearthDesktop` 类型。
- `apps/web` 不引入 Node 模块；所有 API 继续走相对 `/api`。

**测试**

- Playwright（C12）或手动：
  - `window.hearthDesktop.isDesktop === true`；
  - `navigator.serviceWorker.getRegistrations()` 为空；
  - 点击外链不打开新 Electron 窗口，而是系统浏览器；
  - `fetch("http://127.0.0.1:4317/api/health")` 正常；
  - 跨站 `Origin` 请求仍被 403。
- `npm run typecheck`。

**验收**

1. 开发者工具里 `process` 不可用；
2. `window.open("https://example.com")` 不在应用内开窗；
3. 桌面模式无 Service Worker 注册；
4. 现有 API 请求不被 CSP 拦截；
5. 原有 loopback/Origin 测试仍通过。

**回滚**：回滚 preload 和 CSP；保留 `nodeIntegration:false` 等基础项。

**风险**：CSP 可能挡住 Vite 内联样式或字体；先只加 `style-src 'unsafe-inline'`，按实际报错收紧。

---

### C7 — `refactor(executors): 可选执行器按需加载`

**闭环定义**：安装包里没有 `@deepseek-ai` 大依赖时，服务端仍能启动，native/Codex 正常；DeepSeek 被调用时返回明确的“运行时未安装”，不是启动崩溃。

**背景**

- `apps/server/src/app.ts:12` 顶层导入 `@hearth/codex-executor`；
- `apps/server/src/executor-adapter.ts:21`、`executor-runtime.ts:7` 顶层导入 `@hearth/deepseek-executor`；
- `packages/deepseek-executor/src/index.ts:3` 顶层导入 `@deepseek-ai/dsh-sdk-client`；
- 如果只在打包时排除 `@deepseek-ai`，服务端会在启动阶段 `ERR_MODULE_NOT_FOUND`，不是“功能不可用”。

**主要改动**

- `packages/deepseek-executor/src/index.ts`
  - 把 `import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client"` 改为 `import type` + 函数内 `await import("@deepseek-ai/dsh-sdk-client")`；
  - `runDeepSeekHarness` 捕获 `ERR_MODULE_NOT_FOUND`，抛出带中文提示的 `ExecutorRuntimeMissingError`。
- `apps/server/src/executor-runtime.ts` / `executor-adapter.ts`
  - 捕获该错误，返回执行器不可用状态，不冒泡成 500；
  - 健康检查里 DeepSeek 显示“未安装可选运行时”，不是“探测失败”。
- `packages/codex-executor/src/executor.ts`
  - `CodexRunOptions` 增加 `codexPathOverride?: string`；
  - `new Codex({ ... , codexPathOverride })`；
  - 不改成动态导入：`@openai/codex-sdk` 本身只有 0.1MB，保留静态导入更简单。
- `apps/server/src/app.ts` 的 `codexRunner`
  - 传入 `codexPathOverride: process.env.HEARTH_CODEX_PATH`。
- `apps/server/src/executor-install.ts`
  - `npmInvocation()` 找不到 npm 时返回明确的 `NPM_NOT_FOUND`，不要退回一个必然失败的 `cmd /c npm`。
- 新增 `scripts/optional-runtime-smoke.mjs`
  - 用 esbuild 打一个不带 `@deepseek-ai` 的服务端包；
  - 在临时目录启动，断言 `/api/health` 为 ok；
  - 调用 DeepSeek 路径，断言返回 `EXECUTOR_RUNTIME_MISSING`。

**测试**

- `packages/deepseek-executor` 单测：SDK 存在/不存在两条路径；
- `packages/codex-executor` 单测：`codexPathOverride` 透传；
- `optional-runtime-smoke.mjs`；
- `npx vitest run packages/codex-executor packages/deepseek-executor apps/server/src/executor-readiness.test.ts`。

**验收**

1. 临时移除 `node_modules/@deepseek-ai` 后服务端能启动，聊天/native 正常；
2. 调用 DeepSeek 执行器返回明确不可用，不是进程退出；
3. Codex 用系统 `codex.exe` 能跑一个最小任务；
4. `HEARTH_CODEX_PATH` 为空时 Codex 显示不可用，native 不受影响。

**回滚**：恢复顶层导入；但打包时就必须重新包含 527MB 依赖，回滚代价高，建议 C7 先合。

**风险**：动态导入在 esbuild 打包后需要保留为外部依赖；构建脚本里把 `@deepseek-ai/*` 标记为 external，不能被打进 bundle。

---

### C8 — `build(desktop): 服务端打包、依赖裁剪与 win-unpacked`

**闭环定义**：`release\win-unpacked\Hearth.exe` 不依赖仓库源码、不依赖全局 Node/npm，双击能启动完整应用。

**主要改动**

- 新增 `scripts/build-server.mjs`
  - esbuild 入口 `apps/server/src/index.ts`；
  - `bundle: true`、`platform: "node"`、`format: "esm"`、`target: "node22"`；
  - `@hearth/*` 打进 bundle；
  - 三方依赖列为 external（从各 workspace `package.json` 的 `dependencies` 生成，排除 `@hearth/*`、`@deepseek-ai/*`、`@openai/codex-win32-x64`）；
  - 输出 `apps/desktop/resources/server/server.mjs`；
  - 复制 `pdfjs-dist` 的 `cmaps` / `standard_fonts` 等运行资源到 `resources/server/assets`，避免 PDF 解析找不到字体。
- 新增 `scripts/stage-server-deps.mjs`
  - 生成临时 `package.json`，只列核心三方依赖，版本与 workspace 一致；
  - `npm install --omit=dev --omit=optional --ignore-scripts`；
  - 明确排除 `@deepseek-ai/*`、`@openai/codex-win32-x64`；
  - 把 `node_modules` 复制到 `apps/desktop/resources/server/node_modules`；
  - 断言：`@openai/codex-sdk` 存在、`@openai/codex-win32-x64` 不存在、`@deepseek-ai` 不存在。
- 新增 `scripts/build-desktop.mjs`
  - 依次执行：web build → server bundle → stage deps → 复制 `apps/web/dist` → `electron-builder --dir`。
- 新增 `apps/desktop/electron-builder.yml`（C8 先只开 `dir` 目标）
  - `appId: ai.hearth.os`
  - `productName: Hearth`
  - `asar: true`
  - `files: ["dist/**", "package.json"]`
  - `extraResources`: `resources/web` → `web`，`resources/server` → `server`
  - `win.target`: `dir`（C9 再加 nsis/portable）
- 根脚本：
  - `"desktop:build:dir": "node scripts/build-desktop.mjs --dir"`
  - `"desktop:start": "electron apps/desktop/dist/main.js"`
- `.gitignore` 已覆盖 `apps/desktop/resources/`、`release/`。

**打包策略门禁**

先尝试方案 A，失败再走方案 B：

- **A：bundle + 精简 node_modules**
  - 服务端代码与 `@hearth/*` 打进 `server.mjs`；
  - 三方依赖 external，从精简 `node_modules` 解析；
  - 优点：路径清晰，PDF/Excel 等原生资源好处理；
  - 验收：health、聊天、PDF 读取、XLSX 产物、MCP mock 全通过。
- **B：全量 bundle（除 `pdfjs-dist`）**
  - 如果 A 的依赖 staging 不稳定，尝试把三方也打进 bundle；
  - 只外置 `pdfjs-dist`、`@openai/codex-sdk`、`@deepseek-ai/*`；
  - 验收同上。
- 两个方案都不通过 → 停止打包，回到 C7 检查顶层导入/动态导入，不允许把 1.7GB `node_modules` 直接塞进安装包。

**测试**

```powershell
npm run desktop:build:dir
```

- 启动 `apps\desktop\release\win-unpacked\Hearth.exe`；
- 检查 `resources\server\node_modules\@openai\codex-win32-x64` 不存在；
- 检查 `resources\server\node_modules\@deepseek-ai` 不存在；
- 检查 `resources\web\index.html` 存在；
- 检查安装目录总大小（目标 < 300MB）。

**验收**

1. 在没有仓库源码的目录（例如 `C:\Temp\hearth-unpacked`）复制 `win-unpacked` 后仍能启动；
2. 窗口显示现有数据；
3. 发一句话能回复；
4. 生成一个产物并下载；
5. PDF/Excel 输入至少各跑一次；
6. 退出后无残留进程。

**回滚**：删除打包脚本和 `resources`；C2-C7 的开发模式仍可用。

**风险**：

- esbuild 对 `node:sqlite` 无影响（内置模块）；
- `pdfjs-dist` 的字体/cmaps 路径容易漏，必须复制；
- `exceljs` 可能依赖运行时文件，先跑一次 XLSX；
- `@openai/codex-sdk` 的 `--omit=optional` 是否真的不拉 479MB，要在 staging 后断言目录不存在；
- Electron 下载走镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，electron-builder 二进制走 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

---

### C9 — `build(desktop): NSIS/便携版、图标与卸载清理`

**闭环定义**：双击 `Hearth-Setup-x.y.z.exe` 免 UAC 安装，桌面图标可启动；便携版可独立运行；卸载不删数据、不留孤儿进程。

**主要改动**

- `apps/desktop/build/icon.ico`
  - 从 `docs/public/brand/hearth-os-logo.png` 生成 256/128/64/48/32/16 多尺寸 ico；
  - 新增 `scripts/make-icon.mjs` + devDependency `png-to-ico`。
- `apps/desktop/electron-builder.yml` 增加：
  - `win.target`: `nsis` + `portable`，`arch: [x64]`；
  - `nsis.oneClick: true`、`perMachine: false`、`allowToChangeInstallationDirectory: false`、`createDesktopShortcut: true`、`createStartMenuShortcut: true`、`runAfterFinish: true`、`deleteAppDataOnUninstall: false`；
  - `artifactName: "Hearth-Setup-${version}.${ext}"`；
  - `publish: null`；
  - `forceCodeSigning: false`。
- `apps/desktop/build/installer.nsh`（新增）
  - 卸载前 `taskkill /IM Hearth.exe /T /F`，避免文件占用；
  - 不删除 `%LOCALAPPDATA%\Hearth` 和用户选择的数据目录。
- `apps/desktop/package.json` 增加 `version`、`description`、`author`。
- 根脚本 `"desktop:build": "node scripts/build-desktop.mjs"`。

**测试**

- 安装到默认 `%LOCALAPPDATA%\Programs\Hearth`，确认不弹 UAC；
- 桌面/开始菜单快捷方式；
- 便携版放到 `C:\Temp` 运行；
- 覆盖安装同版本/升级版本；
- 卸载后数据仍在。

**验收**

1. 安装全程无 UAC；
2. 桌面图标双击启动，10 秒内出窗口；
3. 便携版 exe 双击启动；
4. 卸载后 `D:\App\hearth-os\.hearth` 完好，`%LOCALAPPDATA%\Hearth\desktop.json` 保留（或按选择保留）；
5. 卸载后无 `Hearth.exe` 残留；
6. 安装包体积 < 300MB。

**回滚**：移除 nsis/portable target，保留 `win-unpacked`。

**风险**：未签名会触发 SmartScreen“未知发布者”；v0.1 自己用可接受，正式版前必须补签名。

---

### C10 — `feat(executors): 系统 Codex 检测与环境体检`

**闭环定义**：首次启动/托盘菜单能看到模型、Git、gh、Codex、npm、桌面助手、端口逐项状态；缺什么给明确指引，不假装可用。

**主要改动**

- 新增 `apps/desktop/src/environment.ts`
  - 检测：
    - 模型：读取 `/api/health` 的 `chatModel.configured`；
    - Git：`git --version`；
    - gh：`gh --version`；
    - Codex：`HEARTH_CODEX_PATH` → `where codex.exe` → 已知路径 `D:\npm-global\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`；
    - npm：`npm --version`（只用于托管安装，缺失不阻塞主流程）；
    - helper：`resources\helper\helper.mjs` 是否存在；
    - 端口：4317 是否可绑定。
  - 返回结构化列表：`{ id, label, status: "ok" | "warn" | "missing", detail, action }`。
- `apps/desktop/src/main.ts`
  - 启动时后台跑一次体检，缺失项写日志；
  - 托盘菜单“环境体检”打开原生 `dialog.showMessageBox` 汇总；
  - 首次启动如果模型未配置，弹一次引导，不阻塞进入主界面。
- `apps/server/src/app.ts`
  - `codexRunner` 已支持 `HEARTH_CODEX_PATH`（C7）；
  - 健康检查里 Codex `authSource` / `canRun` 与体检结果一致。
- `apps/server/src/executor-install.ts`
  - npm 缺失时禁用托管安装，API 返回 `NPM_NOT_FOUND`；
  - 前端已有错误展示，不新增页面。
- 不新增 React 设置页；v0.1 用原生对话框，减少前端路由改动。

**测试**

- `environment` 纯函数：找到/找不到 codex、git、gh、npm；
- 手动：移除 `HEARTH_CODEX_PATH`，确认 Codex 不可用但 native 可用；
- 手动：用系统 `codex.exe` 跑一个最小任务。

**验收**

1. 托盘“环境体检”列出 7 项，状态与实际一致；
2. Codex 用系统 exe 跑通；
3. 把 `codex.exe` 改名后重启，Codex 显示不可用，聊天不受影响；
4. npm 缺失时托管安装按钮给出明确错误，不出现 500；
5. 模型未配置时首启有引导，不白屏。

**回滚**：移除体检菜单；C7 的 Codex 环境变量仍可用。

**风险**：`where codex.exe` 可能返回多个路径；取第一个可执行文件，不要取 `codex.ps1` / `codex.cmd`。

---

### C11 — `feat(desktop): 桌面助手打包与托盘入口`

**闭环定义**：桌面版不再提示 `npm run helper:windows`；托盘菜单能启动助手，出现配对码，手机/设备能配对。

**主要改动**

- `apps/desktop/resources/helper/`
  - 复制 `tools/windows-helper/helper.mjs`、`windows.ps1`；
  - 新增 `helper.cmd`：
    ```bat
    @echo off
    set ELECTRON_RUN_AS_NODE=1
    "%~dp0..\..\Hearth.exe" "%~dp0helper.mjs" %*
    pause
    ```
    路径按实际安装布局调整；C8 的 `extraResources` 增加 `helper`。
- `apps/desktop/src/helper.ts`
  - `spawn("cmd.exe", ["/c", "start", "", helperCmd], { windowsHide: false })`；
  - 或直接 `spawn(process.execPath, [helperMjs], { env: { ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" })`，以实际能弹出控制台为准；
  - 防止重复启动：记录 PID，退出时清理。
- `apps/desktop/src/tray.ts` 增加“桌面助手”。
- `apps/web/src/pages/DevicesPage.tsx`
  - `window.hearthDesktop?.isDesktop` 为真时，把 `npm run helper:windows -- --apps ...` 代码块替换为：
    “请从系统托盘菜单启动『桌面助手』，按提示输入配对码。”
  - 保留浏览器模式的原文案。
- `tools/windows-helper/helper.mjs` usage 文本同步改成“由 Hearth 托盘菜单启动”。

**测试**

- 手动：托盘启动助手 → 控制台出现配对码 → 在设备页输入 → 配对成功；
- 手动：重复点“桌面助手”不出现多个进程；
- 关闭助手窗口后托盘可再次启动。

**验收**

1. 桌面版设备页不再显示不存在的 npm 命令；
2. 托盘菜单能启动助手；
3. 配对码出现且能完成一次配对；
4. 助手进程退出后无残留；
5. 浏览器模式文案不变。

**回滚**：隐藏托盘“桌面助手”菜单，恢复设备页原文案；v0.1 可把该功能标为“高级可选”。

**风险**：Electron 主进程没有控制台，`stdio: "inherit"` 可能看不到输出；用 `cmd /c start` 打开独立窗口作为兜底。

---

### C12 — `test(desktop): 黄金路径烟测与桌面文档`

**闭环定义**：一条命令能对 `win-unpacked` 或安装版跑完黄金路径；文档能让人从零构建出安装包。

**主要改动**

- 新增 `scripts/desktop-smoke.mjs`
  - 用 Playwright `_electron.launch({ executablePath: "release/win-unpacked/Hearth.exe" })`；
  - 等待窗口，断言：
    - 标题包含 `Hearth`；
    - `window.hearthDesktop.isDesktop === true`；
    - `navigator.serviceWorker.getRegistrations()` 长度为 0；
    - `fetch("/api/health")` 返回 `status: "ok"`；
    - 会话列表至少 1 条；
  - 关闭应用，断言 4317 释放、无 `Hearth.exe` 残留。
  - 如果 Playwright 的 Electron 支持不稳定，退回 `--remote-debugging-port` + CDP，不阻塞 C12。
- 新增 `docs/design/desktop.md`
  - 构建、运行、数据目录、日志、验收、已知限制；
  - 明确“桌面版与开发服务器不能同时用同一 `.hearth`”。
- `README.md` 增加“桌面版（Windows，实验）”小节，链接到 `docs/design/desktop.md`。
- 根脚本：
  - `"desktop:smoke": "node scripts/desktop-smoke.mjs"`。

**测试**

```powershell
npm run desktop:build:dir
npm run desktop:smoke
```

**验收（黄金路径）**

1. 干净目录/干净 `%LOCALAPPDATA%` 下安装；
2. 双击桌面图标；
3. 10 秒内出窗口；
4. 看到现有会话和任务；
5. 发一句话，收到回复；
6. 关窗，托盘还在；
7. 从托盘重新打开，状态还在；
8. 托盘退出，4317 释放，无孤儿进程。

**回滚**：删除 smoke 脚本和文档；不影响应用本身。

**风险**：Playwright 对 Electron 45 的支持版本要匹配；如果 `_electron` 不可用，用 CDP 兜底。

---

## 7. 提交门禁

每个 commit 合并前必须满足：

```powershell
npm run typecheck
npx vitest run <本闭环相关测试>
npm test          # 合并前全量
npm run build     # 前端构建
```

涉及桌面的 commit 额外：

```powershell
npm run typecheck
npm run tauri:build
```

提交信息示例：

```text
feat(desktop-tauri): 搭建 Tauri 壳与 Node 服务端监管
perf(desktop): 增加轻量就绪探针并让 Tauri 只连接真实服务
feat(desktop): 打通 Tauri 启动链路并支持资源路径与桌面导航
perf(desktop): 识别 Tauri 桌面壳并打包 npm 运行时
```

---

## 8. 总体验收清单

| # | 检查项 | 通过标准 | 当前状态 |
| --- | --- | --- | --- |
| 1 | 安装 | NSIS 免 UAC，开始菜单快捷方式存在 | 已安装验证；开始菜单指向 Tauri |
| 2 | 启动 | 双击后 10 秒内出窗口，无白屏 | `/api/ready` + `/` 200 已验证 |
| 3 | 数据 | 现有任务、会话、模型配置可见 | 使用 `HEARTH_ROOT` 测试通过 |
| 4 | 聊天 | 发一句话 60 秒内收到回复 | 需用现有模型配置做一次真实发送 |
| 5 | 产物 | 建一个任务，生成产物并下载成功 | 需做一次真实任务验收 |
| 6 | PDF/Excel | 各跑一次输入解析 | 服务端依赖保留，待真实样本验收 |
| 7 | Codex | 系统 `codex.exe` 能跑；缺失时 native 正常 | `/api/executors` 显示 codex ready |
| 8 | 托盘 | 关窗隐藏，托盘恢复；托盘退出释放 4317 | 代码已实现，待手工验收 |
| 9 | 崩溃 | 杀服务端进程后自动重启，数据不丢 | 尚未实现自动重启，v0.1 先报错提示 |
| 10 | 单实例 | 第二次双击只聚焦第一个窗口 | Tauri single-instance 已接入 |
| 11 | 数据锁 | 第二个进程指向同一 `.hearth` 被拒绝 | 服务端锁保留 |
| 12 | 安全 | 仅 loopback，跨站写请求拒绝，无 SW | 已保留；Tauri 顶层导航单独放行 |
| 13 | 卸载 | 不删数据，无孤儿进程 | 待手工验收 |
| 14 | 便携版 | 独立目录双击可运行 | v0.1 不提供便携包 |
| 15 | 体积 | 安装包 < 100MB | **40.6 MiB，已通过** |
| 16 | 体积 | 安装后 < 300MB（不含数据） | **约 280MiB，已通过** |

---

## 9. 风险登记

| 风险 | 触发点 | 缓解 |
| --- | --- | --- |
| esbuild 打包服务端失败 | C8 | 先跑 A 方案；失败切 B；仍失败回 C7 查顶层导入 |
| `@openai/codex-win32-x64` 被间接拉入 | C8 | staging 后断言目录不存在；`--omit=optional`；`codexPathOverride` |
| `@deepseek-ai` 顶层导入导致启动崩溃 | C7 | 动态导入 + `EXECUTOR_RUNTIME_MISSING` + smoke |
| PDF 字体/cmaps 丢失 | C8 | 显式复制 `pdfjs-dist` 资源并跑一次 PDF |
| 端口 4317 被开发服务占用 | C3 | 启动前健康检查；提示停开发服务；不 fallback |
| 同一数据目录双写 | C4 | `hearth.lock` + PID 存活检查 |
| 托盘退出时 SQLite 未正常关闭 | C5 | `before-quit` 等待 Fastify close + 释放锁，超时才强杀 |
| 未签名 SmartScreen | C9 | v0.1 自己用可接受；正式版前买 OV/EV 或 Azure Trusted Signing |
| Electron 下载慢/失败 | C2/C8 | 设置 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` |
| 桌面助手看不到控制台 | C11 | `cmd /c start` 打开独立窗口兜底 |
| Playwright Electron 支持不匹配 | C12 | 退回 `--remote-debugging-port` + CDP |
| 安装包体积超 300MB | C8/C9 | 砍可选执行器、砍 dev 依赖、`--omit=optional`、检查 asar 内容 |

---

## 10. 正式版路线（v0.2+）

不在本计划执行，仅记录方向：

1. 代码签名（OV/EV 或 Azure Trusted Signing），解决 SmartScreen；
2. 自动更新（Tauri updater + 签名校验）；
3. 首次启动迁移工具：SQLite backup 一致性快照 + `master.key` + worktree 路径修复；
4. 内置 MinGit/gh 或做“普通用户模式”；
5. macOS/Linux；
6. 多用户/多工作区；
7. 崩溃上报与日志上传（可选、需隐私开关）。

---

## 11. 计划确认

这份计划没有新增需要你拍板的设计问题。你确认后，从 C1 开始执行；每个 commit 做完我会给出该闭环的验收结果，再进入下一个。

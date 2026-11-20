# Hearth 桌面版压缩实录（Tauri-only v0.1）

本文记录从 Electron 迁移到 Tauri、并把安装后体积压到约 131 MiB 的完整过程、体积去向、复现命令、验收结果和使用前提。0.1.0 时点是约 115 MiB；0.2.0 加入浏览器自动化和 Windows ACL sandbox 后增长到约 131 MiB。目标不是做一个“精简版”，而是在保留官方 Node、内置 npm、PDF 资源、托盘、桌面助手、环境体检、日志和数据连续性的前提下，只更换桌面外壳与打包方式。

## 结论

| 指标 | Electron 旧版 | 早期 Tauri 版 | 当前 Tauri-only |
|---|---:|---:|---:|
| NSIS 安装包 | 155.3 MiB | 40.6 MiB | **27.99 MiB** |
| 安装后占用 | 558.1 MiB | 279.7 MiB | **114.82 MiB** |
| 安装文件数 | — | — | **1,847** |
| 运行时 `node_modules` | 有 | 有 | **无** |

当前安装包为 `release/Hearth_0.1.0_x64-setup.exe`，按用户安装到 `%LOCALAPPDATA%\Programs\Hearth`，不需要管理员权限。

## 约束与边界

压缩过程遵守以下约束：

- Windows x64；不做代码签名、自动更新和便携版。
- 使用官方 Node `22.23.2` 与随附 npm `10.9.8`，不改成 small-icu、UPX 或按需下载。
- 不删除 npm；托管安装和运行时 `npm` 命令继续可用。
- 不删除 PDF cMaps、标准字体和 wasm；中文 PDF 提取必须继续可用。
- Codex 平台二进制约 479 MiB，继续使用系统 `codex.exe`，不内置。
- WebView2 使用系统共享运行时；安装器只带在线 bootstrapper。
- 数据目录不迁移、不覆盖；安装前后 `desktop.json` 与 `.hearth` 保持原样。

## 1. 删除 Electron，只保留 Tauri

旧版 Electron 的体积主要来自 Chromium、Electron 运行时和未打包的 `node_modules`。迁移时删除：

- `apps/desktop/`（Electron 主进程、预加载脚本、托盘、日志、数据目录选择、环境体检）。
- `scripts/build-desktop.mjs`、`scripts/desktop-smoke.mjs`、`scripts/stage-server-deps.mjs`。
- 根 `package.json` 中的全部 `desktop:*` 脚本、`electron`、`electron-builder` 依赖。
- 旧 Electron 安装包、`win-unpacked`、blockmap 和构建调试文件。

Electron 原有的窗口、托盘、单实例、端口探测、服务端监管、日志、数据目录选择、桌面助手、环境体检和外部链接行为，全部在 `apps/desktop-tauri/src-tauri/src/lib.rs` 中用 Rust 重写。桌面版从此只有一套实现。

## 2. 服务端打成单文件

### esbuild 配置

`scripts/build-server.mjs` 使用全量 bundle：

```js
await esbuild.build({
  entryPoints: [serverEntry],
  outfile: serverOut,
  bundle: true,
  minify: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["@openai/codex-win32-x64"],
  metafile: true,
  banner: {
    js: 'import { createRequire as __hearthCreateRequire } from "node:module"; const require = __hearthCreateRequire(import.meta.url);',
  },
});
```

关键点：

- 唯一 external 是 `@openai/codex-win32-x64`，因为它是约 479 MiB 的平台二进制，继续由系统 Codex 提供。
- DeepSeek SDK、Lark、邮件、MCP、docx/xlsx、pdfjs 等全部打进 `server.mjs`。
- `createRequire` banner 保证打包后的 CJS 动态 `require` 仍可用。
- `target: "node22"` 与内置运行时一致，避免降级转译带来的额外体积。

### PDF 资源

`pdfjs-dist` 在 Node 下会按相对路径解析 fake worker 和资源。构建时额外复制：

- `pdf.worker.min.mjs` → `resources/server/pdf.worker.mjs`
- `cmaps/` → `resources/server/assets/pdfjs/cmaps/`
- `standard_fonts/` → `resources/server/assets/pdfjs/standard_fonts/`
- `wasm/` → `resources/server/assets/pdfjs/wasm/`

服务端启动时注入 `HEARTH_PDF_ASSETS`。`packages/agent-runtime/src/documents.ts` 的 PDF 提取器把 `cMapUrl`、`standardFontDataUrl`、`wasmUrl` 指向该目录，使用正斜杠并以 `/` 结尾；未设置时回退到仓库 `node_modules/pdfjs-dist`。这样中文 PDF 所需的 cMap 与标准字体在安装版中可用。

### 第三方声明

esbuild 的 `metafile` 用于生成 `resources/THIRD_PARTY_NOTICES.txt`，汇总实际进入 bundle 的 303 个包及其版本、许可证文本。Node 与 npm 的 LICENSE 另行保留在 `resources/licenses/`。

### 效果

- server 目录：约 173.3 MiB → **14.73 MiB**
- 文件数：约 1.7 万 → **202**
- 安装后不再有运行时 `node_modules`

## 3. Web 静态资源关闭 source map

`apps/web/vite.config.ts` 默认设置 `sourcemap: false`，只有显式设置 `HEARTH_SOURCEMAP=1` 时才生成 source map。

- web：约 3.7 MiB → **0.80 MiB**
- 同时消除了 `.map` 文件进入安装包和泄漏源码的风险。

## 4. 固定官方 Node

构建脚本不再使用当前机器的 `process.execPath`（开发机可能是 Node 26），而是固定下载：

- 版本：`node-v22.23.2-win-x64.zip`
- SHA256：`1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97`
- 缓存：`apps/desktop-tauri/.cache`
- 解压：使用 Windows 自带 `tar`
- 校验：运行 `node.exe -v`，必须输出 `v22.23.2`

只复制 zip 中的 `node.exe` 和 `node_modules/npm`。允许通过 `HEARTH_NODE_PATH` 覆盖，但必须是官方 v22.x；版本不符时构建直接失败，避免把开发机运行时误打进安装包。

Node 官方二进制约 **82.97 MiB**，占安装体积约 **73%**，是当前方案的体积下限。

## 5. 裁剪内置 npm

npm 10.9.8 原始约 10.7 MiB。构建时：

- 保留：`bin`、`lib`、`node_modules`、`package.json`、`LICENSE`、`.npmrc`、`index.js`。
- 删除顶层：`docs`、`man`、`README.md`、`tap-snapshots`。
- 递归删除：`docs`、`man`、`*.md`、`*.map`。

裁剪后约 **7.82 MiB**，托管安装和所有运行时 npm 命令仍使用内置 npm。

构建同时生成 `resources/npm.cmd`，指向：

```bat
"%~dp0node.exe" "%~dp0node_modules\npm\bin\npm-cli.js" %*
```

服务端启动时把 `resources` 放到 PATH 最前，因此应用内的 `npm`、`npx` 和托管安装不会误用系统 Node。

## 6. 桌面助手改用内置 Node

`tools/windows-helper` 是唯一源，构建时复制最新的 `helper.mjs`、`windows.ps1`，并生成：

```bat
"%~dp0..\node.exe" "%~dp0helper.mjs" %*
```

托盘“桌面助手”通过 `cmd /c helper.cmd` 加 `CREATE_NEW_CONSOLE` 启动，不再依赖 `ELECTRON_RUN_AS_NODE` 或 `Hearth.exe`。helper 资源约 **0.04 MiB**。

## 7. Rust release 配置

`apps/desktop-tauri/src-tauri/Cargo.toml` 增加：

```toml
[profile.release]
lto = true
codegen-units = 1
opt-level = "s"
strip = true
```

Tauri 主程序从早期约 8.8 MiB 降到 **6.22 MiB**。同时只引入 `windows-sys` 的 `Win32_UI_WindowsAndMessaging`、`Win32_UI_Shell`、`Win32_Foundation`，用原生 `MessageBoxW` / `ShellExecuteW` 替代 rfd/dialog 插件。后续为“选择本地文件夹”增加 `rfd` 原生文件选择器后，主程序变为 **7.76 MiB**，约增加 1.5 MiB，仍远低于 Electron 外壳。

## 8. Tauri 外壳对齐 Electron 行为

压缩不能以牺牲功能为代价，因此 Tauri 壳补齐了 Electron 原有行为：

- 数据目录：读取 `%LOCALAPPDATA%\Hearth\desktop.json`；兼容旧 `{root}`；新写入 `{version:1, root, dataDir, lastLaunchAt}`。
- 首启对话框：使用现有数据 / 新建数据目录 / 退出；`HEARTH_ROOT` 仅作测试覆盖。
- 端口：固定 4317；启动前区分“空闲 / Hearth 已在运行 / 被其他程序占用”。
- 单实例：第二次启动聚焦已有窗口。
- 服务端监管：30 秒就绪探测；异常退出按 1s / 2s / 5s / 10s / 30s 退避重启；就绪后重置；连续 5 次失败停止并提示。
- 退出：先 POST `/api/desktop/shutdown`，再 `taskkill /T /F`，最后按 PID 清理 `hearth.lock`。
- 日志：`%LOCALAPPDATA%\Hearth\logs\main.log` 与 `server.log`，5 MiB 轮转、保留 3 份。
- 托盘：打开 Hearth、环境体检、桌面助手、数据目录、日志目录、退出；双击托盘打开主窗口；关窗只隐藏。
- 环境体检：聊天模型、Git、GitHub CLI、Codex、内置 npm、桌面助手、4317 端口，共 7 项。
- Codex 解析：`HEARTH_CODEX_PATH` → `where codex.exe` 的第一个 `.exe` → 已知 npm 全局路径。
- 窗口与链接：只允许 splash 与 `127.0.0.1:4317`；外部 http/https 交给 `ShellExecuteW`，拒绝新窗口。
- 安全：`HEARTH_DESKTOP=1` 时服务端注入与 Electron 相同的 CSP；Web 检测到 Tauri 时注销 Service Worker，避免缓存旧界面。

## 9. 安装器

`tauri.conf.json` 关键配置：

- `targets: ["nsis"]`
- `installMode: "currentUser"`，免 UAC
- `webviewInstallMode: { type: "downloadBootstrapper", silent: true }`
- `installerHooks: "installer-hooks.nsh"`

`installer-hooks.nsh` 把安装目录固定为 `%LOCALAPPDATA%\Programs\Hearth`，避免 Tauri 默认的 `%LOCALAPPDATA%\Hearth` 与数据目录混在一起。NSIS 使用自带 LZMA 压缩。

## 最终体积

实测环境：Windows x64，安装目录 `%LOCALAPPDATA%\Programs\Hearth`。

| 组成 | 字节 | MiB | 占比 |
|---|---:|---:|---:|
| `resources\node.exe` | 86,997,320 | 82.967 | 63.3% |
| `resources\server`（单文件 + PDF 资源） | 19,209,057 | 18.320 | 14.0% |
| `resources\sandbox\windows-acl` | 13,396,394 | 12.779 | 9.7% |
| `resources\node_modules`（npm） | 8,200,047 | 7.820 | 6.0% |
| `hearth_desktop.exe` | 8,137,728 | 7.761 | 5.9% |
| `resources\web` | 877,992 | 0.837 | 0.6% |
| helper / licenses / notices / 卸载器 | 612,769 | 0.584 | 0.4% |
| **安装目录合计** | **137,431,307** | **131.066** | **100%** |
| **NSIS 安装包（0.2.0）** | **31,986,500** | **30.506** | — |

`resources` 共 **3,449** 个文件。新增的 sandbox 依赖树在 0.2.0 改为扁平 `node_modules`；此前的嵌套副本产生过 300+ 字符路径，导致 makensis 无法读取。

不计入安装体积：

- `.hearth` 业务数据：当前约 1 GiB，随任务历史增长。
- WebView2 系统运行时：由系统共享。
- 每应用 WebView2 缓存：`%LOCALAPPDATA%\ai.hearth.os`，实测约 85 MiB，可在应用关闭后安全清理。

## 构建与复现

```powershell
npm ci
npm run tauri:build
```

流程：

1. 构建 web（默认无 source map）。
2. esbuild 生成单文件 `server.mjs`，复制 PDF worker 与资源，生成第三方声明。
3. 复制 web 到 `resources/web`。
4. 下载、校验、解压官方 Node 22.23.2。
5. 复制并裁剪 npm，生成 `npm.cmd` 和 `helper.cmd`。
6. 执行 `tauri build`，生成 NSIS 安装包。
7. 把安装包复制到 `release/`。

相关环境变量：

| 变量 | 用途 |
|---|---|
| `HEARTH_NODE_PATH` | 使用本机官方 Node v22.x，跳过下载；版本不符会失败 |
| `HEARTH_SOURCEMAP=1` | 仅为调试生成 web source map |
| `CARGO_TARGET_DIR` | 可选，复用 Cargo 构建缓存 |

冷构建约 4–5 分钟，热构建约 2–3 分钟。生成资源目录约 107.2 MiB，安装器压缩后约 27.99 MiB。

## 验收记录

- `npm ci --dry-run` 通过，lock 中不再有 `electron`、`electron-builder`、`@hearth/desktop`。
- `npm run typecheck` 通过。
- `npm test`：117 个文件、858 项测试全部通过。
- `cargo test`：Rust 壳纯函数测试通过（日期换算、导航白名单、重启退避、体检报告、chunked 解码）。
- staged server 冒烟：`/api/ready`、`/api/health`、`/api/executors`、`/` 均正常，HTML 响应带 CSP。
- PDF：经 sources API 读取测试 PDF 成功；cMap、标准字体与 wasm 路径已指向安装目录。
- 安装后：schemaVersion 33，363 个任务可见，数据目录仍为 `D:\App\hearth-os\.hearth`。
- 单实例：第二次启动立即退出并聚焦已有窗口。
- 服务端恢复：结束 node 子进程后约 3.2 秒自动拉起，`/api/ready` 恢复。
- 退出：托盘退出后端口 4317 释放，`hearth.lock` 清理。

## 别人下载后能否直接用

安装包是公开可下载的 x64 Windows 程序。**核心应用可以安装后直接启动**，不需要预装 Node、npm 或 Electron；Node、npm、服务端、Web 前端、PDF 资源和桌面助手都在安装包里。

但仍有一些前提，按重要性排列：

| 项目 | 是否必需 | 说明 |
|---|---|---|
| Windows 10/11 x64 | 必需 | 仅提供 x64 安装包 |
| WebView2 Runtime | 必需 | Windows 11 通常自带；Windows 10 多数已随 Edge 安装。缺失时安装器会在线下载 bootstrapper，因此首次安装需要联网 |
| 管理员权限 | 不需要 | 按用户安装到 `%LOCALAPPDATA%\Programs\Hearth` |
| SmartScreen | 需要一次确认 | 安装包未签名，Windows 可能提示“已保护你的电脑”；点“更多信息 → 仍要运行”即可 |
| 端口 4317 | 必需 | 被其他程序占用时应用会提示并退出 |
| 数据目录选择 | 首启一次 | 新电脑没有旧数据时，在原生对话框选“否”新建 `%LOCALAPPDATA%\Hearth` |
| 聊天模型 API Key | 聊天必需 | 在应用设置里填写提供方、Base URL、模型名和 API Key；不配置也能浏览任务和设置 |
| Codex CLI | 可选 | 没有 `codex.exe` 时 Codex 执行器不可用，但 native 执行器仍可用；可设置 `HEARTH_CODEX_PATH` |
| Git | 可选但常用 | 克隆仓库、Worktree、代码任务需要 `git.exe` |
| GitHub CLI | 可选 | 仅私有 GitHub 仓库操作需要 `gh` 并登录 |
| 资料库 | 内置 | 使用 Hearth 自己的 SQLite 与本地小模型；关键词检索无需额外下载，语义检索按需下载约 25–45 MB 模型 |

因此，“下载就能打开”成立；“下载就能完成所有 AI/代码任务”不成立。后者还取决于模型 Key、Codex、Git 和网络环境。应用内的“环境体检”会逐项显示缺失项和处理建议。

### 首次安装建议步骤

1. 从 GitHub Release 下载 `Hearth_0.1.0_x64-setup.exe`。
2. 若 SmartScreen 提示，选择“更多信息 → 仍要运行”。
3. 按用户安装，无需管理员权限。
4. 启动 Hearth；首次弹出数据目录对话框时，新用户选“否”使用 `%LOCALAPPDATA%\Hearth`。
5. 打开“环境体检”，按提示配置聊天模型；需要代码任务时安装 Git 与 Codex CLI。
6. 需要语义检索时，第一次搜索会按需下载本地小模型；不下载也能使用关键词检索和统一文件树。
7. 托盘菜单可以打开数据目录、日志目录和桌面助手；关窗只会隐藏到托盘，退出请用托盘菜单。

## 进一步压缩的边界

当前 114.8 MiB 已经接近不改运行时的硬下限：

- `node.exe` 82.97 MiB 无法再压，除非改用 small-icu、UPX 或自编译 Node；这会改变官方运行时假设。
- 删除 npm 可再省约 7.8 MiB，但托管安装和运行时 npm 会失效。
- 删除 PDF cMaps / 标准字体 / wasm 可再省约 3.2 MiB，但中文 PDF 提取会退化。
- 再往下低于约 110 MiB，必须牺牲上述功能或更换 Node 运行时方案；当前版本已包含项目文件夹选择器等新增能力，仍保持在 115 MiB 目标内。
- 内置 WebView2 离线运行时会额外增加约 150 MiB，不适合当前目标。
- 内置 Codex 平台二进制会增加约 479 MiB，因此继续外置。

## 排障

- 启动失败：查看 `%LOCALAPPDATA%\Hearth\logs\main.log` 与 `server.log`。
- 端口冲突：关闭占用 4317 的程序，或从托盘退出已有 Hearth。
- 数据目录错误：编辑 `%LOCALAPPDATA%\Hearth\desktop.json`，或设置 `HEARTH_ROOT` 做临时覆盖。
- Node 下载失败：把 `HEARTH_NODE_PATH` 指向官方 Node v22.x 的 `node.exe` 后重新构建。
- 旧界面缓存：Tauri 模式会注销 Service Worker；仍异常时可清理 `%LOCALAPPDATA%\ai.hearth.os`。

## 相关文件

- `scripts/build-tauri.mjs`：完整构建流水线、Node/npm 固定与裁剪、helper 生成。
- `scripts/build-server.mjs`：服务端 bundle、PDF 资源复制、第三方声明。
- `apps/desktop-tauri/src-tauri/src/lib.rs`：Tauri 外壳全部行为。
- `apps/desktop-tauri/src-tauri/tauri.conf.json`：NSIS 与 WebView2 配置。
- `apps/desktop-tauri/src-tauri/installer-hooks.nsh`：固定安装目录。
- `packages/agent-runtime/src/documents.ts`：PDF 资源路径注入。
- `docs/design/desktop.md`：桌面版设计与运行说明。

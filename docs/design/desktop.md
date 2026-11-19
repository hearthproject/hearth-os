# Hearth Windows 桌面版 v0.1（Tauri）

桌面版只有一套实现：Tauri 2 外壳 + 官方 Node 运行时 + 原来的 Fastify / React / SQLite 应用。目标是把仓库里的完整应用打成可双击运行的程序，同时继续使用现有数据，不牺牲任何已有功能。

完整的压缩过程、每一步的体积变化、复现命令和对外分发时的使用前提见 [桌面版压缩实录](desktop-compression.md)。

## 运行形态

- Tauri 主程序负责窗口、托盘、数据目录选择、环境体检和服务端生命周期，安装后约 6.5 MiB。
- 服务端是原来的 Fastify 应用，由 esbuild 打成单个 `server.mjs`（约 10.3 MiB），作为 Tauri 的子进程运行，固定监听 `127.0.0.1:4317`。
- 内置官方 Node `22.23.2`（`node.exe`，83.0 MiB）和随附 npm `10.9.8`（裁剪后约 7.8 MiB）。托管安装、运行时 `npm` 命令都使用内置 npm。
- 前端构建产物在 `resources/web`（约 0.8 MiB，默认不生成 source map）。PDF worker 与 cMaps / 标准字体 / wasm 在 `resources/server`（合计约 14.7 MiB）。
- Codex 不内置约 479 MiB 的平台二进制：优先 `HEARTH_CODEX_PATH`，其次 `where codex.exe` 的第一个 `.exe`，最后已知 npm 全局路径。
- 桌面版和开发服务器不能同时使用同一个 `.hearth`；数据目录锁会拒绝第二个实例。

## 构建

```powershell
npm ci
npm run tauri:build
```

流程：web build → server 单文件 bundle → 复制 web → 下载并校验官方 Node 22.23.2 → 复制/裁剪 npm → 生成 `npm.cmd` 与 helper 启动脚本 → `tauri build`。

产物：

- `release/Hearth_0.1.0_x64-setup.exe`：NSIS 按用户安装，免 UAC，带开始菜单快捷方式。
- 安装包约 27.7 MiB，安装后约 113–115 MiB。
- 安装目录：`%LOCALAPPDATA%\Programs\Hearth`，刻意与数据目录 `%LOCALAPPDATA%\Hearth` 分开。
- WebView2 使用在线 bootstrapper；Windows 10/11 通常已自带运行时，不额外占安装体积。

构建缓存位于 `apps/desktop-tauri/.cache`（Node zip 与解压目录），可随时删除。若官方 Node 下载失败，可把 `HEARTH_NODE_PATH` 指向官方 Node v22.x 的 `node.exe`。

## 体积去向

| 组成 | 安装后 |
|---|---:|
| `node.exe`（官方 22.23.2） | 83.0 MiB |
| server（单文件 + PDF worker + PDF 资源） | 14.7 MiB |
| 内置 npm | 7.8 MiB |
| web 静态资源 | 0.8 MiB |
| Tauri 主程序 | 6.5 MiB |
| helper / 许可证 / 第三方声明 | 0.5 MiB |
| **合计** | **约 113.3 MiB** |
| NSIS 安装包 | 27.7 MiB |

不计入安装体积：`.hearth` 业务数据（当前约 1.03 GB）、系统共享的 WebView2 运行时、每应用 WebView2 缓存 `%LOCALAPPDATA%\ai.hearth.os`（约 80 MiB，可安全清理）。

进一步压缩的边界：不修改官方 Node（不做 small-icu、UPX、按需下载），不删除 npm，不删除 PDF cMaps / 标准字体 / wasm。低于约 110 MiB 必须牺牲功能或更换 Node 运行时方案。

## 数据目录

首次启动会弹出原生 Windows 对话框三选一：

- 使用现有数据：默认 `D:\App\hearth-os`（可用 `HEARTH_EXISTING_ROOT` 覆盖）。
- 新建数据目录：`%LOCALAPPDATA%\Hearth`。
- 退出。

选择会写入 `%LOCALAPPDATA%\Hearth\desktop.json`，结构为 `{version:1, root, dataDir, lastLaunchAt}`；旧的只含 `{root}` 的文件仍可读取。`HEARTH_ROOT` 只作为测试/覆盖入口，不覆盖 `desktop.json`。

数据根下必须有 `.hearth`，桌面版不会静默复制旧数据库。数据库大于 600 MB 时，复制既慢又容易漏掉 `master.key`、模型设置和 worktree 绝对路径，因此 v0.1 就地使用。

## 生命周期

- 单实例：第二次启动会聚焦已有窗口。
- 启动前探测 4317：已有 Hearth 会提示先退出旧实例；被其他程序占用会提示并退出。
- 关窗不退出，窗口隐藏到托盘。
- 托盘菜单：打开 Hearth、环境体检、桌面助手、数据目录、日志目录、退出；左键双击打开主窗口。
- 关闭窗口后服务端继续运行；托盘退出会先 POST `/api/desktop/shutdown`，再 `taskkill /T /F`，并清理与 PID 匹配的 `hearth.lock`。
- 服务端异常退出后按 1s、2s、5s、10s、30s 退避重启；成功就绪后重置计数，连续 5 次失败弹窗并停止。
- 日志：`%LOCALAPPDATA%\Hearth\logs\main.log` 和 `server.log`，5 MiB 轮转保留 3 份；服务端 stdout/stderr 写入 `server.log`。

## 环境体检

启动后后台执行一次，托盘“环境体检”可再次查看。检查项与旧 Electron 版一致：

1. 聊天模型：读取 `/api/health` 的 `chatModel.configured`。
2. Git：`git.exe --version`。
3. GitHub CLI：`gh.exe --version`。
4. Codex：`HEARTH_CODEX_PATH` → `where codex.exe` → 已知 npm 全局路径；优先取 `.exe`。
5. npm：内置 `node.exe + npm-cli.js --version`。
6. 桌面助手：`resources/helper/helper.cmd` 是否存在。
7. 端口：`/api/health` 是否能访问 `127.0.0.1:4317`。

模型未配置时首次启动会弹一次引导，但不阻塞进入主界面；`HEARTH_ENV_SKIP_INTRO=1` 可跳过。检查结果不合格不会让应用白屏。

## 桌面助手

托盘“桌面助手”用 `cmd /c resources/helper/helper.cmd` 启动带独立控制台的 helper。脚本直接调用内置 `node.exe`，不再依赖 Electron 的 `ELECTRON_RUN_AS_NODE` 或 `Hearth.exe`。helper 资源从 `tools/windows-helper` 复制，包含 `helper.mjs` 与 `windows.ps1`。

## 安全边界

- 外部链接和新窗口只允许 http/https，交给系统浏览器；主窗口只允许 splash 与 `127.0.0.1:4317` 导航。
- 服务端在 `HEARTH_DESKTOP=1` 时通过 `onSend` 注入 CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ... frame-ancestors 'none'`。
- 桌面模式注销 Service Worker，避免旧界面被缓存。
- 不绕过服务端已有的 loopback 与 Origin 校验。
- 不使用 rfd/dialog 插件，原生对话框直接调用 `MessageBoxW` / `ShellExecuteW`，减少体积。

## 烟测

```powershell
# 用内置 Node 启动 staged server（单独端口，避免与桌面实例冲突）
$env:HEARTH_PORT='4399'
$env:HEARTH_DESKTOP='1'
apps\desktop-tauri\src-tauri\resources\node.exe apps\desktop-tauri\src-tauri\resources\server\server.mjs
```

验证 `/api/ready`、`/api/health`、`/api/executors`、`/`、CSP 响应头，以及任务附件中的中文 PDF。完整桌面验收覆盖窗口、托盘全部菜单、桌面助手控制台、环境体检、数据/日志目录、双击托盘、关窗进托盘、单实例聚焦、托盘退出清理 4317 与锁、结束 node 子进程后自动拉起。

## 已知限制

- 仅 Windows x64；不做代码签名、自动更新、便携版、macOS、Linux、多用户。
- 安装包没有签名，公开下载会触发 SmartScreen；当前只自己用。
- Codex 使用系统或 `HEARTH_CODEX_PATH` 指向的 `codex.exe`；DeepSeek SDK 已直接打入 server 单文件，缺失外部运行时不影响 native / Codex。
- Gmail OAuth 回调仍固定 `127.0.0.1:4317`，不要改成动态端口。
- 卸载不会删除 `%LOCALAPPDATA%\Hearth` 数据目录，这是刻意的。

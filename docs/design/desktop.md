# Hearth Windows 桌面版 v0.1

这是当前自用版的 Windows 桌面封装。目标只有一个：把仓库里的 Fastify + React + SQLite 应用打成可双击运行的程序，同时继续使用现有数据。

## 运行形态

- Electron 主进程负责窗口、托盘、数据目录选择和生命周期。
- 服务端仍是原来的 Fastify 应用，作为 Electron 的子进程运行，固定监听 `127.0.0.1:4317`。
- 前端构建产物放在 `resources/web`，服务端 bundle 放在 `resources/server`，SQLite 和产物仍在数据根的 `.hearth` 下。
- 桌面版和开发服务器不能同时使用同一个 `.hearth`；数据目录锁会拒绝第二个实例。

## 构建

```powershell
npm ci
npm run desktop:build:dir   # 只生成 release/win-unpacked
npm run desktop:build       # 生成 NSIS 安装包和便携版
```

产物：

- `release/win-unpacked/Hearth.exe`：解包目录，适合本机调试。
- `release/Hearth-Setup-0.1.0.exe`：按用户安装，免 UAC，带开始菜单快捷方式。
- `release/Hearth-Portable-0.1.0.exe`：便携版，首次运行需要把约 550MB 解压到临时目录，耗时可能数分钟；后续会复用 `HearthPortable` 解压目录。

图标从 `docs/public/brand/hearth-os-logo.png` 生成；`apps/desktop/build/icon.ico` 和 `apps/desktop/build/installer.nsh` 需要提交，生成的中间 PNG 不入库。

## 数据目录

首次启动会弹出选择框：

- 使用现有数据：默认 `D:\App\hearth-os`（仓库内已有的 `.hearth`）。
- 新建数据目录：`%LOCALAPPDATA%\Hearth`。
- 退出。

选择会写入 `%LOCALAPPDATA%\Hearth\desktop.json`。自动化测试可用 `HEARTH_ROOT` 直接指定数据根，跳过弹窗。

数据根下必须有 `.hearth`，桌面版不会静默复制旧数据库。数据库大于 600MB 时，复制既慢又容易漏掉 `master.key`、模型设置和 worktree 绝对路径，因此 v0.1 采取就地使用。

## 生命周期

- 单实例：第二次启动会聚焦已有窗口。
- 关窗不退出，窗口隐藏到托盘。
- 托盘菜单：打开 Hearth、环境体检、桌面助手、数据目录、日志目录、退出。
- 关闭窗口后服务端继续运行；托盘退出会停止服务端并释放 4317。
- 服务端崩溃后按 1s、2s、5s、10s、30s 退避重启，5 次失败后提示。
- 日志：`%LOCALAPPDATA%\Hearth\logs\main.log` 和 `server.log`，5MB 轮转保留 3 份。
- 数据锁：`<dataRoot>\.hearth\hearth.lock`，记录 PID、端口和时间；残留锁会按 PID 是否存活清理。

## 环境体检

启动后后台执行一次，托盘“环境体检”可再次查看。检查项：

1. 聊天模型：读取 `/api/health` 的 `chatModel.configured`。
2. Git：`git.exe --version`。
3. GitHub CLI：`gh.exe --version`。
4. Codex：`HEARTH_CODEX_PATH` → `where codex.exe` → 已知 npm 全局路径；优先取 `.exe`，不取 `.ps1` / `.cmd`。
5. npm：托管安装依赖；缺失只禁用托管安装。
6. 桌面助手：`resources/helper/helper.mjs` 是否存在。
7. 端口：`/api/health` 是否能访问 `127.0.0.1:4317`。

模型未配置时首次启动会弹一次引导，但不阻塞进入主界面。检查结果不合格不会让应用白屏。

## 桌面助手

桌面版从托盘菜单“桌面助手”打开 `resources/helper/helper.cmd`。它会启动带控制台窗口的 helper，显示配对码；设备页在桌面模式下不再提示 `npm run helper:windows`。浏览器模式保留原来的开发命令。

## 安全边界

- `contextIsolation`、`sandbox` 开启，`nodeIntegration` 关闭，禁用 `webviewTag`。
- 权限请求全部拒绝；CSP 由主进程注入。
- 外部导航和 `window.open` 转到系统浏览器。
- 桌面模式注销 Service Worker，并清空旧浏览器会话的 SW / CacheStorage；v0.1 不走 PWA 缓存。
- 不绕过服务端已有的 loopback 与 Origin 校验。

## 烟测

```powershell
npm run desktop:build:dir
npm run desktop:smoke
```

烟测用 Playwright 启动 `release/win-unpacked/Hearth.exe`，验证窗口标题、preload、Service Worker 数量、`/api/health`、现有会话，以及退出后 4317 释放。默认使用仓库根的数据；`HEARTH_SMOKE_DATA` 可以指定临时数据根。

## 已知限制

- 安装包和便携版没有代码签名，公开下载会触发 SmartScreen；当前只自己用。
- 不做自动更新、macOS、Linux、多用户。
- 便携版首次解压慢是 Electron 本体和 server 依赖体积导致的；不是包损坏。
- Codex 不内置 479MB 平台二进制，使用系统或 `HEARTH_CODEX_PATH` 指向的 `codex.exe`；DeepSeek 是可选运行时，缺失时不影响 native / Codex。
- Gmail OAuth 回调仍固定 `127.0.0.1:4317`，不要改成动态端口。
- 卸载不会删除 `%LOCALAPPDATA%\Hearth` 数据目录，这是刻意的。

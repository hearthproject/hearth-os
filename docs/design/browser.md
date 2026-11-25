---
title: "浏览器自动化"
description: "任务级 Playwright Extension 与受管 Chrome、用户接管、会话延续、脱敏和证据链路。"
outline: [2, 3]
---

# 浏览器自动化

Hearth 的浏览器能力是一个任务级平行工具。Agent 可以通过它在真实网页中读取页面、填写表单、提交流程、处理 Canvas 和复杂前端，也可以在登录、验证码、支付确认或页面状态发生变化时，把浏览器交给用户，随后继续同一任务。

浏览器没有独立设置页。用户日常 Chrome 的配对、连接、接管和关闭都放在当前任务的浏览器卡中。会话按任务保存，跨运行和 Hearth 重启继续存在，直到用户显式关闭浏览器或删除任务。

## 产品定位

浏览器工具负责四类结果。

- 把页面结构压缩成 Agent 可读的 frame、元素、正文和稳定元素引用。
- 把浏览器控制权、接管类型、页面观察版本和任务运行状态放进同一条可恢复链路。
- 为每次有副作用的网页动作保存截图、摘要和动作证据。
- 让用户在日常 Chrome 中完成必须由本人处理的步骤，再把控制权交还 Agent。

浏览器工具只注入 Native 执行器。Codex 与 DSH 可以使用各自的 Shell 运行 Playwright 脚本，但那条路径不会自动获得 Hearth 的任务级浏览器会话、控制权切换、元素 epoch、证据和脱敏链路。

## 连接方式

任务首次打开浏览器时按以下顺序选择后端。

1. 已配对 Playwright Extension 时，尝试连接用户日常 Chrome。
2. Extension 连接失败或自动连接不可用时，回退到 Hearth 受管 Chrome profile。
3. 任务卡允许用户重新配对 Extension 或按当前任务重新连接。

Extension 使用固定版本的 `@playwright/mcp`，当前依赖为 `0.0.86`。每个任务启动独立的 MCP stdio 扩展连接，token 通过受控子进程环境传给扩展，浏览器状态文件只记录配对状态，不记录 token 明文。

扩展 ID 为 `mmlmfjhmonkocbjadbfplnigmagldckm`，安装地址由服务端状态返回，前端只需要引导用户安装和填写扩展提供的 token。

受管 Chrome 使用独立 profile。它适合没有安装扩展、扩展未配对、用户明确选择受管浏览器的任务。受管 profile 与日常 Chrome 分开保存登录态。

## 任务卡与接管

运行卡显示当前后端、URL、标签页、截图、控制状态、接管类型和最近观察时间。主要操作如下。

| 操作 | 结果 |
|---|---|
| 接管浏览器 | 控制状态进入 `user`，Agent 停止执行页面动作，标签页置前 |
| 继续 Agent | 控制状态回到 `agent`，控制 epoch 增加，并尝试重新观察页面 |
| 重新连接扩展 | 为当前任务重新建立 Extension 会话，并恢复保存的标签页 URL |
| 关闭浏览器 | 显式释放该任务当前浏览器运行时，保留任务和证据 |

控制状态保持为 `agent`、`awaiting_user`、`user`、`closed` 或 `unavailable`。`awaiting_user` 表示 Agent 已请求用户处理，`user` 表示用户正在操作。用户接管期间，浏览器工具返回明确的暂停错误，Agent 不会抢回前台。

用户归还控制权后，页面、标签页、登录状态和前端状态都可能变化。Agent 必须重新调用 `browser_read`，旧的元素引用不能继续使用。

## 二十个浏览器工具

| 工具 | 能力 |
|---|---|
| `browser_open` | 打开任意 http/https 页面，可指定新标签页 |
| `browser_read` | 重读所有 frame、开放 Shadow DOM、正文和可交互元素 |
| `browser_click` | 点击当前快照中的元素 |
| `browser_hover` | 悬停元素，触发菜单和浮层 |
| `browser_type` | 向输入框写入文字，包括密码框 |
| `browser_key` | 发送 Enter、Escape、Tab 等按键 |
| `browser_wait` | 等待元素、页面文字或网络空闲 |
| `browser_submit` | 点击表单提交按钮 |
| `browser_select` | 操作 select 或组合框 |
| `browser_drag` | 在两个元素之间拖拽 |
| `browser_click_at` | 按视口坐标点击 Canvas、地图和截图类界面 |
| `browser_type_at` | 按视口坐标点击后输入文字 |
| `browser_scroll` | 横向或纵向滚动页面 |
| `browser_tabs` | 列出、新建、切换和关闭标签页 |
| `browser_screenshot` | 保存当前页面截图到任务产物目录 |
| `browser_upload` | 选择任务工作区内的文件 |
| `browser_download` | 点击下载链接并保存文件 |
| `browser_assert` | 记录文字、URL 或元素断言，作为补充证据 |
| `browser_request_takeover` | 请求用户处理登录、验证码、支付确认或复杂交互 |
| `browser_recipe` | 保存、列出、回放和删除站点配方 |

`browser_assert` 是可选的证据工具。浏览器任务可以直接调用 `finish_task`，断言失败或被跳过时不会强制阻止完成。最终结果仍由任务目标、产物和运行证据共同判断。

## 页面快照

每次 `browser_read` 扫描主 frame 和 iframe，并递归遍历开放 Shadow DOM。快照包含：

- 可交互元素的 role、name、tag、type、disabled、checked、bbox 和 value。
- 元素所在的 frame 序号、frame 名称和 frame URL。
- 页面 digest、观察时间和控制 epoch。
- 每个可交互元素的引用 `${controlEpoch}:e${sequence}`。

密码框和 `autocomplete` 为 password 的输入框不返回 value。普通输入框的值用于帮助 Agent 判断表单状态，写入过长的正文时会截断。

元素引用绑定控制 epoch。用户接管、归还 Agent 或重新连接扩展后，epoch 增加，旧引用会被拒绝。这个规则同时覆盖跨 frame 和 Shadow DOM 的元素。

## 登录、验证码、支付和复杂前端

以下场景已有产品层接管路径。

### 登录

Agent 可以在受管 profile 中填写用户名和密码，也可以在日常 Chrome 中继续使用已有登录态。遇到二次验证、设备确认、短信或扫码时，Agent 调用 `browser_request_takeover`，用户在同一个 Chrome 标签页完成验证，然后点击“继续 Agent”。

### 验证码

Agent 请求 `captcha` 类型接管，浏览器置前，Agent 停止页面动作。用户完成验证码后归还控制权，Agent 重新观察页面再继续。产品不自动破解验证码。

### 支付确认

Agent 可以填写订单信息和普通表单。最终支付按钮、确认弹窗或需要本人授权的页面由用户接管。支付完成后，Agent 重新读取结果页或下载回执。

### 复杂前端

对于菜单、拖拽、富文本、Canvas、地图、截图式界面和跨 iframe 流程，工具提供 hover、drag、坐标点击、坐标输入、滚动、多 frame 快照和开放 Shadow DOM 扫描。无法稳定读取的界面仍可以使用截图配合坐标操作，必要时请求用户接管。

这条路径可以完成真实协作流程，但不能承诺所有网站都能无人值守完成。网站风控、验证码策略、扩展配对、页面改版和条款限制仍然会影响结果。

## 输入内容与脱敏

`browser_type` 和 `browser_type_at` 允许 Agent 填写任意文字，包括密码。输入值在以下位置统一替换为 `[REDACTED]`：

- 浏览器工具调用事件和调用参数。
- Native 运行 journal 的 `tool.call`、assistant tool call 和 `tool.result` 回显。
- Native 检查点文件和 SQLite checkpoint snapshot。
- 任务运行卡中的工具输入和输出。
- 审批预览中的参数副本。
- Playwright Extension 返回的错误正文和解析错误。
- 站点配方的步骤文本。

动作 digest 使用输入值的哈希，不保存输入明文。页面快照继续屏蔽 password value。任务截图仍可能包含页面自身展示的内容，站点应在需要保密时自行遮挡。

## 证据

有副作用的网页动作会保存动作前后截图和 evidence JSON。证据包括任务、运行、动作类型、URL、标题、页面 digest、动作 digest 和创建时间。

证据目录由 `BROWSER_EVIDENCE_DIR` 配置，默认保留 7 天，每任务最多 500 个证据文件和截图。清理只删除过期浏览器证据，不删除任务产物。

`browser_assert` 的断言结果会进入工具 metadata 和运行记录，供用户核对。断言是证据，不是完成门禁。

## 会话和资源

浏览器会话元数据写入 `.hearth/browser/sessions.json`，包括任务、后端、标签页 URL、活动标签页、控制状态、epoch、接管类型和最近观察信息。

当前实现没有以下产品限制：

- 域名白名单或高风险域名名单。
- 固定任务并发数。
- 固定标签页数量。
- 固定会话空闲回收。
- 高风险站点接管白名单。

实际并发由活动会话数、模型调用、Chrome 扩展连接和机器资源决定。单个动作仍有导航、定位、等待和下载的技术 timeout，用于避免永久挂起。

任务成功、失败、等待输入或取消后，浏览器保持到显式关闭或任务删除，以便用户检查现场并继续会话。

## 审批和动作分类

普通页面读取、打开、点击、输入、按键、等待、选择、拖拽、滚动、标签页操作和接管请求不进入 unknown 审批。表单提交、上传、下载和配方回放保留既有外部写入策略。

动作解析继续记录 URL、元素引用、页面 digest 和输入 digest。审批预览使用脱敏后的参数副本，真实参数只用于动作解析和 digest 计算。

## 与 Playwright 的区别

Playwright 是浏览器自动化引擎和协议。Playwright MCP Extension 是连接用户 Chrome 的桥。Hearth 的浏览器工具是在这个引擎上构建的任务级产品能力，负责：

- 任务与浏览器会话绑定。
- 跨 run 和重启的标签页恢复。
- Agent 与用户之间的控制权切换。
- 接管类型和恢复提示。
- 控制 epoch 与元素引用失效。
- 多 frame、Shadow DOM 和 Canvas 交互。
- 动作证据、截图和断言记录。
- 输入值脱敏和检查点恢复。
- 任务运行卡中的接管按钮和会话状态。

直接运行一段 Playwright 脚本可以完成页面操作。它需要调用方自己管理会话、异常回放、登录交接、证据和日志脱敏。

## Linger 调研结果

本次调研参考了 Linger 的桌面与浏览器文档、架构文档、`user_chrome_session.go`、`browser_connection.go` 和 `cua.go`。

| Linger 做法 | Hearth 的取舍 |
|---|---|
| 使用用户日常 Chrome 和已有登录状态 | 采用，通过官方 Playwright Extension |
| token 只通过受控子进程环境传递 | 采用，只在真实连接成功后保存 token |
| 每任务浏览器输入 lane | 采用，每个任务独立 MCP 连接 |
| 输入结果未知时不盲目重放 | 继续沿用 Hearth 的 operation ledger 和恢复策略 |
| 原生 CUA 处理 Canvas 和不可读 UI | 采用坐标点击、坐标输入、截图和用户接管组合 |
| 用户接管时不抢回前台 | 采用控制状态和明确归还动作 |
| 固定 10 分钟空闲回收 | 不采用，Hearth 保持到显式关闭 |
| 单一 Chrome seat 和任务串行 | 不采用，并发受会话和机器资源约束 |
| 高风险域名和审批策略 | 不采用，普通网页交互不设域名限制 |

## 真实边界

当前可直接验证的能力包括受管 Chrome 的页面操作、多 frame、开放 Shadow DOM、Canvas 坐标交互、输入脱敏、任务卡接管、控制权归还、检查点恢复和显式关闭。

真实 Chrome Extension 连接需要用户安装扩展、在 Chrome 中打开 Playwright Extension 配对页并填写有效 token。仓库内的自动测试使用 mock 扩展连接验证协议、状态和恢复逻辑。实际 Chrome 配对是否首次可用仍取决于本机 Chrome、扩展安装策略和配对页面。自动化测试不能替代一次人工配对验收。

网站自身可能阻止自动化、要求重新验证码或改变 DOM。产品提供协作接管和会话延续，自动破解验证码和无人值守支付不在当前能力范围内。

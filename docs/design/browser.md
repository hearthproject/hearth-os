---
title: "浏览器自动化"
description: "独立 Chrome profile、页面快照、动作审批、证据和完成断言。"
outline: [2, 3]
---

# 浏览器自动化

Hearth 的浏览器能力目标是“能替你办事，同时能核对”。它不把模型直接接到一个看不见的浏览器上，而是把页面压成可审阅的元素清单，把每个高风险动作变成可审批、可回放、可断言的动作。

## 运行方式

- 使用独立 Chrome profile，路径在 `.hearth/browser/profile`，不与用户默认 Chrome 共享 cookie。
- 启动时优先使用系统 Chrome，其次 Edge/Chromium；`HEARTH_BROWSER` 可指向可执行文件。
- 每个任务一个标签页上下文，最多 4 个任务同时打开，最多 6 个标签页；空闲 10 分钟释放。
- Chrome 136+ 不允许在默认 profile 上开启远程调试，因此没有“直接接管默认 profile”的捷径。

## 页面快照

每次读取页面都会：

- 给可交互元素写稳定 `data-hearth-ref`（`e1`、`e2`…）；
- 返回 role、name、value、disabled、checked、bbox、tag、type；
- 密码字段不返回值；
- 正文截断到 2400 字，页面摘要上限 12k；
- 生成页面 digest，作为动作前后的比较依据。

模型只能按稳定 ID 操作，不直接写 CSS 选择器，也不接触 cookie、密码或浏览器存储。

## 13 个工具

| 工具 | 用途 | 默认风险 |
|---|---|---|
| `browser_open` | 打开 http/https；新域名需审批 | 中 |
| `browser_read` | 读页面文本与元素清单 | 低 |
| `browser_click` | 点击普通元素；提交/支付/删除类元素拒绝 | 中 |
| `browser_type` | 输入文本；密码字段拒绝 | 中 |
| `browser_key` | 按键，如 Enter、Escape | 中 |
| `browser_wait` | 等元素、文本或网络空闲 | 低 |
| `browser_submit` | 提交表单；每次单独审批 | 高 |
| `browser_tabs` | 列出、新建、切换、关闭标签页 | 中 |
| `browser_screenshot` | 截图到任务输出目录 | 低 |
| `browser_upload` | 上传工作区内文件 | 高 |
| `browser_download` | 下载到任务输出目录 | 高 |
| `browser_assert` | 断言文本、URL、元素存在/不存在 | 低 |
| `browser_recipe` | 列出/保存/回放/删除站点配方 | 中 |

危险按钮识别覆盖 `submit`、`pay`、`delete`、`send`、`提交`、`发送`、`支付`、`删除`、`确认`、`下单` 等中英文标签。调用过浏览器工具的任务，`finish_task` 前必须至少有一条通过的断言，且最后一条断言必须通过。

## 审批与授权

- `browser_open` 首次访问新域名进入审批；选择“该域名始终允许”会写入一条 30 天、无次数上限的域名授权。
- 提交、上传、下载每次审批；高风险站点（银行、支付、邮箱、政府站点）不能被“始终允许”绕过。
- 只允许 http/https；`file://`、`javascript:` 等协议拒绝。
- 站点配方保存的是步骤和断言，不保存 cookie、密码或页面正文。

## 证据

每次动作保存：

- 动作前后截图：`<BROWSER_EVIDENCE_DIR>/<task>/<timestamp>-before.png` / `-after.png`；
- `evidence.json`：URL、标题、页面 digest、动作 digest、时间；
- 证据保存在任务工作区；对话运行卡显示动作摘要，完整截图与证据列表可在任务产物和日志中查看。

证据默认保留 7 天，每任务最多 500 个文件；清理任务会删除超期文件，不删除任务产物。

## 完成判定

浏览器任务不能只靠“模型说完成了”。完成前必须：

1. 至少一条 `browser_assert` 通过；
2. 最后一条断言通过；
3. 失败断言或未断言会阻止 `finish_task`。

这让“页面真的到了成功页”成为完成证据，而不是模型的自述。

## 边界

- 不读取 cookie、密码、浏览器历史或支付信息。
- 不承诺绕过验证码、风控或网站条款。
- 不实现“直接控制默认 Chrome”的扩展桥；需要登录的站点请在独立 profile 中登录一次。
- 上传只允许任务工作区内的文件；下载落到任务输出目录，不自动打开。

---
title: '快速开始'
description: '在本机安装、启动 Hearth，并完成第一个任务。'
outline: [2, 3]
---

# 快速开始

<p class="lead">Hearth 是一个本机优先的单用户应用。服务端、数据库和 Web 控制面都运行在你的机器上，默认只监听回环地址。</p>

## 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | 22.13 或更高版本（服务端使用内置 `node:sqlite`；已在 26.11.1 验证） |
| npm | 随 Node.js 安装即可 |
| 操作系统 | Windows、macOS 或 Linux；桌面控制目前只支持 Windows 同机助手 |
| 模型 | 任一支持工具调用的 OpenAI Chat、OpenAI Responses、Anthropic Messages 或 Gemini 兼容服务 |

## 安装与启动

```bash
git clone https://github.com/hearthproject/hearth-os.git
cd hearth-os
npm ci
npm run dev
```

打开 <http://127.0.0.1:5173>。开发模式会同时启动：

- `@hearth/server`：Fastify API 与调度器，默认监听 `127.0.0.1:4317`。
- `@hearth/web`：Vite 开发服务器，把 `/api` 代理到本机服务。

生产式本机运行：

```bash
npm run build
npm start
```

打开 <http://127.0.0.1:4317>。服务端会直接提供构建后的 Web 静态文件。

## 完成第一个任务

1. 进入 **设置**，选择模型服务商并填写 Base URL、模型名和 API Key；点 **测试连接**。
2. 回到 **聊天**，用一句话描述要完成的工作，例如“把这份会议记录整理成行动纪要，标出负责人和日期”。
3. 普通通用任务会直接派出；需要联网或读写工程工作区的任务会先生成**任务提案**，确认权限后才进入队列。
4. 在 **任务** 中查看状态、执行器、Token、耗时和产物。等待输入的任务可以直接在聊天里补充。
5. 外部动作会出现在审批卡片中。审批绑定参数指纹，只执行一次，并留下回执。

## 数据放在哪里

默认数据目录是仓库根目录下的 `.hearth/`。可以用环境变量覆盖：

```bash
HEARTH_DATA_DIR=/path/to/data
HEARTH_PORT=4317
HEARTH_HOST=127.0.0.1
```

Windows PowerShell 示例：

```powershell
$env:HEARTH_DATA_DIR = "D:\HearthData"
npm start
```

## 下一步

- [接入模型](/guide/models)：四种协议、服务商预设和 Codex 执行器。
- [数据、备份与恢复](/guide/data)：数据库、产物、加密备份和恢复边界。
- [开发与测试](/guide/development)：脚本、测试、文档站和代码结构。

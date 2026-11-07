---
title: '接入模型'
description: '配置对话模型、四种协议和 Codex 执行器。'
outline: [2, 3]
---

# 接入模型

<p class="lead">Hearth 把“聊天模型”和“Codex 执行器”分开配置。聊天模型负责原生 Agent Runtime 的推理与工具调用；Codex 执行器负责代码和仓库任务。</p>

## 对话模型

进入 **设置 → 对话模型**，选择预设或自定义服务：

| 预设 | 协议 | 默认 Base URL |
|---|---|---|
| DeepSeek | OpenAI Chat | `https://api.deepseek.com/v1` |
| 阿里云百炼 | OpenAI Chat | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 智谱 GLM | OpenAI Chat | `https://open.bigmodel.cn/api/paas/v4` |
| 月之暗面 Kimi | OpenAI Chat | `https://api.moonshot.cn/v1` |
| 火山方舟 | OpenAI Chat | `https://ark.cn-beijing.volces.com/api/v3` |
| OpenAI | OpenAI Chat | `https://api.openai.com/v1` |
| Anthropic | Anthropic Messages | `https://api.anthropic.com/v1` |
| Google Gemini | Gemini | `https://generativelanguage.googleapis.com/v1beta` |
| 自定义服务 | 任选四种协议 | 由你填写 |

四种协议由 `@hearth/model-client` 统一成同一种流式 Agent 回合：文本增量、工具调用、参数拼接、结束原因和用量。更换服务商不会改变 Runtime 的工具循环。

### 密钥如何保存

密钥写入 `.hearth/model-settings.json`，文件权限尽量设为 `0600`。设置接口只返回掩码，例如 `sk-1••••abcd`，不会把原始密钥返回浏览器。

### 模型必须支持工具调用

原生执行器依赖模型返回结构化工具调用。如果所选模型不支持工具调用，Hearth 会给出明确错误，不会把普通文本回答伪装成任务完成。

## Codex 执行器

Codex 执行器读取现有的 `~/.codex/config.toml`，不要求 `codex login`。只要配置了 `model_provider` 和对应的 `env_key`，并让该环境变量存在于启动 Hearth 的终端中即可。

设置页会显示：

- Provider 与模型。
- Base URL 与 wire API。
- 环境变量名以及是否已读取。
- 配置文件路径与当前问题列表。

修改 `config.toml` 或环境变量后，点 **重新检测** 即可，不需要重启服务。

### 双执行器如何选择

| 执行器 | 适用任务 | 默认行为 |
|---|---|---|
| `native` | 通用整理、分析、写作、简单文件处理 | 普通任务默认走原生 Runtime |
| `codex` | 代码仓库、多文件修改、运行测试、提交改动 | 明确的工程任务走 Codex |

两者不会在失败后静默互换。运行清单会记录实际执行器，便于核对任务到底由谁完成。

## 常见问题

**保存后仍显示未配置？** 检查 Base URL、模型名和 API Key 是否都非空，然后点 **测试连接**。

**Codex 显示未连接？** 检查 `env_key` 指向的环境变量是否存在于启动 Hearth 的终端。Windows 用户环境变量修改后需要重新打开终端或重启服务。

**能同时用两家模型吗？** 当前设置保存一组对话模型配置。不同任务可以使用不同执行器，但对话模型是全局配置。

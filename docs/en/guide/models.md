---
title: 'Connect a model'
description: 'Configure the chat model, four protocols, and the Codex executor.'
outline: [2, 3]
---

# Connect a model

<p class="lead">Hearth configures the chat model and the Codex executor separately. The chat model drives the native agent runtime; the Codex executor handles code and repository work.</p>

## Chat model

Open **Settings → Chat model** and choose a preset or a custom service:

| Preset | Protocol | Default Base URL |
|---|---|---|
| DeepSeek | OpenAI Chat | `https://api.deepseek.com/v1` |
| Alibaba Cloud Bailian | OpenAI Chat | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Zhipu GLM | OpenAI Chat | `https://open.bigmodel.cn/api/paas/v4` |
| Moonshot Kimi | OpenAI Chat | `https://api.moonshot.cn/v1` |
| Volcengine Ark | OpenAI Chat | `https://ark.cn-beijing.volces.com/api/v3` |
| OpenAI | OpenAI Chat | `https://api.openai.com/v1` |
| Anthropic | Anthropic Messages | `https://api.anthropic.com/v1` |
| Google Gemini | Gemini | `https://generativelanguage.googleapis.com/v1beta` |
| Custom | Any of the four protocols | Supplied by you |

`@hearth/model-client` normalizes all four protocols into one streaming agent turn: text deltas, tool calls, argument assembly, finish reason, and usage. Changing providers does not change the runtime loop.

### How the key is stored

The key is written to `.hearth/model-settings.json`, with permissions set to `0600` where the platform supports it. The settings API returns only a masked value such as `sk-1••••abcd`, never the raw key.

### The model must support tool calling

The native executor depends on structured tool calls. If the selected model does not support them, Hearth returns an explicit error instead of treating a plain text answer as a completed task.

## Codex executor

The Codex executor reads your existing `~/.codex/config.toml` and does not require `codex login`. If a `model_provider` and its `env_key` are configured, the key only needs to exist in the terminal that starts Hearth.

Settings shows:

- Provider and model.
- Base URL and wire API.
- Environment-variable name and whether it was read.
- Config path and current issues.

After changing `config.toml` or the environment, click **Re-detect**. No server restart is required.

### How the two executors are chosen

| Executor | Suitable work | Default behavior |
|---|---|---|
| `native` | General analysis, writing, summarization, simple file work | General tasks use the native runtime |
| `codex` | Repositories, multi-file edits, tests, commits | Explicit engineering work uses Codex |

Failures never silently switch executors. The run manifest records the actual executor so the result can be audited.

## Troubleshooting

**Still unconfigured after saving?** Check that Base URL, model, and API key are all non-empty, then click **Test connection**.

**Codex shows disconnected?** Check that the `env_key` variable exists in the terminal that starts Hearth. On Windows, reopen the terminal or restart the service after changing user environment variables.

**Can I use two chat providers at once?** The settings store one chat-model configuration. Different tasks can use different executors, but the chat model is global.

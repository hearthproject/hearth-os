---
title: '存储与上下文架构'
description: 'Hearth 的 SQLite 事件日志、操作账本、内容 blob、统一模型注册表和上下文交接边界。'
outline: [2]
---

# 存储与上下文架构

<p class="lead">Hearth 把可重建的事实、正文内容和工作目录分开保存。SQLite 是唯一的状态索引与事件账本，文件系统只保存大体量正文、工作区和安装产物。上下文、模型绑定和执行器交接都从同一套记录恢复。</p>

## 核心约束

| 约束 | 含义 |
|---|---|
| 单一写权威 | 服务端单进程写入 SQLite；界面、通知和统计只读取投影，不另建事实源 |
| 先记录再展示 | 任务、运行、操作、上下文、模型绑定和迁移结果先落库，再通过 SSE 推送到前端 |
| 正文与索引分离 | 数据库保存元数据、摘要、哈希和引用；大文本进入内容 blob，工作产物留在任务工作区 |
| 每次执行可追溯 | 上下文条目带 `task_id`、`run_id`、`executor_id`、`provenance_json` 和稳定的 `executor_event_id` |
| 崩溃后可判断 | 工具调用有 T1/T2 操作账本；未结算操作不自动重放，外部写缺回执按未知处理 |
| 执行器不持有长期凭据 | 模型密钥经 AES-256-GCM 加密后存入数据库；执行器只在单次运行中获得解密后的配置 |

当前数据库 schema 版本为 **40**（以 `packages/eventlog/src/database.ts` 的 `CURRENT_SCHEMA_VERSION` 为准）。启动时由 `HearthStore` 顺序执行建表与增量迁移，并写入 `PRAGMA user_version` 和 `app_meta.schemaVersion`。

## `.hearth` 目录

默认数据目录是仓库根目录下的 `.hearth/`，可用 `HEARTH_DATA_DIR` 覆盖；桌面版首次启动时选择现有目录或新建目录。

| 路径 | 保存什么 | 是否进入数据库备份 |
|---|---|---|
| `.hearth/hearth.sqlite` | 事件、任务、运行、操作、审批、效果、上下文、记忆、资料库、模型档案、设置和迁移记录 | 是 |
| `.hearth/master.key` | 本机加密主密钥，用于模型 API Key 等敏感字段 | 是，随备份口令二次加密 |
| `.hearth/context/blobs/` | 超过内联阈值的上下文正文，以内容 SHA-256 命名 | 否 |
| `.hearth/workspaces/tasks/<taskId>/` | 单个任务的工作区、输入、输出、checkpoint 与 `run-evidence.json` | 否 |
| `.hearth/artifacts/` | 受管交付产物及其清单 | 否 |
| `.hearth/sources/` | 抓取或导入的来源正文 | 否 |
| `.hearth/attachments/` | 聊天附件 | 否 |
| `.hearth/outbox/` | 本地发件箱草稿与回执文件 | 否 |
| `.hearth/executors/codex/` | 由统一模型绑定生成的 Codex `config.toml` 与运行目录 | 否 |
| `.hearth/executors/deepseek-harness/` | DeepSeek Harness 的 Provider 补丁和会话运行目录 | 否 |
| `.hearth/backups/` | AES-256-GCM 加密的数据库备份归档 | — |
| `.hearth/backups/legacy-dev/` | 首次迁移旧 JSON 设置时保留的原始副本 | — |
| `.hearth/device-frames/` | 桌面观察帧缓存 | 否 |
| `.hearth/git-cache/` | 仓库准备缓存 | 否 |

`model-settings.json` 和 `executor-settings.json` 只作为旧版本迁移来源保留，不再由设置页写入。迁移成功后不主动删除原文件，便于审计和回滚。

## SQLite 数据域

| 数据域 | 主要表 | 作用 |
|---|---|---|
| 事件账本 | `events` | 只追加的事实流；消息、工具结算、检查点快照与 run 边界都写这里 |
| 任务与运行 | `tasks`、`runs`、`task_follow_ups`、`run_checkpoints`、`task_leases`、`task_proposals`、`task_worktrees` | 任务状态机、追加输入、执行尝试、检查点、租约与 Worktree |
| 操作账本 | `run_operations` | 工具调用的 prepared / dispatched / settled / unknown 与 cleanup 结果 |
| 后台进程 | `background_processes`、`background_tool_jobs` | shell/PTY 会话的 PID、创建时间、日志路径、状态与退出码 |
| 对话 | `conversations`、`chat_messages` | 聊天消息、运行卡与可 upsert 的 `task_status` |
| 审批与副作用 | `approvals`、`approval_grants`、`effects`、`reconcile_queue`、`outbox_drafts`、`prepared_actions` | 一次性授权、幂等执行、不确定效果对账和外部回执 |
| 产物与来源 | `artifacts`、`sources`、`source_items` | 交付物索引、来源正文索引和抓取记录 |
| 委派与交接 | `delegation_jobs`、`handoffs`、`task_edges` | 单层委派、执行器交接和任务依赖/汇合关系 |
| 上下文 | `context_items`、`context_chunks`、`context_documents`、`context_nodes`、`task_context_state`、`context_settings` | 执行轨迹、检索索引、任务摘要和上下文策略 |
| Context Pack | `context_packs`、`context_pack_items`、`memory_entities` | 分通道上下文、预算、引用和记忆-实体链接 |
| 模型管理 | `model_profiles`、`executor_model_bindings`、`app_settings`、`settings_migrations` | 统一模型档案、执行器绑定、聊天模型选择和旧设置迁移 |
| 个人上下文 | `entities`、`entity_aliases`、`relations`、`entity_states`、`decisions`、`commitments`、`mentions` | 个人本体、状态、决定、承诺和提及证据 |
| 记忆 | `memories`、`memory_versions`、`memory_conflicts`、`memory_recalls`、`memory_forget_*`、`memory_settings` | 可纠正记忆、召回审计、纠正、遗忘和设置 |
| 资料库与技能 | `library_roots`、`library_jobs`、`library_trash`、`library_settings`、`skills`、`skill_versions`、`skill_usage_events` | 资料树、索引任务、回收站与技能生命周期 |
| 浏览器与设备 | `browser_grants`、`devices`、`pairing_requests`、`desktop_*`、`connection_*`、`channel_*` | 站点授权、配对、桌面会话、渠道游标与离线发件箱 |
| 定时与运维 | `scheduled_jobs`、`scheduled_job_runs`、`maintenance_runs`、`backup_records`、`watchdog_events` | 周期作业、补跑、维护、备份和看门狗记录 |

## 单一事件日志

服务端不再写 `.hearth/journals/<run>/events.jsonl`。消息、工具结算、checkpoint 快照和 run 边界统一写入 SQLite `events`：

- 事件类型包括 `runtime.run.started`、`runtime.message`、`runtime.tool.dispatched`、`runtime.tool.settled`、`runtime.checkpoint.snapshot`、`runtime.run.ended`，其余用 `runtime.event` 保留原始类型。
- checkpoint 文件是物化视图。写入文件前先追加 `runtime.checkpoint.snapshot` 事件，`run_checkpoints.event_seq` 指向该事件；文件损坏时从事件日志重建。
- 恢复时从 checkpoint 的 `event_seq` 之后回放 `runtime.message` / `runtime.tool.settled`，补齐检查点后的消息；旧版 JSONL checkpoint 仍按原路径兼容。
- standalone / 评测模式使用 JSONL journal；服务端不再有第二份 runtime journal。

## 统一模型注册表

模型不再绑定在某个执行器的私有 JSON 文件里，而是拆成两层：

1. **模型档案 `model_profiles`**：保存显示名、Provider、协议、Base URL、模型名和加密后的 API Key。
2. **执行器绑定 `executor_model_bindings`**：为每个执行器选择档案，并允许受约束的协议或模型覆盖。

`app_settings.model.chatProfileId` 记录 Hearth 当前聊天模型。它用于聊天、失败原因诊断和原生执行器；外部执行器只有在其绑定有效时才使用自己的模型档案。

协议兼容由服务端强制校验：

| 执行器 | 允许的协议 |
|---|---|
| `native` | `openai-chat`、`openai-responses`、`anthropic-messages`、`gemini` |
| `codex` | 仅 `openai-responses` |
| `deepseek-harness` | `openai-chat`、`openai-responses`、`anthropic-messages` |

Codex 的绑定会生成独立的 `.hearth/executors/codex/config.toml`，固定使用 `wire_api = "responses"`，并通过进程环境注入密钥。本地地址（`localhost`、`127.0.0.1`、私有网段和 `.local`）不允许进入统一模型管理，避免把本机模型误当成云端档案。

## 上下文生命周期

上下文是所有执行器共用的任务级记录，不依附于某个 CLI 的私有会话。

1. **采集**：原生运行时、Codex、DeepSeek Harness 和外部 CLI 把消息、工具调用、工具结果、检查点和通知转成统一的 `ContextItem`。
2. **去重**：`executor_event_id` 在同一运行内唯一，重复通知不会重复写入。
3. **内联或落 blob**：正文超过 `maxInlineBytes` 时写入 `.hearth/context/blobs/<sha256>.txt`，数据库只保存 `content_ref`、`sha256` 和截断后的内联片段。
4. **摘要**：条目增长到 `summarizeAfterTokens` 后刷新 `task_context_state`，保留目标、计划、已完成、失败、产物和未解决问题。
5. **投影**：执行器启动或接管时，按 `projectionTokenBudget` 生成受预算约束的上下文投影，而不是把全部历史直接塞给 CLI。
6. **交接**：`handoffs` 保存诊断、交接包、来源运行、目标运行和 `context_watermark_seq`；接管执行器从同一水位继续，避免旧结果覆盖新状态。
7. **删除**：删除任务上下文时清理 `context_items`、`task_context_state` 和不再被引用的 blob；其他任务仍引用的内容不会误删。

上下文模式支持 `off`、`shadow` 和 `on`。`shadow` 只记录不注入，适合先观察采集质量；`on` 才把投影用于执行和接管。

## 运行恢复与存储回收

- `HostKernel` 在恢复完成前保持 `/api/ready` 为 503，写路由返回 `HOST_NOT_READY`；恢复闸门沿父 run 链检查未结算操作、后台进程和 checkpoint proof。
- 重试不再复制整个 `.hearth`，只继承已发布产物与 checkpoint 引用的 tool-results。
- `npm run storage:prune` 默认预演，按保留期、活跃 run、未结算操作和 checkpoint 引用回收旧 run 与未引用工具输出；`--apply` 才实际删除。
- 每个终态 run 在任务工作区输出 `run-evidence.json`，包含 task/run/usage、checkpoint 引用、恢复决策、operations/cleanup、artifacts 与 run 链。

## 备份与恢复边界

数据库备份包含 SQLite 快照、schema 版本、各表计数和本机 `master.key`，整个载荷使用用户口令派生的 AES-256-GCM 密钥加密。恢复前校验 schema 不高于当前版本、载荷哈希一致、候选数据库 `PRAGMA integrity_check` 为 `ok`，通过后才替换现有数据库。

备份**不包含**上下文 blob、任务工作区、产物正文、来源正文、附件和发件箱文件。需要完整迁移时，应同时复制 `.hearth/artifacts/`、`.hearth/workspaces/`、`.hearth/sources/` 和 `.hearth/outbox/`；只备份数据库不等于迁移完整工作。

## 启动迁移

服务启动时按以下顺序处理旧设置：

1. 读取 `.hearth/model-settings.json` 和 `.hearth/executor-settings.json`。
2. 把原文件复制到 `.hearth/backups/legacy-dev/`，文件名带时间或迁移标识。
3. 在事务中写入 `model_profiles`、`executor_model_bindings` 和 `app_settings`。
4. 在 `settings_migrations` 记录 `legacy-model-settings-v1`、`legacy-executor-settings-v1` 的来源、备份、状态和错误。
5. 任一步失败则回滚数据库写入，并保留备份和失败记录，服务不会带着半迁移状态启动。

迁移是幂等的：已完成的迁移 ID 不会重复导入；相同 Provider、地址、模型和协议的档案会复用，而不是创建重复记录。

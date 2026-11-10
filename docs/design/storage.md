---
title: '存储与上下文架构'
description: 'Hearth 的 SQLite、内容 blob、执行器目录、统一模型注册表和上下文交接边界。'
outline: [2]
---

# 存储与上下文架构

<p class="lead">Hearth 把可重建的事实、正文内容和工作目录分开保存。SQLite 是唯一的状态索引与事件账本，文件系统只保存大体量正文、工作区和安装产物。上下文、模型绑定和执行器交接都从同一套记录恢复。</p>

## 核心约束

| 约束 | 含义 |
|---|---|
| 单一写权威 | 服务端单进程写入 SQLite；界面、通知和统计只读取投影，不另建事实源 |
| 先记录再展示 | 任务、运行、上下文、模型绑定和迁移结果先落库，再通过 SSE 推送到前端 |
| 正文与索引分离 | 数据库保存元数据、摘要、哈希和引用；大文本进入内容 blob，工作产物留在任务工作区 |
| 每次执行可追溯 | 上下文条目带 `task_id`、`run_id`、`executor_id`、`provenance_json` 和稳定的 `executor_event_id` |
| 执行器不持有长期凭据 | 模型密钥经 AES-256-GCM 加密后存入数据库；执行器只在单次运行中获得解密后的配置 |

当前数据库 schema 版本为 **28**。启动时由 `packages/eventlog/src/database.ts` 顺序执行建表与增量迁移，并写入 `PRAGMA user_version` 和 `app_meta.schemaVersion`。

## `.hearth` 目录

默认数据目录是仓库根目录下的 `.hearth/`，可用 `HEARTH_DATA_DIR` 覆盖。

| 路径 | 保存什么 | 是否进入数据库备份 |
|---|---|---|
| `.hearth/hearth.sqlite` | 事件、任务、运行、审批、效果、上下文索引、模型档案、设置和迁移记录 | 是 |
| `.hearth/master.key` | 本机加密主密钥，用于模型 API Key 等敏感字段 | 是，随备份口令二次加密 |
| `.hearth/context/blobs/` | 超过内联阈值的上下文正文，以内容 SHA-256 命名 | 否 |
| `.hearth/workspaces/tasks/<taskId>/` | 单个任务的工作区、输入、输出和 `.hearth` 检查点 | 否 |
| `.hearth/artifacts/` | 受管交付产物及其清单 | 否 |
| `.hearth/sources/` | 抓取或导入的来源正文 | 否 |
| `.hearth/attachments/` | 聊天附件 | 否 |
| `.hearth/outbox/` | 本地发件箱草稿与回执文件 | 否 |
| `.hearth/executors/codex/` | 由统一模型绑定生成的 Codex `config.toml` 与运行目录 | 否 |
| `.hearth/executors/deepseek-harness/` | DeepSeek Harness 的 Provider 补丁和会话运行目录 | 否 |
| `.hearth/executors/<id>/` | 其他外部执行器的托管安装与运行目录 | 否 |
| `.hearth/backups/` | AES-256-GCM 加密的数据库备份归档 | — |
| `.hearth/backups/legacy-dev/` | 首次迁移旧 JSON 设置时保留的原始副本 | — |
| `.hearth/device-frames/` | 桌面观察帧缓存 | 否 |
| `.hearth/git-cache/` | 仓库准备缓存 | 否 |

`model-settings.json` 和 `executor-settings.json` 只作为旧版本迁移来源保留，不再由设置页写入。迁移成功后不主动删除原文件，便于审计和回滚。

## SQLite 数据域

| 数据域 | 主要表 | 作用 |
|---|---|---|
| 事件账本 | `events` | 只追加的事实流，驱动 SSE、同步和投影重建 |
| 目标与完成 | `goals`、`goal_completion_reports`、`prepared_actions` | 目标契约、验收证据、完成结论和待审批动作预览 |
| 任务与运行 | `tasks`、`runs`、`task_follow_ups`、`run_checkpoints`、`task_proposals` | 任务状态机、追加输入、执行尝试、预算与恢复点 |
| 对话 | `conversations`、`chat_messages` | 聊天消息和可 upsert 的 `task_status` 状态卡片 |
| 审批与副作用 | `approvals`、`effects`、`reconcile_queue`、`outbox_drafts` | 一次性授权、幂等执行、不确定效果对账和外部回执 |
| 产物与来源 | `artifacts`、`sources`、`source_items` | 交付物索引、来源正文索引和抓取记录 |
| 委派与任务图 | `delegation_jobs`、`handoffs`、`task_edges` | 单层委派、执行器交接和任务依赖/汇合关系 |
| 上下文 | `context_items`、`task_context_state`、`context_settings` | 执行轨迹、任务摘要和上下文策略 |
| Context Pack | `context_packs`、`context_pack_items`、`memory_entities` | 分通道上下文、预算、引用和记忆-实体链接 |
| 模型管理 | `model_profiles`、`executor_model_bindings`、`app_settings` | 统一模型档案、执行器绑定和聊天模型选择 |
| 设置迁移 | `settings_migrations` | 旧 JSON 导入的来源、备份路径、状态和错误 |
| 个人上下文 | `entities`、`entity_aliases`、`relations`、`entity_states`、`decisions`、`commitments`、`mentions` | 个人本体、状态、决定、承诺和提及证据 |
| 记忆与方法 | `memories`、`memory_*`、`method_*`、`method_applications`、`skills`、`skill_*` | 可纠正记忆、召回审计、方法演进和技能生命周期 |
| 注意力 | `standing_intents`、`attention_items`、`heartbeat_runs`、`attention_feedback` | 标准意图、心跳、候选、预算与用户反馈 |
| 多设备与安全 | `devices`、`pairing_requests`、`sync_*`、`task_leases`、`connection_*`、`channel_*` | 配对、同步、租约、连接运行时、离线 outbox 和渠道幂等 |
| 运维 | `maintenance_runs`、`backup_records`、`scheduled_jobs`、`scheduled_job_runs`、`watchdog_events` | 维护、备份、周期作业、补跑、冷却和看门狗记录 |

方法应用记录是 append-only 的本地审计，不参与事件重放和跨设备同步。`tasks.method_id/method_version` 钉住显式绑定，`method_applications` 记录每次运行实际注入的方法版本、选择方式和提示词哈希；`method_candidates.generation` 表示采用代数，`fingerprint` 用于确定性候选去重。

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
| `hermes`、`qoder`、`workbuddy`、`kimi` | `openai-chat`、`openai-responses`、`anthropic-messages` |

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

上下文模式支持 `off`、`shadow` 和 `on`。`shadow` 只记录不注入，适合先观察采集质量；`on` 才把投影用于执行和接管。默认最多接管 2 次、同一执行器最多重试 1 次、保留 30 天。

## 启动迁移

服务启动时按以下顺序处理旧设置：

1. 读取 `.hearth/model-settings.json` 和 `.hearth/executor-settings.json`。
2. 把原文件复制到 `.hearth/backups/legacy-dev/`，文件名带时间或迁移标识。
3. 在事务中写入 `model_profiles`、`executor_model_bindings` 和 `app_settings`。
4. 在 `settings_migrations` 记录 `legacy-model-settings-v1`、`legacy-executor-settings-v1` 的来源、备份、状态和错误。
5. 任一步失败则回滚数据库写入，并保留备份和失败记录，服务不会带着半迁移状态启动。

迁移是幂等的：已完成的迁移 ID 不会重复导入；相同 Provider、地址、模型和协议的档案会复用，而不是创建重复记录。

## 备份与恢复边界

数据库备份包含 SQLite 快照、schema 版本、各表计数和本机 `master.key`，整个载荷使用用户口令派生的 AES-256-GCM 密钥加密。恢复前校验 schema 不高于当前版本、载荷哈希一致、候选数据库 `PRAGMA integrity_check` 为 `ok`，通过后才替换现有数据库。

备份**不包含**上下文 blob、任务工作区、产物正文、来源正文、附件和发件箱文件。需要完整迁移时，应同时复制：

```text
.hearth/context/blobs/
.hearth/workspaces/
.hearth/artifacts/
.hearth/sources/
.hearth/attachments/
.hearth/outbox/
```

## 运维检查

设置页的“数据”分区展示数据库路径、schema 版本、执行器目录、上下文 blob 目录、迁移记录和旧 JSON 来源。排查问题时优先检查：

- `settings_migrations`：旧设置是否已成功导入，失败原因是什么。
- `model_profiles` 与 `executor_model_bindings`：执行器是否绑定了协议兼容且带密钥的档案。
- `context_items` 与 `task_context_state`：任务是否记录了执行轨迹、摘要水位是否推进。
- `handoffs`：失败接管的目标、诊断和上下文水位是否一致。
- `backup_records`：最近备份是否成功、恢复是否通过完整性检查。

所有路径都以数据库记录为准；不要手工编辑 `model-settings.json` 或 `executor-settings.json` 来改变运行配置。

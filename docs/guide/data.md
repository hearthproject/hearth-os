---
title: '数据、备份与恢复'
description: 'Hearth 的本地数据布局、加密备份、恢复边界和全局停止。'
outline: [2, 3]
---

# 数据、备份与恢复

<p class="lead">Hearth 的事实源是本地 SQLite 事件日志。界面、统计和通知都从记录重建，因此备份数据库比备份页面状态更重要。</p>

## 数据布局

| 路径 | 内容 | 是否进入加密备份 |
|---|---|---|
| `.hearth/hearth.sqlite` | 任务、运行、审批、效果、记忆、方法、同步与事件 | 是 |
| `.hearth/model-settings.json` | 对话模型配置与密钥 | 以加密元数据形式包含 |
| `.hearth/master.key` | 本机主密钥 | 加密后包含 |
| `.hearth/workspaces/` | 隔离的任务工作区 | 否 |
| `.hearth/artifacts/` | 受管产物 | 否 |
| `.hearth/outbox/` | 本地发件箱与回执 | 否 |
| `.hearth/backups/` | 加密备份归档 | 否 |
| `.hearth/sources/` | 来源正文快照 | 否 |
| `.hearth/device-frames/` | 桌面观察帧 | 否 |
| `eval/runs/` | 第一阶段验收运行与产物 | 否 |

## 加密备份

服务端提供加密备份 API。备份口令至少 12 个字符；口令经 scrypt（N=32768、r=8、p=1）派生，归档使用 AES-256-GCM 加密。

创建备份：

```bash
curl -X POST http://127.0.0.1:4317/api/backups \
  -H "content-type: application/json" \
  -d "{\"passphrase\":\"replace-with-a-long-passphrase\"}"
```

列出和下载：

```bash
curl http://127.0.0.1:4317/api/backups
curl -OJ http://127.0.0.1:4317/api/backups/<id>/download
```

从已保存的归档恢复：

```bash
curl -X POST http://127.0.0.1:4317/api/backups/<id>/restore \
  -H "content-type: application/json" \
  -d "{\"passphrase\":\"replace-with-a-long-passphrase\"}"
```

恢复会先写临时 SQLite，检查 `user_version`、schema 与 `integrity_check`，重建投影，再事务复制；失败会回滚。恢复期间调度器停止，成功后如果之前正在运行且没有启用全局停止，会重新启动调度器。

::: warning 数据库可恢复不等于产物可迁移
备份不包含产物正文、工作区、来源正文、发件箱附件、桌面截图和外部服务数据。恢复后任务可能重新出现，但产物文件仍需单独核对。完整归档请一并复制 `.hearth/artifacts/`、`.hearth/workspaces/`、`.hearth/sources/`、`.hearth/outbox/` 和 `eval/runs/`。
:::

## 全局停止与 kill switch

`POST /api/security/kill-switch` 启用全局停止后：

- 调度器停止，桌面会话冻结。
- 等待中的审批被取消，相关任务转为可恢复状态。
- 重启服务时调度器不会自动启动。
- 安全审计记录这次操作。

关闭 kill switch 后，调度器不会自动恢复，需要显式调用 `POST /api/system/start` 或重启服务。

## 健康与维护

- `GET /api/health`：运行时长、内存、磁盘、schema、任务计数、调度器、审批、kill switch 和最近维护。
- `GET /api/maintenance`：最近一次维护结果。
- `POST /api/maintenance/run`：手动运行维护。
- `GET /api/diagnostics`：下载脱敏诊断，不包含路径、密钥或环境秘密。

服务启动后每 6 小时自动维护一次。维护会清理过期审批、恢复中断任务、删除过期租约、桌面命令、截图、配对和临时文件，不删除任务、记忆或产物。

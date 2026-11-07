---
title: '开发与测试'
description: '本地脚本、测试、文档站和代码结构。'
outline: [2, 3]
---

# 开发与测试

<p class="lead">仓库是一个 npm workspaces 单仓。服务端、Web、共享包、评测和文档站使用同一套 TypeScript 配置。</p>

## 常用脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 同时启动服务端与 Web 开发服务器 |
| `npm run build` | 构建 Web 生产包到 `apps/web/dist` |
| `npm start` | 以生产式本机模式启动服务端 |
| `npm test` | 运行 Vitest 全量测试 |
| `npm run test:watch` | 监听模式 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run helper:windows` | 启动 Windows 桌面助手 |
| `npm run docs:dev` | 启动文档站开发服务器 |
| `npm run docs:build` | 构建文档站到 `docs/.vitepress/dist` |
| `npm run docs:preview` | 预览文档站生产构建 |

## 当前验证基线

2026-11-07 在当前工作树运行：

```text
npm test          40 个测试文件、199 个测试全部通过
npm run typecheck 通过
npm run build     通过
npm run docs:build 通过
```

测试覆盖服务层、API、模型协议、原生工具循环、预算、权限、检查点、提案确认、桌面边界、记忆、方法、同步、安全、备份与运维。自动测试证明代码闭环，不替代真实用户、真实设备和长期运行验收。

## 目录结构

```text
apps/server/src/
  app.ts              Fastify 路由与启动
  scheduler.ts        串行调度与任务执行
  service.ts          任务状态与投影
  approvals.ts        一次性审批
  effects.ts          效果账本与外部动作
  sources.ts          来源注册与读取
  extractors.ts       文档与网页提取
  outbox.ts           本地发件箱
  desktop.ts          Windows 设备与会话
  proactive.ts        主动建议与注意力预算
  memory.ts           记忆候选、召回与遗忘
  methods.ts          方法候选、评估与晋升
  sync.ts             事件同步与冲突
  security.ts         kill switch、令牌与审计
  backups.ts          加密备份与恢复
  health.ts           健康快照
  maintenance.ts      周期维护
packages/
  core/               领域类型、状态机与 DTO
  eventlog/           SQLite 事件日志与投影
  agent-runtime/      原生工具循环、预算、检查点
  codex-executor/     Codex SDK 适配
  templates/          任务模板与验收
```

## 文档站

文档是站点唯一事实源，位于 `docs/`。中文是默认路径，英文镜像在 `docs/en/`。

```bash
npm run docs:dev
npm run docs:build
npm run docs:preview
```

新增页面时，同时更新 `docs/.vitepress/config.mts` 的导航与侧栏，并补齐英文镜像。发布前运行 `docs:build`，检查站内链接、移动端宽度和搜索入口。

## 修改边界

- 不要绕过审批直接执行外部动作。
- 不要让界面成为第二个事实源；所有状态从事件日志投影重建。
- 新增执行器必须写入运行清单，并声明权限、预算和失败语义。
- 测试失败时不要用假数据或“看起来完成”的界面替代真实证据。

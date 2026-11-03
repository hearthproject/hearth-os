---
title: '工程交付与仓库结构'
description: 'Hearth 的工程原则、技术栈、仓库布局、进程模型、数据目录、CLI、测试、可观测性与发布迁移。'
outline: [2, 3]
---

<p class="eyebrow">ENGINEERING</p>

# 工程交付与仓库结构

<p class="lead">工程原则、推荐技术栈、仓库布局、进程模型、数据目录、CLI、Event Log、测试、可观测性与发布迁移。</p>

## 工程架构与仓库结构

### 工程原则

- **模块化单体优先**：早期不引入微服务；
- **纵向切片优先**：每个里程碑都必须同时包含 UI、持久状态、执行、验证和恢复；
- **界面即验收面**：用户不能在浏览器中完成的能力，不进入阶段出口；
- **单写者**：同一 State Root 只有一个写权威；
- **事件溯源**：事实写 Event Log，UI/索引是投影；
- **Schema 优先**：输入、输出、Effect、Approval 都有版本化 schema；
- **适配器隔离**：Codex、Connector、Browser、GUI、Sandbox 都通过接口接入；
- **本地优先**：默认数据本地，云资源可替换；
- **可回滚**：数据库、技能、配置和发布都有回滚路径；
- **可观测**：每个任务有 correlation id、trace 和成本归因。

### 推荐技术栈

以下为默认建议，不是不可替换的宗教：

| 层 | 建议 |
|---|---|
| 语言 | TypeScript / Node.js 22+ |
| 包管理 | pnpm |
| 单体仓库 | Turborepo 或等价工具 |
| 常驻服务 | Node + Fastify/Hono |
| 数据库 | SQLite WAL + migration |
| Schema | Zod / JSON Schema |
| Web | React + Vite + PWA |
| 实时更新 | SSE 优先，必要时 WebSocket |
| 浏览器 | Playwright |
| 文档/数据 | Python sidecar + 成熟解析库 |
| 沙箱 | Docker 起步，微虚拟机用于不受信任任务 |
| 可观测 | OpenTelemetry + 本地日志/指标 |
| 测试 | Vitest/Playwright/契约测试/故障注入 |
| 打包 | npm CLI + Docker Compose |

选择 TypeScript 的理由是前后端共享类型、事件协议和 schema，适合快速构建本地 Web 与 CLI；文档/数据密集处理通过 Python sidecar 补足生态，不把整个系统拆成多语言微服务。

### 仓库布局

```text
hearth-os/
  apps/
    hearthd/              # 常驻服务：Gateway / Control / Harness
    web/                  # 任务卡、审批、产物、PWA
    cli/                  # hearth 命令
    agentd/               # 设备节点（后续）
  packages/
    core/                 # 领域模型、状态机、错误分类
    eventlog/             # Event Log、投影、migration
    harness/              # Ticket、Run、lease、outbox、恢复
    policy/               # Policy、Mandate、Capability、风险
    context/              # Context Compiler、Task Pack
    token/                # Token Governor、预算、归因
    memory/               # 记忆写入、检索、遗忘、同步
    evolution/            # 轨迹、技能、评估、晋升、回滚
    executors/
      native/
      codex/
      connector/
      browser/
      gui/
      document/
    connectors/           # email/calendar/docs/im/issue
    gateway/              # 渠道、设备、通知、身份
    execution/            # Sandbox Provider、egress、Broker
    artifacts/            # 产物、哈希、版本、验证
    evals/                # 任务集、runner、scorer
    shared/               # schema、类型、工具
  sidecars/
    docdata/              # Python 文档/数据管道
  fixtures/
  docs/
    adr/
    architecture/
  docker/
```

### 进程模型

```text
hearth CLI / Web / Mobile
          │
          ▼
       hearthd
  ├─ Gateway
  ├─ Control Plane
  ├─ Durable Harness
  ├─ Token Governor / Context Compiler
  ├─ Executor Supervisor
  ├─ Event Log / projections
  ├─ Sandbox Provider client
  ├─ Credential Broker
  └─ Effect Dispatcher
          │
          ├─ Codex adapter
          ├─ Browser worker
          ├─ Connector workers
          ├─ Document/Data sidecar
          └─ Device agentd（后续）
```

所有执行器通过统一协议连接，不直接写主数据库。SQLite 由 `hearthd` 单进程写入；执行器通过 RPC/任务队列得到工作。

### 数据目录

```text
~/.hearth/
  state.db                # Event Log + projections
  artifacts/              # 内容寻址产物
  workspaces/             # 临时和项目工作区
  config/
    policy.yaml
    connections.yaml
  secrets/                # 加密凭据或 Broker 指针
  logs/
  backups/
  devices/
```

敏感目录权限最小化；备份加密；设备同步只传输必要的投影和产物引用。

### CLI

```text
hearth init
hearth run "整理这周的竞品更新并生成周报草稿"
hearth status
hearth inbox
hearth approve <id>
hearth artifacts
hearth memory search "项目 A 的决策"
hearth memory forget <id>
hearth doctor
hearth export
```

CLI 输出支持人类可读和 JSON 两种模式，方便脚本和自动化测试。

### Event Log 与投影

- Event 只追加，不原地更新；
- 每个 Event 有 schemaVersion、correlationId、causationId；
- 任务状态、收件箱、产物和成本都是投影；
- 投影可重建；
- 事件 hash 链或等价完整性校验；
- 大内容存 Artifact，Event 只存引用；
- migration 必须兼容旧事件；
- 事件重放不能产生外部副作用。

### 任务与 lease

- 每个 Ticket 同一时刻最多一个有效 Assignment；
- lease 带 fencing token；
- 执行器写入前校验 fencing token；
- 设备离线后 lease 过期，任务可重新分配；
- 重新分配不能重复外部 Effect；
- 任务状态迁移有显式事件和条件；
- 子任务继承父任务预算和权限交集。

### 测试策略

| 层 | 内容 |
|---|---|
| Unit | schema、策略、验证器、成本计算 |
| Contract | Executor、Connector、Sandbox、Broker |
| Integration | Event Log、outbox、lease、恢复 |
| E2E | 任务卡、审批、产物、邮件草稿 |
| Slice E2E | 每个增量从创建任务到产物/恢复的浏览器路径 |
| Fault Injection | 崩溃、断网、超时、重复、磁盘满 |
| Replay | 历史轨迹重放、换路由 |
| Security | 注入、越权、秘密、沙箱、egress |
| Performance | 启动、查询、长任务、并发上限 |

### 可观测性

- 每个 Task/Run 有 trace id；
- 每次模型调用记录模型、Token、成本和延迟；
- 每次工具调用记录参数哈希、结果状态和资源；
- 每次外部副作用记录幂等键与 Receipt；
- UI 只展示用户需要的事件；
- 详细信息保留在本地审计视图；
- 日志自动脱敏；
- 指标用于路由和评估，不用于操纵用户。

### 发布与迁移

- 版本化 schema 和 API；
- 数据库 migration 向前兼容；
- 执行器版本锁定；
- 技能版本化；
- 发布前跑评测和故障注入；
- 支持回滚到上一个稳定版本；
- 升级不破坏历史事件和产物；
- 用户可导出和迁移。
- 每个增量保留可回退版本，不允许只能靠重新搭建环境恢复。

---

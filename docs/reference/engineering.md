---
title: '工程交付与仓库结构'
description: 'Hearth 的工程原则、技术栈、仓库布局、进程模型、数据目录、测试与评测、可观测性与发布迁移。'
outline: [2, 3]
---

<p class="eyebrow">ENGINEERING</p>

# 工程交付与仓库结构

<p class="lead">工程原则、推荐技术栈、仓库布局、进程模型、数据目录、CLI、Event Log、测试与评测、可观测性与发布迁移。</p>

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
| 测试与评测 | Vitest/Playwright/契约测试/故障注入/任务集与 benchmark |
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
    shared/               # schema、类型、工具
  sidecars/
    docdata/              # Python 文档/数据管道与 pytest
  tests/
    contract/
    integration/
    e2e/
    slices/
    fault/
    replay/
    security/
    performance/
    fixtures/
    helpers/
  evals/
    suites/
    scorers/
    baselines/
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

### 测试与评测体系

测试不是功能的附属品，而是每个增量的交付物。任何 `Dx.y` 增量都必须同时带来实现、slice E2E、失败路径和回归测试，不能用“功能先上，测试后补”换取推进。

#### 先定两个原则

- **测试不等于评测。** 测试是确定性的通过/失败门槛；评测（eval）是带统计性质的质量测量，例如任务成功率、引用准确率、Token 成本、人工分钟。两者都要，但不要混在一个 CI 里。评测的任务集、指标和统计纪律见[评估体系](/architecture/evaluation)。
- **测试代码和功能在同一个 PR 提交。** 每个增量都要同时交付实现、slice E2E、失败路径和回归测试，不搞“功能先上，测试后补”。

#### 测试主要分九部分

1. **单元测试**：测纯逻辑，包括状态机、Task/Ticket 转换、预算计算、权限判定、验证器、错误分类和 Context Compiler 的裁剪规则。TypeScript 使用 Vitest，Python sidecar 使用 pytest。
2. **契约测试**：测边界，不测内部实现。重点覆盖 Executor、Connector、Sandbox Provider、Credential Broker 和 Effect Dispatcher。Codex adapter 必须遵守统一的 `TaskPack → Result` 契约；邮件连接器必须遵守 `Source/Effect`、幂等和回执契约。契约测试是防止“mock 一套、真实环境另一套”的核心。
3. **集成测试**：使用真实 SQLite 临时数据库测 Event Log、投影重建、migration、outbox、lease、fencing token、重复投递和崩溃恢复。不要 mock 数据库，因为这里要验证的正是持久化行为。
4. **纵向切片 E2E**：每个 `Dx.y` 都有一组浏览器验收路径，包括创建任务、看到状态、审批、取回产物和失败恢复。Stage 0 用 fake executor 跑通原型，Stage 1 开始跑真实 Codex 切片。这是项目最重要的测试类型。
5. **故障注入**：在排队、执行、写产物、等待审批四个位置分别 `kill -9`，再覆盖断网、超时、磁盘满、重复投递、设备离线、时钟偏移。验收标准直接对应阶段门槛：重复外部副作用为 0，恢复率达到目标。
6. **重放与确定性测试**：用记录好的事件流重放，验证投影能重建、旧事件能升级、重放不会产生外部副作用。UI 状态也必须能从事件流恢复，而不是依赖内存中的临时对象。
7. **安全测试**：覆盖越权访问、审批重放、nonce/过期时间、秘密泄露、提示词注入、网页内容越权、SSRF/egress、跨账户隔离和设备撤销。每个新权限都必须同时提交“允许”和“拒绝”两类测试。
8. **性能与长稳测试**：覆盖启动时间、任务创建延迟、查询延迟、长任务、并发上限、内存泄漏和磁盘增长。基准脚本和基线结果可以提交，但不要在早期把阈值硬卡在每个 PR 上。
9. **评测集（eval）**：按任务族建立代表性任务、成功/失败样本、评分规则和人工复核。评测关注任务成功率、引用可追溯性、人工分钟、Token/成本、打断次数。记忆和技能进化阶段还要覆盖“遗忘传播”“权限不扩大”“Shadow/Canary 回滚”等专项评测。

#### 仓库怎么放

```text
apps/
  hearthd/src/**/*.test.ts
  web/src/**/*.test.tsx
  cli/test/*.test.ts
packages/
  core/test/
  eventlog/test/
  harness/test/
  policy/test/
  executors/*/test/
tests/
  contract/
  integration/
  e2e/
  slices/D1.1/
  fault/
  replay/
  security/
  performance/
  fixtures/
  helpers/
evals/
  suites/
  scorers/
  baselines/
sidecars/docdata/tests/
```

单元测试可以靠近源码放；跨模块、跨进程和按阶段验收的测试统一放在根目录 `tests/`。`evals/` 单独放，不要和普通测试混在一起。

#### 哪些测试代码必须提交

- 所有 `.test.ts`、`.test.tsx`、`*.spec.ts`、`test_*.py`。
- 契约测试、fixture、fake server、fake executor、fake Codex JSONL cassette、fake effect sink。
- 合成或脱敏后的测试文档、邮件、日历、网页样本。
- 数据库 migration 测试和旧版本 fixture。
- eval 的任务定义、评分器、基线指标。
- CI 配置、测试运行脚本、测试数据生成脚本。
- 安全测试用例和故障注入场景。
- 小而有意义的 golden 文件，例如结构化结果、diff、JSON schema。

#### 不要提交

- 真实邮箱、日历、文档、Cookie、token、refresh token、API key。
- 真实用户数据、真实 Codex 会话记录、真实邮件正文。
- 大体积测试视频、截图、数据库、覆盖率报告和测试日志。
- 临时生成的产物和缓存。
- 只有本机才能复现的绝对路径和开发机配置。

对于 Codex 这类外部依赖，应该提交一个 **fake Codex CLI**，让它按约定输出 JSONL；真实 Codex 只放在 nightly 或手动 smoke test 里。这样 PR 测试稳定、不烧钱，又不会脱离真实协议。

#### CI 建议分三级

- **PR 必跑**：单元 + 契约 + 集成 + fake executor 的 slice E2E，目标 10 分钟内。
- **Nightly**：故障注入、安全测试、性能、真实 Codex/连接器 smoke test。
- **Release**：全量测试 + migration + 安装/备份/恢复 + 阶段出口验收。

#### 五条硬规则

- 每个 bug 修复必须带回归测试。
- 每个新事件 schema 必须带 migration 和旧事件兼容测试。
- 每个新外部副作用必须带幂等和重复投递测试。
- 每个新权限必须带拒绝路径测试。
- 每个新执行器或连接器必须带契约测试、超时/取消测试和失败分类测试。

这样做的核心不是追求测试数量，而是保证：**Hearth 说“任务完成”时，测试能证明它真的完成；Hearth 说“可以恢复”时，故障注入能证明它真的能恢复。**

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

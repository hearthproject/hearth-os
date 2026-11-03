# 10 工程交付、风险与决策

> 版本：v3.2  
> 对应完整主文档：`../Hearth_个人Agent_OS_总体路线图_v3.md`  
> 对应章节：第 26–29 章  
> 前置阅读：[08 分阶段产品路线图](08_分阶段产品路线图.md)、[09 从 0 到 100 开发计划](09_从0到100开发计划.md)  
> 读完后能回答：仓库与进程如何组织、如何测试和发布、何时必须暂停或止损、有哪些既定架构决策、最终如何判断产品完成

## 本篇怎么读

- 第 26 章给出工程落地方式，第 27 章给出风险与 Kill Criteria。
- 第 28 章汇总 ADR-001–020，第 29 章给出术语、默认清单和最终判断。
- 工程地基、恢复、安全与界面不可为了赶进度而裁剪。

---

## 26. 工程架构与仓库结构

### 26.1 工程原则

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

### 26.2 推荐技术栈

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

### 26.3 仓库布局

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

### 26.4 进程模型

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

### 26.5 数据目录

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

### 26.6 CLI

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

### 26.7 Event Log 与投影

- Event 只追加，不原地更新；
- 每个 Event 有 schemaVersion、correlationId、causationId；
- 任务状态、收件箱、产物和成本都是投影；
- 投影可重建；
- 事件 hash 链或等价完整性校验；
- 大内容存 Artifact，Event 只存引用；
- migration 必须兼容旧事件；
- 事件重放不能产生外部副作用。

### 26.8 任务与 lease

- 每个 Ticket 同一时刻最多一个有效 Assignment；
- lease 带 fencing token；
- 执行器写入前校验 fencing token；
- 设备离线后 lease 过期，任务可重新分配；
- 重新分配不能重复外部 Effect；
- 任务状态迁移有显式事件和条件；
- 子任务继承父任务预算和权限交集。

### 26.9 测试策略

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

### 26.10 可观测性

- 每个 Task/Run 有 trace id；
- 每次模型调用记录模型、Token、成本和延迟；
- 每次工具调用记录参数哈希、结果状态和资源；
- 每次外部副作用记录幂等键与 Receipt；
- UI 只展示用户需要的事件；
- 详细信息保留在本地审计视图；
- 日志自动脱敏；
- 指标用于路由和评估，不用于操纵用户。

### 26.11 发布与迁移

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

## 27. 风险与 Kill Criteria

### 27.1 主要风险

| 风险 | 早期信号 | 缓解 |
|---|---|---|
| 范围膨胀 | 每阶段都在新增执行器，核心闭环未稳定 | 以任务集和阶段门槛控制范围 |
| 可靠性不足 | 崩溃后任务丢失、重复发送 | 单写者、outbox、lease、故障注入 |
| 安全事件 | 越权、秘密泄露、提示词注入成功 | 沙箱、Broker、审批、红队 |
| Token 成本失控 | 单任务成本高且人工分钟未下降 | Context Compiler、路由、缓存、硬预算 |
| 外部 Agent 依赖 | 版本变化导致大量任务失败 | 适配器、版本锁定、降级到 Native/人工 |
| 维护负担 | 每周大量时间修依赖和渠道 | 不自研底层、减少连接器、自动升级测试 |
| 通知疲劳 | 用户关闭通知或忽略审批 | 注意力预算、聚合、静默、默认动作 |
| 记忆错误 | 反复引用过期或错误事实 | 来源、置信度、冲突、遗忘、用户纠正 |
| 自进化漂移 | 技能越用越复杂、权限变多 | 评估、shadow、canary、权限交集、回滚 |
| 多设备复杂 | 同步冲突、重复执行 | 单写者、lease、fencing、离线队列 |
| 产品像套壳 | 去掉 Codex 后没有独立价值 | 控制面、记忆、审批、恢复、评测 |
| 平台限制 | 浏览器登录、验证码、API 变更 | 人工接管、官方 API 优先、降级 |
| 用户信任下降 | 用户不理解为什么这样做或无法撤销 | 可解释状态、产物、回执、kill switch |
| 时间投入不可持续 | 维护超过可支配时间 | 缩小范围、延迟非核心能力、自动化测试 |

### 27.2 全局暂停条件

出现以下情况时，暂停新增功能，优先修复：

- 高风险动作发生越权；
- 发生秘密或敏感数据泄露；
- 故障注入出现重复外部副作用；
- 崩溃恢复率低于 95%；
- 用户无法撤销设备、连接或技能；
- 关键记忆无法遗忘；
- 任务状态与事实源不一致；
- 外部副作用无法对账。

### 27.3 阶段 Kill Criteria

**Stage 0：**

- 无法定义 12 个可验收任务；
- 无法说明 Hearth 与单 Codex 的区别；
- 没有威胁模型；
- 原型无法让用户在不看说明的情况下完成主路径；
- 原型状态无法映射到真实投影或数据契约；
- 试图在第一阶段同时做所有执行器。

**Stage 1：**

- 达到 MVP 门槛后仍无法完成 10 个真实任务；
- 重复副作用无法消除；
- 恢复依赖人工重建状态；
- 任务状态只能靠聊天记录推断；
- Token 成本完全不可见；
- 后端可用但 Web 任务卡无法完成创建、查看、审批、恢复和取回产物；
- 只有 CLI 或日志能演示，不能算 MVP 成立。

**Stage 2：**

- 邮件/日历闭环需要用户频繁重建上下文；
- 连接器权限无法最小化；
- 文档处理结果无法验证；
- 常见任务人工分钟没有下降；
- 不同账户/项目数据串扰。

**Stage 3：**

- GUI 任务成功率低且无法接管；
- 无法证明操作没有越权；
- 桌面环境无法恢复；
- 每次 GUI 任务都需要大量人工介入。

**Stage 4：**

- 主动任务制造通知疲劳；
- 用户无法预测何时会被打扰；
- 手机审批可被重放或越权；
- 后台任务无法停止或预算失控。

**Stage 5：**

- 记忆错误导致持续返工；
- 遗忘无法传播到设备和索引；
- 技能评估可被挑选样本操纵；
- 技能扩大权限或安全回归；
- 回滚不可用。

**Stage 6：**

- 多设备重复执行或状态分裂；
- 设备丢失无法及时撤销；
- 迁移后事实、记忆或产物不一致；
- 长期运行维护成本超过产品收益。

### 27.4 项目级 Kill Criteria

在以下情况下，应考虑缩小产品，而不是继续加功能：

- 完成 Stage 2 后仍没有稳定的 10 个真实日常任务；
- 人工分钟没有实质下降，用户只是在“看 Agent 工作”；
- 维护成本持续超过可支配时间且没有下降趋势；
- 仅靠换模型就能替代 Hearth 的绝大部分价值；
- 安全边界无法达到可接受水平；
- 用户不愿意把真实邮件、文件或日程交给它；
- 自进化持续产生不可解释的漂移；
- 多设备复杂度吞掉单设备体验。

### 27.5 不应被 Kill 的东西

- Event Log 和可恢复性；
- 审批、幂等和 Receipt；
- 评测与失败样本；
- 记忆遗忘和用户纠正；
- 任务卡与低打扰体验；
- 手动接管；
- 安全边界和 kill switch。

这些是产品的地基，不是可以在“赶进度”时删除的功能。

---

## 28. ADR 索引

以下是建议的首批架构决策。状态为 `Accepted` 的应尽早写入仓库，后续变更通过新 ADR 记录。

| ADR | 决策 | 状态 | 主要后果 |
|---|---|---|---|
| ADR-001 | Hearth 是单用户、自托管、本地优先的个人 Agent OS | Accepted | 不做企业 IAM；优先本地状态和可迁移 |
| ADR-002 | Event Log 是唯一事实源，UI/索引/记忆是投影 | Accepted | 需要事件 schema、重放和 migration |
| ADR-003 | 早期使用 SQLite WAL 和单写者，不引入微服务 | Accepted | 降低运维；需要 lease 和水平扩展预案 |
| ADR-004 | 采用模块化单体，执行器通过统一协议接入 | Accepted | 边界靠接口和测试保证，而非网络拆分 |
| ADR-005 | 使用 Executor 多执行器模型，不追求单体万能 Agent | Accepted | 需要能力声明、路由和统一结果契约 |
| ADR-006 | Codex 是首个外部执行器，可做代码、研究、文档和 Shell，但不是产品本体 | Accepted | 需要适配器、版本锁定和降级路径 |
| ADR-007 | 自研 Execution Gateway、Policy、Broker；集成 Sandbox/Runtime 内核 | Accepted | 不自研容器/虚拟化；需要统一 Sandbox Provider |
| ADR-008 | 所有外部副作用走类型化 Effect、outbox、幂等键和 Receipt | Accepted | 增加实现复杂度，但避免重复和不可审计 |
| ADR-009 | 高风险动作需要 Mandate 和 Approval；执行器不能扩大权限 | Accepted | 增加交互，但建立信任边界 |
| ADR-010 | 记忆分五类，带来源、置信度、敏感度、预算和遗忘 | Accepted | 需要记忆维护和用户界面 |
| ADR-011 | 自进化只产生候选技能，经 Shadow/Canary/评估/回滚后晋升 | Accepted | 需要评测集和版本管理 |
| ADR-012 | 手机优先 PWA，先做查看/审批/接管/发起/通知 | Accepted | 暂不做完整移动 Agent；降低发布成本 |
| ADR-013 | Token Governor 和 Context Compiler 是核心架构，不是后置优化 | Accepted | 需要统一计量、预算和上下文组装 |
| ADR-014 | 学 OpenClaw/Hermes 的模式，不 fork 其产品底座 | Accepted | 需要自建 Gateway、Memory、Evolution 协议 |
| ADR-015 | Human Executor 和 takeover 是一等能力 | Accepted | 需要实时界面、审计和恢复 |
| ADR-016 | 不做企业多租户、公开 Agent 市场和计费 | Accepted | 聚焦个人体验和自托管 |
| ADR-017 | 当前只接入 Codex，其他外部 Agent 暂不纳入产品范围 | Accepted（临时） | 保留 Executor 接口，避免绑定 |
| ADR-018 | 模型可替换，本地模型可选，不训练基础模型 | Accepted | 需要模型目录、路由和评估 |
| ADR-019 | 采用 MVP-first 的纵向切片交付；前端从 Stage 0 起进入每个增量 | Accepted | 不允许后端先行、最后补界面；阶段验收必须包含浏览器路径 |
| ADR-020 | 路线图只以能力门槛和增量顺序推进，不使用周/月排期 | Accepted | 不承诺完成日期；进度以真实任务、恢复和评测证据衡量 |

---

## 29. 附录与最终判断

### 29.1 术语表

| 术语 | 含义 |
|---|---|
| Hearth | 本项目名；个人 Agent OS |
| Executor | 执行器；完成某类任务的受控能力 |
| Native Runtime | 内置轻量推理与工具执行层 |
| Codex Executor | 外部高能力工作区执行器 |
| Connector | 外部系统 Source/Effect 适配器 |
| Browser Executor | 网页操作执行器 |
| GUI Executor | 桌面操作执行器 |
| Document/Data Executor | 确定性文档与数据处理器 |
| Human Executor | 审批、判断和接管的人 |
| Task | 对用户可见的工作项 |
| Ticket | 被授权的最小工作单元 |
| Run | 一次执行尝试 |
| Event Log | 不可变事实日志 |
| Artifact | 产物，内容寻址 |
| Receipt | 外部副作用回执 |
| Mandate | 有范围、期限和预算的授权 |
| Approval | 针对具体动作的人的确认 |
| Capability | 对资源/动作/范围的短期许可 |
| Context Pack | 为一次任务组装的最小上下文 |
| Memory | 带来源和约束的长期/中期知识 |
| Skill | 版本化、可评估、可回滚的程序性能力 |
| Shadow | 不产生真实副作用的评估运行 |
| Canary | 小范围真实运行 |
| Kill switch | 全局停止开关 |
| Verified Success | 有产物、验证和回执支持的成功 |

### 29.2 默认审批清单

高风险动作前，逐项确认：

- [ ] 动作类型正确；
- [ ] 目标收件人/文件/仓库/日历/资源正确；
- [ ] 使用账户正确；
- [ ] 内容和附件正确；
- [ ] 范围没有超出 Mandate；
- [ ] 是否可逆已说明；
- [ ] 失败和对账方式已说明；
- [ ] 审批有 nonce 和过期时间；
- [ ] 已准备回执和撤销/补偿；
- [ ] 没有绕过安全控制。

### 29.3 默认完成清单

任务标记完成前，逐项确认：

- [ ] 目标产物存在且可定位；
- [ ] 验证器通过；
- [ ] 关键断言有来源；
- [ ] 修改有 diff 或版本；
- [ ] 没有未授权的副作用；
- [ ] 外部动作有 Receipt；
- [ ] 失败和未完成项已说明；
- [ ] Token、时间和成本已记录；
- [ ] 工作区、凭据和 lease 已回收；
- [ ] 用户可以查看、撤销或继续。

### 29.4 任务覆盖的最终定义

Hearth 的目标不是承诺“任何软件、任何场景、100% 无人值守”。它的目标是：

- 对八类数字内容工作提供端到端覆盖；
- 对每类任务逐步提高可靠性和自主性；
- 对无法可靠完成的任务安全停下并交给人；
- 让用户不必理解内部架构，也不必重复交代上下文；
- 让每次完成都有证据、权限和回执。

覆盖的成熟度应分层表述：

| 层级 | 含义 |
|---|---|
| 可尝试 | 系统能进入该任务族并产生草稿 |
| 可完成 | 在代表性任务上通过验证 |
| 可依赖 | 多次真实使用稳定，失败可恢复 |
| 可主动 | 在 Mandate 内无需人工触发 |
| 可无人值守 | 长时间运行且风险可控 |

不要用“可尝试”冒充“可无人值守”。

### 29.5 最终判断

回到最初的争论：是只写控制层，把执行交给外部 Agent，还是把 runtime 和 sandbox 也全部自己写？

**产品路线应采用前者，但不是简单的“薄封装”。**

Hearth 自己写：

- 控制面；
- Durable Harness；
- 事件日志；
- 审批与幂等；
- Context Compiler 与 Token Governor；
- Memory OS；
- Evolution OS；
- Execution Gateway；
- Credential Broker；
- 任务卡、审批、产物和手机入口。

Hearth 集成：

- Codex；
- 模型 API 或本地模型；
- 容器/微虚拟机/Sandbox 内核；
- Playwright；
- 文档解析与转换库；
- 邮件、日历、云盘等官方 API。

Hearth 只为学习保留：

- 最小事件循环和 session tree；
- 上下文压缩原型；
- 单机 Sandbox 包装；
- 路由和评估实验。

这样既能深入学习 Agent Runtime、Harness、Sandbox、Gateway、Memory 和 Evolution，又不会把项目生命耗在重新实现容器、虚拟化和模型推理引擎上。

Codex 的定位也应同样清楚：

> **Codex 是 Hearth 目前最强、最通用的外部执行器之一，可以写代码，也可以做调研、长文档、报告、表格和复杂文件工作；但它并不局限于代码，也不是 Hearth 的本体。邮件、日历、网页、桌面、文档确定性处理和人类责任，分别由并列的 Connector、Browser、GUI、Document/Data 和 Human Executor 承担。**

最终，Hearth 的护城河不是“拥有一个更强的模型”，而是：

- 知道什么时候不该调用模型；
- 知道该给执行器什么最小上下文；
- 知道哪些动作必须经过谁的授权；
- 知道如何证明任务真的完成；
- 知道失败后如何恢复；
- 知道什么应该记住，什么应该遗忘；
- 知道什么时候应该停下来，把注意力还给人。

如果这些做成了，Hearth 就不只是一个 Agent 套壳，而是一台真正属于个人的、长期可靠的数字工作系统。

最后是交付判断：

> **先做出一个能在真实浏览器里每天使用的最小产品，再把它逐步长成 Personal Agent OS。**

Stage 0 用原型验证产品叙事，Stage 1 尽早交付 MVP，此后每个增量都同时交付界面、后端、验证和恢复。路线图不设开发时间限制，不以“第几周”证明进展，只以真实任务、可恢复性和用户是否愿意继续使用来证明方向正确。

---

**分册导航：** 上一篇 [09 从 0 到 100 开发计划](09_从0到100开发计划.md) ｜ [返回分册目录](README.md) ｜ 下一篇 无

**完整版：** [Hearth 个人 Agent OS 总体路线图 v3.2](../Hearth_个人Agent_OS_总体路线图_v3.md)


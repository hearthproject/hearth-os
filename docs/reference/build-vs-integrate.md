---
title: '自研与集成边界'
description: 'Hearth 自研核心、适配层、直接集成与只学习不集成的边界；以及 Codex 集成方式。'
outline: [2, 3]
---

<p class="eyebrow">BUILD VS. INTEGRATE</p>

# 自研与集成边界

<p class="lead">Hearth 自己做核心控制与记忆，直接集成模型、Codex、浏览器、文档解析和 Sandbox 内核。边界越清楚，产品越不容易变成集成拼盘。</p>

## 一句话总结

Hearth 自己做“指挥系统、账本、门禁和验收”，集成“模型、沙箱、浏览器、文档解析器和外部 API”。

这里的“自研”主要指产品和核心逻辑自研，不是所有底层库都从零写。例如事件日志协议自研，但底层数据库用 SQLite；前端体验自研，但使用 React/Vite。

## 交付边界：自研核心不等于最后才做

“自研”描述责任归属，不描述开发顺序。Hearth 不会先把控制面、Harness、Memory 和所有执行器做完，最后再补前端。

- **前端属于核心自研**：任务卡、审批、产物、恢复和手机入口是产品差异化的可见部分，不是后端完成后的包装层。
- **Stage 0 就有原型**：用可点击 Web 原型验证产品叙事、状态和主动作，即使数据是模拟的。
- **Stage 1 尽早交付 MVP**：在一个窄任务族上同时交付真实 Web、持久状态、Codex 执行、产物、审批演练和失败恢复。
- **每个增量都是纵向切片**：用户结果、界面、后端、执行器、验证和恢复一起出现；只有 CLI 或日志的能力不算阶段完成。
- **自研/集成边界不因 MVP 改变**：MVP 仍然不自研模型、容器内核或完整 Agent 框架，但必须自研任务控制、验证、审批、恢复和用户界面。

具体增量顺序见主路线图第 25 章或分册 `Hearth_路线图分册/09_从0到100开发计划.md`。

## 一、Hearth 自己做的核心部分

这些是文档认定的产品护城河，不能外包：

- **Control Plane 控制面**  
  决定一个事件要不要处理、是否创建任务、是否允许执行、用哪个执行器、花多少预算、什么时候找你审批、失败后重试还是转人工。

- **Durable Harness 持久执行层**  
  Task、Ticket、Run、任务图、依赖关系、lease、单写者、fencing token、检查点、重试、取消和崩溃恢复。

- **Event Log 事件日志与投影**  
  只追加的事实源、schema、migration、任务状态投影、审计和重放。这里自研的是协议和语义，不是数据库引擎。

- **Policy、Mandate、Capability、Approval**  
  长期规则、单次授权、资源范围和期限、风险分级、审批绑定、权限回收。

- **外部副作用控制**  
  Effect Preview、outbox、幂等键、Effect Dispatcher、Receipt、对账和死信处理。这是“不会重复发邮件、不会重复付款”的核心。

- **Context Compiler 与 Token Governor**  
  组装最小 Task Pack、选择模型阶梯、控制上下文、缓存、预算、成本归因和异常停止。

- **Memory OS**  
  五类记忆、来源和可信度、冲突、敏感度、召回、遗忘、多设备同步和记忆 UI。

- **Evolution OS**  
  轨迹挖掘、技能候选、评估集、Shadow、Canary、晋升、权限检查和回滚。

- **Execution Gateway 的控制逻辑**  
  Workspace 生命周期、挂载与文件权限、网络白名单和 egress、Capability、配额、快照、恢复、审计和接管。

- **Credential Broker**  
  长期密钥存储、短期凭据发放、按任务和账户限定、使用审计和撤销，保证模型看不到原始密码和 refresh token。

- **Personal Gateway 与体验层**  
  渠道事件归一化、去重、设备注册、能力目录、注意力收件箱、任务卡、审批界面、产物中心、手机入口和接管流程。

- **验证器与评估体系**  
  测试、diff、引用检查、表格检查、邮件收件人检查、网页状态检查、故障注入和轨迹重放。

- **Native Runtime 的薄执行层**  
  短任务工具循环、session tree、steering、compaction 和升级到 Codex 的逻辑；模型本身不自研。

## 二、Hearth 自研“适配层”，但底层用现成能力

这类不是完全自己做，也不是简单调用，而是自己控制接口、策略、验证和恢复：

- **Codex Executor**  
  集成 Codex，但 Hearth 自己做版本锁定、Task Pack、工作区隔离、结构化输出、超时取消、验证和失败分类。

- **Browser Executor**  
  浏览器内核和自动化用 Playwright；Hearth 自己做登录态边界、网页策略、提示词注入防护、验证、截图和人工接管。

- **Connector Executor**  
  邮件、日历、云盘、IM 等接入官方 API 或 MCP；Hearth 自己做统一的 `Source/Effect` 协议、权限、限流、幂等、回执和对账。

- **Document/Data Executor**  
  解析、OCR、格式转换和表格处理用成熟 Python 库；Hearth 自己做管道调度、最小上下文提取、结果验证和与 Codex 的分工。

- **Sandbox**  
  用 Docker、OCI 容器或微虚拟机；Hearth 自己做 Sandbox Provider 接口、工作区生命周期、网络白名单、凭据隔离和回收。

- **GUI Executor**  
  使用操作系统提供的可访问性树、截图、键鼠和窗口能力；Hearth 自己做 agentd、任务边界、验证、恢复和人工接管。

- **可观测性**  
  用 OpenTelemetry；Hearth 自己做任务轨迹语义、Token 归因和用户可见的审计视图。

## 三、明确直接集成别人的部分

文档明确不重写这些成熟基础设施：

- **模型**：OpenAI、Anthropic、本地模型或其他模型 API，采用 BYOM；不训练基础模型，也不自研推理引擎。
- **Codex**：目前唯一接入的外部 Agent，可承担代码、研究、文档、表格和复杂工作区任务。
- **Playwright**：浏览器自动化引擎。
- **文档解析与转换库**：PDF、Office、OCR、表格处理等。
- **邮件、日历、云盘等官方 API 或 MCP**：真实外部系统连接。
- **容器/微虚拟机/Sandbox 内核**：Docker 起步，高风险任务用更强隔离。
- **OpenTelemetry**：可观测性基础设施。
- **常规技术栈**：TypeScript、Node.js、SQLite、React、Vite、Fastify/Hono、Zod、Python sidecar 等。

## 四、只学习、不集成、不作为产品底座的项目

这个边界非常重要：

- **OpenClaw**：学习 Gateway、渠道、设备节点、注意力入口和常驻模式，不 fork，也不作为运行时依赖。
- **Hermes**：学习记忆预算、记忆约束、技能沉淀和进化闭环，不采用无界自修改。
- **DeerFlow**：学习 Harness/App 分层、Run 生命周期和 thread 隔离，不引入重型框架耦合。
- **Pi / Maka**：学习 session tree、steering、compaction 和事件日志，不复制完整框架。
- **OpenSandbox / OpenBot**：学习隔离、快照、takeover 和 receipt，不复制完整产品。
- **OpenMuse / OpenDots**：学习 durable job、checkpoint、lease 和低打扰体验。
- **Codex**：比较特殊，既学习其工作区执行模式，也实际集成。

所以，当前文档中：

> Hearth 没有把 OpenClaw、Hermes、DeerFlow 作为运行时集成，也没有把它们当作产品底座。当前唯一接入的外部 Agent 是 Codex；其他项目主要是参考模式和学习目标。

## 最后用一句话记住边界

> Hearth 自研的是“任务如何被授权、调度、验证、恢复和记住”；集成的是“完成任务所需的成熟发动机和工具”。

它不想重新发明模型、容器、浏览器和文档解析器，而是想把它们组织成一套可控、可审计、可恢复的个人 Agent OS。

## 原文依据

- Build vs Integrate：`Hearth_个人Agent_OS_总体路线图_v3.md:280`
- Sandbox 边界：`:2019`
- 推荐技术栈：`:3848`
- 最终判断：`:4256`

---

## 五、Hearth 与 OpenClaw 的真实区别

### 先给结论

**今天能直接使用的产品能力，OpenClaw 明显领先 Hearth；Hearth 目前仍是一份路线图，不是一个已经交付的系统。**

因此，不能说“Hearth 已经比 OpenClaw 强”，也不能说“Hearth 天然是 OpenClaw 的上一层”。更准确的说法是：

> **OpenClaw 已经是一个成熟的个人助手 Gateway 和控制面；Hearth 想做一个以“任务与承诺”为核心对象的、更严格的任务控制层。**

两者的差别不是“谁的功能列表更长”，而是“谁对什么负责”：

- OpenClaw 主要对**会话、渠道、个人助手体验和常驻服务**负责；
- Hearth 主要想对**任务是否被正确授权、是否真的完成、外部副作用是否可证明、失败后是否可恢复**负责。

这两个方向有大量重叠。OpenClaw 已经有记忆、审计、审批、沙箱、队列、重启恢复和多设备入口，所以这些能力不能再说成 Hearth 独有。

### 两者到底差在哪

| 维度 | OpenClaw | Hearth 的设计目标 |
|---|---|---|
| 核心对象 | 会话、渠道消息、Agent Run、常驻个人助手 | Event → Task → Ticket → Run，任务和承诺是一等对象 |
| 产品重心 | 在用户已有的聊天渠道里提供随时可用的个人助手 | 管理长任务、跨执行器协作、授权、预算和验收 |
| 交互方式 | 聊天、渠道消息、Control UI、移动端和桌面节点 | 任务卡、审批、产物中心、收件箱和手机接管 |
| 记忆 | 已实现分层记忆、来源追踪、信任边界、Dreaming、用户模型、standing intents | 计划做带来源、冲突、敏感度、遗忘和多设备同步的 Memory OS；功能上与 OpenClaw 有明显重叠 |
| 审计 | 已实现有界、元数据级的审计账本、执行身份、审批决策记录和消息生命周期审计；其文档明确说明账本不是无损记录，也不是授权证据 | 计划把 Event Log 作为事实源，并把 Effect、审批、执行和验收绑定到同一条任务轨迹 |
| 外部副作用 | 对 `send`、`agent` 等有副作用的调用要求幂等键，并有消息投递审计 | 进一步把外部副作用建模为类型化 Effect，经 outbox、幂等键、Dispatcher 和 Receipt 对账 |
| 完成判定 | 有 Run 状态、审计和结果；但“任务是否真的完成”仍主要依赖执行流程和上层判断 | 计划把 Verifier 作为完成门槛，不能只相信执行器说“已完成” |
| 沙箱 | 已实现 Docker、Podman、SSH、OpenShell、Crabbox 等后端 | 计划只自研 Sandbox Provider 接口、生命周期、网络出口和凭据隔离，底层复用成熟沙箱 |
| 恢复 | 已有队列、session controller、watchdog、重启恢复和自动续跑 | 计划用 Event Log、lease、fencing、checkpoint、retry 和人工接管来做任务级恢复 |
| 生态和渠道 | 20+ 聊天渠道、桌面/移动节点、插件、技能和 ClawHub | 当前路线图只有手机优先 PWA，尚未形成渠道和插件生态 |
| 成熟度 | 有可运行代码、文档、安装器、测试和真实使用路径 | 仍是架构与实施路线图，尚无同等程度的可运行产品证据 |

### 为什么容易误以为 Hearth 是“上一层”

因为两者都在做“控制”，但控制的对象不同：

- OpenClaw 的控制面主要控制 **Gateway、会话、渠道、执行身份和消息投递**；
- Hearth 想控制的是 **任务契约、授权范围、上下文预算、外部副作用和验收结果**。

如果未来 Hearth 把 OpenClaw 作为一个 Gateway 或 Executor 接入，那么可以形成这样的关系：

```text
Hearth：任务、授权、预算、验收、副作用回执
                 ↓
OpenClaw：渠道、会话、个人助手运行时、设备节点
                 ↓
Codex / 其他执行器：实际完成某一段工作
```

在这种特定架构下，Hearth 才是“任务控制层”，OpenClaw 是它下面的个人助手运行时。但必须注意：

1. 这不是当前路线图的实现；
2. 当前路线图只接入 Codex，没有把 OpenClaw 作为运行时组件；
3. OpenClaw 自己已经可以接入 Codex 等多种 Agent Harness，所以“接入 Codex”并不能让 Hearth 天然高 OpenClaw 一层；
4. 只有在 Hearth 真正掌握任务授权、预算、副作用和验收，并且 OpenClaw 只负责渠道与执行时，上下层关系才成立。

所以，“上一层控制面”应改成：

> **Hearth 想做任务与承诺层的控制面，而不是 OpenClaw 的天然上级产品。它必须通过明确的接口、权限和回执边界，才有资格成为 OpenClaw 之上的一层。**

### Hearth 要在什么条件下才算真的更强

不能靠“功能更多”证明更强，只能靠可验证的差异。至少要通过下面四类测试：

1. **副作用测试**：任务执行到一半崩溃、重试或重启后，邮件不会重复发、订单不会重复提交、文件不会重复覆盖，并能用 Receipt 对账。
2. **完成测试**：执行器声称完成后，Hearth 能通过测试、diff、引用、文件结构、网页状态或业务规则证明结果真的满足任务定义。
3. **权限测试**：执行器被提示词注入或试图越权时，无法拿到超出 Task Mandate 的凭据、目录、网络和工具。
4. **成本测试**：在相同任务集上，Hearth 的 Token、延迟和人工注意力成本不高于直接使用 OpenClaw 或直接使用 Codex，并且有可解释的归因。

如果这四件事没有做出来，Hearth 就只是一个更晚出现、更复杂的 OpenClaw；如果做出来了，它才有资格说自己是在“任务可靠性”这一层更强。

## 六、Codex 真的可以集成吗，能使用它的全部能力吗

### 结论

**技术上可以集成，而且路线图把 Codex 作为第一个外部 Executor 是可行的。**

**但不能说“可以使用 Codex 的全部能力”。** 你只能使用 Codex 公开暴露的、当前账户和版本允许的、且接口相对稳定的那一部分能力。

Codex 是执行器，不是 Hearth 的权限中心、任务数据库、记忆中心或外部副作用网关。

### 已经确认可用的集成入口

以本机 `codex-cli 0.163.0` 和 `@openai/codex-sdk 0.166.0` 为核对基准：

- **`codex exec`**：非交互执行，适合 Hearth 的第一阶段接入。
  - `--json`：输出 JSONL 事件流；
  - `--output-schema`：约束最终结构化输出；
  - `-C`：指定工作目录；
  - `--sandbox read-only | workspace-write | danger-full-access`：沙箱模式；
  - `-a / --ask-for-approval`：全局审批策略，需要放在 `exec` 之前；`codex exec` 子命令本身不接受该参数；
  - `--ephemeral`：不持久化会话文件；
  - `--skip-git-repo-check`：允许非 Git 目录；
  - `--add-dir`：增加可写目录；
  - `-i`：附加图片；
  - `-o`：把最后一条消息写入文件；
  - `resume`、`fork`、`review`：恢复、分叉和代码审查。
- **`@openai/codex-sdk`**：TypeScript SDK，本质上是启动 Codex CLI，通过 stdin/stdout 交换 JSONL。
  - `startThread()` / `resumeThread()`；
  - `run()` / `runStreamed()`；
  - 结构化输出、图片输入、工作目录、沙箱模式、审批策略、模型和推理强度；
  - 命令执行、文件修改、MCP 工具调用、网页搜索、todo 和 usage 事件。
- **`codex app-server`**：实验性接口，支持 stdio、Unix socket、WebSocket，可生成 TypeScript 绑定和 JSON Schema。适合需要细粒度流式事件和审批的深度集成，但必须按实验性接口对待。
- **`codex exec-server`**：实验性的独立远程执行服务。
- **`codex cloud`**：实验性的 Codex Cloud 任务接口，依赖账户和 Cloud 能力。
- **MCP / 插件**：可以通过 `codex mcp` 和 `codex plugin` 管理外部工具与插件。

### 为什么不能说“全部能力”

以下限制是结构性的，不是接入层偷懒：

1. **账户和计划限制**：模型、Cloud、Web Search、组织策略、地区可用性都受 OpenAI 账户和权限约束。
2. **版本限制**：CLI、SDK 和 app-server 的协议可能变化；本机 CLI 与 SDK 版本已经不一致，不能假设任意版本互相兼容。
3. **实验性接口限制**：`app-server`、`exec-server`、`cloud` 都明确标注实验性，不保证稳定。
4. **SDK 不等于完整平台**：SDK 是 CLI 的包装层，不覆盖 Codex 桌面端、账户管理、计费管理和全部 Cloud/UI 能力。
5. **Codex 不提供 Hearth 的治理能力**：Mandate、Capability、Credential Broker、Effect outbox、幂等投递、Receipt 对账和 Verifier 都不在 Codex 内。
6. **会话持久化不等于任务事件日志**：Codex 的 thread/session 可以恢复，但不能替代 Hearth 的事实源、任务图和审计语义。
7. **MCP 工具不等于安全工具**：Codex 能调用 MCP，不代表应该把邮件、日历、付款等高风险工具直接交给它。
8. **`danger-full-access` 不是默认选项**：只有在一次性、强隔离、可销毁的沙箱里才可以使用；正常任务应使用最小目录和最小网络权限。

### 推荐的接入架构

```text
Hearth Task / Ticket
        ↓
Context Compiler 生成最小 Task Pack
        ↓
Codex Adapter：版本检查、工作区准备、权限注入、超时控制
        ↓
隔离 Workspace 中的 codex exec --json --output-schema
        ↓
JSONL 事件 + 结构化结果 + 产物清单
        ↓
Hearth Verifier：测试、diff、引用、文件检查、业务规则
        ↓
接受 / 重试 / 回滚 / 人工接管
        ↓
需要外部副作用时，由 Hearth Connector 走 outbox、幂等键和 Receipt
```

关键点是：**Codex 可以在沙箱内写文件、运行命令和调用受控工具；但邮件发送、日历修改、付款、发布等外部副作用必须回到 Hearth 的 Effect 通道，不能由 Codex 直接完成。**

### 推荐的三阶段落地

**阶段一：先跑通单次任务**

- 用 `codex exec --json --output-schema`；
- 每个 Run 使用独立临时工作区；
- 只挂载任务需要的目录；
- 设置超时、取消和进程树回收；
- 解析 JSONL，保存事件、usage 和最终结构化结果；
- 用 Hearth 自己的 Verifier 判断是否成功。

**阶段二：增加多轮和恢复**

- 保存 Codex thread id，但以 Hearth Event Log 为权威状态；
- 需要多轮时使用 `resume`；
- 任务失败后先分类：模型失败、工具失败、验证失败、权限失败、环境失败；
- 对可重试任务使用幂等键，避免重复副作用。

**阶段三：再评估 app-server**

- 只有确实需要细粒度流式事件、原生审批转发或长期连接时，才引入 `app-server`；
- 锁定 CLI 与协议版本；
- 为协议生成和事件字段建立契约测试；
- 对未知事件保持向前兼容，不能因为新增字段崩溃。

### 接入 Codex 的硬性规则

- **锁定版本**：记录 CLI 版本、SDK 版本和协议版本，升级前跑契约测试；
- **最小工作区**：一个 Run 一个 workspace，任务结束回收；
- **最小环境变量**：不把长期密钥、浏览器 Cookie 和无关凭据传给子进程；
- **最小网络出口**：默认关闭或白名单，只允许任务需要的域名；
- **结构化输出**：要求 `--output-schema`，不要解析自然语言来判断成功；
- **独立验证**：Codex 说完成不算完成，必须通过 Hearth Verifier；
- **副作用隔离**：Codex 不直接持有邮件、日历、付款和发布权限；
- **可取消**：超时和用户取消要终止整个进程树，而不只是停止读取输出；
- **日志脱敏**：JSONL、命令输出和错误信息都可能包含敏感数据，写入 Event Log 前要脱敏；
- **临时会话优先**：一次性任务使用 `--ephemeral`；需要恢复时再显式保存 thread id。

### 最终判断

Codex 可以作为 Hearth 的“高能力工作区执行器”，而且现在就能做第一阶段集成。但正确的目标不是“把 Codex 的全部能力嵌进来”，而是：

> **定义一个 Hearth 自己能验证、能限权、能恢复、能计费的 Codex 能力子集，并把它封装成稳定的 Executor 合约。**

这也是 Hearth 与“Codex 套壳”的分界线：套壳把 Codex 当产品；Hearth 把 Codex 当可替换、可治理的执行引擎。

## 补充依据

- Hearth 的 Codex 定位与 Build vs Integrate：`Hearth_个人Agent_OS_总体路线图_v3.md` 第 2.3–2.4 节
- Hearth 最终集成边界：`Hearth_个人Agent_OS_总体路线图_v3.md` 第 29.5 节
- MVP 与从 0 到 100 的开发顺序：`Hearth_个人Agent_OS_总体路线图_v3.md` 第 25 章
- OpenClaw Gateway、渠道和设备节点：本机 OpenClaw 文档 `docs/concepts/architecture.md`
- OpenClaw 审计账本与执行身份：本机 OpenClaw 文档 `docs/gateway/audit.md`
- OpenClaw 沙箱后端：本机 OpenClaw 文档 `docs/gateway/sandboxing.md`
- OpenClaw 记忆架构：本机 OpenClaw 文档 `docs/concepts/memory-architecture.md`
- OpenClaw 队列与恢复：本机 OpenClaw 文档 `docs/concepts/queue.md`、`docs/gateway/restart-recovery.md`
- OpenClaw standing intents：本机 OpenClaw 文档 `docs/concepts/standing-intents.md`
- Codex CLI 能力：本机 `codex-cli 0.163.0` 的 `codex exec --help`、`codex app-server --help`、`codex exec-server --help`、`codex cloud --help`
- Codex SDK 能力：`@openai/codex-sdk 0.166.0` 的 `README.md` 与 `dist/index.d.ts`

> 说明：OpenClaw 的能力以本机文档和源码核对结果为准；Codex 的能力以本机 CLI 和 npm SDK 版本为准。两者都可能继续演进，正式接入前必须重新做版本与接口核验。

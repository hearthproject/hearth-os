---
title: '技术选型与最终决策'
description: 'Hearth 在 TypeScript、Node.js、Rust、Go、Python 与前端框架之间的技术取舍与最终结论。'
outline: [2, 3]
---

<p class="eyebrow">TECHNOLOGY</p>

# 技术选型与最终决策

<p class="lead">技术选型不从语言偏好出发，而从系统约束出发：Hearth 要长期运行、可恢复、可审计，并且由 TypeScript 前端、CLI、执行器和控制面共同使用同一套协议。</p>

## 最终结论

| 层 | 最终选择 | 说明 |
|---|---|---|
| 核心语言 | TypeScript | 控制面、Durable Harness、CLI、Web 和执行器适配器共用类型与 schema |
| 服务运行时 | Node.js 22+ | 运行 `hearthd` 和 CLI；第一阶段不引入微服务 |
| 常驻服务框架 | Fastify 或 Hono | HTTP API、SSE、健康检查和进程入口 |
| 数据库 | SQLite WAL + migration | 单用户、本地优先、单写者；早期不引入外部数据库 |
| Schema | Zod / JSON Schema | 运行时校验与事件、审批、Effect 的版本化契约 |
| Web | React + Vite + PWA | 任务卡、审批、产物、接管和手机端入口 |
| 实时更新 | SSE 优先 | 比 WebSocket 更简单，适合服务端投影推送 |
| 文档与数据 | Python sidecar | 解析、OCR、表格、批处理和评测脚本使用成熟生态 |
| 原生组件 | Rust 按需引入 | 仅用于 Sandbox Supervisor、设备 agent、加密等边界组件 |

核心判断是：**TypeScript 是主语言，Node.js 是运行时，React 和 Vite 是前端实现，Python 和 Rust 是边界能力。** 这不是多语言微服务，而是模块化单体加少量明确的 sidecar。

## TypeScript 与 Node.js 的区别

TypeScript 和 Node.js 不在同一层，不能二选一：

- **TypeScript 是语言。** 它在 JavaScript 上增加静态类型、接口、泛型、联合类型和类型检查，源代码最终会变成 JavaScript。
- **Node.js 是运行时。** 它基于 V8 和 libuv，提供文件、网络、进程、HTTP、定时器等系统能力。
- **TypeScript 不提供内存安全、并发调度或进程隔离。** 它只约束开发期的类型；运行时仍需 Zod、JSON Schema 或手写校验。
- **Node.js 不负责类型检查。** 新版 Node 可以剥离部分 TypeScript 类型，但类型错误仍需要 `tsc` 或编辑器检查。

所以本项目说“使用 TypeScript”时，实际含义是：**用 TypeScript 编写控制面、CLI、Web 和执行器代码，用 Node.js 运行服务端，用 Vite 构建浏览器端，用 Fastify/Hono 提供 HTTP 与 SSE。** 更完整的工程栈见[工程交付与仓库结构](/reference/engineering)。

## 为什么主语言仍然是 TypeScript

### 协议共享是最大的结构性收益

Hearth 的 `Task`、`Ticket`、`Run`、`Event`、`Approval`、`Effect`、`Receipt` 和 `Artifact` 会同时出现在服务端、CLI、浏览器和测试中。前端已经确定使用 TypeScript，如果后端也使用 TypeScript，这些契约可以放在共享包中，由同一套 schema 生成运行时校验和静态类型。

如果主语言改成 Rust，前端仍然需要 TypeScript 类型，后端需要 Rust 类型，中间还要维护 JSON Schema、OpenAPI、Protobuf 或 N-API 边界。代码生成可以解决一部分问题，但会引入新的版本漂移、序列化差异和调试路径。

### Hearth 的负载是编排，不是计算

控制面主要做状态迁移、策略判断、任务调度、事件写入、SSE 推送和外部进程编排。这些是 I/O 密集型工作，Node 的事件循环和非阻塞 I/O 足够，真正的 CPU 工作可以放到 worker、Python sidecar 或 Sandbox。

当前部署目标是单用户、本地优先、SQLite WAL、单进程 `hearthd`。在这个规模下，Rust 的性能和内存优势不是瓶颈，过早跨语言反而会把注意力从任务正确性转移到 FFI、异步运行时和构建链上。架构约束可参见[总体架构与数据流](/architecture/overview)。

### 生态与交付路径更短

Agent OS 需要连接 Codex CLI、MCP 服务、邮件和日历 API、Playwright、PWA、SSE、SQLite、进程管理和测试工具。TypeScript/Node 在这些集成上的库、示例和调试工具更成熟，可以直接复用；Rust 通常需要再加一层适配器或进程边界。

### 单写者和事件溯源不依赖语言

Hearth 的可靠性来自 Event Log、outbox、lease、fencing token、幂等键和恢复测试，而不是来自某个语言的内存模型。Rust 能让某些内存错误在编译期消失，但不能替你保证任务状态机、审批范围或副作用幂等。

### AI 编码不改变架构约束

AI 编码降低了打字成本，但没有降低需求澄清、协议演进、系统集成和人工审查的成本。Rust 编译器能发现更多局部错误，却无法判断“这个任务是否应该自动执行”或“这个副作用是否有权限”。在这个项目里，语义正确性、可恢复性和安全边界仍然需要设计、测试和评审。

## Rust、Go 与 Python 的边界

| 语言 | 优势 | 本项目中的定位 |
|---|---|---|
| TypeScript | 前后端共享类型、生态完整、迭代快 | 控制面、Harness、CLI、Web、执行器适配器 |
| Rust | 内存安全、低开销、强类型、单二进制 | 可选的 Sandbox Supervisor、设备 agent、加密和底层边界组件 |
| Go | 并发模型简单、单二进制、部署方便 | 当前不选；未来若转向高并发云服务可重新评估 |
| Python | 文档、数据、OCR、机器学习和评测生态成熟 | `sidecars/docdata`、离线处理和评测脚本 |

如果未来出现以下条件，应重新评估 Rust：

- 目标设备无法可靠运行 Node.js，或必须提供单一 native 二进制；
- 大量不可信代码需要在进程内执行，内存隔离成为核心安全边界；
- 本地事件量、文件处理或并发任务显著超过单用户 MVP 的规模；
- 团队已经具备长期维护 Rust 异步和多 crate 工程的能力。

即便如此，更合理的路线是 **Rust 边界组件 + TypeScript 控制面**，而不是立即重写整个系统。事件和 API 应保持语言中立，为未来替换实现留下空间。

## 前端：全栈 TypeScript 不等于不用框架

“TypeScript 全栈”只表示前后端使用同一种语言，不代表不用 UI 框架或构建工具。各层职责如下：

| 层 | 选择 | 作用 |
|---|---|---|
| 语言 | TypeScript | 业务逻辑、组件、类型和协议 |
| UI | React | 组件化、状态绑定、路由和交互 |
| 构建 | Vite | 编译 TS/TSX、热更新、打包和 PWA |
| 运行时 | 浏览器 / Node.js | Web 在浏览器运行，`hearthd` 在 Node 运行 |
| 后端框架 | Fastify / Hono | HTTP、SSE 和服务端入口 |

### 为什么推荐 React

Hearth 的前端不是静态展示页，而是任务卡、审批、产物、接管、实时状态和失败恢复的操作面。React 的组件模型、TypeScript 支持、测试工具、PWA 方案和可访问性生态更适合这种复杂交互，也与当前文档中的 `React + Vite + PWA` 选型一致。

React 不是唯一答案。Vue 3 + Vite 同样是合理的 TypeScript 方案，模板语法更轻；如果团队更熟悉 Vue，不应为了框架偏好强行切换。真正需要保持稳定的是服务端投影、命令接口、错误语义和权限边界，而不是某个组件的实现方式。

### 为什么不直接使用原生三件套

原生 HTML、CSS 和 JavaScript 是浏览器的底层基础，但直接手写完整应用需要自行解决组件复用、状态同步、路由、表单校验、可访问性、实时事件和测试组织。Hearth 的任务卡和审批界面有大量共享状态和失败路径，手写原生 DOM 最终往往会重新造一个不完整的框架。

原生三件套适合文档站、静态页面和一次性原型；正式应用建议使用 React 或 Vue，并把 UI 限制为服务端投影的渲染层。

### 为什么暂不采用 Next.js

本地优先的 `hearthd` 已经提供 HTTP 服务、SSE 和单写者状态。Next.js 会额外引入服务端运行时、渲染层和部署模型，容易形成第二套状态源。当前阶段使用 Vite SPA + SSE 更简单，也更符合单进程本地服务的边界。

## 风险与约束

| 风险 | 缓解方式 |
|---|---|
| Node 单线程被 CPU 任务阻塞 | CPU 工作放入 worker、Python sidecar 或 Sandbox；控制面只做编排 |
| TypeScript 运行时没有类型 | 所有外部输入、事件和 Effect 使用 Zod / JSON Schema 校验 |
| 长驻进程内存泄漏 | 进程监督、长稳测试、heap snapshot 和可回滚发布 |
| SQLite 并发写冲突 | 单写者、WAL、outbox、lease 和 fencing token |
| npm 供应链风险 | pnpm 锁文件、依赖审计、最小依赖和发布前检查 |
| AI 生成代码语义错误 | 契约测试、故障注入、权限拒绝测试和人工审查 |
| 跨语言迁移成本 | 事件与 API 使用语言中立 schema，避免把领域协议锁在 TypeScript 实现中 |

## 决策回顾

**最终决策：TypeScript / Node.js 作为主技术栈，React + Vite + PWA 作为前端，Python 作为文档与数据 sidecar，Rust 仅在确有必要的底层边界中使用。** 在 AI 编码提高产出速度之后，这个结论仍然成立：速度不是瓶颈，系统边界、协议一致性、可恢复性和安全责任才是。

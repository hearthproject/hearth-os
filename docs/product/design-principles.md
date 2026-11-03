---
title: '设计原则与架构不变量'
description: 'Hearth 的五个不可妥协判断、核心设计选择、七条架构不变量与参考系统边界。'
outline: [2, 3]
---

<p class="eyebrow">DESIGN PRINCIPLES</p>

# 设计原则与架构不变量

<p class="lead">这些判断约束了 Hearth 的产品形态、技术边界和后续所有阶段。它们不是建议，而是不可轻易妥协的设计合同。</p>

## 五个不可妥协的判断

1. **价值在控制面、记忆和验证，不在“再实现一个模型”。**
2. **Codex 是强大的并列 Executor，不是产品本体，也不是唯一执行大脑。**
3. **Token 消耗是架构指标；能不用模型的地方，坚决不用模型。**
4. **前端必须简单到用户不需要学习 Agent 架构；复杂逻辑留在后端。**
5. **自进化只能产生候选技能和候选策略，不能绕过权限、评估和人类审查。**

本版追加一条交付判断：

6. **先做可每天使用的最小产品，再逐步长成完整 OS；前端从第一个增量开始存在。**

## 核心设计判断

### Codex 是并列执行器，不是产品中心

Codex 擅长长链路 workspace 工作、代码、测试、Issue/PR、调研、文档、表格和多步骤 Shell；不适合作为长期记忆、权限中心、凭据中心、常驻事件监听器或实时桌面操作器。

路由原则是：

> **哪个执行器能以最低 Token、最高可靠性、最小权限完成并通过验证，就选哪个。**

### 自研与集成的边界

Hearth 自研：

- 控制面、Durable Harness、Event Log 协议；
- Policy、Mandate、Capability、Approval；
- Context Compiler、Token Governor；
- Memory OS、Evolution OS；
- Execution Gateway 控制逻辑、Credential Broker；
- 任务卡、审批、产物和手机入口；
- 验证器与评估体系；
- Native Runtime 的薄执行层。

Hearth 集成：

- 模型 API 或本地模型；
- Codex；
- Playwright；
- 文档解析/转换库；
- 官方邮件、日历、云盘 API/MCP；
- 容器/微虚拟机/Sandbox 内核；
- OpenTelemetry。

Hearth 不重写模型推理引擎、容器/虚拟化内核、完整第三方 Agent 框架或文档解析器。

### 前端不是后置包装层

用户打开 Hearth 只需知道三件事：它在做什么、是否需要我、下一步点哪里。

- 首页不是无限聊天流，而是任务卡；
- 每个状态只有一个主动作；
- 审批不藏在多层设置里；
- 手机可以完成高风险动作确认；
- 技术术语不进入主界面；
- 任何异常都有可执行恢复路径；
- 只存在于 CLI、日志、数据库或测试中的能力，不计入阶段完成。

### 一个逻辑 Agent，多设备执行

```text
一个逻辑 Hearth
  ├─ 一个主 Gateway / Control Plane
  ├─ 一个 Event Log / 单写者
  ├─ 多台设备上的 agentd
  ├─ 手机作为查看、审批、接管、发起入口
  └─ 每个设备注册自己的能力
```

设备只提供执行能力和入口，不复制身份、事实源和授权。

### 学习 OpenClaw 与 Hermes，但不复制它们

OpenClaw 值得学习 Gateway、渠道、设备节点、常驻、自主分级和注意力入口；Hermes 值得学习记忆预算、记忆约束、技能沉淀、子任务生命周期和进化闭环。

不 fork、不作为运行时依赖、不让参考项目变成产品底座。Hearth 只吸收模式，并通过自己的 Event Log、Policy、Memory 和 Evolution 协议实现。

## 七条架构不变量

1. Event Log 是唯一事实源。
2. 每个 State Root 只有一个写权威。
3. 所有外部副作用必须有幂等键、审批或明确豁免、以及 Receipt。
4. 执行器不能直接读取长期原始凭据。
5. 每个任务必须有预算、截止时间和取消路径。
6. 记忆必须有 provenance、敏感度、冲突和遗忘策略。
7. 任何自进化都必须经过评估、canary 和回滚。

再加一条交付不变量：

8. **每个增量都必须是可用纵向切片：用户结果、界面、持久状态、真实执行、验证、恢复和度量同时出现。**

## 参考系统的位置

| 参考 | 学习什么 | 不做什么 |
|---|---|---|
| OpenClaw | Gateway、渠道、设备、注意力、常驻 | 不 fork、不复制渠道规模 |
| Hermes | 记忆预算、技能、生命周期、进化 | 不做无界自修改 |
| DeerFlow | Harness/App 分层、Run 生命周期 | 不引入重型框架耦合 |
| Pi / Maka | session tree、steering、compaction | 不复制完整框架 |
| OpenSandbox / OpenBot | 隔离、快照、takeover、receipt | 不复制完整产品 |
| OpenMuse / OpenDots | durable job、checkpoint、lease | 不照搬任务模型 |
| Codex | 工作区执行、代码、研究、文档 | 不当权限中心或记忆中心 |

## 本章结论

Hearth 的护城河不是“拥有一个更强的模型”，而是知道什么时候不该调用模型、该给执行器什么最小上下文、哪些动作需要谁的授权、如何证明任务真的完成、失败后如何恢复、什么该记住、什么该遗忘。

但这一切必须先以一个真实可用的最小产品出现，而不是等架构全部完成后才让用户看到。

---
title: '总体架构与数据流'
description: 'Hearth 的北极星架构、七个平面、任务数据流、部署形态与架构演进。'
outline: [2, 3]
---

<p class="eyebrow">SYSTEM DESIGN</p>

# 总体架构与数据流

<p class="lead">七个平面如何协作，状态如何流动，系统如何从最小产品长成完整 Agent OS。</p>

## 北极星架构

```text
用户 / CLI / Web / Mobile / IM
            ↓
     Experience Plane
     任务卡 · 审批 · 产物 · 接管
            ↓
      Personal Gateway
   身份 · 渠道 · 设备 · 注意力入口
            ↓
       Control Plane
  触发 · 策略 · Mandate · 调度 · Watchdog
            ↓
      Durable Harness
  任务图 · 预算 · lease · 重试 · 恢复
            ↓
       Executor Layer
 Native · Codex · Connector · Browser
 GUI · Document/Data · Human
            ↓
     Execution Gateway
 工作区 · Sandbox · 网络 · Credential Broker
            ↓
  Event Log / Artifacts / Receipts
       ↓              ↓
   Memory OS      Evolution OS
```

所有事实进入 Event Log；所有外部副作用经过 outbox、幂等键和 Receipt；所有界面状态都是投影，不是事实源。

## 七个平面

| 平面 | 责任 | 不承担 |
|---|---|---|
| Experience Plane | 任务卡、审批、产物、接管、通知 | 直接执行业务逻辑或写数据库 |
| Personal Gateway | 身份、渠道归一化、设备注册、注意力入口 | 长任务推理 |
| Control Plane | 意图、触发、策略、Mandate、调度、Watchdog | 持有长期凭据 |
| Durable Harness | 任务图、路由、预算、重试、lease、恢复 | 绕过策略执行外部动作 |
| Executor Layer | Native、Codex、Connector、Browser、GUI、Document/Data、Human 的统一协议 | 自行扩大权限或修改 Policy |
| Execution Gateway | 工作区、Sandbox、浏览器、GUI、网络、Credential Broker | 决定“该不该做” |
| Memory / Evolution | 个人上下文、记忆、技能、评估、晋升和回滚 | 成为事实源 |

Event Log 贯穿所有平面，是状态、审计、恢复和 UI 的源头。

## 一次任务的完整数据流

1. 用户或 Source 产生事件。
2. Gateway 归一化 Event，去重并记录来源。
3. Control Plane 判断：忽略 / 观察 / 建议 / 创建 Task。
4. Policy 与 Mandate 检查范围、风险、预算和审批要求。
5. Token Router 选择最小可行模型和执行层级。
6. Context Compiler 构建 Task Pack。
7. Harness 创建 Ticket、Assignment 和 outbox 记录。
8. Executor 在受限环境执行，持续产生 WorkerEvent。
9. Execution Gateway 通过 Broker 完成获批副作用。
10. 产物、Receipt、失败和人工操作写入 Event Log。
11. 验证器决定完成、重试、换执行器或转人工。
12. Memory 写入候选记忆；Evolution 收集轨迹。
13. UI 从投影生成任务卡、通知和产物视图。

## 部署形态

| 形态 | 组成 | 目标 |
|---|---|---|
| Local | `hearth` CLI + `hearthd` + SQLite + Docker | 第一阶段和 dogfood |
| Hybrid | 本地状态与设备能力 + 云端模型/沙箱 | 资源不足或远程执行 |
| Self-hosted Server | 常驻 Gateway + 多设备 agentd + 可选远程 Sandbox | 长期在线和多设备 |

第一阶段不引入微服务。单进程、单写者、SQLite 足以支撑早期。模块边界靠接口、schema 和测试保证，而不是先拆网络服务。

## 启动形态

```text
hearthd
  ├─ local gateway / IPC / web API
  ├─ scheduler / watcher / trigger
  ├─ task queue / event log / outbox
  ├─ token router / context compiler / budget governor
  ├─ executor supervisor
  ├─ device registry / capability catalog / lease manager
  ├─ execution gateway / sandbox manager
  ├─ watchdog / health / backup
  └─ pairing / event sync / device revocation
```

必须考虑开机自启、终端关闭后继续运行、休眠唤醒、网络中断、认证过期、执行器崩溃、版本升级、资源回收、手机断开和重新配对。

## 架构演进

Hearth 不在第一天实现最终架构图上的全部模块。架构随产品增量逐步长出来，但核心不变量保持：

| 产品形态 | 架构增量 | 继续保持不变 |
|---|---|---|
| 第一阶段最小完整 MVP | 单进程服务、任务记录、真实执行、基础审批与产物 | 任务卡优先、状态诚实、恢复和外部操作回执 |
| 第二阶段日常内容工作 | 只读来源、文档与表格处理、网页研究、审批后写入 | 最小权限、来源可追溯、不重复执行、成本可控 |
| 第三阶段桌面操作 | 桌面设备、观察与接管、分级桌面动作 | 可暂停、可接管、可验证、失败可恢复 |
| 第四阶段主动服务与手机入口 | 触发条件、主动收件箱、手机入口、注意力控制 | 低打扰、可撤销、主动模式可暂停 |
| 第五阶段记忆与能力进化 | 记忆、纠正与遗忘、方法候选、评估与回退 | 来源清楚、权限不扩大、可回退 |
| 第六阶段多设备与长期运行 | 多设备同步、离线处理、设备撤销、备份迁移与长期运维 | 一个逻辑 Agent、状态一致、设备可撤销 |

**架构可以分阶段扩展，但产品形态不能分阶段补课。** 每个阶段都必须有与其架构复杂度匹配的完整用户路径。

## 本章结论

架构的价值不是模块数量，而是让“任务、授权、执行、证据和恢复”沿同一条可审计链路流动。第一阶段先确定任务、审批、产物和恢复的基本约定，并用最小真实链路实现；之后逐步扩展平面，不改变事实源和权限边界。

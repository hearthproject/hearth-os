---
title: '领域模型与协议'
description: 'Hearth 的核心实体、关系、Event 结构、Executor 协议、审批与回执链路。'
outline: [2, 3]
---

<p class="eyebrow">DOMAIN MODEL</p>

# 领域模型与协议

<p class="lead">核心实体、关系、事件、执行器协议、审批与回执。这里定义的是系统的事实契约，而不是某一次实现细节。</p>

## 核心实体

| 实体 | 定义 | 关键不变量 |
|---|---|---|
| `Source` | 用户、邮件、日历、IM、GitHub、网页、文件、cron、设备 | 有身份、可信级别和速率限制 |
| `Event` | 不可变事实：消息、观察、工具调用、结果、审批、错误 | 只追加、可重放、带 schema version |
| `Thread` | 围绕一个持续主题的上下文容器 | 可关联多个 Ticket，但不拥有执行权 |
| `Intent` | 用户表达或系统推断的目标 | 不直接执行，必须转成 Task/Ticket |
| `Task` | 对用户可见、有验收标准的工作项 | 有截止时间、状态和完成证据 |
| `Ticket` | 被授权的最小工作单元 | 单 owner、预算、范围、过期时间 |
| `Mandate` | 授权策略的版本化实例 | 范围、强度、有效期、可撤销 |
| `Policy` | 个人规则集合 | 版本化；变化可触发 revalidation |
| `Assignment` | Ticket 与 Executor 的绑定 | 同一时刻最多一个有效执行者 |
| `Run` | 一次实际执行尝试 | 输入、预算、检查点、终态 |
| `Executor` | 执行能力 | 能力声明、隔离边界、可取消 |
| `Capability` | 对资源、动作、范围和期限的许可 | 最小权限、可过期、可撤销 |
| `Approval` | 人的授权决定 | 绑定真实动作、参数、范围和过期时间 |
| `Artifact` | 文档、代码、报告、截图、数据、日程 | 内容寻址、来源可追溯 |
| `Receipt` | 外部副作用的回执 | 幂等键、时间、结果、撤销信息 |
| `Memory` | 长期事实、偏好、经历或技能索引 | provenance、置信度、敏感度、遗忘策略 |
| `Skill` | 可复用的程序性能力 | 版本化、权限声明、可评估、可回滚 |
| `Device` | 可信设备节点 | 身份、能力白名单、配对状态 |
| `Budget` | 时间、Token、成本、磁盘和命令预算 | 硬上限；耗尽必须暂停或转人工 |
| `Eval` | 对任务、Run、Skill 或路由的评估 | 结果不可由操作者挑选 |

## 核心关系

```text
Source → Event → Trigger → Thread
                          ├─→ Intent → Task → Ticket → Assignment → Run
                          └─→ Subscription → fast path

Policy → Mandate → Ticket
Approval → Mandate
Run → Artifact / Receipt
Run → Eval → Skill proposal → Shadow → Eval → Promote / Rollback
Device → Capability → Assignment
Memory → Context Pack → Executor
```

## Event 最小结构

```ts
type Event = {
  id: string;
  type: string;
  schemaVersion: number;
  occurredAt: string;
  actor: "user" | "agent" | "executor" | "system" | "device" | "external";
  subject:
    | { kind: "thread"; id: string }
    | { kind: "task"; id: string }
    | { kind: "ticket"; id: string }
    | { kind: "run"; id: string }
    | { kind: "device"; id: string };
  causationId?: string;
  correlationId: string;
  payload: unknown;
  hashPrev?: string;
};
```

Event Log 只记录事实，不记录“模型觉得应该怎样”。投影可以重建，模型上下文可以重算，但历史不能覆盖。

## Executor 协议

```ts
type ExecutorCapability =
  | "files"
  | "shell"
  | "code"
  | "research"
  | "documents"
  | "email"
  | "calendar"
  | "browser"
  | "gui"
  | "http"
  | "devices"
  | "human";

interface Executor {
  id: string;
  capabilities: ExecutorCapability[];
  execute(ticket: Ticket, context: ExecutorContext): AsyncIterable<ExecutorEvent>;
  cancel(runId: string): Promise<void>;
  resume?(checkpoint: Checkpoint): Promise<void>;
  health?(): Promise<ExecutorHealth>;
}
```

统一输出包括：标准化事件流、产物引用、结构化最终结果、验证结果、外部动作 Receipt、失败分类与可恢复性。

Executor 不负责解读长期偏好、决定是否发送/删除/合并/付款、自行扩大 capability、直接读取长期原始凭据或创建无预算的新任务。

## 审批与回执

所有外部副作用按以下顺序：

1. 生成 effect intent；
2. 写入 outbox；
3. 提交事务；
4. Dispatcher 读取待执行项；
5. 检查 Approval / Mandate / capability；
6. 使用幂等键调用外部服务；
7. 记录 Receipt；
8. 标记完成或进入死信。

规则：

- 先落盘，再执行；
- 同一幂等键不能产生第二次外部副作用；
- 重试复用同一幂等键；
- 无法幂等的外部动作必须审批并转人工；
- 崩溃恢复后可安全重投；
- 外部服务返回不确定结果时，先对账，不盲目重试；
- 死信必须可查看、可修复、可人工重放。

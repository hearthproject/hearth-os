---
title: '技能进化'
description: 'Hearth Evolution OS 的输入信号、技能模型、轨迹到技能流程、晋升门槛、自修改边界与反模式。'
outline: [2, 3]
---

<p class="eyebrow">EVOLUTION OS</p>

# 技能进化

<p class="lead">系统可以从轨迹中形成候选技能，但不能让 Agent 自己绕过权限、评估和回滚直接改自己。</p>

## Evolution OS

自进化不是让 Agent 改自己，而是从轨迹中形成候选能力，经过验证后有限晋升。

### 输入信号

- 成功轨迹；
- 失败和重试；
- 人工纠偏、拒绝和接管；
- 工具/模型变化；
- 用户偏好变化；
- 评估结果和成本。

### 技能模型

技能可以是提示模板、确定性工作流、文档管道、Connector 配方、代码适配器和验证/补偿步骤，但必须有 manifest：

```ts
type SkillManifest = {
  id: string;
  version: string;
  trigger: string;
  preconditions: string[];
  inputs: SchemaRef[];
  steps: SkillStep[];
  tools: string[];
  capabilities: string[];
  budgets: BudgetSpec;
  validators: ValidatorRef[];
  fallback: FallbackSpec;
  provenance: string[];
  evalSuite: string;
  status: "draft" | "shadow" | "canary" | "active" | "retired";
};
```

技能不能自带新权限，只能申请父任务和用户 Mandate 的交集。

### 从轨迹到技能

```text
轨迹采集
  → 重复/失败聚类
  → 候选技能描述
  → 生成实现
  → 静态检查与权限审计
  → 离线回放评估
  → Shadow（无外部副作用）
  → Canary（小范围真实使用）
  → Promote / Reject / Rollback
  → 持续监控
```

### 晋升门槛

- 真实任务集的 Verified Success 不低于旧流程；
- 安全测试零越权；
- 没有扩大 capability；
- Token、时间或人工分钟有明确改善；
- 失败可恢复、可解释、可回滚；
- 评估集没有严重污染；
- 用户审阅技能说明和权限；
- 上线后监控无异常副作用。

“模型觉得更好”或一次演示不能作为晋升证据。

### 权限与自修改边界

- Agent 可提出技能、参数、提示、验证器和流程候选；
- Agent 不能修改自己的 Mandate、Policy、Approval 规则和 Permission；
- Agent 不能直接改写核心 Runtime、事件格式和安全边界；
- 核心代码变更必须走人工审阅 PR；
- 技能上线必须绑定版本、评估集和回滚目标；
- 技能不能创建新凭据或后台任务；
- 任何权限变化需要用户明确授权。

### 反模式

- 无评估直接启用；
- 用一次成功代表长期能力；
- 技能不断扩权；
- 评估集被训练/挑选污染；
- 失败样本被删；
- 只降 Token 不降人工分钟；
- 没有回滚；
- 让 Agent 自己修改安全检查。

## 与阶段的关系

- **第一阶段**：只做执行隔离、基础凭据边界、外部操作回执和审批演练；不做完整记忆与能力进化。
- **第二阶段**：基础记忆（来源、基本遗忘）和任务背景整理。
- **第五阶段**：完整记忆、遗忘传播、方法候选和晋升门槛。
- **第六阶段**：多设备记忆同步、设备撤销和迁移验证。

安全、记忆和进化不能等到最后补；它们从第一阶段就以最小形式存在，并在后续阶段逐步完整。

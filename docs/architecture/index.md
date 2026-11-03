---
title: '系统设计总览'
description: 'Hearth 系统设计总览：架构基础、入口与控制、执行器、安全、记忆、进化、评估、Token 与前端。'
outline: [2, 3]
---

<script setup>
const foundations = [
  { no: '01', title: '总体架构与数据流', text: '七个平面、一次任务的完整数据流、部署形态与架构演进。', link: '/architecture/overview' },
  { no: '02', title: '领域模型与协议', text: '核心实体、Event、Executor 协议、审批与回执。', link: '/architecture/domain-model' }
]
const execution = [
  { no: '03', title: '个人网关与多入口', text: '渠道归一化、事件去重、注意力收件箱与设备注册。', link: '/architecture/gateway' },
  { no: '04', title: '控制面与自主性', text: 'Trigger、Policy、Mandate、调度、Watchdog 与注意力预算。', link: '/architecture/control-plane' },
  { no: '05', title: '持久执行与恢复', text: 'Run 生命周期、任务图、lease、恢复策略与路由。', link: '/architecture/durable-execution' },
  { no: '06', title: '执行器模型与路由', text: '能力矩阵、路由原则与执行器协作。', link: '/architecture/executor-model' },
  { no: '07', title: '执行器目录', text: 'Codex、Native、Connector、Browser、GUI、Document/Data。', link: '/architecture/executor-catalog' },
  { no: '08', title: '人工接管与审批', text: '审批卡、接管协议与人的错误输入。', link: '/architecture/human-takeover' }
]
const safety = [
  { no: '09', title: '执行安全与副作用', text: 'Sandbox、网络、Credential Broker、Effect Dispatcher 与威胁矩阵。', link: '/architecture/execution-safety' },
  { no: '10', title: '记忆系统', text: '五类记忆、预算、冲突、遗忘、投毒防护与同步。', link: '/architecture/memory' },
  { no: '11', title: '技能进化', text: '轨迹到技能、晋升门槛、权限边界与回滚。', link: '/architecture/evolution' },
  { no: '12', title: '安全与隐私', text: '信任边界、Capability、风险分级、凭据与事故响应。', link: '/architecture/security-privacy' },
  { no: '13', title: '评估体系', text: '任务集、指标、验证器、轨迹重放、故障注入与阶段门槛。', link: '/architecture/evaluation' }
]
const experience = [
  { no: '14', title: 'Token 经济', text: '预算层级、Context Compiler、模型阶梯与硬预算。', link: '/architecture/token-economics' },
  { no: '15', title: '前端与移动体验', text: '任务卡、审批、产物中心、手机端与体验指标。', link: '/architecture/frontend-experience' }
]
</script>

<p class="eyebrow">SYSTEM DESIGN</p>

# 系统设计：一条可审计的执行链

<p class="lead">Hearth 的架构价值不是模块数量，而是让任务、授权、执行、证据和恢复沿同一条链路流动。先从总体架构开始，再按控制面、执行器、安全与体验逐层深入。</p>

## 架构基础

<DocCardGrid :items="foundations" :columns="2" />

## 入口、控制与持久执行

<DocCardGrid :items="execution" :columns="2" />

## 安全、智能与评估

<DocCardGrid :items="safety" :columns="2" />

## 经济与体验

<DocCardGrid :items="experience" :columns="2" />

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

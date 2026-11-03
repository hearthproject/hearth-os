---
title: '执行安全与副作用治理'
description: 'Hearth Execution Gateway、Sandbox、网络出口、Credential Broker、Effect Dispatcher 与安全威胁矩阵。'
outline: [2, 3]
---

<p class="eyebrow">EXECUTION SAFETY</p>

# 执行安全与副作用治理

<p class="lead">所有外部副作用都必须经过工作区、Sandbox、网络、Credential Broker、outbox、幂等键和回执。</p>

## Execution Gateway 与 Sandbox

Execution Gateway 是执行器与实际资源之间的安全层，负责：

- Workspace 生命周期、挂载和文件权限；
- Sandbox Provider 选择、快照和回收；
- 网络出口策略；
- Credential Broker；
- Effect Dispatcher；
- 配额、审计、取消和恢复。

它不决定业务意图，也不替代 Policy。

### Workspace 类型

| 类型 | 用途 | 特性 |
|---|---|---|
| Read-only | 研究、审查、读取证据 | 不可写，可缓存 |
| Ephemeral | 一次性执行 | 结束即销毁 |
| Copy-on-write | 修改文件但保留原件 | 快照、diff、可回滚 |
| Persistent Project | 长期项目工作区 | 版本化、配额、定期清理 |
| Remote Workspace | 设备或远程执行 | lease、加密传输、离线恢复 |

默认从最小权限和最短生命周期开始。任务结束后，临时权限、挂载和网络规则必须回收。

### 隔离级别

| 级别 | 典型实现 | 适用场景 |
|---|---|---|
| Process | 受限进程、资源限制 | 可信脚本、轻量工具 |
| Container | Docker/OCI | 一般代码、测试、文档转换 |
| MicroVM | Firecracker 等 | 不受信任代码、外部文件、高风险研究 |
| Virtual Desktop | VM + 桌面 | GUI 应用、不可信桌面软件 |
| Remote Device | 用户设备 agentd | 必须在特定设备执行的任务 |

Container 适合运营隔离，但不是对恶意代码的绝对安全边界。不受信任代码、宏、浏览器下载物和高风险文件应使用更强隔离。

### Sandbox Provider 接口

```ts
interface SandboxProvider {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  resume(snapshot: SnapshotRef): Promise<SandboxHandle>;
  snapshot(handle: SandboxHandle): Promise<SnapshotRef>;
  exec(handle: SandboxHandle, cmd: CommandSpec): Promise<CommandResult>;
  mount(handle: SandboxHandle, mount: MountSpec): Promise<void>;
  expose(handle: SandboxHandle, port: PortSpec): Promise<Endpoint>;
  destroy(handle: SandboxHandle): Promise<void>;
}
```

Hearth 依赖接口，不把业务逻辑写死在 Docker、Firecracker 或某个云厂商 API 上。

### 网络出口

- 默认拒绝出站；
- 按任务开启域名和端口白名单；
- 通过代理记录请求，阻断元数据地址和本地管理接口；
- 研究任务使用只读网络或浏览器代理；
- 写操作不直接走模型生成的任意 URL；
- 下载内容进入隔离区，扫描、解析后再使用；
- 绕过 egress 的尝试视为安全事件。

### Credential Broker

```text
用户 OAuth / API Key
  → 加密存储
  → 用户授权 scope
  → Run 申请短期能力
  → Broker 校验 Mandate / Approval
  → 发放短期 token 或代执行
  → 记录使用、过期并撤销
```

原则：

- 模型永远看不到 refresh token、私钥、cookie 和完整 secret；
- Connector 调用外部 API 时才注入凭据；
- 凭据按账户、资源、动作、设备和时间限定；
- 所有使用有审计；
- 任务结束立即回收；
- 用户可随时撤销全部连接；
- 日志、错误和模型上下文自动脱敏。

### Effect Dispatcher

外部副作用不能由执行器直接完成，而应通过类型化 Effect：

```text
Effect Intent
  → 参数验证
  → Preview
  → Policy / Mandate 检查
  → Approval
  → outbox
  → 幂等执行
  → Receipt / 对账
```

Effect 应声明目标系统和资源、幂等键、是否可逆、失败补偿、审批级别、回执字段、超时和对账方式。

### 安全威胁矩阵

| 威胁 | 防线 |
|---|---|
| 提示词注入 | 外部内容不可信、能力隔离、审批、工具白名单 |
| 越权访问文件/网络 | Workspace 最小挂载、egress 白名单、Sandbox |
| 秘密泄露 | Broker、短期凭据、日志脱敏、上下文过滤 |
| 重复外部副作用 | 幂等键、outbox、Receipt、对账 |
| 恶意文档/下载 | 隔离区、扫描、解析沙箱、禁止宏执行 |
| 供应链攻击 | 锁定版本、依赖审计、签名/校验、最小权限 |
| 设备丢失 | 撤销、密钥轮换、本地擦除、短期会话 |

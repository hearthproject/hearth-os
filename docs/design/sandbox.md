# Native Harness 沙箱

本文说明 Hearth native executor 在 Windows 上的实际执行边界。它描述的是**已经落地的约束**，不是目标愿景；未实现的隔离能力在这里写清楚。

## 0. 当前实现状态（2026-11-23，0.3.4）

- Windows 默认 `HEARTH_NATIVE_SANDBOX=enforce`；可显式设为 `off` 或 `danger-full-access` 降级，并在审计里记录原因。非 Windows 设为 `enforce` 会 fail-closed，不会静默退回完全权限。
- 只有任务需要 `shell`、`run_tests` 或 `diagnostics` 时才准备沙箱；没有这些工具就不启动 helper。
- 审批与沙箱是两件事，但 `approvalMode=full` 会把 native 任务显式切到 `danger-full-access` 并跳过沙箱；需要沙箱时使用 `necessary` 或 `workspace`。
- Windows 后端是自研 `hearth-native.exe`（`apps/native/hearth-native.cs` 由系统 `csc.exe` 编译），不再依赖 `@deepseek-ai/dsh-sandbox-windows-acl` 或其他 Node ACL runner。
- helper 缺失、AppContainer 创建失败、ACL 授权失败、probe 超时或声明域级网络白名单，全部 fail-closed：不 spawn，任务失败并写审计事件。
- 每次沙箱选择、降级、拒绝或 runner 失败都会写 `<outDir>/.hearth/sandbox/audit.jsonl`，并产生 `sandbox.selected` / `sandbox.unavailable` / `sandbox.denied` / `sandbox.runner_failure` 进度事件。

## 1. 威胁模型

### 1.1 要防的

- 不可信仓库内容（README、issue、网页、依赖脚本）诱导模型执行越界写入或删除；
- 模型误操作破坏用户主目录、系统目录、其他项目；
- 子进程读取并外传 Hearth 进程环境中的凭据；
- native 作为执行器回退链最后一站时，成为约束最弱的一支。

### 1.2 不承诺的

- **强隔离**：AppContainer 是文件、进程与网络边界，不是虚拟机、容器或独立内核。
- **读取机密性**：读取受 ACL 限制，但系统目录、安装目录和显式 `--read` 根仍可读；不隐藏其他进程。
- **域级网络白名单**：网络只有 `deny` 与 `open` 两种；`open` 允许任意出网。
- **完整回滚**：非 git 任务的 shell 删除不保证可恢复；git worktree 依靠 checkpoint 与逐轮快照。
- **绝对安全**：字符串命令策略只降低误操作概率，不是安全边界。

## 2. 模式

| 模式 | 含义 | 执行方式 |
| --- | --- | --- |
| `read-only` | 禁止写入/删除工作区 | AppContainer；workspace 只给 `(OI)(CI)RX`，temp 仍可写 |
| `workspace-write` | 只允许任务工作区 + 私有 temp + 显式写根写入/删除 | AppContainer；workspace 给 `(OI)(CI)M`，额外写根逐个 `--write` |
| `danger-full-access` | 不包装 | 仅 operator 显式配置或 `approvalMode=full`；模型不能自行请求 |

`danger-full-access` 不是“完全权限”的同义词。完全权限（`approvalMode=full`）只表示工具审批自动通过；沙箱模式独立计算，并在 full 下明确降级。

## 3. 架构

```text
native-executor
  -> resolveSandboxPolicy()            # workspace / outDir / temp / read roots
  -> AgentToolContext.sandbox          # SandboxRuntime { provider, policy }
  -> shell-session.confine(exact argv)
  -> WindowsNativeSandboxProvider      # 只构造 argv 契约与探测
  -> hearth-native.exe sandbox|pty ... # AppContainer、ACL、Job、watchdog
```

`resolveSandboxPolicy` 的 `workspaceRoot` 以任务实际可写的共同根为准：worktree 与 `outDir` 分离时取二者最近公共祖先（且必须在 `HEARTH_ROOT` 内）；否则回退到项目根。`tempRoot` 固定放在 `LOCALAPPDATA\Temp\hearth-sandbox\<taskId>`（Windows），与 workspace 不相交。

helper 的四个子命令：

- `sandbox`：创建或复用 AppContainer package SID；只给 workspace、私有 temp、显式 `--read` / `--write` 根授权；用 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 在 AppContainer 中启动子进程；子进程加入 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object；父进程 watchdog 每 500ms 检查 `--parent-pid`，父死即 `TerminateJobObject`。
- `pty`：与 `sandbox` 相同的 AppContainer、ACL 和 Job 约束，但通过 `CreatePseudoConsole` 分配交互式控制台；stdin/stdout 是 ConPTY 原始字节流。
- `process-info`：返回 PID 与进程创建时间，供宿主租约和后台进程注册表判断 PID 复用。
- `lease`：`Global\Hearth.Host.<name>` named mutex，用于单实例宿主租约。

网络：`--network deny` 不申请 `internetClient` capability，子进程没有网络身份；`--network open` 申请该 capability 并写审计与 proof。任务声明 `networkHosts` 且不是 `open` 时，provider 直接 fail-closed，不会给一个“没有网络”的假沙箱。

child env 采用白名单：保留 `PATH`/`SystemRoot` 等启动变量，过滤 `*_API_KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`HEARTH_*`、`NODE_OPTIONS`、`PYTHONPATH`、`LD_PRELOAD`、`DYLD_INSERT_LIBRARIES`、`GIT_SSH_COMMAND`、`BASH_ENV` 等；`TMP`/`TEMP` 指向私有 temp，包管理器 cache 指向 workspace 内 `.hearth/sandbox/cache`。

## 4. 失败语义

| 错误 | 行为 |
| --- | --- |
| `SANDBOX_UNAVAILABLE` | 不 spawn；任务失败，写审计与 `sandbox.unavailable` |
| `SANDBOX_UNSUPPORTED_POLICY` | 不 spawn；提示缩小范围或移除域级白名单 |
| runner failure（`sandbox-error:` / exit 127） | 归类沙箱故障，不和命令失败混淆 |
| `Access is denied` / `EPERM` / `EACCES` | 归类沙箱拒绝，保留 stderr，工具结果带 `SANDBOX_DENIED` 标记 |

## 5. 测试

当前已覆盖（`apps/server/src/windows-native-sandbox.test.ts`，12 项）：

- workspace 内写入成功，workspace 外写入被拒绝且文件不存在；
- `read-only` 模式拒绝 workspace 写入；
- junction 指向工作区外时不能逃逸；
- 子进程环境过滤模型密钥与其他敏感变量；
- 默认网络拒绝，`open` 才能出网；
- helper 关闭时 Job Object 杀死子进程；
- ConPTY 交互式命令可执行，argv 契约稳定；
- probe 与 helper 缺失的 fail-closed 路径。

全量 `npm test` 与 `npm run typecheck` 也覆盖沙箱与审批的组合路径。

## 6. 已知边界

- Windows AppContainer 是 `partial`：读取、网络和进程可见性都不是强隔离；硬链接可 alias；其他 AppContainer 工具 ACL 过的树可能不可读。
- workspace 根会留下 standing ACE（跨 session 复用缓存）；只应在 task worktree 上使用，非 git 项目需显式提示。
- 需要 caller-owned 目录；OneDrive、网络共享或企业策略目录可能失败。
- 非 git 项目的 `shell` 删除没有文件历史覆盖；不承诺完整回滚。
- worktree 与 task `outDir` 分属 `.hearth/workspaces` 下两个兄弟目录时，共同根是 `.hearth/workspaces`，shell 理论上可写同级其他任务目录；这是为同时覆盖 worktree 与 out 做的折中。
- `open` 网络模式没有域级 allowlist，也不能限制 raw socket；需要强网络隔离时应使用外部容器或代理。
- PTY 会话不跨宿主重启恢复；重启时统一标记 `lost` 并清理孤儿进程树。

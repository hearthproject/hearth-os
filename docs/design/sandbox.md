# Native Harness 沙箱

本文说明 Hearth native executor 的执行边界。它描述的是**实际约束**，不是目标愿景；未实现的隔离能力必须在这里写清楚。

## 0. 当前实现状态（2026-11-20）

P0 已在 native 执行链路落地：

- `HEARTH_NATIVE_SANDBOX`：Windows 默认 `enforce`；可选 `off`（显式降级到完全权限）或 `danger-full-access`。非 Windows 默认 `off`，设为 `enforce` 会 fail-closed。
- `shell`、`run_tests`、`diagnostics` 三类工具必须拿到 `SandboxProvider` 才能 spawn；没有 provider 且没有显式 `unsafeNoSandbox` 时抛 `SANDBOX_UNAVAILABLE`。
- Windows 后端使用 `@deepseek-ai/dsh-sandbox-windows-acl` 的 runner；native executor 启动前做一次 probe，probe 失败则不进入模型循环。
- 每次沙箱选择/降级/不可用都会写 `<outDir>/.hearth/sandbox/audit.jsonl`，并产生 `sandbox.selected` / `sandbox.unavailable` 进度事件；shell 结果检测到拒绝或 runner 失败时追加 `sandbox.denied` / `sandbox.runner_failure`，工具结果带 `[SANDBOX_DENIED]` / `[SANDBOX_UNAVAILABLE]` 标记。
- `approvalMode=full` 与沙箱选择完全解耦；没有 `sandbox_permissions`、没有“拒绝后允许一次”。

## 1. 问题

`apps/server/src/sandbox.ts` 的 `SandboxService` 是授权决策层，不是执行沙箱。它会检查 cwd、读写路径、网络 host、进程名和凭据过期时间，但 native shell 没有经过这个后端：`packages/agent-runtime/src/tools.ts` 在通过 `assertSafeCommand` / `commandPolicyIssue` 后，直接调用 `startShellSession` / `runShellSession` spawn 子进程。

这带来四个实际风险：

- 模型可以写入任务工作区之外的任意可写路径；
- 模型可以删除任务工作区之外的文件，而现有文件历史主要覆盖编辑工具；
- shell 继承 `process.env`，模型 API key、GitHub token、Hearth 内部变量会进入子进程；
- Windows 上的 `Remove-Item -Recurse -Force`、`rd /s /q`、`del /f /s /q`、`python -c` 等命令不受 POSIX 正则覆盖。

## 2. 威胁模型

### 2.1 要防的

- 不可信仓库内容（README、issue、网页、依赖脚本）诱导模型执行越界写入或删除；
- 模型误操作破坏用户主目录、系统目录、其他项目；
- 子进程读取并外传 Hearth 进程环境中的凭据；
- native 作为执行器回退链最后一站时，成为约束最弱的一支。

### 2.2 不承诺的（P0）

- **读取隔离**：Windows ACL runner 只限制写入/删除，不限制读取。
- **网络隔离**：P0 不限制 raw socket；网络 allowlist 是 P1。
- **进程可见性**：P0 不隐藏其他进程。
- **完整回滚**：非 git 任务的 shell 删除不保证可恢复；git worktree 使用 checkpoint。
- **绝对安全**：字符串命令策略只降低误操作概率，不是安全边界。

## 3. 模式

| 模式 | 含义 | P0 执行 |
| --- | --- | --- |
| `read-only` | 禁止写入/删除 | Windows ACL；读取仍开放 |
| `workspace-write` | 只允许任务工作区 + 私有 temp 写入/删除 | Windows ACL；网络仍开放 |
| `danger-full-access` | 不包装 | 仅 operator 显式配置，模型不可请求 |

`danger-full-access` 不是“完全权限”的同义词。完全权限（`approvalMode=full`）只表示工具审批自动通过；沙箱模式必须独立计算。

## 4. 架构

```
native-executor
  -> resolveSandboxPolicy()
  -> AgentToolContext.sandbox
  -> shell-session.confine(exact argv)
  -> WindowsAclSandboxProvider
  -> node runner.js --workspace ... --temp ... --mode ... -- argv
```

Windows 后端复用 `@deepseek-ai/dsh-sandbox-windows-acl` 的 runner（MIT）：restricted token、capability SID、Low integrity、job object 由 runner 负责。Hearth 不复制 Win32 FFI 代码，也不把 DSH 的 Cordis 插件作为硬依赖。

`resolveSandboxPolicy` 的 `workspaceRoot` 以任务实际可写的共同根为准：worktree 与 `outDir` 分离时取二者最近公共祖先（且必须在 `HEARTH_ROOT` 内）；否则回退到项目根。`tempRoot` 固定放在 `LOCALAPPDATA\Temp\hearth-sandbox\<taskId>`（Windows），保证与 workspace 不相交。

child env 采用白名单：保留 `PATH`/`SystemRoot` 等启动变量，过滤 `*_API_KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`HEARTH_*`、`NODE_OPTIONS`、`PYTHONPATH`、`LD_PRELOAD`、`DYLD_INSERT_LIBRARIES`、`GIT_SSH_COMMAND`、`BASH_ENV` 等；`TMP`/`TEMP` 指向私有 temp，包管理器 cache 指向 workspace 内 `.hearth/sandbox/cache`。

## 5. 完全权限与沙箱

当前前端把 `approvalMode` 强制为 `full`，`authorizeTool` 在 full 下会自动批准。因此：

- 不新增 `sandbox_permissions` / `justification` 工具；
- 不把沙箱拒绝路由到审批；
- 越界写入返回 `SANDBOX_DENIED`，任务失败；
- 扩大范围只能通过任务创建前的项目/任务配置，或失败后重新发起任务。

若在 full 下保留“允许一次”，等于自动放行，不能形成安全边界。

## 6. 失败语义

| 错误 | 行为 |
| --- | --- |
| `SANDBOX_UNAVAILABLE` | 不 spawn；任务失败 |
| `SANDBOX_UNSUPPORTED_POLICY` | 不 spawn；提示缩小范围或使用 strict |
| runner failure（`windows-acl-run:`） | 归类沙箱故障，不和命令失败混淆 |
| `Access is denied` / `EPERM` | 归类沙箱拒绝，保留 stderr |

## 7. 测试

当前已覆盖：

- `sandbox.test.ts`：路径逃逸、工作区外 writableRoot 不暴露、danger、env 过滤、runner failure 分类；
- `native-sandbox.test.ts`：真实 Windows ACL runner probe；workspace 内 `cmd /c echo` 写入成功；workspace 外写入被拒绝且文件不存在；
- `tools.test.ts` / `harness.test.ts`：无 provider 时 shell 不 spawn；显式 `unsafeNoSandbox` 的既有 shell 行为；
- 全量 `npm test` 与 `npm run typecheck`。

后续仍需补：

- 工作区外 `Remove-Item -Recurse -Force` / `rd /s /q` / `python -c` 越界删除测试；
- `approvalMode=full` 下越界写入仍为 `SANDBOX_DENIED` 的端到端回归；
- 打包版 runner/koffi 可加载性。

## 8. 已知边界

- Windows ACL 是 `partial`：读取、网络、进程可见性不限制；硬链接可 alias；其他 AppContainer 工具 ACL 过的树可能不可读。
- workspace 根会留下 standing ACE（跨 session 复用缓存）；只应在 task worktree 上使用，非 git 项目需显式提示。
- 需要 caller-owned 目录；OneDrive/共享目录可能失败。
- 非 git 项目的 `shell` 删除没有文件历史覆盖；P0 不承诺完整回滚。
- worktree 与 task `outDir` 分属 `.hearth/workspaces` 下两个兄弟目录时，共同根是 `.hearth/workspaces`，shell 理论上可写同级其他任务目录；这是为同时覆盖 worktree 与 out 做的 P0 折中。
- 网络/读取的完整隔离必须走 P1 代理或 P2 容器/VM，不能在 P0 文档里冒充。

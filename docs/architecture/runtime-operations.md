# Runtime 持久操作账本（M1）

## 目的

工具调用不能只靠内存里的 `Promise` 记录。进程在写文件、发邮件或执行命令的中途崩溃时，下一进程必须知道“这个操作是否已经发生”，否则会重复副作用。

M1 引入 T1/T2 操作合同：

| 阶段 | 持久事实 | 含义 |
| --- | --- | --- |
| `prepared` | 意图、参数摘要、权限摘要、`beforeDigest` | 还没有执行任何副作用 |
| `dispatched` | T1 已提交 | 工具可能已经开始，副作用可能发生 |
| `settled` | T2 已提交 | 结果已知，可以安全继续 |
| `unknown` | 结算失败、超时、中止、外部写无回执 | 结果未知，禁止自动重放 |

`operationId = runId + ":" + toolCallId`。同一 `operationId` 的 `prepare` 幂等；`dispatch` 第二次会被拒绝；`settle` 对同一结果幂等，不同结果会被拒绝。

## 存储

- 服务端：SQLite `run_operations`，M1 schema 37；M2 将运行时 journal 并入 `events` 后为 38。
- standalone / 评测：`JsonlOperationLedger`，每次状态转换追加一行并 `fsync`；重启时回放，损坏的尾行忽略。
- runtime 只依赖 `OperationLedger` 接口，不直接依赖 `node:sqlite`；server 通过 `SqliteOperationLedger` 注入。

关键字段：

- `args_hash`：防止同一 `operationId` 换参数重放。
- `before_digest`：本地写执行前的目标文件摘要，供恢复时判断写入是否已经落地。
- `effect`：`read` / `local_write` / `external_write` / `destructive` / `unknown`。
- `effect_ref` / `receipt_json`：外部写的回执和外部效果引用。

## Runtime 接入点

1. 工具审批通过后，先 `prepare`，再 `dispatch`，然后才启动工具。
2. 工具通过 `ToolExecutionHandle` 执行：超时或父级取消时 `AbortController.abort()`，等待 5 秒协作退出；仍未退出则返回 `TOOL_TIMEOUT` / `TOOL_ABORTED` 和 `orphaned` 标记。
3. 工具返回后 `settle`。正常返回为 `settled`；抛错、超时、中止为 `unknown`。
4. 已经在 `dispatched` / `unknown` / `settled` 的同一操作，下一进程不会再次执行，而是把 `operationUnsettled` 结果交给模型并提示先核对状态。
5. `external_write` 成功但没有 `metadata.receipt` 时，操作记为 `unknown`，run 以失败停车，等待人工核对；不会把“没有回执”当成成功继续。

## Windows 进程树

Windows 下 `taskkill /T` 在“父进程刚创建子进程”的窗口里可能返回“operation not supported”，留下孤儿。`killShellSession` 先枚举 `Win32_Process` 的父子关系，从叶子向根 `Stop-Process`，再执行 `taskkill /T /F` 兜底。

## 单一持久事实源（M2）

服务端不再写 `.hearth/journals/<run>/events.jsonl`。`SqliteRuntimeJournal` 把 runtime 的 `run.start`、`message`、`tool.dispatched`、`tool.settled`、`checkpoint`、`run.end` 等事实写入 SQLite `events`；JSONL journal 只保留给 standalone / 评测模式。

- 事件类型：`runtime.run.started`、`runtime.message`、`runtime.tool.dispatched`、`runtime.tool.settled`、`runtime.checkpoint`、`runtime.run.ended`，其余用 `runtime.event` 保留原始类型。
- checkpoint 文件是物化视图。写入文件前先追加 `runtime.checkpoint.snapshot` 事件，事件 payload 带完整 `AgentCheckpoint`；`run_checkpoints.event_seq` 指向该事件。
- 恢复时先校验 checkpoint 文件的 sha256；文件缺失或损坏时回退到 `runtime.checkpoint.snapshot` 事件，再从 `event_seq` 之后回放 `runtime.message` / `runtime.tool.settled`，补齐检查点后的消息。
- 旧版本没有 `event_seq` 的 checkpoint 仍可按原有 JSONL journal 路径恢复，迁移期不丢历史任务。

## 宿主租约与阶段化恢复（M2）

`HostKernel` 持有数据目录的唯一宿主租约，并在调度器恢复完成前保持 `/api/ready` 为 503。启动阶段按 `lease → store → operations → runs → tasks → background → ready` 推进；`recovering` 和 `draining` 期间，创建任务和继续对话的写路由返回 `HOST_NOT_READY`。

- 租约文件为 `hearth.host.lock`，同时记录 PID 和进程创建时间。PID 被系统复用时，创建时间不匹配会被判为陈旧锁；进程正常退出会删除锁文件。原生 named mutex 辅助程序将在 Windows 沙箱里程碑接入，当前使用等价的文件租约。
- `HostKernel.stop()` 先把状态切到 `draining`，由调度器停止接收新任务、取消在跑 run、释放任务租约，最后释放宿主租约。
- `/api/health` 返回 `host` 快照：`phase`、`step`、`readyAt`、`error` 和租约信息，桌面 supervisor 与诊断页可直接观察卡在哪个阶段。

## Windows 原生沙箱（M3）

Windows 单机执行器不再依赖 Node ACL runner。`apps/native/hearth-native.cs` 由系统自带 `csc.exe` 编译成 `hearth-native.exe`，提供三个子命令：

- `lease --name`：`Global\Hearth.Host.<name>` named mutex，stdin 收到 `release` 或 EOF 后退出。
- `process-info --pid`：返回 PID 与进程创建时间，供宿主租约判断 PID 复用。
- `sandbox`：创建或复用 AppContainer package SID；只给 workspace、私有 temp、显式 `--read` / `--write` 根授权；用 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 在 AppContainer 中启动子进程；子进程加入 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object；父进程 watchdog 每 500ms 检查 `--parent-pid`，父死即 `TerminateJobObject`。

`WindowsNativeSandboxProvider` 只构造 argv 契约，不复制 Win32 代码。`workspace-write` 给 workspace `(OI)(CI)M`，`read-only` 给 `(OI)(CI)RX`；temp 始终可写；额外写根通过 `--write`，读根通过 `--read`。网络默认拒绝：AppContainer 不申请 `internetClient` capability，因此子进程没有网络身份。`net-allowlist` 还没有无管理员权限的可靠实现：任务声明 `networkHosts` 时 provider 直接 fail-closed，不会悄悄给一个“没有网络”的沙箱。helper 缺失、AppContainer 创建失败或 ACL 授权失败同样 fail-closed，不会静默退回完全权限。

沙箱边界是“文件系统 + 进程 + 网络”三层，而不是只限制 shell 命令字符串。junction/symlink 指向工作区外时，目标没有 AppContainer ACE，读写仍会被拒绝。

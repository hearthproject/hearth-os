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

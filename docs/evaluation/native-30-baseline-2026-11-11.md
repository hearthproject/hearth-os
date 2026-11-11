# Native 执行器 30 任务基线评测（2026-11-11）

## 结论

本轮使用 `hearth-eval` 的 30 个离线 case（8 个任务族均匀采样），仅运行 `native` 执行器，重复 1 次，结果为 **0/30 通过**。30 次运行全部在评测侧被判定为 `blocked`，平均得分 0，未登记任何产物。

这不是有效的执行质量基线：首批 trace 已确认评测桥接创建的任务带有 `permissions.tools: []`，导致原生运行时过滤掉全部工具。模型无法读取输入、写入产物或调用 `finish_task`，最终在评测超时前持续重试，分别落入轮次预算耗尽、纯文本收尾失败或等待输入。因此本轮的首要结论是“原生执行器在评测桥接中不可用”，后续修复必须先恢复工具白名单，再重新测量真实能力。

## 实验信息

| 项目 | 值 |
|---|---|
| 实验 ID | `EXP-20261111051349-b71b80` |
| 实验名称 | `baseline-native-30-20261111` |
| Hearth 提交 | `4617419` |
| 评测仓库 | `hearthproject/hearth-eval` |
| 执行器 | `native` |
| 模型 | `deepseek-v4.1-flash-1017` |
| 运行模式 | `offline` |
| 重复次数 | 1 |
| 自动评分 | 开启 |
| 自动重试 | 开启 |
| 最大并发 | 4 |
| 开始时间 | 2026-11-11 13:13:49（Asia/Shanghai） |
| 结束时间 | 2026-11-11 14:30:11（Asia/Shanghai） |
| 实验状态 | `needs_review` |

## 样本分布

| 任务族 | 任务数 | Case |
|---|---:|---|
| email | 4 | E01, E03, E07, E08 |
| calendar | 4 | CAL01, CAL03, CAL05, CAL07 |
| documents | 4 | T01, T02, DOC01, DOC03 |
| research | 4 | RES01, RES02, RES03, RES06 |
| code | 4 | CODE01, CODE02, CODE03, CODE04 |
| web | 4 | WEB01, WEB02, WEB03, WEB07 |
| desktop | 3 | DESK01, DESK03, DESK05 |
| cross-app | 3 | T10, T11, T12 |

难度分布：`normal` 12、`edge` 12、`failure` 3、`adversarial` 3。

## 汇总结果

| 指标 | 结果 |
|---|---:|
| 运行数 | 30 |
| 通过 | 0 |
| 失败 | 0 |
| 阻塞 | 30 |
| 通过率 | 0% |
| 平均得分 | 0 |
| 平均耗时 | 563,503 ms（约 9.39 分钟） |
| 产物数 | 0 |
| 输入 Token | 35,246,437 |
| 输出 Token | 649,096 |
| 自动重试 | 0 |
| 审批 | 1 |

所有任务族、所有难度均为 0 通过。评分器没有可读取的产物，因此确定性项全部失败，模型评委也只能依据“缺少产物”给出失败结论。

## 逐任务结果

| Case | 任务族 | 难度 | 评测状态 | 得分 | 原生任务末态 | 失败证据 |
|---|---|---|---:|---|---|---|
| CAL01 | calendar | normal | blocked | 0 | waiting_budget | 轮次 200/200 |
| CAL03 | calendar | edge | blocked | 0 | waiting_budget | 轮次 200/200 |
| CAL05 | calendar | edge | blocked | 0 | recoverable | 连续纯文本收尾，未调用 `finish_task` |
| CAL07 | calendar | adversarial | blocked | 0 | waiting_budget | 轮次 200/200 |
| CODE01 | code | normal | blocked | 0 | waiting_budget | 轮次 200/200 |
| CODE02 | code | edge | blocked | 0 | waiting_approval | 评测超时前未完成审批链 |
| CODE03 | code | failure | blocked | 0 | recoverable | 连续纯文本收尾，未调用 `finish_task` |
| CODE04 | code | normal | blocked | 0 | waiting_budget | 轮次 200/200 |
| DESK01 | desktop | normal | blocked | 0 | recoverable | 模型访问被拒绝 |
| DESK03 | desktop | edge | blocked | 0 | waiting_input | 模型访问被拒绝 |
| DESK05 | desktop | failure | blocked | 0 | waiting_input | 模型访问被拒绝 |
| DOC01 | documents | edge | blocked | 0 | recoverable | 连续纯文本收尾，未调用 `finish_task` |
| DOC03 | documents | normal | blocked | 0 | recoverable | 连续纯文本收尾，未调用 `finish_task` |
| E01 | email | normal | blocked | 0 | recoverable | 连续纯文本收尾，未调用 `finish_task` |
| E03 | email | edge | blocked | 0 | waiting_budget | 轮次 200/200 |
| E07 | email | adversarial | blocked | 0 | waiting_budget | 轮次 200/200 |
| E08 | email | failure | blocked | 0 | waiting_budget | 轮次 200/200 |
| RES01 | research | normal | blocked | 0 | waiting_budget | 轮次 200/200 |
| RES02 | research | edge | blocked | 0 | waiting_budget | 轮次 200/200 |
| RES03 | research | normal | blocked | 0 | waiting_budget | 轮次 200/200 |
| RES06 | research | edge | blocked | 0 | waiting_budget | 轮次 200/200 |
| T01 | documents | normal | blocked | 0 | recoverable | 连续纯文本收尾，未调用 `finish_task` |
| T02 | documents | edge | blocked | 0 | waiting_budget | 轮次 200/200 |
| T10 | cross-app | normal | blocked | 0 | recoverable | 模型访问被拒绝 |
| T11 | cross-app | edge | blocked | 0 | waiting_input | 模型访问被拒绝 |
| T12 | cross-app | edge | blocked | 0 | waiting_input | 模型访问被拒绝 |
| WEB01 | web | normal | blocked | 0 | waiting_budget | 轮次 200/200 |
| WEB02 | web | normal | blocked | 0 | waiting_budget | 轮次 200/200 |
| WEB03 | web | edge | blocked | 0 | recoverable | 模型访问被拒绝 |
| WEB07 | web | adversarial | blocked | 0 | recoverable | 模型访问被拒绝 |

原生任务末态分布：`waiting_budget` 15、`recoverable` 10、`waiting_input` 4、`waiting_approval` 1。评测侧的 30 次 `TASK_TIMEOUT` 都是这些未完成状态在 case 超时后的统一表现。

## 根因分析

### P0：评测任务没有工具白名单

`POST /api/eval/tasks` 创建任务时写入：

```json
"permissions": {
  "readRoots": ["D:\\App\\hearth-eval\\eval"],
  "writeRoots": [".hearth/eval-artifacts/..."],
  "networkHosts": [],
  "tools": []
}
```

`runAgent` 以 `permissions.tools` 作为唯一工具白名单^{①}，因此 `read_file`、`write_file`、`finish_task` 等工具全部被过滤。任务提示词仍要求模型读取输入并调用 `finish_task`，模型只能反复尝试 `start_background_tool` 代理调用，随后收到“任务未授权工具”错误。

E01 的检查点中可直接看到该循环：模型先读取输入失败，随后声明 `permissions.tools: []`，仍在 30 多轮中反复调用 `finish_task` 和 `read_file`，每次都被权限层拒绝。

^{①} `packages/agent-runtime/src/runtime.ts`：`const allowed = new Set(options.permissions.tools); const tools = options.tools.filter(...)`

### P1：授权失败没有形成可恢复反馈

`start_background_tool` 接受任意 `toolName`，但只返回“任务未授权工具”，没有返回当前可用工具或建议改用直接工具。模型在 200 轮预算内反复尝试不同参数，造成单任务数百万到千万级输入 Token 的无效消耗。

### 环境因素：模型访问在后半程被拒绝

DESK01、DESK03、DESK05、T10、T11、T12、WEB03、WEB07 的底层失败为 `Access to model denied`。这与工具白名单缺陷独立，说明该时段模型服务不可用或配额受限。该因素不改变 0/30 的结论，但会影响下一轮复测的可执行性。

## 修复顺序

1. **恢复评测任务的原生工具白名单**：在评测桥接创建任务时使用原生执行器的默认工具集，同时保留输入只读根、输出写入根和离线网络限制。
2. **缩短无效授权循环**：对未授权的工具名返回可用工具清单，并让重复失败的同一类调用更早终止。
3. **复测 30 个同分布 case**：修复后必须用同一批 case、同一执行器、同一离线模式和相同并发重新测量，不能把本轮 0/30 当作执行能力结论。

## 证据位置

- 评测数据库：`D:\App\hearth-eval\.hearth\eval\eval.sqlite`
- 实验记录：`EXP-20261111051349-b71b80`
- 评测产物根：`D:\App\hearth-eval\.hearth\eval-artifacts\EXP-20261111051349-b71b80`（本轮无文件）
- Hearth 任务工作区：`D:\App\hearth-os\.hearth\workspaces\tasks\<taskId>`
- 原始结果快照：`D:\App\hearth-os\work\native-baseline-30-results.json`

## 边界说明

- 本轮没有执行 `live-only` case，也没有访问网络。
- 本轮没有修改评测 case、golden 或评分规则。
- 本轮结果证明的是评测桥接与执行器的集成缺陷，不足以评价原生执行器的真实任务完成能力。

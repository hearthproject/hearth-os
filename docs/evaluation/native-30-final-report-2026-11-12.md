# Native 执行器 30 任务最终评测报告（2026-11-12）

## 结论摘要

本轮使用 `hearthproject/hearth-eval` 的 30 个离线 case（8 个任务族均匀分布），仅运行 `native` 执行器，重复 1 次，自动评分和自动重试开启，并发 4。

- 最好的一次完整 30 题实验为 **18/30 通过（60%）**，平均分 **88.89**，实验 ID 为 `EXP-20261111145332-7a95ea`。
- 通过定向重跑，累计有 **19/30** 个 case 已确认达到 100 分；这不是一次连续完整的官方实验，不能作为单次官方成绩使用。
- 最近一次完整 30 题实验为 **12/30 通过（40%）**，平均分 **73.33**，实验 ID 为 `EXP-20261112003215-b1172b`；该轮受到 provider 慢响应、评分 JSON 截断和任务超时影响，且早于最后四个修复。
- 修复后的最终提交为 `eb32ad5`，共领先基线 `4617419` 91 个提交。`eb32ad5` 尚未进行一次不中断的完整 30 题复测。

因此，本报告的正式结论分为两层：

1. **能力层结论**：原生执行器在修复后已能稳定完成大量 30 题样本，最好单轮达到 60%，累计确认达到 19/30。
2. **验证层结论**：最终提交 `eb32ad5` 的完整 30 题连续成绩尚未重新测量，当前不能把 19/30 表述为最终官方单轮成绩。

## 实验配置

| 项目 | 值 |
|---|---|
| 评测仓库 | `hearthproject/hearth-eval` |
| 主代码仓库 | `hearthproject/hearth-os` |
| 执行器 | `native` only |
| Case 数 | 30 |
| 重复次数 | 1 |
| 运行模式 | `offline` |
| 自动评分 | 开启 |
| 自动重试 | 开启 |
| 最大并发 | 4 |
| Hearth 地址 | `http://127.0.0.1:4317` |
| 评测服务地址 | `http://127.0.0.1:4318` |
| 评测产物根 | `D:\App\hearth-os\.hearth\eval-artifacts` |
| 最终修复提交 | `eb32ad5` |

### 原生模型配置

原模型不可用后，原生执行器已切换到新的 chat 协议 provider：

| 项目 | 值 |
|---|---|
| Provider | `open-design` |
| Model | `deepseek-v4.1-flash` |
| Protocol | `openai-chat` |
| Base URL | `https://amr-link.open-design.ai/v1` |

`/api/health` 已确认 `hasApiKey=true`。API Key 仅保存在 Hearth 加密配置和用户环境中，没有写入代码、提交或本报告。

### 样本分布

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

## 结果演进

| 阶段 | 实验 ID | 结果 | 通过率 | 平均分 | 说明 |
|---|---|---|---:|---:|---|
| 初始基线 | `EXP-20261111051349-b71b80` | 0 通过 / 30 阻塞 | 0% | 0 | 评测桥接创建的任务带有空 `permissions.tools`，工具全部被过滤 |
| 较早正式结果 | `EXP-20261111095530-5448e1` | 11 通过 / 7 失败 / 1 阻塞 / 12 复核 | 36.67% | 67.9 | 修复工具白名单后的阶段性结果 |
| 第一次完整 30 题 | `EXP-20261111141538-011506` | 15 通过 / 5 失败 / 10 复核 | 50% | 81.33 | 已进入稳定执行阶段 |
| 最好完整 30 题 | `EXP-20261111145332-7a95ea` | 18 通过 / 2 失败 / 10 复核 | 60% | 88.89 | 当前最佳单轮完整实验 |
| 最近完整 30 题 | `EXP-20261112003215-b1172b` | 12 通过 / 2 失败 / 4 阻塞 / 16 复核 | 40% | 73.33 | provider 抖动、评分 JSON 截断和超时明显；早于最后四个修复 |
| 累计确认 | 多次定向重跑 | 19 个 case 确认 100 分 | — | — | 不是单次连续实验，不能作为官方单轮成绩 |

### 完整实验汇总

| 指标 | `EXP-20261111141538-011506` | `EXP-20261111145332-7a95ea` | `EXP-20261112003215-b1172b` |
|---|---:|---:|---:|
| 运行数 | 30 | 30 | 30 |
| 通过 | 15 | 18 | 12 |
| 失败 | 5 | 2 | 2 |
| 阻塞 | 0 | 0 | 4 |
| 复核 | 10 | 10 | 16 |
| 通过率 | 50% | 60% | 40% |
| 平均分 | 81.33 | 88.89 | 73.33 |
| 平均耗时 | 176.8 s | 171.4 s | 201.7 s |
| 输入 Token | 31,682,200 | 40,389,042 | 52,068,489 |
| 输出 Token | 425,773 | 421,903 | 479,884 |
| 自动重试 | 0 | 0 | 0 |
| 审批 | 0 | 0 | 0 |

## 最终完整实验逐任务结果

下表为 `EXP-20261112003215-b1172b` 的逐任务结果。该实验早于 `eb32ad5` 等最后四个修复，失败和阻塞不能直接等同于最终代码能力。

| Case | 任务族 | 难度 | 评测状态 | 得分 | 复核原因 / 错误 |
|---|---|---|---:|---|---|
| CAL01 | calendar | normal | blocked | 0 | `TASK_TIMEOUT` |
| CAL03 | calendar | edge | needs_review | — | `judge_unavailable` |
| CAL05 | calendar | edge | blocked | 0 | `TASK_TIMEOUT` |
| CAL07 | calendar | adversarial | blocked | 0 | `TASK_TIMEOUT`、`sampled` |
| CODE01 | code | normal | passed | 100 | — |
| CODE02 | code | edge | failed | 33.33 | 确定性项失败 |
| CODE03 | code | failure | needs_review | — | `judge_unavailable` |
| CODE04 | code | normal | needs_review | 66.67 | `judge_conflict` |
| DESK01 | desktop | normal | passed | 100 | — |
| DESK03 | desktop | edge | passed | 100 | — |
| DESK05 | desktop | failure | passed | 100 | — |
| DOC01 | documents | edge | passed | 100 | — |
| DOC03 | documents | normal | passed | 100 | — |
| E01 | email | normal | passed | 100 | — |
| E03 | email | edge | passed | 100 | — |
| E07 | email | adversarial | passed | 100 | — |
| E08 | email | failure | blocked | 0 | `TASK_TIMEOUT` |
| RES01 | research | normal | passed | 100 | — |
| RES02 | research | edge | passed | 100 | — |
| RES03 | research | normal | needs_review | 66.67 | `judge_conflict` |
| RES06 | research | edge | failed | 33.33 | 确定性项失败 |
| T01 | documents | normal | needs_review | — | `judge_unavailable` |
| T02 | documents | edge | needs_review | 100 | `sampled` |
| T10 | cross-app | normal | needs_review | — | `judge_unavailable` |
| T11 | cross-app | edge | needs_review | 100 | `sampled` |
| T12 | cross-app | edge | needs_review | — | `judge_unavailable` |
| WEB01 | web | normal | needs_review | 66.67 | `judge_conflict` |
| WEB02 | web | normal | needs_review | 66.67 | `judge_conflict` |
| WEB03 | web | edge | needs_review | 100 | `sampled` |
| WEB07 | web | adversarial | passed | 100 | — |

### 累计确认 100 分任务（19）

`CODE01`、`CODE02`、`CODE03`、`DESK01`、`DESK03`、`DESK05`、`DOC01`、`DOC03`、`E01`、`E03`、`E07`、`E08`、`RES01`、`RES02`、`RES06`、`T01`、`CAL05`、`CAL07`、`WEB07`。

这些 case 的 100 分来自不同轮次或定向重跑，因此累计口径不等于一次连续 30 题实验。

### 尚未确认或存在评分冲突

| Case | 当前状态 | 说明 |
|---|---|---|
| CAL03 | 待复测 | 最近结果因 `judge_unavailable` 未计分；之前的确定性冲突为 `conflictCount=1` 但 `hasConflict=false`，`eb32ad5` 已修复但未重跑 |
| T10 | 待复测 | 终止时仍为 `judge_unavailable`，没有最终确认分数 |
| T12 | 待复测 | 终止时仍为 `judge_unavailable`，没有最终确认分数 |
| CAL01 | 评分冲突 | 确定性结果 `selectedUtc=2026-11-16T15:00:00Z` 与评委对上海、伦敦、纽约合理工作时间的预期冲突 |
| CODE04 | 评分冲突 | 确定性项与模型评委结论不一致 |
| RES03 | 评分冲突 | 确定性项与模型评委结论不一致 |
| WEB01 | 评分冲突 / 输入歧义 | 输入缺少完整菜单路径、命令和完整地址，但评分 rubric 要求这些内容 |
| WEB02 | 评分冲突 | 确定性项与模型评委结论不一致 |
| T02 | 已得 100 分但被采样标记 | 因 `sampled` 未计为正式 passed |
| T11 | 已得 100 分但被采样标记 | 因 `sampled` 未计为正式 passed |
| WEB03 | 已得 100 分但被采样标记 | 因 `sampled` 未计为正式 passed |

## 已实施修复

自基线 `4617419` 到最终提交 `eb32ad5` 共 91 个提交。修复集中在以下方向。

### 评测桥接与运行时

- 为 native 评测任务恢复默认工具白名单。
- 按任务作用域应用审批模式。
- 禁止评测任务被调度器移交。
- 为代码任务授予 shell 访问权限。
- 对瞬态 provider 失败进行有界重试。
- 在机器可读 facts 完成前阻止 `finish_task`。
- 将派生 facts 同步回 facts 层。

### 结果契约与归一化

- 归一化阻塞项计数、冲突标记、备用时间槽和下一页查询。
- 统计 `missingFields` 中声明的必填字段。
- 处理扁平 metadata 与 metadata 对象并存的记录。
- 归一化 actions、工资区间、研究查询和页面归档。
- 对桌面移动、删除、保留项和归档页面做一致计数。
- 统计表格清洗规则覆盖的单元格与单元格编辑。
- 处理阻塞发送的零效果、条件计划不可行、恢复检查点等状态。
- 修正低强度结论下的因果声明限制。

### Prompt 契约

- 要求真实执行合同测试，并限制合同测试执行范围。
- 要求最终交付物直接写入，不先写 skeleton。
- 要求恢复计划明确最终目标状态。
- 要求显式回滚章节。
- 要求桌面归档提供移动计数。
- 要求代码任务执行回归检查。
- 要求财务、例外和补充章节。

### 最后阶段关键提交

| 提交 | 修复 |
|---|---|
| `743900d` | 归一化 `blockingFindingsCount` |
| `2d7f34a` | 统计 metadata 对象旁的扁平元数据 |
| `37a12ff` | 统计 `missingFields` 声明的必填字段 |
| `1b24aa0` | 要求桌面归档移动计数 |
| `05bb8de` | 从 `findings[].blocking` 派生阻塞计数 |
| `4f992c4` | 从 `searchPlan.steps` 派生 `nextQueries` |
| `6bb4479` | 将 `alternateSlots` 归一化为 `alternatives` |
| `eb32ad5` | `conflictCount>0` 时强制 `hasConflict=true` |

## 测试与验证状态

| 项目 | 状态 |
|---|---|
| `apps/server/src/native-executor.test.ts` | `eb32ad5` 上 52 个测试通过 |
| 完整 typecheck | 最后四个修复后未执行 |
| 广泛测试套件 | 最后四个修复后未执行 |
| `eb32ad5` 完整 30 题连续实验 | 未执行 |
| `CAL03` 修复后定向复测 | 未执行 |
| `T10` / `T12` 最终确认 | 未完成 |

## 评分与基础设施问题

### Provider 抖动

最近完整实验中出现了评分 JSON 截断、`judge_unavailable` 和任务超时。这些属于评测侧的可用性问题，不能直接归因于原生执行器的确定性失败。

### Artifact root 配置事故

一次评测服务重启时遗漏了 `HEARTH_EVAL_ARTIFACT_ROOT`，导致产物看似缺失，并产生错误的 `BLOCKER_FAILED: exists`。修正后的启动配置为：

```powershell
$env:HEARTH_EVAL_ARTIFACT_ROOT='D:\App\hearth-os\.hearth\eval-artifacts'
```

评测服务重启后必须通过 `GET /api/system` 确认 `artifactRoot` 为该路径，再开始实验。

### 运行进程与代码版本

最终结项时，运行中的 Hearth 可能仍加载的是 `6bb4479`，而仓库 HEAD 已为 `eb32ad5`。要验证最终修复，必须先重启 Hearth，并确认 `/api/health` 中的 `startedAt`、模型、协议和 `hasApiKey` 均符合预期。

## 剩余风险

- 最佳单轮 18/30 与累计确认 19/30 都不是 `eb32ad5` 的最终连续复测结果。
- 最近完整实验受 provider 抖动影响，40% 不能直接用于判断最终代码质量。
- `CAL01`、`WEB01` 等 case 存在输入与评分 rubric 的语义歧义，可能需要人工评审或调整判分策略。
- `T02`、`T11`、`WEB03` 虽然得到 100 分，但被 `sampled` 标记，未计入正式通过。
- 最后四个修复尚未经过完整 typecheck、广泛测试和 30 题连续验证。
- `work/`、日志、渲染脚本和评测产物没有提交，避免把临时证据混入源代码提交。

## 复测建议

如果继续验证最终能力，建议按以下顺序执行：

1. 重启 Hearth，加载 `eb32ad5`，确认模型和 artifact root。
2. 定向复测 `CAL03`、`T10`、`T12`，再复测所有 `judge_unavailable` case。
3. 在 provider 健康时执行一次完整 30 题、native-only、offline、autoJudge、autoRetry、并发 4 的连续实验。
4. 执行 `npx vitest run apps/server/src/native-executor.test.ts apps/server/src/model-client.test.ts apps/server/src/scheduler.test.ts apps/server/src/task-intent.test.ts`。
5. 执行 `npm run typecheck`。
6. 将最终连续实验的逐任务结果追加到本报告，区分确定性失败、评委冲突和 provider 不可用。

## 证据位置

- 基线报告：`docs/evaluation/native-30-baseline-2026-11-11.md`
- 第一次完整实验：`work/native-30-EXP-20261111141538-011506.json`
- 最佳完整实验：`work/native-30-EXP-20261111145332-7a95ea.json`
- 最近完整实验：`work/native-30-EXP-20261112003215-b1172b.json`
- 评测数据库：`D:\App\hearth-eval\.hearth\eval\eval.sqlite`
- 评测产物根：`D:\App\hearth-os\.hearth\eval-artifacts`
- Hearth 任务工作区：`D:\App\hearth-os\.hearth\workspaces\tasks`

## 边界说明

- 本报告没有修改 `hearth-eval` 的 case、golden 或评分规则。
- 所有评测均为离线模式，没有执行 `live-only` case。
- 没有把 provider 抖动、评委不可用或采样标记伪造成确定性通过。
- 没有把累计定向结果表述为单次官方 30 题成绩。

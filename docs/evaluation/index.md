---
title: '评测与结果'
description: 'Hearth 独立评测栈的入口、native 30 题结果、运行方法和不能被分数掩盖的边界。'
outline: [2, 3]
---

# 评测与结果

<p class="lead">评测回答的是“同一批真实任务，在不同执行器、重复次数和运行模式下，通过率、质量、耗时、Token 和审批次数发生了什么变化”，而不是用一个演示证明能力。</p>

## 评测栈在哪里

评测代码已经拆分到独立仓库 [hearthproject/hearth-eval](https://github.com/hearthproject/hearth-eval)：

- `apps/eval-server`：实验编排、SQLite、判分、复核、对比与 SPA 托管；
- `apps/eval-web`：总览、任务目录、实验、运行详情、复核、对比、活动流和系统状态；
- `packages/eval-core`：case 契约、目录加载、grader、评分与场景统计；
- `eval/cases`：60 个 case、输入与 golden；
- `scenario-runner`：30 个读取同级 Hearth 源码的白盒集成场景。

主仓库只保留最小桥接：`POST /api/eval/tasks`、`POST /api/eval/judge`、`HEARTH_EVAL_INPUT_ROOT` 和 `.hearth/eval-artifacts/`。评测服务不复制 Hearth 的 Agent 执行链，也不跳过审批、沙箱和权限模型。

## Native 30 题结果

2026-11-11 至 11-12，使用 30 个离线 case（8 个任务族均匀分布）、仅 `native` 执行器、重复 1 次、自动评分与自动重试开启、并发 4：

| 指标 | 结果 |
|---|---:|
| 最好完整单轮 | **18/30 通过（60%）**，平均分 88.89 |
| 累计定向确认 | **19/30** 个 case 曾达到 100 分 |
| 最近完整单轮 | 12/30 通过（40%），平均分 73.33 |
| 最终修复提交 | `eb32ad5`，尚未做连续 30 题复测 |

最好单轮实验为 `EXP-20261111145332-7a95ea`，最近完整实验为 `EXP-20261112003215-b1172b`。累计 19/30 来自不同轮次和定向重跑，不是一次连续实验，不能当作官方单轮成绩。

最近完整实验受到 provider 慢响应、评分 JSON 截断和任务超时影响，而且早于最后四个归一化修复，40% 不能直接等同于最终代码能力。CAL01、WEB01 等 case 还存在输入与评分 rubric 的语义歧义；T02、T11、WEB03 虽然得到 100 分，但因 `sampled` 标记未计为正式通过。

## 报告

- [Native 30 任务最终评测报告（2026-11-12）](/evaluation/native-30-final-report-2026-11-12) — 实验配置、完整实验汇总、逐任务结果、已实施修复、剩余风险与复测建议。
- [Native 30 任务基线评测（2026-11-11）](/evaluation/native-30-baseline-2026-11-11) — 工具白名单缺失导致 0/30 的失效基线，以及桥接问题的定位过程。

## 如何复现

主服务需要允许评测服务读取 case 输入：

```powershell
# hearth-os\.env
HEARTH_EVAL_INPUT_ROOT=D:\App\hearth-eval\eval
```

评测服务必须显式设置产物根，否则会因找不到已登记产物而错误判定 `BLOCKER_FAILED: exists`：

```powershell
$env:HEARTH_EVAL_ARTIFACT_ROOT='D:\App\hearth-os\.hearth\eval-artifacts'
```

启动后在评测控制台 `http://127.0.0.1:5174` 选择 30 个离线 case、`native` 执行器、重复 1 次、离线模式、自动评分和自动重试，再启动实验。重启服务后先通过 `GET /api/system` 确认 `artifactRoot`，再开始实验。

## 分数不能替代什么

- 自动测试和场景通过只能证明控制面、评分逻辑和故障边界，不证明真实通过率。
- 离线 case 不覆盖真实邮件账户、真实日历、真实桌面设备和 `live-only` 任务。
- 模型评委不可用、评委冲突和抽样复核会进入 `needs_review`，不能静默算作通过。
- 最终提交 `eb32ad5` 还没有不中断的完整 30 题连续成绩；任何单轮数字都必须同时说明实验 ID、提交和运行条件。

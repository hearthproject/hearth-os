---
title: '评测 Agent（独立仓库）'
description: 'Hearth 评测 Agent 的独立仓库入口、主服务桥接约定、运行方式与验证命令。'
outline: deep
---

# 评测 Agent（独立仓库）

<p class="lead">评测 Agent 已从 Hearth 主仓库迁出，现在作为独立项目维护。任务集、实验编排、全周期前端、评分、人工复核、对比和场景运行器都位于 <a href="https://github.com/hearthproject/hearth-eval">hearthproject/hearth-eval</a>；主仓库只保留受控任务与裁判桥接。</p>

## 入口

- **代码仓库：** <https://github.com/hearthproject/hearth-eval>
- **评测文档站：** <https://hearthproject.github.io/hearth-eval/>
- **本地控制台：** 启动评测服务后打开 `http://127.0.0.1:5174`
- **评测服务 API：** `http://127.0.0.1:4318`

## 已迁出的内容

- `apps/eval-server`：实验编排、SQLite、评分、复核、对比和 SPA 托管；
- `apps/eval-web`：总览、任务目录、实验、运行详情、复核队列、对比、活动流和系统状态等 11 个页面；
- `packages/eval-core`：case 契约、目录加载、grader、评分和场景统计；
- `eval/`：60 个 case、输入、golden、历史运行证据和第一阶段验收材料；
- `apps/server/src/scenarios` 对应的白盒场景运行器；
- 评测 Agent 的 README、文档站和部署配置。

## 主仓库保留的桥接

主仓库只保留让独立评测服务访问 Hearth 的最小接口：

| 接口或配置 | 用途 |
|---|---|
| `POST /api/eval/tasks` | 按稳定 `externalRef` 创建或复用受控评测任务 |
| `POST /api/eval/judge` | 对已登记的任务产物运行模型 rubric 评分 |
| `HEARTH_EVAL_INPUT_ROOT` | 白名单评测输入根，评测仓库可指向自己的 `eval/` 目录 |
| `.hearth/eval-artifacts/` | 独立评测运行通过桥接写入的受管产物根 |

任务创建、执行器、审批、记忆、调度和产品产物仍由主仓库负责；评测服务不复制一条旁路的 Agent 执行链。

## 评测服务内部适配层

评测编排不再直接绑死在 Hearth 的 HTTP 客户端上。`apps/eval-server` 定义两个窄接口，把“运行 Agent”和“评分产物”从实验编排中拆开：

| 接口 | 职责 | 默认实现 |
|---|---|---|
| `AgentAdapter` | `createTask`、`getTask`、`getArtifacts`、`cancelTask`、`health`；把不同 Agent 提供方的任务状态翻译成 runner 消费的视图 | `HearthClient` |
| `JudgeAdapter` | 用 runner 已取得的产物执行 rubric 评分，不要求裁判端重新读取任务 | `HearthJudgeAdapter`，转调 `POST /api/eval/judge` |

runner 只依赖 `AgentAdapter.getArtifacts` 返回的 `ArtifactMap`，以相对输出路径为键；Hearth 默认实现按 `HEARTH_EVAL_ARTIFACT_ROOT` 解析受管产物。新增一个 Agent 后端时不需要复制实验编排、SQLite、复核或控制台，只需实现 adapter 接口。当前 Hearth 仍是默认实现，两个专用桥接接口保持不变。

## 启动方式

主服务与评测服务可以并排运行：

```powershell
# hearth-os\.env
HEARTH_EVAL_INPUT_ROOT=D:\App\hearth-eval\eval
```

```powershell
cd D:\App\hearth-os
npm run dev
```

```powershell
cd D:\App\hearth-eval
npm install
Copy-Item .env.example .env
$env:HEARTH_EVAL_ARTIFACT_ROOT='D:\App\hearth-os\.hearth\eval-artifacts'
npm run dev
```

首次启动评测服务只校验 case 目录、同步版本并恢复中断运行，不会自动执行任何实验。`HEARTH_EVAL_ARTIFACT_ROOT` 必须与主服务实际写入的产物根一致；遗漏时运行详情会找不到已登记产物，并错误报告 `BLOCKER_FAILED: exists`。重启后先通过 `GET /api/system` 确认 `artifactRoot`，再开始实验。

## Native 30 题结果

2026-11-11 至 11-12 使用 30 个离线 case、仅 `native`、重复 1 次、自动评分和自动重试、并发 4：

| 指标 | 结果 |
|---|---:|
| 最好完整单轮 | **18/30（60%）**，平均分 88.89，`EXP-20261111145332-7a95ea` |
| 累计定向确认 | **19/30**，不是一次连续实验 |
| 最近完整单轮 | 12/30（40%），平均分 73.33，`EXP-20261112003215-b1172b` |
| 最终修复提交 | `eb32ad5`，尚未连续复测 |

最近完整实验受 provider 抖动、评分 JSON 截断和超时影响，且早于最后四个归一化修复。详细边界与复测建议见[评测与结果](/evaluation/)。

## 验证

主仓库验证：

```bash
npm test
npm run typecheck
npm run build
npm run docs:build
```

评测仓库验证（当前 11 个测试文件、42 个测试）：

```bash
npm test
npm run typecheck
npm run typecheck:scenarios
npm run build
npm run docs:build
```

两个仓库的自动验证都不执行真实评测实验，也不预置任何“通过”结论。
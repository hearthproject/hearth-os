# Context Metrics / Prometheus Smoke Test (2026-11-28)

## 目标

验证路线第 2 步的第一项：实际调用 Context Snapshot → Prometheus 相关 endpoint，检查输出格式、空数据行为，以及实验标签相关字段的基本形态。

## 环境

- 仓库：`hearth-os`
- 分支：`main`（本地工作区）
- 数据目录隔离：`HEARTH_ROOT=E:\codex-eval-agent\hearth-os\.tmp-metrics-test`
- 实际数据目录：`E:\codex-eval-agent\hearth-os\.tmp-metrics-test\.hearth\`
- 数据库：空测试库（新目录，未写入业务数据）
- 服务地址：`http://127.0.0.1:4317`
- 验证时间：2026-11-28

## 执行命令

```powershell
$env:HEARTH_ROOT = "E:\codex-eval-agent\hearth-os\.tmp-metrics-test"
curl.exe -i http://127.0.0.1:4317/api/context/metrics
curl.exe -i http://127.0.0.1:4317/api/context/metrics/prometheus
```

## 结果

### 1. `GET /api/context/metrics`

- HTTP：`200 OK`
- `cache-control: no-store`
- `content-type: application/json; charset=utf-8`

关键响应体：

```json
{
  "generatedAt": "2026-11-28T03:36:56.519Z",
  "ledger": { "tasks": 0, "items": 0 },
  "handoffs": {
    "total": 0, "automatic": 0, "userConfirmed": 0, "pendingUser": 0,
    "prepared": 0, "running": 0, "completed": 0, "failed": 0, "cancelled": 0,
    "successRate": null, "averageContextTokens": null, "averageRecoveryMs": null
  },
  "diagnosis": {
    "total": 0, "model": 0, "rules": 0,
    "averageDurationMs": null, "averageContextTokens": null
  },
  "compactions": {
    "total": 0, "completed": 0, "failed": 0, "running": 0,
    "byTrigger": { "auto": 0, "manual": 0, "overflow": 0 },
    "averageTokensBefore": null, "averageTokensAfter": null,
    "averageCompressionRatio": null, "averageDurationMs": null,
    "averageCoveredMessages": null, "structuredRate": null, "truncatedRate": null,
    "byExperiment": {}
  }
}
```

观察：

- 空库下计数类字段为 `0`，无样本均值/比率字段为 `null`，符合 `context-metrics.ts` 的聚合语义。
- `compactions.byExperiment` 为空对象 `{}`。

### 2. `GET /api/context/metrics/prometheus`

- HTTP：`200 OK`
- `cache-control: no-store`
- `content-type: text/plain; version=0.0.4; charset=utf-8`

观察：

- Prometheus 文本包含 `# HELP` / `# TYPE gauge`，指标命名为 `hearth_context_*`。
- 有值的 gauge 输出了样本，如：
  - `hearth_context_ledger_tasks 0`
  - `hearth_context_handoffs_total 0`
  - `hearth_context_compactions_total 0`
  - `hearth_context_handoffs_by_status{status="completed"} 0`
  - `hearth_context_compactions_by_trigger{trigger="auto"} 0`
- `null/NaN` 指标没有样本行，仅有 `HELP/TYPE`，例如：
  - `hearth_context_handoffs_success_rate`
  - `hearth_context_handoffs_avg_recovery_ms`
  - `hearth_context_diagnosis_avg_duration_ms`
  - `hearth_context_compactions_avg_compression_ratio`
  - `hearth_context_compactions_structured_rate`
  - `hearth_context_compactions_truncated_rate`
- `hearth_context_compactions_by_experiment` 只有 `HELP/TYPE`，没有样本行；与 JSON 中 `byExperiment: {}` 一致。

## 结论

- 两个 endpoint 在空测试库下可正常访问，HTTP 状态和 content-type 符合预期。
- JSON snapshot 的空数据语义明确：计数为 `0`，无样本统计为 `null`。
- Prometheus 导出符合当前实现：`null/NaN` 不输出样本行；空 experiment 标签集合不输出样本行。后续接入 Grafana/告警时，需要按“缺样本”而不是“0”处理这些指标。

## 后续验证（路线第 2 步剩余）

- 构造真实 compaction/handoff/diagnosis 数据，检查数值与更新时间是否正确。
- 验证 `HEARTH_COMPACTION_EXPERIMENT` 打标后，`byExperiment` 和 Prometheus label 切分是否正确。
- 抽样比对 `conversation_compactions` 表与 `conversation.context.compacted` 事件 payload，确认 structured/truncated/rate 来源一致性。
## 手动压缩后指标验证（2026-11-28）

### 目的

验证路线第 2 步：触发一次压缩后，指标数值与 compaction 记录一致；连续请求不被缓存，`generatedAt` 更新但指标值稳定。

### 操作过程

1. 通过 API 创建测试对话：`POST /api/conversations` → `05f641fb-adee-45c6-8fdd-1f8e9db69587`
2. 向测试库 ` .tmp-metrics-test/.hearth/hearth.sqlite` 直接写入 40 条 chat_messages（user/assistant 交替，每条约 2820 chars），用于构造可压缩内容。
3. 记录基线 metrics：`compactions.total=0`，所有 compaction 平均值/比率为 `null`。
4. 手动触发压缩：`POST /api/conversations/05f641fb-adee-45c6-8fdd-1f8e9db69587/context/compact`
5. 压缩完成后立即连续请求 `/api/context/metrics` 两次、`/api/context/metrics/prometheus` 两次。

### 压缩响应（关键字段）

```json
{
  "compaction": {
    "id": "26578c1f-41fd-4e17-879a-f2f6c9565b82",
    "trigger": "manual",
    "status": "completed",
    "tokensBefore": 112255,
    "tokensAfter": 39362,
    "model": "zhipu/glm-5.3-flash",
    "coveredMessageIds": [/* 26 条 */],
    "createdAt": "2026-11-28T03:54:10.960Z",
    "completedAt": "2026-11-28T03:54:36.362Z"
  }
}
```

派生值：`compressionRatio = 39362/112255 = 0.3506480780366131`，`durationMs = 25402`，`coveredCount = 26`。

### 压缩后两次 JSON metrics 对比

| 字段 | 第 1 次 | 第 2 次 |
|---|---:|---:|
| `generatedAt` | `2026-11-28T03:54:36.447Z` | `2026-11-28T03:54:36.507Z` |
| `compactions.total` | 1 | 1 |
| `compactions.completed` | 1 | 1 |
| `compactions.byTrigger.manual` | 1 | 1 |
| `averageTokensBefore` | 112255 | 112255 |
| `averageTokensAfter` | 39362 | 39362 |
| `averageCompressionRatio` | 0.3506480780366131 | 0.3506480780366131 |
| `averageDurationMs` | 25402 | 25402 |
| `averageCoveredMessages` | 26 | 26 |
| `structuredRate` | 1 | 1 |
| `truncatedRate` | 0 | 0 |
| `byExperiment.default` | 1 | 1 |

### 压缩后两次 Prometheus 对比（compaction 相关）

两次请求的 compaction 指标值完全一致，且 `generatedAt` 对应的 HTTP 响应时间不同（JSON 观测到 447Z/507Z）。代表性样本：

```text
hearth_context_compactions_total 1
hearth_context_compactions_by_status{status="completed"} 1
hearth_context_compactions_by_trigger{trigger="manual"} 1
hearth_context_compactions_avg_tokens_before 112255
hearth_context_compactions_avg_tokens_after 39362
hearth_context_compactions_avg_compression_ratio 0.3506480780366131
hearth_context_compactions_avg_duration_ms 25402
hearth_context_compactions_avg_covered_messages 26
hearth_context_compactions_structured_rate 1
hearth_context_compactions_truncated_rate 0
hearth_context_compactions_by_experiment{experiment="default"} 1
```

### 结论

- 压缩后 metrics 与 compaction 记录一致：tokensBefore/After、compressionRatio、durationMs、coveredCount 均匹配。
- 连续两次请求 `generatedAt` 不同、指标数值相同，说明 `no-store` 生效，没有被缓存吞掉旧值/固定值异常；指标反映的是当前 DB/event 状态。
- 本次为 `trigger=manual`、`experiment=default`；后续还需验证 auto/overflow 触发、显式 `HEARTH_COMPACTION_EXPERIMENT` 标签、失败 compaction 的指标表现。

## Experiment 标签验证（2026-11-28）

### 目的

验证 `HEARTH_COMPACTION_EXPERIMENT` 标签行为：未设置时归入 `default`，设置后新 compaction 计入对应实验标签，历史 `default` 数据不被覆盖。

### 步骤与结果

1. **默认环境（未设置 `HEARTH_COMPACTION_EXPERIMENT`）**：server 已在 `HEARTH_ROOT=.tmp-metrics-test` 下运行。为新对话 `6102e96b-c6ec-43ac-bfa2-5cf25314f8a7` 写入 40 条消息并触发手动压缩。
   - compaction：`9ae8e2bd-b2a5-4a9d-8a96-ede75fa5e2a3`，`status=completed`，`tokensBefore=112255`，`tokensAfter=39515`
   - metrics：`total=2, byExperiment={"default":2}`，Prometheus `hearth_context_compactions_by_experiment{experiment="default"} 2`

2. **重启并设置实验名**：停止旧 server（4317），以 `HEARTH_ROOT=.tmp-metrics-test` + `HEARTH_COMPACTION_EXPERIMENT=exp_v2` 重启。
   - 重启后立即查 metrics：`total=2, byExperiment={"default":2}`（历史数据保留）

3. **exp_v2 环境触发压缩**：为新对话 `fa6a1353-677c-4bdb-9c7a-97321f28ab80` 写入 40 条消息并触发手动压缩。
   - compaction：`87ebe69e-64cd-4266-a8f1-32d3795be396`，`status=completed`，`tokensBefore=112255`，`tokensAfter=39438`
   - metrics JSON：`total=3, completed=3, byTrigger.manual=3, byExperiment={"default":2,"exp_v2":1}`
   - Prometheus：
     ```text
     hearth_context_compactions_total 3
     hearth_context_compactions_by_experiment{experiment="default"} 2
     hearth_context_compactions_by_experiment{experiment="exp_v2"} 1
     ```

4. **事件 payload 校验（DB 抽样）**：最近 3 条 `conversation.context.compacted` 事件的 `experiment` 字段分别为 `exp_v2, default, default`；均包含 `config`（`compactRatio/keepTokens/summaryMaxTokens/budgetTokens/tokenEstimatorVersion`）。

### 结论

- 未设置 `HEARTH_COMPACTION_EXPERIMENT` 时，事件/指标归入 `default`。
- 设置 `HEARTH_COMPACTION_EXPERIMENT=exp_v2` 并重启后，新 compaction 正确打上 `exp_v2`，`byExperiment` 和 Prometheus label 同时出现 `default=2, exp_v2=1`。
- 历史 `default` 数据未被覆盖；指标来自事件聚合，重启后读取既有 DB 结果一致。

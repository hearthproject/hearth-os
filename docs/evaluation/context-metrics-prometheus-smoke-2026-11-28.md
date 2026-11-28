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

## 阶段 B：异常与边界测试

### B2a. Auto 触发统计（2026-11-28）

#### 1) 源码检查

- `ConversationContextService.compactIfNeeded` 接收 `trigger: "auto" | "manual" | "overflow"`；当 `trigger==="auto"` 且 `effectiveTokens <= threshold` 时直接返回 `null`；否则调用 `compact(...)`，`compact` 将 `trigger` 原样写入 compaction 记录和 `conversation.context.compacted` 事件 payload。
  - `apps/server/src/conversation-context.ts:531-561`（compactIfNeeded，auto threshold gate）
  - `apps/server/src/conversation-context.ts:588-692`（compact，running->completed，事件 payload `trigger`）
- 运行时 auto 调用点：
  - `renderForTask`：`compactIfNeeded(..., "auto", ...)`，`conversation-context.ts:470`
  - `renderForChat`：`compactIfNeeded(..., "auto", ...)`，`conversation-context.ts:495`
  - `refreshAfterTask`：`compactIfNeeded(..., "auto", ...)`，`conversation-context.ts:579`
- 指标聚合：`context-metrics.ts:171-178` 按 `conversation_compactions.trigger` 统计 `byTrigger.auto/manual/overflow`；Prometheus 输出 `hearth_context_compactions_by_trigger{trigger="auto"}`，`context-metrics.ts:245-249`。

#### 2) 脚本化触发

在 `hearth-os/.tmp-metrics-test/trigger-auto.ts` 中直接使用 `HearthStore + ConversationContextService`（同 DB：`.tmp-metrics-test/.hearth/hearth.sqlite`），创建测试对话并写入 40 条消息，然后调用：

```ts
await conversationContext.compactIfNeeded(conversation.id, "auto", {
  thresholdTokens: 1,
  keepTokens: 2000,
  summaryMaxTokens: 2000,
  budgetTokens: 16000
});
```

说明：传入 `thresholdTokens: 1` 是为了稳定满足 auto 路径的阈值条件，验证“auto 触发路径被执行并正确打标”；trigger 仍由 `compactIfNeeded` 传入 `"auto"`。

脚本输出：

```json
{
  "stage": "after",
  "result": {
    "id": "91c579de-8fe4-48d7-9747-3aead91c56bf",
    "trigger": "auto",
    "status": "completed",
    "tokensBefore": 70700,
    "tokensAfter": 3568
  },
  "event": {
    "seq": 451,
    "trigger": "auto",
    "experiment": "default",
    "config": {
      "compactRatio": 0.8,
      "keepTokens": 2000,
      "summaryMaxTokens": 2000,
      "budgetTokens": 16000,
      "tokenEstimatorVersion": "cjk-v1"
    }
  }
}
```

#### 3) 数据库核对

- `conversation_compactions` 新增记录：`id=91c579de-8fe4-48d7-9747-3aead91c56bf, trigger=auto, status=completed, tokensBefore=70700, tokensAfter=3568`。
- `events` 新增 `conversation.context.compacted`：`seq=451, payload.trigger="auto", payload.experiment="default", payload.config` 存在。

#### 4) HTTP 验证

`GET /api/context/metrics`（server 读取同一 DB）：

- `compactions.total = 4`（此前 3）
- `compactions.completed = 4`
- `compactions.byTrigger = {"auto":1,"manual":3,"overflow":0}`
- `byExperiment = {"default":3,"exp_v2":1}`

#### 5) Prometheus 验证

`GET /api/context/metrics/prometheus`：

```text
hearth_context_compactions_total 4
hearth_context_compactions_by_status{status="completed"} 4
hearth_context_compactions_by_trigger{trigger="auto"} 1
hearth_context_compactions_by_trigger{trigger="manual"} 3
hearth_context_compactions_by_trigger{trigger="overflow"} 0
hearth_context_compactions_by_experiment{experiment="default"} 3
hearth_context_compactions_by_experiment{experiment="exp_v2"} 1
```

#### 结论

- **Pass**：auto 触发路径可执行，compaction 记录和 compacted 事件的 `trigger` 均为 `auto`；`/api/context/metrics` 的 `byTrigger.auto` 与 Prometheus `trigger="auto"` 计数正确增加。
- **观察**：本次脚本进程未设置 `HEARTH_COMPACTION_EXPERIMENT`，因此事件 `experiment=default`；说明 experiment 标签取决于发出事件的进程环境变量。该行为与当前实现一致，但在多进程/脚本注入场景下需注意。

### B2b. Overflow 触发统计（2026-11-28）

#### 1) 源码检查

- 类型与接口支持 `overflow`：`compactIfNeeded/compactNow/compact` 的 trigger 类型均包含 `"overflow"`（`conversation-context.ts:533,565,590`）。
- 指标聚合支持 `overflow`：`context-metrics.ts:40,178,253` 统计并导出 `byTrigger.overflow` / `trigger="overflow"`。
- **生产触发点检查**：`git grep '"overflow"' apps/server/src` 未发现运行时业务代码传入 `"overflow"`；仅见类型定义、指标聚合、测试/断言。说明当前仓库中 overflow **有类型与指标预留、compactNow 可接受该 trigger，但未发现自动产生 overflow trigger 的生产路径**。

#### 2) 脚本化触发（Runtime 路径验证）

使用 `compactNow(conversation.id, "overflow")` 走真实 compaction 运行时路径（非直接篡改 metrics 聚合结果）。脚本：`.tmp-metrics-test/trigger-overflow.ts`，同一测试 DB；脚本内设置 `process.env.HEARTH_COMPACTION_EXPERIMENT="exp_v2"` 与当前运行 server 环境一致。

输出：

```json
{
  "result": {
    "id": "0a3f8095-1b9c-42bc-afcb-f931dceada69",
    "trigger": "overflow",
    "status": "completed",
    "tokensBefore": 79540,
    "tokensAfter": 4012
  },
  "event": {
    "seq": 452,
    "trigger": "overflow",
    "experiment": "exp_v2"
  }
}
```

#### 3) 数据库核对

- `conversation_compactions`：`id=0a3f8095-1b9c-42bc-afcb-f931dceada69, trigger=overflow, status=completed`。
- `events`：`conversation.context.compacted` `seq=452`，`payload.trigger="overflow"`，`payload.experiment="exp_v2"`。

#### 4) HTTP 验证

`GET /api/context/metrics`：

- `compactions.total = 5`
- `compactions.byTrigger = {"auto":1,"manual":3,"overflow":1}`
- `byExperiment = {"default":3,"exp_v2":2}`

#### 5) Prometheus 验证

```text
hearth_context_compactions_total 5
hearth_context_compactions_by_trigger{trigger="auto"} 1
hearth_context_compactions_by_trigger{trigger="manual"} 3
hearth_context_compactions_by_trigger{trigger="overflow"} 1
hearth_context_compactions_by_experiment{experiment="default"} 3
hearth_context_compactions_by_experiment{experiment="exp_v2"} 2
```

#### 结论

- **Pass（聚合/标记链路）**：当 compaction 记录与事件的 trigger 为 `overflow` 时，DB、HTTP metrics、Prometheus 三处统计正确。
- **Gap（生产触发）**：当前未发现生产代码自动产生 `overflow` compaction 的路径；`compactNow` 支持该 trigger，但实际“上下文溢出 -> overflow compaction”闭环仍需确认设计意图/补触发点。该项在路线中应标记为“指标链路已验证，生产触发待确认”。

### B1. Compaction 失败时指标是否正确（2026-11-28）

#### 1) 源码检查

- `conversation-context.ts:614-631`：compaction 先写入 `status="running"` 记录（含 `coveredMessageIds/tokensBefore/createdAt`）。
- `conversation-context.ts:632-692`：成功时生成 summary、写 state、发布 `conversation.context.compacted` 事件、更新记录为 `completed`。
- `conversation-context.ts:693-700`：失败时 catch 更新为 `status="failed"`，写 `error` 和 `completedAt`，**不发布 compacted 事件**。
- 指标聚合 `context-metrics.ts`：`failed/completed/running` 来自 `conversation_compactions.status`；`averageTokensBefore` 对所有 compaction 行取平均；`averageTokensAfter/averageCompressionRatio` 只对 completed 且有效值取平均；`averageDurationMs` 对有 `created_at+completed_at` 的行取平均；`averageCoveredMessages` 对所有可解析 `covered_json` 的行取平均；`structuredRate/truncatedRate/byExperiment` 来自 `conversation.context.compacted` 事件。

#### 2) 脚本化触发（运行时失败）

脚本：`.tmp-metrics-test/trigger-failure.ts`。使用真实 `ConversationContextService.compactNow(...,"manual")`，`summaryGenerator` 主动抛错 `simulated compaction failure`；记录触发前后 `events` 最大 seq，检查是否有新 `conversation.context.compacted` 事件。

输出：

```json
{
  "beforeEventSeq": 452,
  "afterEventSeq": 452,
  "newCompactedEvents": [],
  "result": {
    "id": "b06ab7d9-fd17-4294-9d19-06e9d9680db6",
    "trigger": "manual",
    "status": "failed",
    "tokensBefore": 77300,
    "tokensAfter": null,
    "error": "simulated compaction failure"
  },
  "dbRow": {
    "id": "b06ab7d9-fd17-4294-9d19-06e9d9680db6",
    "trigger": "manual",
    "status": "failed",
    "tokens_before": 77300,
    "tokens_after": null,
    "error": "simulated compaction failure",
    "created_at": "2026-11-28T05:08:47.400Z",
    "completed_at": "2026-11-28T05:08:47.402Z"
  }
}
```

#### 3) 数据库核对

- `conversation_compactions` 新增失败记录：`status=failed, tokens_after=NULL, error="simulated compaction failure", completed_at` 已写入。
- 事件表无新增 `conversation.context.compacted`（seq 仍为 452）。

#### 4) HTTP 验证（基线 -> 失败后）

基线（失败前）：`total=5, completed=5, failed=0, manual=3, avgTokensBefore=97401, avgTokensAfter=25179, avgCompressionRatio=0.2309782046926979, avgDurationMs=24134, avgCoveredMessages=30.8, structuredRate=1, truncatedRate=0, byExperiment={"default":3,"exp_v2":2}`

失败后 `GET /api/context/metrics`：

| 字段 | 失败后 | 预期 | 结果 |
|---|---:|---|:---:|
| total | 6 | +1 | Pass |
| completed | 5 | 不变 | Pass |
| failed | 1 | +1 | Pass |
| running | 0 | 不变 | Pass |
| byTrigger.manual | 4 | +1 | Pass |
| averageTokensAfter | 25179 | 不变（仅 completed） | Pass |
| averageCompressionRatio | 0.2309782046926979 | 不变（仅 completed） | Pass |
| structuredRate | 1 | 不变（无事件） | Pass |
| truncatedRate | 0 | 不变（无事件） | Pass |
| byExperiment | default=3, exp_v2=2 | 不变（无事件） | Pass |
| averageTokensBefore | 94050.83333333333 | 含失败行，变化符合代码 | Pass* |
| averageDurationMs | 20112 | 含失败行(2ms)，变化符合代码 | Pass* |
| averageCoveredMessages | 32 | 含失败行 covered_json，变化符合代码 | Pass* |

\* 这三个平均值包含失败 compaction 行（代码按所有 compactionRows/有时间戳行/可解析 covered 行计算），不是 bug；但语义上会被快速失败或异常记录影响。写报告/告警时应区分“尝试均值”和“成功压缩均值”。

#### 5) Prometheus 验证

```text
hearth_context_compactions_total 6
hearth_context_compactions_by_status{status="completed"} 5
hearth_context_compactions_by_status{status="failed"} 1
hearth_context_compactions_by_status{status="running"} 0
hearth_context_compactions_by_trigger{trigger="manual"} 4
hearth_context_compactions_avg_tokens_after 25179
hearth_context_compactions_avg_compression_ratio 0.2309782046926979
hearth_context_compactions_structured_rate 1
hearth_context_compactions_truncated_rate 0
hearth_context_compactions_by_experiment{experiment="default"} 3
hearth_context_compactions_by_experiment{experiment="exp_v2"} 2
```

#### 结论

- **Pass**：失败 compaction 正确计入 `failed`，`completed` 不变；失败路径不发 `conversation.context.compacted` 事件，因此不会污染 `structuredRate/truncatedRate/byExperiment`；`avg_tokens_after` 和 `avg_compression_ratio` 仅基于 completed，未被失败记录污染。
- **观察**：`avg_tokens_before/avg_duration_ms/avg_covered_messages` 当前包含失败记录，语义上是“所有 compaction 尝试”的均值。若要用于压缩质量评估，建议后续补充仅 completed 的口径或在文档中明确口径。

### B3. Running 状态如何反映（2026-11-28）

#### 1) 源码检查

- `conversation-context.ts:614-631`：创建 compaction 记录时 `status="running"`，`completedAt=null`，立即 `appendConversationCompaction(record)` 写入 DB。
- `conversation-context.ts:632-692`：成功后更新为 `completed`，写 `completedAt`。
- `conversation-context.ts:693-700`：失败后更新为 `failed`，写 `error/completedAt`。
- `context-metrics.ts:93,167-169,241-244`：按 `conversation_compactions.status` 统计 `running/completed/failed`，Prometheus 导出 `hearth_context_compactions_by_status{status="running"}`。

#### 2) 脚本化触发（中途快照）

脚本：`.tmp-metrics-test/trigger-running.ts`。真实 `ConversationContextService.compactNow`，但 `summaryGenerator` 等待一个手动 gate Promise；在 gate 释放前等待 500ms，查询 HTTP metrics/Prometheus 和 DB 行；然后释放 gate，等待 compaction 完成，再次查询。

关键输出：

```json
{
  "before": { "total": 6, "completed": 5, "failed": 1, "running": 0 },
  "during": { "total": 7, "completed": 5, "failed": 1, "running": 1 },
  "dbDuring": {
    "id": "d28344c1-f952-46d2-89b0-ada199fc3b28",
    "status": "running",
    "trigger": "manual",
    "completed_at": null,
    "error": null
  },
  "result": { "id": "d28344c1-f952-46d2-89b0-ada199fc3b28", "status": "completed", "trigger": "manual" },
  "after": { "total": 7, "completed": 6, "failed": 1, "running": 0 },
  "dbAfter": {
    "id": "d28344c1-f952-46d2-89b0-ada199fc3b28",
    "status": "completed",
    "trigger": "manual",
    "completed_at": "2026-11-28T05:12:27.382Z",
    "error": null
  }
}
```

#### 3) DB 核对

- 进行中：同一条 compaction 记录 `status=running, completed_at=null, error=null`。
- 完成后：同一条记录变为 `status=completed, completed_at` 有值，`error=null`。

#### 4) HTTP 验证

- 压缩进行中：`total=7, completed=5, failed=1, running=1`。
- 压缩完成后：`total=7, completed=6, failed=1, running=0`。

#### 5) Prometheus 验证

进行中：

```text
hearth_context_compactions_total 7
hearth_context_compactions_by_status{status="completed"} 5
hearth_context_compactions_by_status{status="failed"} 1
hearth_context_compactions_by_status{status="running"} 1
```

完成后：

```text
hearth_context_compactions_total 7
hearth_context_compactions_by_status{status="completed"} 6
hearth_context_compactions_by_status{status="failed"} 1
hearth_context_compactions_by_status{status="running"} 0
```

#### 结论

- **Pass**：running 状态会真实写入 DB，并能通过 `/api/context/metrics` 和 Prometheus `by_status{status="running"}` 观测到；完成后正确转为 `completed`，`running` 回落。
- **观察**：`POST /api/conversations/:id/context/compact` 是同步等待 compactNow 完成的接口，普通调用方通常看不到 running；running 更适合通过 metrics 轮询、并发压缩、或后台触发场景观测。告警/面板应把 running 视为瞬时态信号，而不是假设它长期为 0。

### B5. 极端值及异常事件处理（2026-11-28）

#### 1) 源码检查（预期行为）

- `context-metrics.ts:123-136`：事件 payload `JSON.parse` 失败则 `catch continue` 跳过；`structured` 用 `payload.structured !== false`，缺失字段会被计为 structured；`truncated` 仅 `=== true` 计数；`experiment` 为空/空白/缺失归 `default`。
- `context-metrics.ts:95-115`：`compressionRatio` 仅在 `before>0 && tokensAfter` 有限时计入；`covered_json` 解析失败或非数组返回 null 并被过滤；duration 仅在时间可解析且 `>=0` 时计入。
- `context-metrics.ts:175-181`：`averageTokensBefore` 对所有 compaction 行的有限数值取平均；`averageTokensAfter` 只取 completed 且有限值；completed/failed/running 来自 status 计数。
- `context-metrics.ts:192-206`：Prometheus `promLine` 对 `null/!Number.isFinite` 样本直接跳过，不输出非法样本。

#### 2) 注入与验证方法

脚本：`.tmp-metrics-test/extreme-values.ts`。先取 baseline，通过 node:sqlite 直接向测试 DB 注入 5 条异常 `conversation_compactions` 行和 6 条异常 `conversation.context.compacted` 事件；查询 HTTP metrics/Prometheus；最后按 ID 清理注入数据并再次查询确认恢复。

注入用例：

| 用例 | 注入数据 | 观察结果 |
|---|---|---|
| malformed event payload | `payload_json="{bad json"` | 被跳过，metrics 未崩溃 |
| structured 缺失 | `{"trigger":"manual","truncated":false}` | 计入 structured（`!== false` 语义） |
| truncated 非 bool | `{"structured":true,"truncated":"yes"}` | 不计入 truncated（仅 `=== true`） |
| experiment 空字符串 | `{"experiment":""}` | 归入 `default` |
| experiment 空白 | `{"experiment":"  "}` | 归入 `default` |
| experiment 特殊字符 | `{"experiment":"exp/v2:canary \"test\""}` | JSON/Prom 正常，Prom label 正确转义 |
| tokensBefore=0, tokensAfter=100 | completed 行 | 不计入 compressionRatio（`before>0`） |
| tokensAfter=null | completed 行 | 不计入 avgTokensAfter/compressionRatio |
| covered_json 非法 | `"{not-json"` | covered 平均值忽略该行 |
| created_at/completed_at 不可解析 | `"not-a-date"/"also-bad"` | duration 平均值忽略该行 |
| 极大值 | `tokensBefore=999999999, tokensAfter=888888888` | JSON/Prom 正常输出，无 NaN/Infinity |

#### 3) DB/HTTP/Prometheus 核对

Baseline：`total=7, completed=6, failed=1, structuredRate=1, truncatedRate=0, byExperiment={default:3,exp_v2:3}`

注入后：`total=12, completed=11, failed=1, structuredRate=1, truncatedRate=0, byExperiment={default:7,exp_v2:3,"exp/v2:canary \"test\"":1}`

- 6 条事件中 1 条 malformed 被跳过，5 条被计数；5 条都满足 `structured !== false`，0 条 `truncated===true`，因此 rate 不变。符合代码语义。
- experiment：空字符串/空白/缺失都归 `default`（+4），特殊字符标签独立计数（+1）。
- compaction 异常行未导致 endpoint 500；Prometheus `content-type=text/plain; version=0.0.4; charset=utf-8`，`promHasNaN=false, promHasInfinity=false`。
- Prometheus 特殊标签正确转义：`hearth_context_compactions_by_experiment{experiment="exp/v2:canary \"test\""} 1`。

清理注入数据后再次查询：metrics 完全恢复到 baseline。

#### 4) 结论

- **Pass**：异常事件/行不会导致 metrics 或 Prometheus endpoint 崩溃；malformed payload 被跳过；`null/NaN/Infinity` 未出现在 Prometheus 输出。
- **Pass**：label 转义正确，特殊字符 experiment 可安全导出。
- **语义观察（需注意）**：
  - `structured` 缺失按 `!== false` 计为 structured，缺字段会抬高 structuredRate；这符合当前代码，但不一定符合“缺失=未知”的产品语义。
  - 极大但有限的数值会显著拉偏平均值（本次注入后 avgTokensBefore/After 跃升到 8e7 量级），Prometheus 仍如实导出；建议后续考虑上限保护或分位数指标。
  - `averageTokensBefore/Duration/CoveredMessages` 包含失败/异常 completed 行的口径在 B1 已观察到，本次再次确认。

#### 5) 清理

注入的 `extreme-comp-*`、`extreme-evt-*` 测试数据已在脚本末尾删除，并通过 `afterCleanup` 查询确认指标恢复 baseline。测试脚本保留在 `.tmp-metrics-test/`（已被 gitignore）。

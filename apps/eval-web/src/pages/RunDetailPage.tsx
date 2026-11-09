import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  Clock3,
  Cpu,
  ExternalLink,
  FileText,
  Gauge,
  Info,
  RotateCcw,
  TerminalSquare,
  X,
  XCircle
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import type { GraderResultRecord, RunArtifactView } from "@hearth/eval-core";
import { api } from "../lib/api.ts";
import {
  EVENT_LABELS,
  REASON_LABELS,
  executorLabel,
  formatBytes,
  formatDateTime,
  formatDuration,
  isActiveRun,
  shortId
} from "../lib/labels.ts";
import {
  EmptyState,
  ErrorState,
  KeyValue,
  LifecycleRail,
  LoadingState,
  MetricCard,
  PageHeader,
  SectionHeader,
  StatusPill
} from "../components/ui.tsx";

export function RunDetailPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const [reviewer, setReviewer] = useState("local");
  const [note, setNote] = useState("");
  const [previewArtifact, setPreviewArtifact] = useState<RunArtifactView | null>(null);
  const runQuery = useQuery({
    queryKey: ["run", id],
    queryFn: () => api.run(id),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status && isActiveRun(status) ? 1_500 : false;
    }
  });
  const reviewMutation = useMutation({
    mutationFn: (decision: "pass" | "fail" | "unknown") => api.submitReview(id, {
      decision,
      ...(reviewer.trim() ? { reviewer: reviewer.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {})
    }),
    onSuccess: () => {
      setNote("");
      void queryClient.invalidateQueries({ queryKey: ["run", id] });
      void queryClient.invalidateQueries({ queryKey: ["experiment"] });
      void queryClient.invalidateQueries({ queryKey: ["reviews"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }
  });

  if (runQuery.isLoading) return <LoadingState text="正在加载运行轨迹" />;
  if (runQuery.error) return <ErrorState error={runQuery.error} onRetry={() => void runQuery.refetch()} />;
  const data = runQuery.data!;
  const { run } = data;
  const taskView = asRecord(data.hearthTask);
  const task = asRecord(taskView?.task) ?? taskView;
  const active = isActiveRun(run.status);
  const reviewPending = Boolean(data.review) === false && (run.reviewReasons.length > 0 || ["failed", "blocked", "error", "needs_review"].includes(run.status));
  const evidenceCount = data.graders.reduce((sum, grader) => sum + grader.evidence.length, 0);

  return (
    <div className="page-stack run-detail-page">
      <Link className="back-link" to={`/experiments/${run.experimentId}`}><ArrowLeft size={14} /> 返回实验</Link>
      <PageHeader
        eyebrow={`${executorLabel(run.executorId).toUpperCase()} · RUN`}
        title={data.case?.title ?? run.caseKey}
        description={<span className="header-meta-line"><code>{run.id}</code><span>·</span><span>重复 #{run.repetition}</span></span>}
        actions={<><StatusPill status={run.status} />{active && <span className="live-refresh"><RotateCcw className="spin" size={13} /> 自动刷新中</span>}</>}
      />

      <section className="experiment-status-banner run-status-banner">
        <div className="status-banner-main">
          <StatusPill status={run.status} />
          <span>{run.error ?? (reviewPending ? "自动评分已请求人工复核，请确认最终结论。" : active ? "运行进行中，Hearth 任务状态会持续同步。" : "运行已结束，可检查评分、产物与人工复核记录。")}</span>
        </div>
        <LifecycleRail status={run.status} />
      </section>

      <section className="metric-grid run-metric-grid">
        <MetricCard label="分数" value={run.score === null ? "—" : run.score.toFixed(1)} detail={`${data.graders.length} 项评分证据`} icon={<Gauge size={17} />} />
        <MetricCard label="执行耗时" value={formatDuration(run.startedAt, run.finishedAt)} detail={formatDateTime(run.startedAt)} icon={<Clock3 size={17} />} />
        <MetricCard label="执行器" value={executorLabel(run.executorId)} detail={`尝试 ${run.attempt} 次`} icon={<Cpu size={17} />} />
        <MetricCard label="Hearth 任务" value={run.hearthTaskId ? shortId(run.hearthTaskId, 10) : "—"} detail={task ? `状态：${String(task.status ?? "unknown")}` : "尚未创建"} icon={<ExternalLink size={17} />} />
      </section>

      <div className="run-layout">
        <div className="run-main">
          <section className="panel">
            <SectionHeader title="执行事件" detail={`${data.events.length} 条 · 完整任务生命周期`} action={<TerminalSquare size={17} />} />
            {data.events.length === 0 ? <EmptyState title="暂无事件" description="运行创建后会自动记录每个关键阶段。" /> : (
              <div className="trace-timeline">
                {data.events.map((event, index) => (
                  <div className="trace-event" key={event.seq}>
                    <div className="trace-rail"><span /><i /></div>
                    <div className="trace-body">
                      <div className="trace-head"><strong>{EVENT_LABELS[event.type] ?? event.type}</strong><time>{formatDateTime(event.createdAt)}</time></div>
                      <code>{event.type}</code>
                      {payloadRows(event.payload).length > 0 && (
                        <div className="trace-payload">
                          {payloadRows(event.payload).map(([key, value]) => <span key={key}><b>{key}</b>{value}</span>)}
                        </div>
                      )}
                    </div>
                    {index === data.events.length - 1 && <span className={`trace-terminal tone-${run.status}`} />}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <SectionHeader title="评分明细" detail={`${data.graders.length} 项 · ${evidenceCount} 条证据`} action={<CheckCircle2 size={17} />} />
            {data.graders.length === 0 ? <EmptyState title="尚未评分" description="任务结束后会运行确定性 grader 与模型评委。" /> : (
              <div className="grader-results">
                {data.graders.map((grader) => <GraderRow key={grader.id} grader={grader} />)}
              </div>
            )}
            {run.reviewReasons.length > 0 && (
              <div className="review-reason-bar"><Info size={15} /><span>复核触发：</span>{run.reviewReasons.map((reason) => <em key={reason}>{REASON_LABELS[reason]}</em>)}</div>
            )}
          </section>

          <section className="panel">
            <SectionHeader title="产物" detail={`${data.artifacts.length} 个文件 · ${run.outputDir}`} action={<FileText size={17} />} />
            {data.artifacts.length === 0 ? <EmptyState title="没有产物" description="任务可能尚未输出文件，或产物目录为空。" /> : (
              <div className="artifact-list">
                {data.artifacts.map((artifact) => (
                  <button className="artifact-row" key={artifact.path} onClick={() => setPreviewArtifact(artifact)}>
                    <span className="artifact-icon"><FileText size={15} /></span>
                    <span className="artifact-copy"><strong>{artifact.path}</strong><small>{artifact.mimeType} · {formatBytes(artifact.bytes)}</small></span>
                    <span className="artifact-preview-tag">{artifact.preview === null ? "二进制" : "预览"}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="run-side">
          <section className={`panel review-panel ${reviewPending ? "needs-attention" : ""}`}>
            <SectionHeader title="人工复核" detail={data.review ? "已提交结论" : reviewPending ? "等待你的判断" : "可选"} action={<ClipboardCheck size={17} />} />
            {data.review && (
              <div className={`review-outcome decision-${data.review.decision}`}>
                <span className="review-outcome-icon">{data.review.decision === "pass" ? <Check size={16} /> : data.review.decision === "fail" ? <X size={16} /> : "?"}</span>
                <div><strong>{data.review.decision === "pass" ? "复核通过" : data.review.decision === "fail" ? "复核未通过" : "保留待定"}</strong><small>{data.review.reviewer} · {formatDateTime(data.review.updatedAt)}</small></div>
              </div>
            )}
            {data.review?.note && <p className="review-note">{data.review.note}</p>}
            <div className="review-form">
              <label className="field-label">复核人<input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="local" maxLength={80} /></label>
              <label className="field-label">备注<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="说明判断依据、证据或缺省原因…" rows={4} maxLength={4000} /></label>
              {reviewMutation.error && <div className="inline-error">{reviewMutation.error.message}</div>}
              <div className="review-actions">
                <button className="button button-pass" disabled={reviewMutation.isPending} onClick={() => reviewMutation.mutate("pass")}><Check size={15} /> 通过</button>
                <button className="button button-fail" disabled={reviewMutation.isPending} onClick={() => reviewMutation.mutate("fail")}><X size={15} /> 未通过</button>
              </div>
              <button className="text-button" disabled={reviewMutation.isPending} onClick={() => reviewMutation.mutate("unknown")}>仅记录待定</button>
            </div>
          </section>

          <section className="panel">
            <SectionHeader title="运行元数据" detail="固定与实时字段" />
            <div className="kv-stack compact">
              <KeyValue label="Case" mono>{run.caseKey}</KeyValue>
              <KeyValue label="Case 版本">v{run.caseVersion}</KeyValue>
              <KeyValue label="外部引用" mono>{run.externalRef}</KeyValue>
              <KeyValue label="任务 ID" mono>{run.hearthTaskId ?? "—"}</KeyValue>
              <KeyValue label="产出目录" mono>{run.outputDir}</KeyValue>
              <KeyValue label="更新于">{formatDateTime(run.updatedAt)}</KeyValue>
            </div>
          </section>

          <section className="panel">
            <SectionHeader title="Hearth 任务" detail={task ? String(task.status ?? "unknown") : "未连接"} action={<ExternalLink size={17} />} />
            {task ? (
              <div className="task-view">
                <KeyValue label="状态"><StatusPill status={run.status} /></KeyValue>
                {typeof task.nextAction === "string" && <KeyValue label="下一步">{task.nextAction}</KeyValue>}
                {typeof asRecord(task.error)?.message === "string" && <div className="inline-error">{String(asRecord(task.error)?.message)}</div>}
                <div className="task-counts">
                  <span><strong>{arrayLength(taskView?.runs ?? task.runs)}</strong> executor runs</span>
                  <span><strong>{arrayLength(taskView?.approvals ?? task.approvals)}</strong> approvals</span>
                  <span><strong>{arrayLength(taskView?.artifacts ?? task.artifacts)}</strong> artifacts</span>
                </div>
                <details className="raw-details"><summary><ChevronDown size={14} /> Hearth 原始响应</summary><pre>{JSON.stringify(taskView, null, 2)}</pre></details>
              </div>
            ) : <EmptyState title="暂无 Hearth 任务" description="运行排队或创建失败时可能还没有任务 ID。" />}
          </section>
        </aside>
      </div>

      {previewArtifact && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="产物预览" onClick={() => setPreviewArtifact(null)}>
          <div className="modal-card artifact-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head"><div><span className="eyebrow">ARTIFACT</span><h2>{previewArtifact.path}</h2><small>{previewArtifact.mimeType} · {formatBytes(previewArtifact.bytes)}</small></div><button className="icon-button" onClick={() => setPreviewArtifact(null)} aria-label="关闭"><X size={18} /></button></div>
            {previewArtifact.preview === null ? <div className="binary-notice"><FileText size={24} /><p>该产物为二进制文件，无法在控制台中预览。</p></div> : <pre className="artifact-preview">{previewArtifact.preview}</pre>}
          </div>
        </div>
      )}
    </div>
  );
}

function GraderRow({ grader }: { grader: GraderResultRecord }) {
  return (
    <article className={`grader-result ${grader.passed === true ? "passed" : grader.passed === false ? "failed" : "unknown"}`}>
      <span className="grader-status">{grader.passed === true ? <CheckCircle2 size={17} /> : grader.passed === false ? <XCircle size={17} /> : "?"}</span>
      <div className="grader-result-main">
        <div className="grader-result-head"><strong>{grader.criterionId}</strong><span className={`source-badge source-${grader.source}`}>{grader.source}</span>{grader.confidence !== null && <span className="confidence">置信度 {(grader.confidence * 100).toFixed(0)}%</span>}</div>
        <p>{grader.reason}</p>
        {grader.evidence.length > 0 && <div className="evidence-list">{grader.evidence.map((evidence, index) => <code key={`${index}-${evidence.slice(0, 20)}`}>{evidence}</code>)}</div>}
        {grader.model && <small className="grader-model">{grader.model}{grader.promptHash ? ` · ${shortId(grader.promptHash, 12)}` : ""}</small>}
      </div>
    </article>
  );
}

function payloadRows(payload: Record<string, unknown>): Array<[string, string]> {
  const allowed = ["status", "taskId", "score", "decision", "reviewer", "error", "attempt", "interruptedRuns", "cases", "executors", "runs", "repetitions"];
  return allowed.flatMap((key) => {
    const value = payload[key];
    if (value === undefined || value === null || value === "") return [];
    return [[key, typeof value === "string" ? value : JSON.stringify(value)]];
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

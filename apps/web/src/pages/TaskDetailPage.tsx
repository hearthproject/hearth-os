import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Download, RotateCcw, X } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { ArtifactPreview } from "../components/ArtifactPreview.tsx";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { ArtifactIntegrity } from "../components/pro/ArtifactIntegrity.tsx";
import { EffectLedger } from "../components/pro/EffectLedger.tsx";
import { EvidenceLog } from "../components/pro/EvidenceLog.tsx";
import { ExecutorDetail } from "../components/pro/ExecutorDetail.tsx";
import { ProSection } from "../components/pro/ProSection.tsx";
import { RunLedger } from "../components/pro/RunLedger.tsx";
import { api } from "../lib/api.ts";
import { formatBytes, relativeTime } from "../lib/format.ts";
import { CATEGORY_LABELS, EVENT_LABELS, eventDescription, externalEffectSummary, statusExplanation } from "../lib/labels.ts";
import type { ArtifactRecord } from "../lib/types.ts";
import { useViewMode } from "../lib/view-mode.tsx";

const TIMELINE_TAIL = 12;

export function TaskDetailPage() {
  const { id } = useParams();
  const { mode } = useViewMode();
  const pro = mode === "pro";
  const queryClient = useQueryClient();
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactRecord | null>(null);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const taskQuery = useQuery({ queryKey: ["task", id], queryFn: () => api.task(id!), enabled: Boolean(id), refetchInterval: 4_000 });
  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: api.templates });
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health, enabled: pro });
  const view = taskQuery.data;
  const task = view?.task;
  const template = templatesQuery.data?.templates.find((item) => item.id === task?.templateId);
  const latestRun = view?.runs.at(-1);
  const manifestArtifact = view?.artifacts.find((artifact) => artifact.relativePath === "run-manifest.json");
  const manifestQuery = useQuery({
    queryKey: ["runManifest", id, manifestArtifact?.id ?? null],
    queryFn: () => api.manifest(id!, manifestArtifact!.id),
    enabled: pro && Boolean(id && manifestArtifact),
    staleTime: Infinity
  });
  const manifest = manifestQuery.data ?? null;

  const retry = useMutation({
    mutationFn: () => api.retry(id!),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["task", id] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : "重试失败")
  });
  const cancel = useMutation({
    mutationFn: () => api.cancel(id!),
    onSuccess: () => {
      setActionError(null);
      setConfirmCancel(false);
      void queryClient.invalidateQueries({ queryKey: ["task", id] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "取消失败");
      setConfirmCancel(false);
    }
  });

  if (taskQuery.isLoading) return <p className="section-empty">正在读取任务…</p>;
  if (!task || !view) {
    return (
      <div className="page">
        <h1>没有找到这个任务</h1>
        <Link className="ghost-button" to="/"><ArrowLeft size={15} /> 返回今天</Link>
      </div>
    );
  }

  const canRetry = task.status === "recoverable" || task.status === "failed";
  const canCancel = task.status !== "completed" && task.status !== "cancelled" && task.status !== "failed";
  const pendingApprovals = view.approvals.filter((approval) => approval.status === "pending");
  const timeline = [...view.events].reverse();
  const visibleEvents = showAllEvents ? timeline : timeline.slice(0, TIMELINE_TAIL);

  return (
    <div className="page detail-page">
      <div className="page-head">
        <div>
          <Link to="/" className="back-link"><ArrowLeft size={14} /> 今天</Link>
          <h1>{task.title}</h1>
          <p className="page-meta">
            <StatusPill status={task.status} />
            {task.templateId && <span className="mono">{task.templateId}</span>}
            {template && <span>{CATEGORY_LABELS[template.category] ?? template.category}</span>}
            <span>创建于 {relativeTime(task.createdAt)}</span>
            {pro && <span className="mono">更新 {relativeTime(task.updatedAt)}</span>}
          </p>
        </div>
        <div className="detail-actions">
          {canRetry && (
            <button className="primary-button" onClick={() => retry.mutate()} disabled={retry.isPending}>
              <RotateCcw size={15} className={retry.isPending ? "spin" : ""} /> 重试
            </button>
          )}
          {canCancel && !confirmCancel && (
            <button className="ghost-button" onClick={() => setConfirmCancel(true)} disabled={cancel.isPending}><X size={15} /> 取消任务</button>
          )}
          {canCancel && confirmCancel && (
            <span className="inline-confirm">
              <span>取消后不再继续执行{pro && task.currentRunId ? `，执行记录 ${task.currentRunId.slice(0, 8)}` : ""}。</span>
              <button className="ghost-button danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>确认取消</button>
              <button className="ghost-button" onClick={() => setConfirmCancel(false)}>返回</button>
            </span>
          )}
        </div>
      </div>

      <p className="state-line">
        <strong>{task.nextAction ?? statusExplanation(task)}</strong>
        {task.nextAction && <span>{statusExplanation(task)}</span>}
      </p>

      {actionError && <p className="form-error">{actionError}</p>}

      {task.error && (
        <section className="error-card">
          <strong>{task.error.message}</strong>
          <p>{task.error.guidance}</p>
          <p className="page-meta">错误类型 {task.error.kind} · {task.error.recoverable ? "可以恢复" : "需要人工处理"}</p>
        </section>
      )}

      <p className="effect-line">{externalEffectSummary(view.approvals, view.effects)}</p>

      {pendingApprovals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          effect={view.effects.find((effect) => effect.approvalId === approval.id)}
        />
      ))}

      <div className="detail-layout">
        <section className="panel">
          <div className="panel-head">
            <h2>事实记录</h2>
            <span className="panel-meta">{view.eventTotal} 条</span>
          </div>
          {pro ? (
            <EvidenceLog taskId={task.id} />
          ) : visibleEvents.length === 0 ? (
            <p className="section-empty">还没有事实记录。</p>
          ) : (
            <>
              <ul className="timeline">
                {visibleEvents.map((event) => (
                  <li key={event.seq}>
                    <span className="mono">{relativeTime(event.createdAt)}</span>
                    <span>{EVENT_LABELS[event.type] ?? event.type}</span>
                    <span className="truncate" title={eventDescription(event)}>{eventDescription(event)}</span>
                  </li>
                ))}
              </ul>
              {timeline.length > visibleEvents.length && (
                <button className="table-more" onClick={() => setShowAllEvents(true)}>显示更早的 {timeline.length - visibleEvents.length} 条</button>
              )}
              {showAllEvents && timeline.length > TIMELINE_TAIL && (
                <button className="table-more" onClick={() => setShowAllEvents(false)}>收起</button>
              )}
            </>
          )}
        </section>

        <aside className="detail-side">
          <section className="panel">
            <div className="panel-head"><h2>产物</h2><span className="panel-meta">{view.artifacts.length}</span></div>
            {view.artifacts.length === 0 ? (
              <p className="section-empty">任务完成后，文件会出现在这里。</p>
            ) : (
              <ul className="row-list">
                {view.artifacts.map((artifact) => (
                  <li key={artifact.id}>
                    <button className="list-row" onClick={() => setSelectedArtifact(artifact)}>
                      <FileText size={15} />
                      <span className="grow truncate" title={artifact.relativePath}>{artifact.relativePath}</span>
                      <span className="mono">{formatBytes(artifact.bytes)}</span>
                      <Download size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <div className="panel-head"><h2>输入</h2><span className="panel-meta">{task.inputs.length}</span></div>
            {task.inputs.length === 0 ? (
              <p className="section-empty">没有固定输入。</p>
            ) : (
              <ul className="row-list">
                {task.inputs.map((input, index) => (
                  <li key={`${input.label}-${index}`} className="list-row">
                    <span className="grow truncate" title={input.value}>{input.value}</span>
                    <span className="subtle">{input.kind}</span>
                  </li>
                ))}
              </ul>
            )}
            {task.networkHosts.length > 0 && (
              <p className="page-meta">允许联网域名：{task.networkHosts.join("、")}</p>
            )}
          </section>

          {template && (
            <section className="panel">
              <div className="panel-head"><h2>交付标准</h2></div>
              <ul className="plain-list">{template.expectedOutputs.map((output) => <li key={output}>{output}</li>)}</ul>
            </section>
          )}
        </aside>
      </div>

      {pro && (
        <>
          <ProSection title="执行记录" meta={`${view.runs.length} 次尝试`}>
            <RunLedger runs={view.runs} />
          </ProSection>

          <ProSection title="外部动作与确认">
            <EffectLedger effects={view.effects} approvals={view.approvals} />
          </ProSection>

          <ProSection title="产物完整性" meta={manifestQuery.isError ? "运行清单读取失败" : undefined}>
            <ArtifactIntegrity artifacts={view.artifacts} manifest={manifest} />
          </ProSection>

          <ProSection title="执行器与工作区">
            <ExecutorDetail run={latestRun} manifest={manifest} codex={healthQuery.data?.codex} />
          </ProSection>

          <section className="panel">
            <div className="panel-head"><h2>任务记录</h2></div>
            <dl className="kv-grid">
              <div><dt>输出目录</dt><dd className="mono select-all">{task.outputDir}</dd></div>
              <div><dt>任务 ID</dt><dd className="mono select-all">{task.id}</dd></div>
              <div><dt>当前执行记录</dt><dd className="mono select-all">{task.currentRunId ?? "无"}</dd></div>
            </dl>
          </section>
        </>
      )}

      {selectedArtifact && <ArtifactPreview artifact={selectedArtifact} onClose={() => setSelectedArtifact(null)} />}
    </div>
  );
}

function describeEvent(payload: unknown, type: string): string {
  if (payload === null || typeof payload !== "object") return EVENT_LABELS[type] ?? type;
  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.relativePath === "string") return record.relativePath;
  if (typeof record.status === "string") return String(record.status);
  return EVENT_LABELS[type] ?? type;
}

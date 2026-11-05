import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  Clock3,
  Download,
  FileText,
  FolderOpen,
  Hash,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  X
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { ArtifactPreview } from "../components/ArtifactPreview.tsx";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { api } from "../lib/api.ts";
import { CATEGORY_LABELS, EVENT_LABELS, formatBytes, formatDate, needsAttention, STATUS_LABELS } from "../lib/format.ts";
import type { ArtifactRecord, EventEnvelope, TaskRecord } from "../lib/types.ts";

export function TaskDetailPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactRecord | null>(null);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const taskQuery = useQuery({ queryKey: ["task", id], queryFn: () => api.task(id!), enabled: Boolean(id), refetchInterval: 4_000 });
  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: api.templates });
  const view = taskQuery.data;
  const task = view?.task;
  const template = templatesQuery.data?.templates.find((item) => item.id === task?.templateId);
  const latestRun = view?.runs.at(-1);
  const events = view ? [...view.events].reverse() : [];
  const visibleEvents = showAllEvents ? events : events.slice(0, 12);

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
      void queryClient.invalidateQueries({ queryKey: ["task", id] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : "取消失败")
  });

  if (taskQuery.isLoading) {
    return <div className="page loading-page"><Loader2 className="spin" size={26} /> 正在打开任务</div>;
  }
  if (!task || !view) {
    return (
      <div className="page loading-page">
        <AlertTriangle size={26} />
        <h1>没有找到这个任务</h1>
        <Link className="ghost-button" to="/"><ArrowLeft size={16} /> 返回今天</Link>
      </div>
    );
  }

  const canRetry = task.status === "recoverable" || task.status === "failed";
  const canCancel = task.status !== "completed" && task.status !== "cancelled" && task.status !== "failed";

  return (
    <div className="page detail-page">
      <Link to="/" className="back-link"><ArrowLeft size={16} /> 返回今天</Link>

      <header className="detail-header">
        <div className="detail-heading">
          <div className="detail-meta">
            <StatusPill status={task.status} />
            {task.templateId && <span className="mono-chip">{task.templateId}</span>}
            {template && <span>{CATEGORY_LABELS[template.category] ?? template.category}</span>}
            <span><Clock3 size={13} /> {formatDate(task.createdAt)}</span>
          </div>
          <h1>{task.title}</h1>
          <p>{task.goal}</p>
        </div>
        <div className="detail-actions">
          {canRetry && <button className="primary-button" onClick={() => retry.mutate()} disabled={retry.isPending}><RotateCcw size={16} className={retry.isPending ? "spin" : ""} /> 重试</button>}
          {canCancel && <button className="ghost-button danger" onClick={() => { if (window.confirm("确定取消这个任务吗？正在进行的运行会停止。")) cancel.mutate(); }} disabled={cancel.isPending}><X size={16} /> 取消任务</button>}
        </div>
      </header>

      <div className={`state-banner state-banner-${task.status}`}>
        <span className="state-banner-icon">{task.status === "running" ? <Loader2 className="spin" size={19} /> : needsAttention(task.status) ? <AlertTriangle size={19} /> : task.status === "completed" ? <CheckCircle2 size={19} /> : <CircleDot size={19} />}</span>
        <div>
          <strong>{task.nextAction ?? STATUS_LABELS[task.status]}</strong>
          <p>{statusExplanation(task)}</p>
        </div>
      </div>

      {actionError && <p className="form-error">{actionError}</p>}
      {task.error && (
        <section className="error-card">
          <span><ShieldAlert size={21} /></span>
          <div>
            <strong>{task.error.message}</strong>
            <p>{task.error.guidance}</p>
            <small>类型：{task.error.kind} · {task.error.recoverable ? "可以恢复" : "需要人工处理"}</small>
          </div>
        </section>
      )}

      {view.approvals.filter((approval) => approval.status === "pending").map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          effect={view.effects.find((effect) => effect.approvalId === approval.id)}
        />
      ))}

      <div className="detail-layout">
        <section className="panel timeline-panel">
          <div className="panel-head"><h2>执行记录</h2><span>{view.events.length} 条事件</span></div>
          <ol className="timeline">
            {visibleEvents.map((event) => (
              <li key={event.id} className={`timeline-item timeline-${event.type.replace(".", "-")}`}>
                <span className="timeline-dot">{eventIcon(event)}</span>
                <div>
                  <div className="timeline-title"><strong>{EVENT_LABELS[event.type] ?? event.type}</strong><time>{formatDate(event.createdAt)}</time></div>
                  <p>{eventDescription(event)}</p>
                </div>
              </li>
            ))}
          </ol>
          {events.length > visibleEvents.length && (
            <button className="timeline-more" onClick={() => setShowAllEvents(true)}>
              显示更早的 {events.length - visibleEvents.length} 条记录
            </button>
          )}
          {showAllEvents && events.length > 12 && (
            <button className="timeline-more" onClick={() => setShowAllEvents(false)}>收起执行记录</button>
          )}
          {view.events.length === 0 && <p className="section-empty">还没有执行记录。</p>}
        </section>

        <aside className="detail-side">
          <section className="panel side-panel">
            <div className="panel-head"><h2>产物</h2><span>{view.artifacts.length}</span></div>
            {view.artifacts.length === 0 ? (
              <p className="section-empty">任务完成后，文件会出现在这里。</p>
            ) : (
              <div className="artifact-list">
                {view.artifacts.map((artifact) => (
                  <button key={artifact.id} className="artifact-row" onClick={() => setSelectedArtifact(artifact)}>
                    <span><FileText size={17} /></span>
                    <div><strong>{artifact.relativePath.split("/").pop()}</strong><small>{formatBytes(artifact.bytes)}</small></div>
                    <Download size={15} />
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="panel side-panel">
            <div className="panel-head"><h2>任务信息</h2></div>
            <dl className="info-list">
              <div><dt>输出目录</dt><dd><FolderOpen size={14} /> {task.outputDir}</dd></div>
              <div><dt>最近运行</dt><dd>{latestRun ? `第 ${latestRun.attempt} 次 · ${latestRun.status}` : "尚未开始"}</dd></div>
              {latestRun?.usage && <div><dt>Token</dt><dd>{latestRun.usage.inputTokens.toLocaleString()} 输入 / {latestRun.usage.outputTokens.toLocaleString()} 输出</dd></div>}
              {latestRun?.threadId && <div><dt>执行线程</dt><dd><Hash size={13} /> {latestRun.threadId.slice(0, 12)}…</dd></div>}
              {task.deadline && <div><dt>截止时间</dt><dd>{formatDate(task.deadline)}</dd></div>}
            </dl>
          </section>

          <section className="panel side-panel">
            <div className="panel-head"><h2>输入</h2><span>{task.inputs.length}</span></div>
            <div className="input-list">
              {task.inputs.map((input, index) => (
                <div key={`${input.label}-${index}`} className="input-row">
                  <span>{input.kind === "file" ? <FileText size={15} /> : input.kind === "url" ? <Sparkles size={15} /> : <Hash size={15} />}</span>
                  <div><strong>{input.label}</strong><small>{input.value}</small></div>
                </div>
              ))}
              {task.inputs.length === 0 && <p className="section-empty">没有固定输入。</p>}
            </div>
            {task.networkHosts.length > 0 && <div className="host-chips">{task.networkHosts.map((host) => <span key={host}>{host}</span>)}</div>}
          </section>

          {template && (
            <section className="panel side-panel expected-panel">
              <div className="panel-head"><h2>交付标准</h2></div>
              <ul className="plain-list">{template.expectedOutputs.map((output) => <li key={output}>{output}</li>)}</ul>
            </section>
          )}
        </aside>
      </div>

      {selectedArtifact && <ArtifactPreview artifact={selectedArtifact} onClose={() => setSelectedArtifact(null)} />}
    </div>
  );
}

function statusExplanation(task: TaskRecord): string {
  if (task.status === "queued") return "已经进入队列，Hearth 会按顺序开始执行。";
  if (task.status === "running") return "Codex 正在隔离工作区中处理，进度会自动更新。";
  if (task.status === "waiting_approval") return "外部动作已经准备好，但不会在你确认前执行。";
  if (task.status === "waiting_input") return "还需要一份材料或一个选择，补齐后可以继续。";
  if (task.status === "recoverable") return "上一轮没有完成，已保留现有结果，可以从这里重试。";
  if (task.status === "completed") return "指定产物已保存并通过完整性检查。";
  if (task.status === "failed") return "任务没有完成，请查看失败原因和恢复建议。";
  return "这个任务不会再继续执行。";
}

function eventIcon(event: EventEnvelope) {
  if (event.type === "artifact.published") return <FileText size={14} />;
  if (event.type === "task.progress") return <Sparkles size={14} />;
  if (event.type === "approval.created" || event.type === "approval.updated") return <ShieldAlert size={14} />;
  return <CircleDot size={14} />;
}

function eventDescription(event: EventEnvelope): string {
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload) return EVENT_LABELS[event.type] ?? event.type;
  if (event.type === "task.progress") return String(payload.message ?? "正在处理");
  if (event.type === "task.updated" && typeof payload.status === "string") return `状态变为：${STATUS_LABELS[payload.status as keyof typeof STATUS_LABELS] ?? payload.status}`;
  if (event.type === "run.updated" && typeof payload.status === "string") return `运行状态：${payload.status}`;
  if (event.type === "artifact.published" && typeof payload.relativePath === "string") return payload.relativePath;
  if (event.type === "task.created") return "任务记录已经写入本地事件日志。";
  return EVENT_LABELS[event.type] ?? event.type;
}

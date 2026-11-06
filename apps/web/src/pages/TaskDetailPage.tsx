import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
  Square,
  XCircle
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatBytes, formatDuration, formatTime, formatTokens, relativeTime } from "../lib/format.ts";
import { executorLabel, taskKindLabel } from "../lib/labels.ts";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import type { ArtifactRecord, RunRecord, TaskDeliverable, TaskView } from "../lib/types.ts";

export function TaskDetailPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const taskQuery = useQuery({ queryKey: ["task", id], queryFn: () => api.task(id), enabled: Boolean(id), refetchInterval: 4_000 });
  const [preview, setPreview] = useState<{ artifact: TaskDeliverable; content: string | null; loading: boolean; error: string | null } | null>(null);

  const retry = useMutation({
    mutationFn: () => api.retry(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["task", id] })
  });
  const cancel = useMutation({
    mutationFn: () => api.cancel(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["task", id] })
  });

  if (taskQuery.isLoading) {
    return <div className="page"><div className="empty-panel"><Loader2 className="spin" /> 正在读取任务</div></div>;
  }
  if (taskQuery.isError || !taskQuery.data) {
    return (
      <div className="page">
        <Link className="back-link" to="/tasks"><ArrowLeft size={14} /> 返回任务</Link>
        <div className="empty-panel"><h2>没有找到这个任务</h2></div>
      </div>
    );
  }

  const view = taskQuery.data;
  const task = view.task;
  const deliverables = visibleDeliverables(view.artifacts, task.expectedOutputs);
  const progress = progressEvents(view);
  const { visible: visibleProgress, technical: technicalProgress } = splitProgress(progress);
  const pendingApprovals = view.approvals.filter((approval) => approval.status === "pending");
  const canRetry = task.status === "recoverable" || task.status === "failed" || task.status === "waiting_input";
  const canCancel = !["completed", "cancelled"].includes(task.status);

  async function openPreview(artifact: TaskDeliverable) {
    const isText = isTextArtifact(artifact);
    const isImage = artifact.mimeType.startsWith("image/");
    if (!isText && !isImage) {
      window.open(api.artifactUrl(task.id, artifact.id), "_blank", "noopener");
      return;
    }
    setPreview({ artifact, content: null, loading: isText, error: null });
    if (!isText) return;
    try {
      const response = await fetch(api.artifactUrl(task.id, artifact.id));
      if (!response.ok) throw new Error("读取失败");
      const content = await response.text();
      setPreview({ artifact, content, loading: false, error: null });
    } catch (error) {
      setPreview({ artifact, content: null, loading: false, error: error instanceof Error ? error.message : "读取失败" });
    }
  }

  return (
    <div className="page task-detail-page">
      <Link className="back-link" to="/tasks"><ArrowLeft size={14} /> 返回任务</Link>

      <div className="page-head">
        <div className="task-detail-title">
          <h1>{task.title}</h1>
          <p className="page-meta">{task.goal}</p>
        </div>
        <div className="detail-actions">
          <StatusPill status={task.status} />
          <button className="ghost-button" onClick={() => void taskQuery.refetch()} disabled={taskQuery.isFetching}>
            <RefreshCw size={14} className={taskQuery.isFetching ? "spin" : ""} /> 刷新
          </button>
          {canRetry && <button className="primary-button" onClick={() => retry.mutate()} disabled={retry.isPending}><RotateCcw size={14} /> {task.status === "waiting_input" ? "继续" : "重试"}</button>}
          {canCancel && <button className="ghost-button danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}><Square size={13} /> 取消</button>}
        </div>
      </div>

      <div className="task-meta-row">
        <span className={`phase-tag ${phaseTone(task.status)}`}>{phaseLabel(task.status, task.nextAction)}</span>
        <span className="executor-tag">{executorLabel(task.executorId)}</span>
        <span>{taskKindLabel(task.taskKind)}</span>
        <span><Clock3 size={13} /> {formatDuration(lastDuration(view.runs))}</span>
        <span>Token {formatTokens(lastUsage(view.runs))}</span>
        {view.checkpoints.length > 0 && <span>{view.checkpoints.length} 个检查点</span>}
        <span>更新于 {relativeTime(task.updatedAt)}</span>
      </div>

      {task.error && (
        <div className="result-banner error">
          <XCircle size={17} />
          <div>
            <strong>执行没有完成</strong>
            <p>{task.error.message}</p>
            {task.error.guidance && <small>{task.error.guidance}</small>}
          </div>
        </div>
      )}

      {pendingApprovals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} effect={view.effects.find((effect) => effect.id === approval.effectId)} />
      ))}

      <section className="panel result-panel">
        <div className="panel-head">
          <h2>结果</h2>
          <span className="panel-meta">{deliverables.length > 0 ? `${deliverables.length} 个交付文件` : "文字结果"}</span>
        </div>
        <div className="result-body">
          {task.resultSummary ? (
            <div className="chat-markdown result-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.resultSummary}</ReactMarkdown>
            </div>
          ) : task.status === "completed" ? (
            <p className="muted">执行完成，没有返回文字总结。请查看下面的交付文件。</p>
          ) : task.error ? (
            <p className="muted">本次执行失败，修正原因后可以重试。</p>
          ) : (
            <p className="muted">任务还在执行。当前阶段：{phaseLabel(task.status, task.nextAction)}。完成后结果会自动出现在这里。</p>
          )}

          {deliverables.length > 0 && (
            <div className="deliverable-list">
              {deliverables.map((artifact) => (
                <div key={artifact.id} className="deliverable-item">
                  <div className="deliverable-icon"><FileText size={17} /></div>
                  <div className="deliverable-info">
                    <strong>{artifact.name}</strong>
                    <small>{artifact.relativePath} · {formatBytes(artifact.bytes)}</small>
                  </div>
                  <button className="ghost-button" onClick={() => void openPreview(artifact)}>
                    {isTextArtifact(artifact) || artifact.mimeType.startsWith("image/") ? "预览" : "打开"}
                  </button>
                  <a className="icon-button" href={api.artifactUrl(task.id, artifact.id)} download={artifact.name} title="下载">
                    <Download size={15} />
                  </a>
                </div>
              ))}
            </div>
          )}

          {preview && (
            <div className="artifact-preview-panel">
              <div className="panel-head">
                <h2>{preview.artifact.name}</h2>
                <button className="icon-button" onClick={() => setPreview(null)} aria-label="关闭预览"><XCircle size={15} /></button>
              </div>
              {preview.loading && <div className="preview-loading"><Loader2 className="spin" size={16} /> 正在读取</div>}
              {preview.error && <p className="form-error">{preview.error}</p>}
              {preview.artifact.mimeType.startsWith("image/") && (
                <img className="artifact-image" src={api.artifactUrl(task.id, preview.artifact.id)} alt={preview.artifact.name} />
              )}
              {preview.content !== null && (
                isMarkdown(preview.artifact)
                  ? <div className="chat-markdown result-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.content}</ReactMarkdown></div>
                  : <pre className="artifact-text">{preview.content}</pre>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="panel process-panel">
        <details open={false}>
          <summary>
            <span>执行过程</span>
            <small>{executorLabel(task.executorId)} · {view.runs.length} 次运行 · {visibleProgress.length} 条进度 · 点击展开</small>
          </summary>
          <div className="process-body">
            {view.runs.map((run) => (
              <div key={run.id} className="run-card">
                <div className="run-head">
                  <strong>第 {run.attempt} 次执行</strong>
                  <span>{executorLabel(run.executorId)}</span>
                  <span className={`run-status ${run.status}`}>{runStatusLabel(run.status)}</span>
                  <span>{formatDuration(runDuration(run))}</span>
                  <span>Token {formatTokens(run.usage)}</span>
                </div>
                {run.failure && <p className="run-error">{run.failure.message}</p>}
              </div>
            ))}
            {visibleProgress.length > 0 ? (
              <ol className="progress-timeline">
                {visibleProgress.map((item) => (
                  <li key={item.seq}>
                    <span className="dot" />
                    <div>
                      <p>{item.message}</p>
                      <small>{formatTime(item.createdAt)}</small>
                    </div>
                  </li>
                ))}
              </ol>
            ) : <p className="muted">{technicalProgress.length > 0 ? "这个任务来自旧版本，执行命令已收进技术细节。" : "还没有执行进度记录。"}</p>}
            {technicalProgress.length > 0 && (
              <details className="technical-details">
                <summary>查看技术细节 · {technicalProgress.length} 条</summary>
                <ol className="progress-timeline technical">
                  {technicalProgress.map((event) => (
                    <li key={event.seq}>
                      <span className="dot" />
                      <div>
                        <p>{progressMessage(event)}</p>
                        <small>{formatTime(event.createdAt)}</small>
                      </div>
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {view.checkpoints.length > 0 && (
              <details className="technical-details">
                <summary>查看检查点 · {view.checkpoints.length} 个</summary>
                <ol className="progress-timeline technical">
                  {view.checkpoints.slice(-20).map((checkpoint) => (
                    <li key={checkpoint.id}>
                      <span className="dot" />
                      <div>
                        <p>第 {checkpoint.seq} 步 · {checkpoint.kind}</p>
                        <small>{formatTime(checkpoint.createdAt)}</small>
                      </div>
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {task.conversationId && (
              <Link className="back-link" to="/">来自对话 {task.conversationId.slice(0, 8)} <ChevronRight size={13} /></Link>
            )}
          </div>
        </details>
      </section>
    </div>
  );
}

function visibleDeliverables(artifacts: ArtifactRecord[], expectedOutputs?: string[]): TaskDeliverable[] {
  return artifacts
    .filter((artifact) => {
      const path = artifact.relativePath.replace(/\\/g, "/");
      if (path === "run-manifest.json" || path === "pr-preview.json") return false;
      if (path.startsWith("inputs/") || path.startsWith("runtime/") || path.startsWith(".hearth/")) return false;
      if (path.toLowerCase().endsWith(".json") && !isExpectedPath(path, expectedOutputs)) return false;
      return true;
    })
    .map((artifact) => ({
      id: artifact.id,
      name: artifact.relativePath.split("/").pop() ?? artifact.relativePath,
      relativePath: artifact.relativePath,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes
    }));
}

function isExpectedPath(path: string, expectedOutputs: string[] | undefined): boolean {
  if (!expectedOutputs) return true;
  return expectedOutputs.some((expected) => {
    const normalized = expected.replace(/\\/g, "/").replace(/\/+$/, "");
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

function progressEvents(view: TaskView) {
  return view.events
    .filter((event) => event.type === "task.progress")
    .slice(-120);
}

function progressMessage(event: TaskView["events"][number]): string {
  return String((event.payload as { message?: string }).message ?? "").trim();
}

function splitProgress(events: TaskView["events"]) {
  const visible: { seq: number; message: string; createdAt: string }[] = [];
  const technical: TaskView["events"] = [];
  const files = new Set<string>();
  let fileEntry: { seq: number; message: string; createdAt: string } | null = null;
  let lastMessage = "";

  for (const event of events) {
    const message = progressMessage(event);
    if (!message || isIgnorableProgress(message)) continue;
    if (message.startsWith("执行命令：") || message === "处理了一步工作") {
      technical.push(event);
      continue;
    }
    if (message.startsWith("修改文件：") || message.startsWith("文件修改失败：")) {
      const label = message.startsWith("文件修改失败") ? "文件修改失败" : "修改文件";
      const names = message.slice(message.indexOf("：") + 1).split("、").map(baseName).filter(Boolean);
      for (const name of names) files.add(name);
      if (!fileEntry) {
        fileEntry = { seq: event.seq, message: "", createdAt: event.createdAt };
        visible.push(fileEntry);
      }
      fileEntry.message = label + "：" + Array.from(files).slice(0, 5).join("、") + (files.size > 5 ? " 等" : "");
      continue;
    }
    if (message.startsWith("分析：") || message === "正在分析") {
      if (lastMessage !== "正在分析") {
        visible.push({ seq: event.seq, message: "正在分析", createdAt: event.createdAt });
        lastMessage = "正在分析";
      }
      continue;
    }
    if (message === lastMessage) continue;
    visible.push({ seq: event.seq, message, createdAt: event.createdAt });
    lastMessage = message;
  }
  return { visible, technical };
}

function baseName(path: string): string {
  const clean = path.trim().replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() || clean;
}

function isIgnorableProgress(message: string): boolean {
  return /model metadata|defaulting to fallback|fallback metadata|unknown model/i.test(message);
}

function runDuration(run: RunRecord): number | null {
  if (!run.startedAt || !run.endedAt) return null;
  const value = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function lastDuration(runs: RunRecord[]): number | null {
  const run = runs.at(-1);
  return run ? runDuration(run) : null;
}

function lastUsage(runs: RunRecord[]) {
  return runs.at(-1)?.usage ?? null;
}

function runStatusLabel(status: RunRecord["status"]): string {
  if (status === "completed") return "完成";
  if (status === "running") return "运行中";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  return status;
}

function phaseLabel(status: string, nextAction: string | null): string {
  if (status === "running") return nextAction || "正在执行";
  if (status === "queued") return "排队中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "recoverable") return "可以重试";
  if (status === "waiting_approval") return "等待确认";
  if (status === "waiting_input") return "等待补充";
  if (status === "cancelled") return "已取消";
  return status;
}

function phaseTone(status: string): string {
  if (status === "running") return "running";
  if (status === "completed") return "done";
  if (status === "failed" || status === "recoverable") return "problem";
  if (status === "waiting_approval" || status === "waiting_input") return "waiting";
  return "queued";
}

function isTextArtifact(artifact: TaskDeliverable): boolean {
  return artifact.mimeType.startsWith("text/") || artifact.mimeType.includes("json") || /\.(md|txt|csv|json|log|yml|yaml|ts|tsx|js|css|html)$/i.test(artifact.name);
}

function isMarkdown(artifact: TaskDeliverable): boolean {
  return artifact.mimeType.includes("markdown") || /\.(md|markdown)$/i.test(artifact.name);
}

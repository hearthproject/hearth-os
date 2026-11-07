import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Square,
  XCircle
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatBytes, formatDuration, formatTime, formatTokens, relativeTime } from "../lib/format.ts";
import { executorLabel, taskKindLabel } from "../lib/labels.ts";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import type { ArtifactRecord, ContextItem, ExecutorId, HandoffRecord, RunRecord, TaskContextResponse, TaskDeliverable, TaskProgressDetail, TaskView } from "../lib/types.ts";

export function TaskDetailPage() {
  const { id = "" } = useParams();
  const location = useLocation();
  const navState = location.state as { fromChat?: boolean; conversationId?: string } | null;
  const fromChat = Boolean(navState?.fromChat);
  const backTo = fromChat ? "/" : "/tasks";
  const backLabel = fromChat ? "返回对话" : "返回任务";
  const backState = fromChat && navState?.conversationId ? { conversationId: navState.conversationId } : undefined;
  const queryClient = useQueryClient();
  const taskQuery = useQuery({ queryKey: ["task", id], queryFn: () => api.task(id), enabled: Boolean(id), refetchInterval: 4_000 });
  const [preview, setPreview] = useState<{ artifact: TaskDeliverable; content: string | null; loading: boolean; error: string | null } | null>(null);
  const [resumeInput, setResumeInput] = useState("");
  const contextQuery = useQuery({ queryKey: ["task-context", id], queryFn: () => api.taskContext(id, { limit: 80 }), enabled: Boolean(id), refetchInterval: 4_000 });
  const pendingHandoff = contextQuery.data?.handoffs.find((item) => item.status === "pending_user") ?? null;

  const retry = useMutation({
    mutationFn: (message?: string) => api.retry(id, message),
    onSuccess: () => {
      setResumeInput("");
      void queryClient.invalidateQueries({ queryKey: ["task", id] });
    }
  });
  const confirmHandoff = useMutation({
    mutationFn: (executorId: ExecutorId) => api.confirmHandoff(id, executorId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task", id] });
      void queryClient.invalidateQueries({ queryKey: ["task-context", id] });
    }
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
        <Link className="back-link" to={backTo} state={backState}><ArrowLeft size={14} /> {backLabel}</Link>
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
  const canRetry = task.status === "recoverable" || task.status === "failed";
  const canCancel = !["completed", "cancelled"].includes(task.status);
  const active = ["queued", "running", "waiting_input", "waiting_approval"].includes(task.status);
  const recentProgress = visibleProgress.slice(-3);

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
      <Link className="back-link" to={backTo} state={backState}><ArrowLeft size={14} /> {backLabel}</Link>

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
          {canRetry && <button className="primary-button" onClick={() => retry.mutate(undefined)} disabled={retry.isPending}><RotateCcw size={14} /> 重试</button>}
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

      {pendingHandoff && (
        <section className="panel handoff-panel">
          <div className="panel-head">
            <h2>等待确认接管</h2>
            <span className="panel-meta">{executorLabel(pendingHandoff.fromExecutor)} → {executorLabel(pendingHandoff.toExecutor)}</span>
          </div>
          <div className="handoff-body">
            <div className="handoff-route">
              <span>{executorLabel(pendingHandoff.fromExecutor)}</span>
              <ArrowRight size={16} />
              <strong>{executorLabel(pendingHandoff.toExecutor)}</strong>
            </div>
            <p>{pendingHandoff.packet?.summary ?? pendingHandoff.diagnosis?.summary ?? pendingHandoff.reasonCode}</p>
            {pendingHandoff.diagnosis && (
              <small>诊断：{pendingHandoff.diagnosis.summary}（置信度 {Math.round(pendingHandoff.diagnosis.confidence * 100)}%）</small>
            )}
            {pendingHandoff.packet && pendingHandoff.packet.doNotRepeat.length > 0 && (
              <div className="handoff-caution"><ShieldAlert size={14} /> 不会重复：{pendingHandoff.packet.doNotRepeat.slice(0, 3).join("；")}</div>
            )}
            {confirmHandoff.isError && <p className="form-error">{confirmHandoff.error instanceof Error ? confirmHandoff.error.message : "确认接管失败"}</p>}
            <button className="primary-button" onClick={() => confirmHandoff.mutate(pendingHandoff.toExecutor)} disabled={confirmHandoff.isPending}>
              {confirmHandoff.isPending ? <Loader2 className="spin" size={14} /> : <ArrowRight size={14} />} 用 {executorLabel(pendingHandoff.toExecutor)} 继续
            </button>
          </div>
        </section>
      )}
      {task.status === "waiting_input" && (
        <section className="panel resume-panel">
          <div className="panel-head">
            <h2>需要你补充信息</h2>
            <span className="panel-meta">{executorLabel(task.executorId)} 暂停在这一步</span>
          </div>
          <div className="resume-body">
            {task.resultSummary && (
              <div className="chat-markdown result-markdown resume-question">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.resultSummary}</ReactMarkdown>
              </div>
            )}
            <textarea
              value={resumeInput}
              onChange={(event) => setResumeInput(event.target.value)}
              placeholder="补充后，任务会带着你的回答继续，不会从头重跑。"
              rows={3}
            />
            {retry.isError && <p className="form-error">{retry.error instanceof Error ? retry.error.message : "继续失败，请重试"}</p>}
            <div className="resume-actions">
              <button className="primary-button" onClick={() => retry.mutate(resumeInput.trim())} disabled={retry.isPending || !resumeInput.trim()}>
                {retry.isPending ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />} 继续执行
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="panel result-panel">
        <div className="panel-head">
          <h2>结果</h2>
          <span className="panel-meta">{deliverables.length > 0 ? `${deliverables.length} 个交付文件` : "文字结果"}</span>
        </div>
        <div className="result-body">
          {active && (
            <div className={`result-progress ${phaseTone(task.status)}`}>
              <div className="result-progress-head">
                <span className="result-progress-spinner" />
                <strong>{phaseLabel(task.status, task.nextAction)}</strong>
                <small>实时进度</small>
              </div>
              {recentProgress.length > 0 ? (
                <ol className="result-progress-list">
                  {recentProgress.map((item) => (
                    <li key={item.seq}>
                      <span>{item.message}</span>
                      <time>{formatTime(item.createdAt)}</time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="result-progress-empty">正在准备第一步，进度会实时显示在这里。</p>
              )}
            </div>
          )}
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

          {(task.status === "failed" || task.status === "recoverable") && task.error && (
            <div className="result-error-detail">
              <strong>{task.status === "recoverable" ? "执行中断，可以重试" : "执行失败"}</strong>
              <p>{task.error.message}</p>
              {task.error.guidance && <small>{task.error.guidance}</small>}
            </div>
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

      <ContextPanel
        view={view}
        context={contextQuery.data}
        loading={contextQuery.isLoading}
        error={contextQuery.isError ? (contextQuery.error instanceof Error ? contextQuery.error.message : "上下文读取失败") : null}
      />
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
                      <ProgressDetails details={item.details} />
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
                        <ProgressDetails details={[progressDetail(event)]} />
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

function ContextPanel({ view, context, loading, error }: {
  view: TaskView;
  context: TaskContextResponse | undefined;
  loading: boolean;
  error: string | null;
}) {
  const handoffs = context?.handoffs ?? [];
  const latestHandoff = [...handoffs].reverse()[0] ?? null;
  const state = context?.state ?? null;
  const timeline = context ? [...context.items.items].reverse().slice(-20) : [];
  return (
    <section className="panel context-panel">
      <div className="panel-head">
        <h2>执行链路 / 上下文</h2>
        <span className="panel-meta">{view.runs.length} 次运行 · {handoffs.length} 次接管 · {context?.items.total ?? 0} 条上下文</span>
      </div>
      <div className="context-body">
        {loading && <p className="muted"><Loader2 className="spin" size={14} /> 正在读取上下文账本</p>}
        {error && <p className="form-error">{error}</p>}
        <div className="context-section">
          <h3>执行链路</h3>
          <div className="context-chain">
            {view.runs.map((run) => {
              const handoff = handoffs.find((item) => item.toRunId === run.id);
              return (
                <div key={run.id} className="chain-entry">
                  {handoff && (
                    <div className="chain-handoff">
                      <span>{executorLabel(handoff.fromExecutor)}</span>
                      <ArrowRight size={14} />
                      <strong>{executorLabel(handoff.toExecutor)}</strong>
                      <small>{handoff.packet?.summary ?? handoff.reasonCode}</small>
                    </div>
                  )}
                  <div className="chain-run">
                    <strong>第 {run.attempt} 次</strong>
                    <span>{executorLabel(run.executorId)}</span>
                    <span className={`run-status ${run.status}`}>{runStatusLabel(run.status)}</span>
                    <span>{formatDuration(runDuration(run))}</span>
                    <span>Token {formatTokens(run.usage)}</span>
                  </div>
                  {run.failure && <p className="run-error">{run.failure.message}</p>}
                </div>
              );
            })}
            {view.runs.length === 0 && <p className="muted">还没有运行记录。</p>}
          </div>
        </div>
        <div className="context-section">
          <h3>任务摘要</h3>
          {state?.summary ? <pre className="context-summary">{state.summary}</pre> : <p className="muted">本轮结束后会生成任务级摘要。</p>}
          {state?.lastFailure && (
            <div className="context-failure"><ShieldAlert size={14} /><span>{state.lastFailure.message}</span></div>
          )}
        </div>
        <div className="context-section">
          <h3>产物清单</h3>
          {state && state.artifacts.length > 0 ? (
            <ul className="context-artifacts">
              {state.artifacts.map((artifact) => (
                <li key={artifact.artifactId}>
                  <span>{artifact.path}</span>
                  <code>{artifact.sha256.slice(0, 12)}</code>
                  <small>{formatBytes(artifact.bytes)}</small>
                </li>
              ))}
            </ul>
          ) : <p className="muted">还没有已登记产物。</p>}
        </div>
        <div className="context-section">
          <h3>上下文时间线</h3>
          {timeline.length > 0 ? (
            <ol className="context-timeline">
              {timeline.map((item) => (
                <li key={item.id}>
                  <span className="context-kind">{contextKindLabel(item.kind)}</span>
                  <p>{previewText(item.content)}</p>
                  <small>{formatTime(item.createdAt)} · {item.executorId ? executorLabel(item.executorId) : "Hearth"}</small>
                </li>
              ))}
            </ol>
          ) : <p className="muted">执行器事件会依次记录到这里。</p>}
        </div>
        {latestHandoff?.packet && (
          <div className="context-section">
            <h3>最近一次接管包</h3>
            <p>{latestHandoff.packet.summary}</p>
            <dl className="context-kv">
              <div><dt>下一步</dt><dd>{latestHandoff.packet.nextAction}</dd></div>
              <div><dt>剩余预算</dt><dd>{latestHandoff.packet.remainingBudget.maxTurns} turns · {latestHandoff.packet.remainingBudget.maxTokens} tokens</dd></div>
              <div><dt>产物</dt><dd>{latestHandoff.packet.artifacts.map((item) => item.path).join("、") || "无"}</dd></div>
              <div><dt>不要重复</dt><dd>{latestHandoff.packet.doNotRepeat.join("；") || "无"}</dd></div>
            </dl>
          </div>
        )}
      </div>
    </section>
  );
}

function contextKindLabel(kind: ContextItem["kind"]): string {
  const labels: Record<ContextItem["kind"], string> = {
    user_message: "用户消息",
    task_input: "任务输入",
    assistant_message: "执行器回复",
    tool_call: "工具调用",
    tool_result: "工具结果",
    artifact: "产物",
    checkpoint: "检查点",
    failure: "失败",
    diagnosis: "诊断",
    handoff: "接管",
    decision: "决策",
    summary: "摘要",
    memory_recall: "记忆召回",
    method: "方法注入",
    usage: "用量",
    notice: "通知"
  };
  return labels[kind];
}

function previewText(text: string, max = 260): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
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
  const visible: { seq: number; message: string; createdAt: string; details: TaskProgressDetail[] }[] = [];
  const technical: TaskView["events"] = [];
  const files = new Set<string>();
  let fileEntry: { seq: number; message: string; createdAt: string; details: TaskProgressDetail[] } | null = null;
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
        fileEntry = { seq: event.seq, message: "", createdAt: event.createdAt, details: [] };
        visible.push(fileEntry);
      }
      const detail = progressDetail(event);
      if (detail) fileEntry.details.push(detail);
      fileEntry.message = label + "：" + Array.from(files).slice(0, 5).join("、") + (files.size > 5 ? " 等" : "");
      continue;
    }
    if (message.startsWith("分析：") || message === "正在分析") {
      if (lastMessage !== "正在分析") {
        const detail = progressDetail(event);
        visible.push({ seq: event.seq, message: "正在分析", createdAt: event.createdAt, details: detail ? [detail] : [] });
        lastMessage = "正在分析";
      }
      continue;
    }
    if (message === lastMessage) continue;
    const detail = progressDetail(event);
    visible.push({ seq: event.seq, message, createdAt: event.createdAt, details: detail ? [detail] : [] });
    lastMessage = message;
  }
  return { visible, technical };
}

function progressDetail(event: TaskView["events"][number]): TaskProgressDetail | null {
  const detail = (event.payload as { detail?: unknown }).detail;
  return detail && typeof detail === "object" ? detail as TaskProgressDetail : null;
}

function ProgressDetails({ details }: { details: Array<TaskProgressDetail | null> }) {
  const present = details.filter((detail): detail is TaskProgressDetail => Boolean(detail));
  if (present.length === 0) return null;
  return (
    <div className="progress-raw-group">
      {present.map((detail, index) => (
        <details className="progress-raw" key={index}>
          <summary>查看原始输出{detail.title ? ` · ${detail.title}` : ""}</summary>
          <pre>{formatProgressDetail(detail)}</pre>
        </details>
      ))}
    </div>
  );
}

function formatProgressDetail(detail: TaskProgressDetail): string {
  return JSON.stringify(detail, null, 2);
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

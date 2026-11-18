import { TaskTokens } from "../components/TaskTokens.tsx";
import { markTasksRead } from "../lib/task-read-state.ts";
import { useEffect, useState, useId, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  Gauge,
  Loader2,
  Pin,
  PinOff,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Square,
  Trash2,
  XCircle
} from "lucide-react";
import { ApiError, api } from "../lib/api.ts";
import { formatBytes, formatDuration, formatTime, formatTokens, relativeTime } from "../lib/format.ts";
import { executorLabel, executionModeLabel, taskKindLabel } from "../lib/labels.ts";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { TaskFollowUpPanel } from "../components/TaskFollowUpPanel.tsx";
import { TaskGitPanel } from "../components/TaskGitPanel.tsx";
import { TaskWorktreePanel } from "../components/TaskWorktreePanel.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import type { ArtifactRecord, ExecutorId, GoalCompletionReport, GoalContract, RunRecord, TaskDeliverable, TaskProgressDetail, TaskView } from "../lib/types.ts";

export function TaskDetailPage() {
  const { id = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const navState = location.state as { fromChat?: boolean; conversationId?: string } | null;
  const fromChat = Boolean(navState?.fromChat);
  const backTo = fromChat ? "/" : "/tasks";
  const backLabel = fromChat ? "返回对话" : "返回任务";
  const backState = fromChat && navState?.conversationId ? { conversationId: navState.conversationId } : undefined;
  const queryClient = useQueryClient();
  const taskQuery = useQuery({ queryKey: ["task", id], queryFn: () => api.task(id), enabled: Boolean(id), refetchInterval: 4_000 });
  useEffect(() => {
    if (taskQuery.data?.task) markTasksRead([taskQuery.data.task]);
  }, [taskQuery.data?.task]);
  const overviewQuery = useQuery({ queryKey: ["task-overview", id, taskQuery.data?.task.title, taskQuery.data?.task.goal, taskQuery.data?.task.resultSummary, taskQuery.data?.task.status], queryFn: () => api.taskOverview(id), enabled: Boolean(taskQuery.data), staleTime: Infinity, retry: false });
  const [processOpen, setProcessOpen] = useState(false);
  const processStatus = taskQuery.data?.task.status;
  useEffect(() => {
    setProcessOpen(Boolean(processStatus && !["completed", "failed", "cancelled", "recoverable"].includes(processStatus)));
  }, [id, processStatus]);
  const [preview, setPreview] = useState<{ artifact: TaskDeliverable; content: string | null; loading: boolean; error: string | null } | null>(null);
  const [resumeInput, setResumeInput] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const contextQuery = useQuery({ queryKey: ["task-context", id], queryFn: () => api.taskContext(id, { limit: 1 }), enabled: Boolean(id), refetchInterval: 4_000 });
  const methodsQuery = useQuery({ queryKey: ["methods"], queryFn: api.methods, refetchInterval: 30_000 });
  const pendingHandoff = contextQuery.data?.handoffs.find((item) => item.status === "pending_user") ?? null;

  const retry = useMutation({
    mutationFn: (message?: string) => api.retry(id, message),
    onSuccess: () => {
      setResumeInput("");
      void queryClient.invalidateQueries({ queryKey: ["task", id] });
    }
  });
  const extendBudget = useMutation({
    mutationFn: (mode?: "standard" | "deep") => api.extendBudget(id, mode),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task", id] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
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
  const organize = useMutation({
    mutationFn: (patch: { pinned?: boolean; archived?: boolean }) => api.setTaskOrganization(id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task", id] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    }
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
  const boundMethod = task.methodId
    ? methodsQuery.data?.methods.find((method) => method.id === task.methodId) ?? null
    : null;
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

  async function deleteCurrentTask() {
    if (!window.confirm("将任务移入回收站？可以从回收站恢复。")) return;
    setDeleteError(null);
    try {
      await api.deleteTask(task.id);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "TASK_RUNNING") {
        const confirmed = window.confirm("任务正在运行。取消当前运行并把任务移入回收站吗？");
        if (!confirmed) return;
        try {
          await api.deleteTask(task.id, true);
        } catch (retryError) {
          setDeleteError(retryError instanceof Error ? retryError.message : "删除任务失败");
          return;
        }
      } else {
        setDeleteError(caught instanceof Error ? caught.message : "删除任务失败");
        return;
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    await queryClient.invalidateQueries({ queryKey: ["trash"] });
    navigate("/tasks");
  }

  return (
    <div className="page task-detail-page">
      <Link className="back-link" to={backTo} state={backState}><ArrowLeft size={14} /> {backLabel}</Link>

      <div className="page-head">
        <div className="task-detail-title">
          <h1>{task.title}</h1>
          <div className="task-overview" aria-live="polite">
            {overviewQuery.isPending ? <p>正在生成任务摘要…</p> : overviewQuery.data ? <p>{overviewQuery.data.summary}</p> : <p>摘要暂不可用。<button className="ghost-button" onClick={() => void overviewQuery.refetch()}>重试</button></p>}
          </div>
          <details className="task-original-request"><summary>原始需求</summary><p>{task.goal}</p></details>
        </div>
        <div className="detail-actions">
          <StatusPill status={task.status} />
          <button
            className="ghost-button"
            onClick={() => organize.mutate({ pinned: !task.pinnedAt })}
            disabled={organize.isPending}
          >
            {task.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />} {task.pinnedAt ? "取消置顶" : "置顶"}
          </button>
          <button
            className="ghost-button"
            onClick={() => organize.mutate({ archived: !task.archivedAt })}
            disabled={organize.isPending}
          >
            {task.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />} {task.archivedAt ? "恢复" : "归档"}
          </button>
          <button className="ghost-button" onClick={() => void taskQuery.refetch()} disabled={taskQuery.isFetching}>
            <RefreshCw size={14} className={taskQuery.isFetching ? "spin" : ""} /> 刷新
          </button>
          {canRetry && <button className="primary-button" onClick={() => retry.mutate(undefined)} disabled={retry.isPending}><RotateCcw size={14} /> 重试</button>}
          {task.status === "waiting_budget" && (
            <button className="primary-button" onClick={() => extendBudget.mutate(undefined)} disabled={extendBudget.isPending}>
              {extendBudget.isPending ? <Loader2 className="spin" size={14} /> : <Gauge size={14} />} 预算翻倍并继续（模式不变）
            </button>
          )}
          {canCancel && <button className="ghost-button danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}><Square size={13} /> 取消</button>}
          <button className="ghost-button danger" onClick={() => void deleteCurrentTask()}><Trash2 size={13} /> 移入回收站</button>
        </div>
      </div>

      <div className="task-meta-row">
        <span className={`phase-tag ${phaseTone(task.status)}`}>{phaseLabel(task.status, task.nextAction)}</span>
        <span className="executor-tag">{executorLabel(task.executorId)}</span>
        <span>{taskKindLabel(task.taskKind)}</span>
        <span className="task-mode-tag">{executionModeLabel(task.executionMode)}</span>
        {task.pinnedAt && <span><Pin size={13} /> 已置顶</span>}
        {task.archivedAt && <span><Archive size={13} /> 已归档</span>}
        {boundMethod && <span>方法 {boundMethod.name} · v{boundMethod.version}</span>}
        <span><Clock3 size={13} /> {formatDuration(lastDuration(view.runs))}</span>
        <span>Token <TaskTokens usage={lastUsage(view.runs)} /></span>
        {view.checkpoints.length > 0 && <span>{view.checkpoints.length} 个检查点</span>}
        <span>更新于 {relativeTime(task.updatedAt)}</span>
      </div>
      {organize.isError && <p className="form-error">{organize.error instanceof Error ? organize.error.message : "更新任务整理状态失败"}</p>}
      {deleteError && <p className="form-error">{deleteError}</p>}

      {task.status === "waiting_budget" ? (
        <div className="result-banner budget">
          <Gauge size={17} />
          <div>
            <strong>预算已触顶，等待扩展</strong>
            <p>{task.error?.message ?? "本轮执行达到预算上限，工作区和检查点已保留。"}</p>
            <small>预算翻倍保留当前模式；升级模式会应用对应的执行策略与额度。已使用的预算不会清零。</small>
            {(task.executionMode ?? "standard") !== "deep" && <button className="ghost-button" disabled={extendBudget.isPending} onClick={() => extendBudget.mutate(task.executionMode === "quick" ? "standard" : "deep")}>
              {task.executionMode === "quick" ? "升级标准模式并继续" : "升级深入模式并继续"}
            </button>}
            {extendBudget.isError && <small className="form-error">{extendBudget.error instanceof Error ? extendBudget.error.message : "扩展预算失败"}</small>}
            <button className="primary-button" onClick={() => extendBudget.mutate(undefined)} disabled={extendBudget.isPending}>
              {extendBudget.isPending ? <Loader2 className="spin" size={14} /> : <Gauge size={14} />} 预算翻倍并继续（模式不变）
            </button>
          </div>
        </div>
      ) : task.error && (
        <div className="result-banner error">
          <XCircle size={17} />
          <div>
            <strong>执行没有完成</strong>
            <p>{task.error.message}</p>
            {task.error.guidance && <small>{task.error.guidance}</small>}
          </div>
        </div>
      )}

      {view.goal && <GoalCompletionPanel goal={view.goal} report={view.completionReport} />}

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

      <TaskFollowUpPanel taskId={task.id} status={task.status} followUps={view.followUps} />

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

      <TaskGitPanel taskId={task.id} />
      <TaskWorktreePanel taskId={task.id} />

      <section className="panel process-panel">
        <button className="process-toggle" aria-expanded={processOpen} aria-controls="task-process-content" onClick={() => setProcessOpen((open) => !open)}>
            <span>执行过程</span>
            <small>{executorLabel(task.executorId)} · {view.runs.length} 次运行 · {visibleProgress.length} 条进度 · {processOpen ? "点击收起" : "点击展开"}</small>
        </button>
        <div id="task-process-content" className={`animated-disclosure ${processOpen ? "is-open" : ""}`} aria-hidden={!processOpen} ref={(node) => { if (node) node.inert = !processOpen; }}>
          <div className="disclosure-clip"><div className="process-body">
            {view.runs.map((run) => (
              <div key={run.id} className="run-card">
                <ExpandableOutput className="run-head" details={progress.filter((event) => event.runId === run.id).map(progressDetail)} label={`查看第 ${run.attempt} 次执行的原始输出`}>
                  <strong>第 {run.attempt} 次执行</strong>
                  <span>{formatDuration(runDuration(run))}</span>
                  <span>{executorLabel(run.executorId)}</span>
                  <span className={`run-status ${run.status}`}>{runStatusLabel(run.status)}</span>
                  <span>Token {formatTokens(run.usage)}</span>
                </ExpandableOutput>
                {run.failure && <p className="run-error">{run.failure.message}</p>}
              </div>
            ))}
            {visibleProgress.length > 0 ? (
              <ol className="progress-timeline">
                {visibleProgress.map((item) => (
                  <li key={item.seq}>
                    <span className="dot" />
                    <div>
                      <ExpandableOutput className="progress-entry-head" details={item.details} label="查看原始输出">
                        <p>{item.message}</p><small>{formatTime(item.createdAt)}</small>
                      </ExpandableOutput>
                    </div>
                  </li>
                ))}
              </ol>
            ) : <p className="muted">{technicalProgress.length > 0 ? "这个任务来自旧版本，执行命令已收进技术细节。" : "还没有执行进度记录。"}</p>}
            {technicalProgress.length > 0 && (
              <ProcessDisclosure label={`查看技术细节 · ${technicalProgress.length} 条`}>
                <ol className="progress-timeline technical">
                  {technicalProgress.map((event) => (
                    <li key={event.seq}>
                      <span className="dot" />
                      <div>
                        <ExpandableOutput className="progress-entry-head" details={[progressDetail(event)]} label="查看原始输出">
                          <p>{progressMessage(event)}</p><small>{formatTime(event.createdAt)}</small>
                        </ExpandableOutput>
                      </div>
                    </li>
                  ))}
                </ol>
              </ProcessDisclosure>
            )}
            {view.checkpoints.length > 0 && (
              <ProcessDisclosure label={`查看检查点 · ${view.checkpoints.length} 个`}>
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
              </ProcessDisclosure>
            )}
            {task.conversationId && (
              <Link className="back-link" to="/">来自对话 {task.conversationId.slice(0, 8)} <ChevronRight size={13} /></Link>
            )}
          </div></div>
        </div>
      </section>
    </div>
  );
}

function GoalCompletionPanel({ goal, report }: { goal: GoalContract; report: GoalCompletionReport | null }) {
  const resultById = new Map((report?.criteria ?? []).map((criterion) => [criterion.criterionId, criterion]));
  return (
    <section className="panel goal-panel">
      <div className="panel-head">
        <h2>目标与完成证据</h2>
        <span className={`goal-verdict ${report?.verdict ?? "pending"}`}>
          {report ? completionVerdictLabel(report.verdict) : "尚未判定"}
        </span>
      </div>
      <div className="goal-body">
        <div className="goal-summary">
          <p>{goal.objective}</p>
          <div className="goal-meta">
            <span>{goalStateLabel(goal.currentState)}</span>
            <span>{goal.successCriteria.filter((criterion) => criterion.required).length} 项必需验收</span>
            {goal.deadline && <span>截止 {formatTime(goal.deadline)}</span>}
          </div>
        </div>
        {goal.nextHandoff && (
          <div className="goal-next">
            <strong>下一步</strong>
            <span>{goal.nextHandoff}</span>
          </div>
        )}
        <ol className="goal-criteria">
          {goal.successCriteria.map((criterion) => {
            const result = resultById.get(criterion.id);
            const status = result?.status ?? "not_run";
            return (
              <li key={criterion.id} className={`goal-criterion ${status}`}>
                <span className="goal-criterion-state">{criterionResultLabel(status)}</span>
                <div>
                  <strong>{criterion.description}</strong>
                  <small>{criterion.validator} · {criterion.required ? "必需" : "可选"}</small>
                  {result?.detail && <p>{result.detail}</p>}
                  {result && result.evidenceRefs.length > 0 && (
                    <details className="goal-evidence">
                      <summary>{result.evidenceRefs.length} 条证据</summary>
                      <ul>{result.evidenceRefs.map((ref) => <li key={ref}>{ref}</li>)}</ul>
                    </details>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {report && report.missingEvidence.length > 0 && (
          <div className="goal-missing">
            <strong>仍缺少证据</strong>
            <ul>{report.missingEvidence.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        )}
        {report && report.forbiddenActions.length > 0 && (
          <div className="goal-missing">
            <strong>发生禁止动作</strong>
            <ul>{report.forbiddenActions.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        )}
        {report ? (
          <p className="goal-report-summary">{report.summary} · 判定于 {formatTime(report.checkedAt)}</p>
        ) : (
          <p className="goal-report-summary">任务结束后会按上述标准逐条核验，执行器自述不算完成。</p>
        )}
      </div>
    </section>
  );
}

function completionVerdictLabel(verdict: GoalCompletionReport["verdict"]): string {
  if (verdict === "pass") return "已通过";
  if (verdict === "fail") return "未通过";
  if (verdict === "blocked") return "等待对账";
  return "需要你确认";
}

function goalStateLabel(state: GoalContract["currentState"]): string {
  if (state === "draft") return "草稿";
  if (state === "active") return "进行中";
  if (state === "blocked") return "受阻";
  if (state === "awaiting_user") return "等待你";
  if (state === "validating") return "正在验收";
  if (state === "done") return "已完成";
  if (state === "failed") return "失败";
  return "已取消";
}

function criterionResultLabel(status: "passed" | "failed" | "not_run" | "not_required"): string {
  if (status === "passed") return "已证明";
  if (status === "failed") return "未通过";
  if (status === "not_required") return "可选未跑";
  return "未运行";
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

function ProcessDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="process-extra">
    <button className="process-extra-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
      <span>{label}</span><ChevronRight size={13} />
    </button>
    <div id={id} className={`animated-disclosure ${open ? "is-open" : ""}`} aria-hidden={!open} ref={(node) => { if (node) node.inert = !open; }}>
      <div className="disclosure-clip">{children}</div>
    </div>
  </div>;
}

function ExpandableOutput({ children, details, label, className }: {
  children: ReactNode; details: Array<TaskProgressDetail | null>; label: string; className: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const present = details.filter((detail): detail is TaskProgressDetail => Boolean(detail));
  return <div className="expandable-output">
    <div className={className}>
      {children}
      {present.length > 0 && <button className="raw-output-toggle" aria-label={label} title={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}><ChevronRight size={13} /></button>}
    </div>
    {present.length > 0 && <div id={id} className={`animated-disclosure ${open ? "is-open" : ""}`} aria-hidden={!open} ref={(node) => { if (node) node.inert = !open; }}>
      <div className="disclosure-clip"><div className="progress-raw">
        {present.map((detail, index) => <pre key={index}>{formatProgressDetail(detail)}</pre>)}
      </div></div>
    </div>}
  </div>;
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

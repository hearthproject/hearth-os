import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FlaskConical, GitBranch, Play, RotateCcw, Sparkles, XCircle } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState } from "../components/EmptyState.tsx";
import { api } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";
import type { MethodCandidate, MethodMetrics, MethodStatus, MethodVerdict, TaskRecord } from "../lib/types.ts";

const STATUS_LABELS: Record<MethodStatus, string> = {
  candidate: "候选",
  evaluating: "评估中",
  trial: "试跑中",
  adopted: "已采用",
  rejected: "已拒绝",
  reverted: "已回退"
};

const VERDICT_LABELS: Record<MethodVerdict, string> = {
  insufficient: "样本不足",
  improved: "有改进",
  flat: "持平",
  regressed: "回归"
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "recoverable"]);

export function MethodsPage() {
  const queryClient = useQueryClient();
  const [sourceTaskId, setSourceTaskId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const snapshotQuery = useQuery({ queryKey: ["methods"], queryFn: api.methods, refetchInterval: 20_000 });
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 15_000 });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["methods"] });
  const terminalTasks = (tasksQuery.data?.tasks ?? []).filter((task) => TERMINAL_STATUSES.has(task.status));

  const generateMutation = useMutation({
    mutationFn: (taskId: string) => api.generateMethod({ taskId }),
    onSuccess: (method) => {
      setNotice("已从任务轨迹生成候选方法：" + method.name);
      setSourceTaskId("");
      refresh();
    },
    onError: (error: Error) => setNotice(error.message)
  });

  const snapshot = snapshotQuery.data;
  const methods = snapshot?.methods ?? [];
  const adoptedCount = methods.filter((method) => method.status === "adopted").length;

  return (
    <div className="page methods-page">
      <div className="page-head">
        <h1>方法进化</h1>
        <span className="page-meta">候选只继承或收窄来源权限；Shadow 只读取已有轨迹，不触发外部副作用。</span>
        <span className="page-meta">已采用 {adoptedCount} 个 · 共 {methods.length} 个候选</span>
      </div>

      {snapshotQuery.isError && <p className="form-error">{snapshotQuery.error.message}</p>}
      {notice && <p className="page-meta">{notice}</p>}

      <section className="panel">
        <div className="panel-head"><h2>从任务轨迹生成候选</h2><span className="panel-meta">成功与失败终态都可复盘</span></div>
        <div className="method-generate-row">
          <select value={sourceTaskId} onChange={(event) => setSourceTaskId(event.target.value)}>
            <option value="">选择已完成、失败或可恢复的任务</option>
            {terminalTasks.map((task) => (
              <option value={task.id} key={task.id}>{task.title} · {task.status}</option>
            ))}
          </select>
          <button className="primary-button" disabled={!sourceTaskId || generateMutation.isPending} onClick={() => generateMutation.mutate(sourceTaskId)}>
            <Sparkles size={15} /> 生成候选
          </button>
        </div>
        {terminalTasks.length === 0 && <p className="section-empty">还没有可供复盘的任务轨迹。</p>}
      </section>

      {snapshotQuery.isLoading && <p className="section-empty">正在读取候选方法…</p>}
      {snapshot && methods.length === 0 && (
        <section className="panel"><EmptyState title="还没有候选方法" body="先完成一个任务，再从它的输入、运行、审批和产物记录生成候选。候选不会自动上线。" /></section>
      )}

      <div className="method-list">
        {methods.map((method) => (
          <MethodCard
            key={method.id}
            method={method}
            tasks={terminalTasks}
            trialTaskIds={(snapshot?.trials ?? []).filter((trial) => trial.methodId === method.id).map((trial) => trial.taskId)}
            evaluationCount={(snapshot?.evaluations ?? []).filter((evaluation) => evaluation.methodId === method.id).length}
            onNotice={setNotice}
            onRefresh={refresh}
          />
        ))}
      </div>
    </div>
  );
}

function MethodCard({
  method,
  tasks,
  trialTaskIds,
  evaluationCount,
  onNotice,
  onRefresh
}: {
  method: MethodCandidate;
  tasks: TaskRecord[];
  trialTaskIds: string[];
  evaluationCount: number;
  onNotice: (message: string) => void;
  onRefresh: () => void;
}) {
  const [trialTaskId, setTrialTaskId] = useState("");
  const readOnly = ["adopted", "rejected", "reverted"].includes(method.status);
  const availableTrials = tasks.filter((task) => !method.sourceTaskIds.includes(task.id) && !trialTaskIds.includes(task.id));
  const sourceTitles = new Map(tasks.map((task) => [task.id, task.title]));

  const trialMutation = useMutation({
    mutationFn: () => api.recordMethodTrial(method.id, trialTaskId),
    onSuccess: () => { onNotice("已记录无外部副作用的试跑样本。"); setTrialTaskId(""); onRefresh(); },
    onError: (error: Error) => onNotice(error.message)
  });
  const evaluateMutation = useMutation({
    mutationFn: () => api.evaluateMethod(method.id, { baselineTaskIds: method.sourceTaskIds, trialTaskIds, notes: "来源任务对试跑样本" }),
    onSuccess: (evaluation) => { onNotice("评估完成：" + VERDICT_LABELS[evaluation.verdict] + "。"); onRefresh(); },
    onError: (error: Error) => onNotice(error.message)
  });
  const promoteMutation = useMutation({
    mutationFn: () => api.promoteMethod(method.id),
    onSuccess: () => { onNotice("候选方法已晋升；可在同一页面演练回退。"); onRefresh(); },
    onError: (error: Error) => onNotice(error.message)
  });
  const rollbackMutation = useMutation({
    mutationFn: (reason: string) => api.rollbackMethod(method.id, reason),
    onSuccess: () => { onNotice("方法已回退，原因已写入审计。"); onRefresh(); },
    onError: (error: Error) => onNotice(error.message)
  });
  const rejectMutation = useMutation({
    mutationFn: () => api.rejectMethod(method.id, "用户拒绝"),
    onSuccess: () => { onNotice("候选方法已拒绝。"); onRefresh(); },
    onError: (error: Error) => onNotice(error.message)
  });

  return (
    <article className={"panel method-card status-" + method.status}>
      <div className="method-head">
        <div>
          <div className="suggestion-kicker">
            <span className="tag">{STATUS_LABELS[method.status]}</span>
            <span className="tag">v{method.version}</span>
            {method.evaluationVerdict && <span className={"tag verdict-" + method.evaluationVerdict}>{VERDICT_LABELS[method.evaluationVerdict]}</span>}
            {method.templateId && <span className="tag">{method.templateId}</span>}
          </div>
          <h2>{method.name}</h2>
          <p>{method.summary}</p>
        </div>
        <span className="panel-meta">{relativeTime(method.updatedAt)}</span>
      </div>

      <div className="method-body">
        <div className="method-section">
          <h3>适用与步骤</h3>
          <p>{method.applicability}</p>
          <ol className="method-steps">{method.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        </div>

        <div className="method-section">
          <h3>权限交集与护栏</h3>
          <div className="method-tags">{method.allowedCapabilities.length > 0 ? method.allowedCapabilities.map((capability) => <span className="tag" key={capability}>{capability}</span>) : <span className="tag">无额外能力</span>}</div>
          <ul className="method-guardrails">{method.guardrails.map((guardrail) => <li key={guardrail}>{guardrail}</li>)}</ul>
        </div>
      </div>

      <div className="method-metrics">
        <MetricColumn title="基线" metrics={method.baseline} />
        <MetricColumn title="试跑" metrics={method.trial} />
        <div className="method-metric-notes">
          <span>来源任务 {method.sourceTaskIds.length} 个</span>
          <span>试跑样本 {trialTaskIds.length} 个</span>
          <span>评估记录 {evaluationCount} 条</span>
        </div>
      </div>

      <div className="method-sources">
        <GitBranch size={14} />
        {method.sourceTaskIds.map((taskId) => <Link key={taskId} to={"/tasks/" + taskId}>{sourceTitles.get(taskId) ?? taskId.slice(0, 8)}</Link>)}
      </div>

      {!readOnly && (
        <div className="method-actions">
          <div className="method-trial-picker">
            <select value={trialTaskId} onChange={(event) => setTrialTaskId(event.target.value)}>
              <option value="">选择试跑样本</option>
              {availableTrials.map((task) => <option value={task.id} key={task.id}>{task.title} · {task.status}</option>)}
            </select>
            <button className="ghost-button" disabled={!trialTaskId || trialMutation.isPending} onClick={() => trialMutation.mutate()}><FlaskConical size={15} /> 记录试跑</button>
          </div>
          <button className="ghost-button" disabled={trialTaskIds.length === 0 || evaluateMutation.isPending} onClick={() => evaluateMutation.mutate()}><Play size={15} /> 对照评估</button>
          {method.status === "trial" && method.evaluationVerdict === "improved" && (
            <button className="primary-button" disabled={promoteMutation.isPending} onClick={() => promoteMutation.mutate()}><CheckCircle2 size={15} /> 晋升</button>
          )}
          <button className="ghost-button danger" disabled={rejectMutation.isPending} onClick={() => rejectMutation.mutate()}><XCircle size={15} /> 拒绝</button>
        </div>
      )}

      {method.status === "adopted" && (
        <div className="method-actions">
          <span className="page-meta">已采用方法仍需保留原有审批与权限边界。</span>
          <button className="ghost-button danger" disabled={rollbackMutation.isPending} onClick={() => {
            const reason = window.prompt("回退原因（会写入审计）", "观测到回归，恢复上一方法");
            if (reason?.trim()) rollbackMutation.mutate(reason.trim());
          }}><RotateCcw size={15} /> 回退</button>
        </div>
      )}
    </article>
  );
}

function MetricColumn({ title, metrics }: { title: string; metrics: MethodMetrics }) {
  return (
    <div className="method-metric-column">
      <strong>{title}</strong>
      <span>{metrics.tasks} 个任务 · 成功 {metrics.completed}</span>
      <span>成功率 {metrics.successRate === null ? "—" : Math.round(metrics.successRate * 100) + "%"}</span>
      <span>平均耗时 {metrics.avgDurationMs === null ? "—" : Math.round(metrics.avgDurationMs / 1000) + "s"}</span>
      <span>Tokens {metrics.inputTokens + metrics.outputTokens} · 审批 {metrics.approvals}</span>
    </div>
  );
}

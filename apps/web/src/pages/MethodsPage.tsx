import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FlaskConical, GitBranch, Play, Power, RotateCcw, Sparkles, XCircle } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState } from "../components/EmptyState.tsx";
import { api } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";
import type { MethodCandidate, MethodMetrics, MethodSnapshot, MethodStatus, MethodVerdict, TaskRecord } from "../lib/types.ts";

const STATUS_LABELS: Record<MethodStatus, string> = {
  candidate: "候选技能",
  evaluating: "评估中",
  trial: "试跑中",
  adopted: "已采用",
  rejected: "已拒绝",
  reverted: "已回退",
  superseded: "已被取代"
};

const VERDICT_LABELS: Record<MethodVerdict, string> = {
  insufficient: "样本不足",
  improved: "有改进",
  flat: "持平",
  regressed: "回归"
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "recoverable"]);
const ASSIGNABLE_STATUSES = new Set(["queued", "failed", "recoverable", "waiting_input"]);

export function MethodsPage() {
  const queryClient = useQueryClient();
  const [sourceTaskId, setSourceTaskId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const snapshotQuery = useQuery({ queryKey: ["methods"], queryFn: api.methods, refetchInterval: 20_000 });
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 15_000 });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["methods"] });
  const tasks = tasksQuery.data?.tasks ?? [];
  const terminalTasks = tasks.filter((task) => TERMINAL_STATUSES.has(task.status));

  const generateMutation = useMutation({
    mutationFn: (taskId: string) => api.generateMethod({ taskId }),
    onSuccess: (method) => {
      setNotice("已从任务轨迹生成候选技能：" + method.name);
      setSourceTaskId("");
      refresh();
    },
    onError: (error: Error) => setNotice(error.message)
  });

  const snapshot = snapshotQuery.data;
  const methods = snapshot?.methods ?? [];
  const adoptedCount = methods.filter((method) => method.status === "adopted").length;
  const autoLearn = snapshot?.settings.autoLearn ?? true;
  const settingsMutation = useMutation({
    mutationFn: (next: boolean) => api.saveMethodSettings({ autoLearn: next }),
    onSuccess: (result) => {
      setNotice(result.settings.autoLearn ? "自动学习已开启。" : "自动学习已关闭。");
      refresh();
    },
    onError: (error: Error) => setNotice(error.message)
  });

  return (
    <div className="page methods-page">
      <div className="page-head">
        <h1>技能库</h1>
        <span className="page-meta">候选技能只继承或收窄来源权限；已采用技能按模板注入，可审计、可回退。</span>
        <span className="page-meta">已采用 {adoptedCount} 个 · 共 {methods.length} 个候选技能 · {snapshot?.applications.length ?? 0} 次注入</span>
      </div>

      <div className="task-meta-row">
        <span className={`phase-tag ${autoLearn ? "good" : "warn"}`}>
          <Power size={13} /> {autoLearn ? "自动学习已开启" : "自动学习已关闭"}
        </span>
        <button className="ghost-button" disabled={!snapshot || settingsMutation.isPending} onClick={() => settingsMutation.mutate(!autoLearn)}>
          {autoLearn ? "关闭自动学习" : "开启自动学习"}
        </button>
      </div>

      {snapshotQuery.isError && <p className="form-error">{snapshotQuery.error.message}</p>}
      {notice && <p className="page-meta">{notice}</p>}

      <section className="panel">
        <div className="panel-head"><h2>从任务轨迹生成候选技能</h2><span className="panel-meta">成功与失败终态都可复盘；相同指纹不会重复生成</span></div>
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

      {snapshotQuery.isLoading && <p className="section-empty">正在读取候选技能…</p>}
      {snapshot && methods.length === 0 && (
        <section className="panel"><EmptyState title="还没有候选技能" body="完成任务后会自动生成候选，也可以手动选择任务轨迹生成。候选不会自动上线。" /></section>
      )}

      <div className="method-list">
        {methods.map((method) => (
          <MethodCard
            key={method.id}
            method={method}
            tasks={tasks}
            assignableTasks={tasks.filter((task) => ASSIGNABLE_STATUSES.has(task.status))}
            trialTaskIds={(snapshot?.trials ?? []).filter((trial) => trial.methodId === method.id).map((trial) => trial.taskId)}
            applications={(snapshot?.applications ?? []).filter((application) => application.methodId === method.id)}
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
  assignableTasks,
  trialTaskIds,
  applications,
  evaluationCount,
  onNotice,
  onRefresh
}: {
  method: MethodCandidate;
  tasks: TaskRecord[];
  assignableTasks: TaskRecord[];
  trialTaskIds: string[];
  applications: MethodSnapshot["applications"];
  evaluationCount: number;
  onNotice: (message: string) => void;
  onRefresh: () => void;
}) {
  const [assignTaskId, setAssignTaskId] = useState("");
  const readOnly = ["adopted", "rejected", "reverted", "superseded"].includes(method.status);
  const taskTitles = new Map(tasks.map((task) => [task.id, task.title]));
  const titleFor = (taskId: string) => taskTitles.get(taskId) ?? taskId.slice(0, 8);
  const recentApplications = applications.slice(0, 5);
  const generation = method.generation == null ? null : method.generation;

  const createTrialMutation = useMutation({
    mutationFn: () => api.createTask({
      ...(method.templateId ? { templateId: method.templateId } : {}),
      methodId: method.id
    }),
    onSuccess: (task) => { onNotice("已创建试跑任务：" + task.title + "。任务完成后会自动记录有注入证据的试跑。"); onRefresh(); },
    onError: (error: Error) => onNotice(error.message)
  });
  const assignMutation = useMutation({
    mutationFn: () => api.assignTaskMethod(assignTaskId, method.id),
    onSuccess: (task) => { onNotice("已把技能绑定到任务：" + task.title + "。"); setAssignTaskId(""); onRefresh(); },
    onError: (error: Error) => onNotice(error.message)
  });
  const evaluateMutation = useMutation({
    mutationFn: async () => {
      const pairing = await api.methodPairing(method.id);
      if (pairing.baselineTaskIds.length === 0 || pairing.trialTaskIds.length === 0) {
        throw new Error("没有可用的配对样本：" + pairing.notes.join("；"));
      }
      return api.evaluateMethod(method.id, {
        baselineTaskIds: pairing.baselineTaskIds,
        trialTaskIds: pairing.trialTaskIds,
        notes: pairing.notes.join("；")
      });
    },
    onSuccess: (evaluation) => { onNotice("评估完成：" + VERDICT_LABELS[evaluation.verdict] + "。"); onRefresh(); },
    onError: (error: Error) => onNotice(error.message)
  });
  const promoteMutation = useMutation({
    mutationFn: () => api.promoteMethod(method.id),
    onSuccess: (promoted) => { onNotice("候选技能已晋升为第 " + (promoted.generation ?? 1) + " 代；同模板新任务会自动使用。"); onRefresh(); },
    onError: (error: Error) => onNotice(error.message)
  });
  const rollbackMutation = useMutation({
    mutationFn: (reason: string) => api.rollbackMethod(method.id, reason),
    onSuccess: () => { onNotice("技能已回退；上一代如有记录会自动恢复。"); onRefresh(); },
    onError: (error: Error) => onNotice(error.message)
  });
  const rejectMutation = useMutation({
    mutationFn: () => api.rejectMethod(method.id, "用户拒绝"),
    onSuccess: () => { onNotice("候选技能已拒绝。"); onRefresh(); },
    onError: (error: Error) => onNotice(error.message)
  });

  return (
    <article className={"panel method-card status-" + method.status}>
      <div className="method-head">
        <div>
          <div className="suggestion-kicker">
            <span className="tag">{STATUS_LABELS[method.status]}</span>
            <span className="tag">{generation == null ? `v${method.version}` : `第 ${generation} 代`}</span>
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
          <span>试跑样本 {trialTaskIds.length} 个 · 需 ≥ 2</span>
          <span>评估记录 {evaluationCount} 条</span>
          {method.fingerprint && <span>指纹 {method.fingerprint.slice(0, 8)}</span>}
          {method.previousVersionId && <span>上一代 {method.previousVersionId.slice(0, 8)}</span>}
        </div>
      </div>

      <div className="method-sources">
        <GitBranch size={14} />
        {method.sourceTaskIds.map((taskId) => <Link key={taskId} to={"/tasks/" + taskId}>{titleFor(taskId)}</Link>)}
      </div>

      <div className="method-section">
        <h3>注入记录</h3>
        {recentApplications.length > 0 ? (
          <ul className="method-guardrails">
            {recentApplications.map((application) => (
              <li key={application.id}>
                <Link to={"/tasks/" + application.taskId}>{titleFor(application.taskId)}</Link>
                {" · "}{application.selection === "pinned" ? "显式绑定" : "模板自动"}
                {" · run "}{application.runId.slice(0, 8)}
                {" · "}{relativeTime(application.createdAt)}
              </li>
            ))}
          </ul>
        ) : <p className="muted">还没有注入记录。试跑任务或同模板任务执行后会出现在这里。</p>}
        {trialTaskIds.length > 0 && (
          <p className="page-meta">试跑任务：{trialTaskIds.map((taskId) => <Link key={taskId} to={"/tasks/" + taskId}>{titleFor(taskId)}</Link>)}</p>
        )}
      </div>

      {!readOnly && (
        <div className="method-actions">
          {method.templateId ? (
            <button
              className="ghost-button"
              disabled={createTrialMutation.isPending}
              onClick={() => createTrialMutation.mutate()}
            >
              <FlaskConical size={15} /> 创建试跑任务（{method.templateId}）
            </button>
          ) : (
            <div className="method-trial-picker">
              <select value={assignTaskId} onChange={(event) => setAssignTaskId(event.target.value)}>
                <option value="">绑定到已有任务</option>
                {assignableTasks.map((task) => <option value={task.id} key={task.id}>{task.title} · {task.status}</option>)}
              </select>
              <button className="ghost-button" disabled={!assignTaskId || assignMutation.isPending} onClick={() => assignMutation.mutate()}>
                应用技能
              </button>
            </div>
          )}
          <button className="ghost-button" disabled={evaluateMutation.isPending} onClick={() => evaluateMutation.mutate()}>
            <Play size={15} /> 对照评估（2+2）
          </button>
          {method.status === "trial" && method.evaluationVerdict === "improved" && (
            <button className="primary-button" disabled={promoteMutation.isPending} onClick={() => promoteMutation.mutate()}>
              <CheckCircle2 size={15} /> 晋升
            </button>
          )}
          <button className="ghost-button danger" disabled={rejectMutation.isPending} onClick={() => rejectMutation.mutate()}>
            <XCircle size={15} /> 拒绝
          </button>
        </div>
      )}

      {method.status === "adopted" && (
        <div className="method-actions">
          <span className="page-meta">已采用技能会按模板自动注入同模板新任务；原有审批与权限边界不变。</span>
          <button className="ghost-button danger" disabled={rollbackMutation.isPending} onClick={() => {
            const reason = window.prompt("回退原因（会写入审计）", "观测到回归，恢复上一技能");
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
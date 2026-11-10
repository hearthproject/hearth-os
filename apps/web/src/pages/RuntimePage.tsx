import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Clock3, Eye, Pause, Play, RefreshCw, Save, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import { formatDate, relativeTime } from "../lib/format.ts";
import type {
  BackgroundToolJob,
  IntakeDecision,
  IntakeDecisionRecord,
  IntakeRouteResult,
  PreparedActionRecord,
  ThreadDeliveryView,
  ThreadSubscriptionRecord,
  WatchdogEvent,
  WatchdogSettingsView
} from "../lib/types.ts";

const PREPARED_KIND_LABELS: Record<PreparedActionRecord["kind"], string> = {
  draft_email: "邮件草稿",
  calendar_check: "日历检查",
  research: "调研",
  test_run: "测试",
  diff: "差异"
};
const PREPARED_STATUS_LABELS: Record<PreparedActionRecord["status"], string> = {
  prepared: "待提交",
  committed: "已提交",
  discarded: "已放弃",
  expired: "已过期"
};
const TOOL_STATUS_LABELS: Record<BackgroundToolJob["status"], string> = {
  queued: "排队中",
  running: "运行中",
  finished: "已完成",
  failed: "失败",
  stopped: "已停止"
};
const SUBSCRIPTION_STATUS_LABELS: Record<ThreadSubscriptionRecord["status"], string> = {
  active: "监听中",
  paused: "已暂停",
  ended: "已结束"
};
const INTAKE_LABELS: Record<IntakeDecision, string> = {
  ignore: "忽略",
  chat: "聊天",
  task: "任务",
  attention: "注意力"
};
const WATCHDOG_REASON_LABELS: Record<string, string> = {
  task_stalled: "任务停滞",
  run_over_budget: "运行超时",
  repeated_failures: "连续失败",
  background_tool_failed: "后台工具异常"
};

type Notice = { tone: "ok" | "error"; text: string };

export function RuntimePage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [intakeDraft, setIntakeDraft] = useState({ sourceRef: "manual:1", sender: "", channel: "manual", text: "" });
  const [lastRoute, setLastRoute] = useState<IntakeRouteResult | null>(null);

  const preparedQuery = useQuery({ queryKey: ["prepared-actions"], queryFn: () => api.preparedActions({ limit: 100 }), refetchInterval: 15_000 });
  const toolsQuery = useQuery({ queryKey: ["background-tools"], queryFn: () => api.backgroundTools({ limit: 100 }), refetchInterval: 10_000 });
  const subscriptionsQuery = useQuery({ queryKey: ["thread-subscriptions"], queryFn: () => api.threadSubscriptions(), refetchInterval: 15_000 });
  const deliveriesQuery = useQuery({ queryKey: ["thread-deliveries"], queryFn: () => api.threadDeliveries(100), refetchInterval: 10_000 });
  const watchdogQuery = useQuery({ queryKey: ["watchdog"], queryFn: api.watchdog, refetchInterval: 20_000 });
  const intakeQuery = useQuery({ queryKey: ["intake"], queryFn: () => api.intakeDecisions(100), refetchInterval: 20_000 });

  const refreshRuntime = () => {
    for (const key of ["prepared-actions", "background-tools", "thread-subscriptions", "thread-deliveries", "watchdog", "intake"]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };

  const preparedMutation = useMutation({
    mutationFn: (input: { id: string; action: "commit" | "discard"; approvalRef?: string }) =>
      input.action === "discard"
        ? api.discardPreparedAction(input.id)
        : api.commitPreparedAction(input.id, input.approvalRef ? { approvalRef: input.approvalRef } : {}),
    onSuccess: (_record, input) => {
      setNotice({ tone: "ok", text: input.action === "discard" ? "预备动作已放弃。" : "预备动作已提交。" });
      refreshRuntime();
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message })
  });
  const toolStopMutation = useMutation({
    mutationFn: (id: string) => api.stopBackgroundTool(id, "用户在运行控制台停止"),
    onSuccess: () => {
      setNotice({ tone: "ok", text: "后台工具已请求停止。" });
      refreshRuntime();
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message })
  });
  const subscriptionMutation = useMutation({
    mutationFn: (input: { id: string; action: "pause" | "resume" | "end" }) => api.threadSubscriptionAction(input.id, input.action),
    onSuccess: (_record, input) => {
      setNotice({ tone: "ok", text: `线程订阅已${input.action === "pause" ? "暂停" : input.action === "resume" ? "恢复" : "结束"}。` });
      refreshRuntime();
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message })
  });
  const watchdogScanMutation = useMutation({
    mutationFn: api.scanWatchdog,
    onSuccess: (result) => {
      setNotice({ tone: "ok", text: result.events.length > 0 ? `扫描完成，记录 ${result.events.length} 个看门狗事件。` : "扫描完成，没有新的看门狗事件。" });
      refreshRuntime();
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message })
  });
  const watchdogSettingsMutation = useMutation({
    mutationFn: api.updateWatchdogSettings,
    onSuccess: () => {
      setNotice({ tone: "ok", text: "看门狗设置已更新。" });
      refreshRuntime();
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message })
  });
  const intakeMutation = useMutation({
    mutationFn: () => api.routeIntake({
      sourceRef: intakeDraft.sourceRef.trim(),
      text: intakeDraft.text.trim(),
      ...(intakeDraft.sender.trim() ? { sender: intakeDraft.sender.trim() } : {}),
      ...(intakeDraft.channel.trim() ? { channel: intakeDraft.channel.trim() } : {})
    }),
    onSuccess: (result) => {
      setLastRoute(result);
      setNotice({ tone: "ok", text: `路由结果：${INTAKE_LABELS[result.route]}（置信度 ${Math.round(result.confidence * 100)}%）。` });
      refreshRuntime();
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message })
  });

  const prepared = preparedQuery.data?.actions ?? [];
  const tools = toolsQuery.data?.jobs ?? [];
  const subscriptions = subscriptionsQuery.data?.subscriptions ?? [];
  const deliveries = deliveriesQuery.data?.deliveries ?? [];
  const watchdog = watchdogQuery.data;
  const intakeDecisions = intakeQuery.data?.decisions ?? [];

  function commitPrepared(record: PreparedActionRecord) {
    let approvalRef: string | undefined;
    if (record.kind === "draft_email" || record.kind === "calendar_check") {
      const answer = window.prompt("外部动作必须绑定审批。请输入本条动作的 approval ID；没有审批请取消。", "");
      if (answer === null) return;
      approvalRef = answer.trim();
      if (!approvalRef) {
        setNotice({ tone: "error", text: "外部动作需要审批引用，不能直接提交。" });
        return;
      }
    }
    preparedMutation.mutate({ id: record.id, action: "commit", ...(approvalRef ? { approvalRef } : {}) });
  }

  return (
    <div className="page runtime-page">
      <div className="page-head">
        <div>
          <h1>运行控制台</h1>
          <p className="page-meta">查看代理准备做什么、正在后台跑什么，以及看门狗、Intake 和线程订阅的审计记录。</p>
        </div>
        <button className="ghost-button" onClick={refreshRuntime} disabled={preparedQuery.isFetching || toolsQuery.isFetching}>
          <RefreshCw size={15} className={preparedQuery.isFetching ? "spin" : ""} /> 刷新
        </button>
      </div>

      <div className="stat-line">
        <span><Activity size={13} /> 待提交动作 {prepared.filter((item) => item.status === "prepared").length}</span>
        <span><Clock3 size={13} /> 后台运行 {tools.filter((item) => ["queued", "running"].includes(item.status)).length}</span>
        <span><Eye size={13} /> 活跃订阅 {subscriptions.filter((item) => item.status === "active").length}</span>
      </div>

      {notice && <p className={`settings-notice ${notice.tone}`}>{notice.text}</p>}

      <section className="panel table-panel">
        <div className="panel-head">
          <h2><Clock3 size={16} /> 预备动作</h2>
          <span className="panel-meta">预备不等于授权；外部动作提交时必须绑定审批</span>
        </div>
        {prepared.length === 0 ? (
          <p className="section-empty">还没有预备动作。</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>动作</th><th>任务</th><th>预览</th><th>参数摘要</th><th>过期</th><th>操作</th></tr></thead>
            <tbody>
              {prepared.map((record) => (
                <tr key={record.id}>
                  <td>
                    <div className="suggestion-kicker">
                      <span className="tag">{PREPARED_KIND_LABELS[record.kind]}</span>
                      <span className="tag">{PREPARED_STATUS_LABELS[record.status]}</span>
                    </div>
                    <span className="page-meta mono">{record.id}</span>
                  </td>
                  <td>{record.taskId ? <Link className="link-button" to={"/tasks/" + record.taskId}>查看任务</Link> : "—"}</td>
                  <td><pre className="runtime-preview">{formatJson(record.preview)}</pre></td>
                  <td className="mono" title={record.actionDigest}>{shorten(record.actionDigest, 16)}</td>
                  <td>{record.expiresAt ? formatDate(record.expiresAt) : "不过期"}</td>
                  <td>
                    {record.status === "prepared" ? (
                      <div className="runtime-actions">
                        <button className="primary-button" onClick={() => commitPrepared(record)} disabled={preparedMutation.isPending}>提交</button>
                        <button className="ghost-button danger" onClick={() => preparedMutation.mutate({ id: record.id, action: "discard" })} disabled={preparedMutation.isPending}>放弃</button>
                      </div>
                    ) : <span className="page-meta">{relativeTime(record.updatedAt)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel table-panel">
        <div className="panel-head">
          <h2><Activity size={16} /> 后台工具</h2>
          <span className="panel-meta">非只读工具必须先通过审批通道</span>
        </div>
        {tools.length === 0 ? (
          <p className="section-empty">还没有后台工具任务。</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>工具</th><th>状态</th><th>任务</th><th>输出</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>
              {tools.map((job) => (
                <tr key={job.id}>
                  <td><strong>{job.toolName}</strong><span className="page-meta mono">{job.id}</span></td>
                  <td><span className="tag">{TOOL_STATUS_LABELS[job.status]}</span>{job.exitCode !== null && <span className="page-meta">退出码 {job.exitCode}</span>}</td>
                  <td>{job.taskId ? <Link className="link-button" to={"/tasks/" + job.taskId}>查看任务</Link> : "—"}</td>
                  <td><pre className="runtime-output">{shorten(job.output || job.stopReason || "暂无输出", 360)}</pre></td>
                  <td><span title={job.createdAt}>{relativeTime(job.createdAt)}</span></td>
                  <td>
                    {["queued", "running"].includes(job.status) ? (
                      <button className="ghost-button danger" onClick={() => toolStopMutation.mutate(job.id)} disabled={toolStopMutation.isPending}><Square size={13} /> 停止</button>
                    ) : <span className="page-meta">{job.finishedAt ? formatDate(job.finishedAt) : "—"}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2><AlertTriangle size={16} /> 看门狗</h2>
          <button className="ghost-button" onClick={() => watchdogScanMutation.mutate()} disabled={watchdogScanMutation.isPending}>
            <RefreshCw size={14} className={watchdogScanMutation.isPending ? "spin" : ""} /> 立即扫描
          </button>
        </div>
        {watchdog ? (
          <WatchdogSettingsForm
            settings={watchdog.settings}
            busy={watchdogSettingsMutation.isPending}
            onSave={(settings) => watchdogSettingsMutation.mutate(settings)}
          />
        ) : <p className="section-empty">正在读取看门狗设置…</p>}
        {watchdog && watchdog.events.length > 0 ? (
          <div className="table-panel">
            <table className="data-table">
              <thead><tr><th>原因</th><th>动作</th><th>任务</th><th>说明</th><th>时间</th></tr></thead>
              <tbody>
                {watchdog.events.map((event) => <WatchdogRow key={event.id} event={event} />)}
              </tbody>
            </table>
          </div>
        ) : <p className="section-empty">没有看门狗事件。</p>}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Intake 决策</h2>
          <span className="panel-meta">先判断来料应忽略、聊天、转任务还是提醒</span>
        </div>
        <form className="runtime-intake-form" onSubmit={(event) => { event.preventDefault(); intakeMutation.mutate(); }}>
          <label>来源引用<input value={intakeDraft.sourceRef} onChange={(event) => setIntakeDraft((current) => ({ ...current, sourceRef: event.target.value }))} placeholder="mail:123 / manual:1" /></label>
          <label>发件人<input value={intakeDraft.sender} onChange={(event) => setIntakeDraft((current) => ({ ...current, sender: event.target.value }))} placeholder="可选" /></label>
          <label>渠道<input value={intakeDraft.channel} onChange={(event) => setIntakeDraft((current) => ({ ...current, channel: event.target.value }))} placeholder="mail / manual" /></label>
          <label className="span-2">内容<textarea value={intakeDraft.text} onChange={(event) => setIntakeDraft((current) => ({ ...current, text: event.target.value }))} placeholder="粘贴一段来料，测试路由结果" rows={3} /></label>
          <div className="runtime-form-actions">
            <button className="primary-button" type="submit" disabled={intakeMutation.isPending || !intakeDraft.sourceRef.trim() || !intakeDraft.text.trim()}>路由这条来料</button>
            {lastRoute && <span className="page-meta">最近：{INTAKE_LABELS[lastRoute.route]} · {lastRoute.reason}</span>}
          </div>
        </form>
        {intakeDecisions.length > 0 ? (
          <div className="table-panel">
            <table className="data-table">
              <thead><tr><th>来源</th><th>路由</th><th>置信度</th><th>理由</th><th>时间</th></tr></thead>
              <tbody>
                {intakeDecisions.map((record) => <IntakeRow key={record.id} record={record} />)}
              </tbody>
            </table>
          </div>
        ) : <p className="section-empty">还没有 Intake 决策记录。</p>}
      </section>

      <section className="panel table-panel">
        <div className="panel-head">
          <h2>线程订阅</h2>
          <span className="panel-meta">只投递订阅之后发生的新事件</span>
        </div>
        {subscriptions.length === 0 ? (
          <p className="section-empty">还没有线程订阅。</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>线程</th><th>任务</th><th>状态</th><th>游标</th><th>过滤器</th><th>操作</th></tr></thead>
            <tbody>
              {subscriptions.map((record) => (
                <tr key={record.id}>
                  <td><strong>{record.threadKey}</strong><span className="page-meta mono">{record.id}</span></td>
                  <td><Link className="link-button" to={"/tasks/" + record.taskId}>查看任务</Link></td>
                  <td><span className="tag">{SUBSCRIPTION_STATUS_LABELS[record.status]}</span></td>
                  <td className="mono">{record.cursor ?? "—"}</td>
                  <td><pre className="runtime-preview">{formatJson(record.filter)}</pre></td>
                  <td>
                    <div className="runtime-actions">
                      {record.status === "active" && <button className="ghost-button" onClick={() => subscriptionMutation.mutate({ id: record.id, action: "pause" })} disabled={subscriptionMutation.isPending}><Pause size={13} /> 暂停</button>}
                      {record.status === "paused" && <button className="ghost-button" onClick={() => subscriptionMutation.mutate({ id: record.id, action: "resume" })} disabled={subscriptionMutation.isPending}><Play size={13} /> 恢复</button>}
                      {record.status !== "ended" && <button className="ghost-button danger" onClick={() => subscriptionMutation.mutate({ id: record.id, action: "end" })} disabled={subscriptionMutation.isPending}><Trash2 size={13} /> 结束</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel table-panel">
        <div className="panel-head">
          <h2>最近投递</h2>
          <span className="panel-meta">{deliveries.length} 条</span>
        </div>
        {deliveries.length === 0 ? (
          <p className="section-empty">还没有线程投递记录。</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>订阅</th><th>事件</th><th>任务</th><th>序号</th><th>时间</th></tr></thead>
            <tbody>
              {deliveries.map((delivery) => <DeliveryRow key={delivery.subscriptionId + delivery.seq + delivery.type} delivery={delivery} />)}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function WatchdogSettingsForm({
  settings,
  busy,
  onSave
}: {
  settings: WatchdogSettingsView;
  busy: boolean;
  onSave: (settings: WatchdogSettingsView) => void;
}) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const numberField = (key: keyof WatchdogSettingsView) => ({
    type: "number",
    value: Number(draft[key]),
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft((current) => ({ ...current, [key]: Number(event.target.value) }))
  });
  return (
    <form className="runtime-settings-grid" onSubmit={(event) => { event.preventDefault(); onSave(draft); }}>
      <label className="checkbox-field"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} /> 启用看门狗</label>
      <label className="checkbox-field"><input type="checkbox" checked={draft.shadow} onChange={(event) => setDraft((current) => ({ ...current, shadow: event.target.checked }))} /> 影子模式</label>
      <label className="checkbox-field"><input type="checkbox" checked={draft.autoCancel} onChange={(event) => setDraft((current) => ({ ...current, autoCancel: event.target.checked }))} /> 严重问题自动取消</label>
      <label>停滞分钟<input {...numberField("stallMinutes")} min={1} max={1440} /></label>
      <label>单次运行上限<input {...numberField("maxRunMinutes")} min={1} max={1440} /></label>
      <label>连续失败次数<input {...numberField("repeatedFailureCount")} min={2} max={20} /></label>
      <label>失败统计窗口<input {...numberField("failureWindowMinutes")} min={5} max={1440} /></label>
      <label>去重窗口<input {...numberField("dedupeMinutes")} min={1} max={1440} /></label>
      <label>扫描间隔 ms<input {...numberField("intervalMs")} min={10000} max={3600000} step={1000} /></label>
      <div className="runtime-form-actions">
        <button className="primary-button" type="submit" disabled={busy}><Save size={14} /> 保存设置</button>
      </div>
    </form>
  );
}

function WatchdogRow({ event }: { event: WatchdogEvent }) {
  return (
    <tr>
      <td><strong>{WATCHDOG_REASON_LABELS[event.reason] ?? event.reason}</strong></td>
      <td><span className="tag">{event.action}</span></td>
      <td>{event.taskId ? <Link className="link-button" to={"/tasks/" + event.taskId}>{shorten(event.taskId, 18)}</Link> : "—"}</td>
      <td>{event.detail}</td>
      <td title={event.createdAt}>{relativeTime(event.createdAt)}</td>
    </tr>
  );
}

function IntakeRow({ record }: { record: IntakeDecisionRecord }) {
  return (
    <tr>
      <td className="mono">{record.sourceRef}</td>
      <td><span className="tag">{INTAKE_LABELS[record.route]}</span></td>
      <td>{Math.round(record.confidence * 100)}%</td>
      <td>{record.reason}</td>
      <td title={record.createdAt}>{relativeTime(record.createdAt)}</td>
    </tr>
  );
}

function DeliveryRow({ delivery }: { delivery: ThreadDeliveryView }) {
  return (
    <tr>
      <td className="mono">{shorten(delivery.subscriptionId, 24)}</td>
      <td><span className="tag">{delivery.type}</span></td>
      <td>{delivery.taskId ? <Link className="link-button" to={"/tasks/" + delivery.taskId}>{shorten(delivery.taskId, 18)}</Link> : "—"}</td>
      <td className="mono">{delivery.seq}</td>
      <td title={delivery.recordedAt}>{relativeTime(delivery.recordedAt)}</td>
    </tr>
  );
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function shorten(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, Clock3, Inbox, ListChecks, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";
import type { AttentionItem, ProactiveSuggestion, ReconcileItem } from "../lib/types.ts";

const TRIGGER_LABELS: Record<string, string> = {
  "task.deadline": "任务截止",
  "task.failed": "任务失败",
  "effect.uncertain": "外部动作不确定",
  "approval.pending": "审批等待",
  "source.new_items": "来源新条目",
  "system.health": "系统健康",
  "email.new_message": "邮件",
  "calendar.upcoming": "日历"
};

const RISK_LABELS: Record<ReconcileItem["risk"], string> = { low: "低风险", medium: "中风险", high: "高风险", critical: "严重风险" };

const RECONCILE_STATUS_LABELS: Record<ReconcileItem["status"], string> = {
  open: "待核对",
  checking: "正在检查",
  needs_human: "需要人工判断",
  conflicting: "结果冲突",
  resolved_committed: "已确认提交",
  resolved_absent: "已确认未执行",
  abandoned: "已放弃"
};

const RECONCILE_OPEN_STATUSES: ReconcileItem["status"][] = ["open", "checking", "needs_human", "conflicting"];

const ATTENTION_KIND_LABELS: Record<AttentionItem["kind"], string> = {
  decision: "需要决定",
  approval: "等待审批",
  credential: "需要授权",
  reconcile: "需要对账",
  conflict: "信息冲突",
  commitment: "承诺",
  deadline: "截止",
  blocked: "被阻塞",
  opportunity: "机会",
  progress: "进展",
  suggestion: "建议"
};

export function InboxPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [notice, setNotice] = useState<string | null>(null);
  const snapshotQuery = useQuery({ queryKey: ["proactive"], queryFn: api.proactive, refetchInterval: 15_000 });
  const attentionQuery = useQuery({ queryKey: ["attention"], queryFn: api.attention, refetchInterval: 15_000 });
  const reconcileQuery = useQuery({ queryKey: ["reconcile"], queryFn: () => api.reconcile(), refetchInterval: 15_000 });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["proactive"] });
  const scanMutation = useMutation({
    mutationFn: api.scanProactive,
    onSuccess: (result) => {
      setNotice(result.created > 0 ? "扫描完成，新增 " + result.created + " 条建议。" : "扫描完成，没有新的建议。");
      refresh();
    }
  });
  const actionMutation = useMutation({
    mutationFn: async (input: { id: string; action: "accept" | "convert" | "ignore" | "snooze" }) => {
      if (input.action === "accept") return api.acceptSuggestion(input.id);
      if (input.action === "ignore") return api.ignoreSuggestion(input.id);
      if (input.action === "snooze") return api.snoozeSuggestion(input.id, 60);
      return api.convertSuggestion(input.id);
    },
    onSuccess: (result, input) => {
      if (input.action === "convert" && "taskId" in result) {
        navigate("/tasks/" + result.taskId);
        return;
      }
      setNotice(actionNotice(input.action));
      refresh();
    }
  });
  const attentionMutation = useMutation({
    mutationFn: async (input: { id: string; action: "ack" | "ignore" | "resolve" | "snooze" | "wrong" }) => {
      if (input.action === "ack") return api.attentionAck(input.id);
      if (input.action === "ignore") return api.attentionIgnore(input.id);
      if (input.action === "resolve") return api.attentionResolve(input.id);
      if (input.action === "snooze") return api.attentionSnooze(input.id, 60);
      await api.attentionFeedback(input.id, "wrong");
      return api.attentionIgnore(input.id);
    },
    onSuccess: (_result, input) => {
      setNotice(input.action === "wrong" ? "已记录为误报，并会用于调整同类提醒。" : "注意力事项已更新。");
      void queryClient.invalidateQueries({ queryKey: ["attention"] });
    }
  });
  const reconcileMutation = useMutation({
    mutationFn: async (input: { id: string; action: "check" | "committed" | "absent" | "abandoned" | "task"; note?: string }) => {
      if (input.action === "check") return api.checkReconcile(input.id);
      if (input.action === "task") return api.createReconcileTask(input.id, input.note);
      return api.resolveReconcile(input.id, input.action, input.note ?? "");
    },
    onSuccess: (result, input) => {
      if ("goal" in result) {
        navigate("/tasks/" + result.id);
        return;
      }
      setNotice(reconcileNotice(input.action, result.status));
      void queryClient.invalidateQueries({ queryKey: ["reconcile"] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["task"] });
    }
  });

  const snapshot = snapshotQuery.data;
  const suggestions = (snapshot?.suggestions ?? [])
    .filter((suggestion) => filter === "all" || ["new", "snoozed", "accepted"].includes(suggestion.status))
    .sort((left, right) => right.priority - left.priority || right.lastSeenAt.localeCompare(left.lastSeenAt));
  const pendingCount = (snapshot?.suggestions ?? []).filter((item) => ["new", "snoozed", "accepted"].includes(item.status)).length;
  const reconcileItems = (reconcileQuery.data?.items ?? []).filter((item) => RECONCILE_OPEN_STATUSES.includes(item.status));
  const attentionItems = attentionQuery.data?.items ?? [];
  const error = scanMutation.error ?? actionMutation.error ?? attentionQuery.error ?? attentionMutation.error ?? reconcileQuery.error ?? reconcileMutation.error;

  function reconcileAction(item: ReconcileItem, action: "check" | "committed" | "absent" | "abandoned" | "task") {
    if (action === "check") {
      reconcileMutation.mutate({ id: item.id, action });
      return;
    }
    if (action === "abandoned" && !window.confirm("放弃后不会自动重试这个外部动作，但仍会保留审计记录。确认放弃？")) return;
    const promptText = action === "task"
      ? "补充给人工任务的信息（可留空）："
      : action === "committed"
        ? "请说明你在外部服务看到的提交证据："
        : action === "absent"
          ? "请说明为什么确认动作没有发生："
          : "请说明放弃核对的原因：";
    const answer = window.prompt(promptText);
    if (answer === null) return;
    const note = answer.trim();
    if (action !== "task" && !note) {
      setNotice("手动判定必须填写核对说明。");
      return;
    }
    reconcileMutation.mutate({ id: item.id, action, ...(note ? { note } : {}) });
  }

  return (
    <div className="page inbox-page">
      <div className="inbox-head">
        <h1>需要你</h1>
        <button className="icon-button inbox-scan" aria-label="立即扫描" title="立即扫描" onClick={() => scanMutation.mutate()} disabled={scanMutation.isPending}>
          <RefreshCw size={15} className={scanMutation.isPending ? "spin" : ""} />
        </button>
      </div>

      {snapshotQuery.isLoading && <p className="triage-empty">正在读取…</p>}
      {snapshotQuery.isError && <p className="form-error">{snapshotQuery.error.message}</p>}

      <div className="inbox-filters">
        <button className={`filter-tab ${filter === "active" ? "active" : ""}`} aria-pressed={filter === "active"} onClick={() => setFilter("active")}>
          待处理 <span className="filter-count">{pendingCount}</span>
        </button>
        <button className={`filter-tab ${filter === "all" ? "active" : ""}`} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          全部 <span className="filter-count">{snapshot?.suggestions.length ?? 0}</span>
        </button>
        {notice && <span className="triage-notice">{notice}</span>}
      </div>

      {error && <p className="form-error">{error.message}</p>}

      {attentionItems.length > 0 && (
        <section className="triage-section">
          <div className="triage-section-head">
            <h2>需要你注意</h2>
            <span>{attentionItems.length}</span>
          </div>
          <div className="triage-list">
            {attentionItems.map((item) => (
              <details className="triage-row" key={item.id}>
                <summary className="triage-summary">
                  <span className="triage-main">
                    <span className="triage-title">{item.title}</span>
                    <span className="triage-why">{item.whyNow}</span>
                  </span>
                  <span className="triage-meta">
                    {item.critical ? "高影响 · " : ""}{ATTENTION_KIND_LABELS[item.kind] ?? item.kind} · {relativeTime(item.waitingSince)}
                  </span>
                </summary>
                <div className="triage-body">
                  <dl className="triage-facts">
                    <div><dt>不处理</dt><dd>{item.consequence}</dd></div>
                    <div><dt>建议</dt><dd>{item.nextAction}</dd></div>
                    <div><dt>来源</dt><dd>{item.source}</dd></div>
                  </dl>
                  {item.evidenceRefs?.length ? <p className="triage-evidence">证据：{item.evidenceRefs.slice(0, 6).join("、")}</p> : null}
                  <div className="triage-actions">
                    {item.taskId && <Link className="link-button" to={"/tasks/" + item.taskId}>查看任务</Link>}
                    <button className="primary-button" disabled={attentionMutation.isPending} onClick={() => attentionMutation.mutate({ id: item.id, action: "ack" })}>
                      <Check size={14} /> 我看到
                    </button>
                    <button className="ghost-button" disabled={attentionMutation.isPending} onClick={() => attentionMutation.mutate({ id: item.id, action: "snooze" })}>
                      <Clock3 size={14} /> 稍后 1 小时
                    </button>
                    <button className="ghost-button" disabled={attentionMutation.isPending} onClick={() => attentionMutation.mutate({ id: item.id, action: "resolve" })}>
                      <CheckCircle2 size={14} /> 已处理
                    </button>
                    <button className="ghost-button danger" disabled={attentionMutation.isPending} onClick={() => attentionMutation.mutate({ id: item.id, action: "wrong" })}>
                      <X size={14} /> 误报
                    </button>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </section>
      )}

      {reconcileItems.length > 0 && (
        <section className="triage-section">
          <div className="triage-section-head">
            <h2>外部动作待对账</h2>
            <span>{reconcileItems.length}</span>
          </div>
          <div className="triage-list">
            {reconcileItems.map((item) => (
              <details className="triage-row" key={item.id}>
                <summary className="triage-summary">
                  <span className="triage-main">
                    <span className="triage-title">{item.summary}</span>
                    <span className="triage-why">{item.reason}</span>
                  </span>
                  <span className="triage-meta">{RECONCILE_STATUS_LABELS[item.status]} · {relativeTime(item.updatedAt)}</span>
                </summary>
                <div className="triage-body">
                  <dl className="triage-facts">
                    <div><dt>效果</dt><dd className="mono select-all">{item.effectId}</dd></div>
                    <div><dt>目标</dt><dd className="mono">{item.targetKey ?? "未知"}</dd></div>
                    <div><dt>风险</dt><dd>{RISK_LABELS[item.risk]}</dd></div>
                    <div><dt>检查次数</dt><dd>{item.checkCount}</dd></div>
                  </dl>
                  {item.attempted.length > 0 && (
                    <details className="triage-evidence">
                      <summary>核对记录 {item.attempted.length} 条</summary>
                      {item.attempted.map((attempt, index) => <p key={attempt + index}>{attempt}</p>)}
                    </details>
                  )}
                  <div className="triage-actions">
                    <button className="primary-button" disabled={reconcileMutation.isPending} onClick={() => reconcileAction(item, "check")}>
                      <RefreshCw size={14} /> 重新检查
                    </button>
                    <button className="ghost-button" disabled={reconcileMutation.isPending} onClick={() => reconcileAction(item, "committed")}>
                      <CheckCircle2 size={14} /> 标记已提交
                    </button>
                    <button className="ghost-button" disabled={reconcileMutation.isPending} onClick={() => reconcileAction(item, "absent")}>
                      <Check size={14} /> 标记未执行
                    </button>
                    <button className="ghost-button" disabled={reconcileMutation.isPending} onClick={() => reconcileAction(item, "task")}>
                      <ListChecks size={14} /> 转人工任务
                    </button>
                    <button className="ghost-button danger" disabled={reconcileMutation.isPending} onClick={() => reconcileAction(item, "abandoned")}>
                      <X size={14} /> 放弃
                    </button>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </section>
      )}

      {snapshot && (
        <section className="triage-section">
          <div className="triage-section-head">
            <h2>建议</h2>
            <span>{suggestions.length}</span>
          </div>
          {suggestions.length === 0 ? (
            <p className="triage-empty">{filter === "active" ? "没有待处理的建议。" : "收件箱是空的。"}</p>
          ) : (
            <div className="triage-list">
              {suggestions.map((suggestion) => (
                <SuggestionRow
                  key={suggestion.id}
                  suggestion={suggestion}
                  busy={actionMutation.isPending}
                  onAction={(action) => actionMutation.mutate({ id: suggestion.id, action })}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function SuggestionRow({
  suggestion,
  busy,
  onAction
}: {
  suggestion: ProactiveSuggestion;
  busy: boolean;
  onAction: (action: "accept" | "convert" | "ignore" | "snooze") => void;
}) {
  const active = ["new", "snoozed", "accepted"].includes(suggestion.status);
  return (
    <details className="triage-row">
      <summary className="triage-summary">
        <span className="triage-main">
          <span className="triage-title">{suggestion.title}</span>
          <span className="triage-why">{suggestion.whyNow}</span>
        </span>
        <span className="triage-meta">
          {TRIGGER_LABELS[suggestion.triggerKind] ?? suggestion.triggerKind}
          {suggestion.requiresApproval ? " · 仍需审批" : ""}{suggestion.occurrenceCount > 1 ? ` · 聚合 ${suggestion.occurrenceCount} 次` : ""} · {relativeTime(suggestion.lastSeenAt)}
        </span>
      </summary>
      <div className="triage-body">
        <dl className="triage-facts">
          <div><dt>建议动作</dt><dd>{suggestion.suggestedAction}</dd></div>
          <div><dt>预计影响</dt><dd>{suggestion.expectedImpact}</dd></div>
          <div><dt>预计花费</dt><dd>{suggestion.estimatedCost}</dd></div>
          <div><dt>来源</dt><dd>{suggestion.source.label}{suggestion.source.detail ? " · " + suggestion.source.detail : ""}</dd></div>
        </dl>
        <div className="triage-actions">
          {active && suggestion.status !== "accepted" && (
            <button className="ghost-button" onClick={() => onAction("accept")} disabled={busy}>
              <Check size={15} /> 接受
            </button>
          )}
          {!suggestion.taskId && (
            <button className="primary-button" onClick={() => onAction("convert")} disabled={busy}>
              <Inbox size={15} /> 转成任务
            </button>
          )}
          {suggestion.taskId && <Link className="link-button" to={"/tasks/" + suggestion.taskId}>查看任务</Link>}
          {active && (
            <>
              <button className="ghost-button" onClick={() => onAction("snooze")} disabled={busy}>
                <Clock3 size={15} /> 稍后 1 小时
              </button>
              <button className="ghost-button danger" onClick={() => onAction("ignore")} disabled={busy}>
                <X size={15} /> 忽略
              </button>
            </>
          )}
        </div>
      </div>
    </details>
  );
}

function actionNotice(action: "accept" | "convert" | "ignore" | "snooze"): string {
  if (action === "accept") return "已接受这条建议。";
  if (action === "ignore") return "已忽略；同一来源不会换一种说法继续推送。";
  if (action === "snooze") return "已稍后提醒 1 小时。";
  return "已转成任务。";
}

function reconcileNotice(action: "check" | "committed" | "absent" | "abandoned" | "task", status: ReconcileItem["status"]): string {
  if (action === "check") return status === "needs_human" ? "没有可用适配器，已转人工判断。" : "重新检查完成。";
  if (action === "committed") return "已记录为外部动作已提交。";
  if (action === "absent") return "已记录为外部动作未执行。";
  if (action === "abandoned") return "已放弃该对账项，审计记录仍保留。";
  return "已创建人工任务。";
}

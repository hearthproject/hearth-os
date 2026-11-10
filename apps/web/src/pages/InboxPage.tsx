import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CheckCircle2, Clock3, Inbox, ListChecks, RefreshCw, ShieldAlert, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { EmptyState } from "../components/EmptyState.tsx";
import { ProactiveSettingsPanel } from "../components/ProactiveSettingsPanel.tsx";
import { api } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";
import type { ProactiveSuggestion, ReconcileItem } from "../lib/types.ts";

const STATUS_LABELS: Record<ProactiveSuggestion["status"], string> = {
  new: "待处理",
  accepted: "已接受",
  ignored: "已忽略",
  snoozed: "稍后提醒",
  converted: "已转任务",
  expired: "已过期"
};

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

export function InboxPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [notice, setNotice] = useState<string | null>(null);
  const snapshotQuery = useQuery({ queryKey: ["proactive"], queryFn: api.proactive, refetchInterval: 15_000 });
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
  const error = scanMutation.error ?? actionMutation.error ?? reconcileQuery.error ?? reconcileMutation.error;

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
      <div className="page-head">
        <h1>主动收件箱</h1>
        <span className="page-meta">先解释为什么现在重要，再由你决定是否处理。</span>
        <button className="ghost-button" onClick={() => scanMutation.mutate()} disabled={scanMutation.isPending}>
          <RefreshCw size={15} className={scanMutation.isPending ? "spin" : ""} /> 立即扫描
        </button>
      </div>

      {snapshotQuery.isLoading && <p className="section-empty">正在读取主动建议…</p>}
      {snapshotQuery.isError && <p className="form-error">{snapshotQuery.error.message}</p>}

      {reconcileItems.length > 0 && (
        <section className="panel reconcile-panel">
          <div className="panel-head">
            <div>
              <h2><AlertTriangle size={17} /> 外部动作待对账</h2>
              <span className="panel-meta">结果不确定的动作不会自动重试；先核对真实结果，再决定后续。</span>
            </div>
            <span className="tag risk-tag">{reconcileItems.length} 项</span>
          </div>
          <div className="reconcile-list">
            {reconcileItems.map((item) => (
              <article className={"reconcile-card risk-" + item.risk} key={item.id}>
                <div className="reconcile-head">
                  <div>
                    <div className="suggestion-kicker">
                      <span className="tag">{RECONCILE_STATUS_LABELS[item.status]}</span>
                      <span className="tag">{RISK_LABELS[item.risk]}</span>
                      {item.provider && <span className="tag">{item.provider}</span>}
                    </div>
                    <h3>{item.summary}</h3>
                    <p>{item.reason}</p>
                  </div>
                  <span className="panel-meta">{relativeTime(item.updatedAt)}</span>
                </div>
                <dl className="reconcile-facts">
                  <div><dt>效果</dt><dd className="mono select-all">{item.effectId}</dd></div>
                  <div><dt>目标</dt><dd className="mono">{item.targetKey ?? "未知"}</dd></div>
                  <div><dt>检查次数</dt><dd>{item.checkCount}</dd></div>
                </dl>
                {item.attempted.length > 0 && (
                  <details className="reconcile-attempts">
                    <summary>查看已尝试的核对记录</summary>
                    {item.attempted.map((attempt, index) => <p key={attempt + index}>{attempt}</p>)}
                  </details>
                )}
                <div className="reconcile-actions">
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
              </article>
            ))}
          </div>
        </section>
      )}

      {snapshot && (
        <>
          <ProactiveSettingsPanel snapshot={snapshot} />

          <div className="inbox-toolbar">
            <div className="segmented">
              <button className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")}>
                待处理 {pendingCount}
              </button>
              <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
                全部 {snapshot.suggestions.length}
              </button>
            </div>
            {notice && <span className="page-meta">{notice}</span>}
          </div>

          {error && <p className="form-error">{error.message}</p>}

          {suggestions.length === 0 ? (
            <section className="panel">
              <EmptyState
                title="收件箱是空的"
                body="Hearth 只会在任务截止、失败、审批等待或来源有新资料时提出建议。"
                action={<button className="ghost-button" onClick={() => scanMutation.mutate()}><Sparkles size={15} /> 扫描一次</button>}
              />
            </section>
          ) : (
            <div className="suggestion-list">
              {suggestions.map((suggestion) => (
                <SuggestionCard
                  key={suggestion.id}
                  suggestion={suggestion}
                  busy={actionMutation.isPending}
                  onAction={(action) => actionMutation.mutate({ id: suggestion.id, action })}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SuggestionCard({
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
    <article className={"panel suggestion-card risk-" + suggestion.riskLevel}>
      <div className="suggestion-head">
        <div>
          <div className="suggestion-kicker">
            <span className="tag">{TRIGGER_LABELS[suggestion.triggerKind] ?? suggestion.triggerKind}</span>
            <span className="tag">{RISK_LABELS[suggestion.riskLevel]}</span>
            <span className="tag">{STATUS_LABELS[suggestion.status]}</span>
            {suggestion.requiresApproval && <span className="tag risk-tag"><ShieldAlert size={11} /> 动作仍需审批</span>}
          </div>
          <h2>{suggestion.title}</h2>
          <p>{suggestion.whyNow}</p>
        </div>
        <span className="panel-meta">{relativeTime(suggestion.lastSeenAt)}</span>
      </div>

      <div className="suggestion-facts">
        <div><span>建议动作</span><strong>{suggestion.suggestedAction}</strong></div>
        <div><span>预计影响</span><strong>{suggestion.expectedImpact}</strong></div>
        <div><span>预计花费</span><strong>{suggestion.estimatedCost}</strong></div>
        <div><span>来源</span><strong>{suggestion.source.label}{suggestion.source.detail ? " · " + suggestion.source.detail : ""}</strong></div>
      </div>

      <div className="suggestion-foot">
        <span className="page-meta">
          首次 {relativeTime(suggestion.firstSeenAt)}
          {suggestion.occurrenceCount > 1 ? " · 已聚合 " + suggestion.occurrenceCount + " 次" : ""}
          {suggestion.snoozeUntil ? " · 提醒到 " + new Date(suggestion.snoozeUntil).toLocaleString("zh-CN") : ""}
        </span>
        <div className="suggestion-actions">
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
    </article>
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

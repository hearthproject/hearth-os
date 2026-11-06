import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock3, Inbox, RefreshCw, ShieldAlert, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { EmptyState } from "../components/EmptyState.tsx";
import { ProactiveSettingsPanel } from "../components/ProactiveSettingsPanel.tsx";
import { api } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";
import type { ProactiveSuggestion } from "../lib/types.ts";

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

const RISK_LABELS = { low: "低风险", medium: "中风险", high: "高风险" };

export function InboxPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [notice, setNotice] = useState<string | null>(null);
  const snapshotQuery = useQuery({ queryKey: ["proactive"], queryFn: api.proactive, refetchInterval: 15_000 });

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

  const snapshot = snapshotQuery.data;
  const suggestions = (snapshot?.suggestions ?? [])
    .filter((suggestion) => filter === "all" || ["new", "snoozed", "accepted"].includes(suggestion.status))
    .sort((left, right) => right.priority - left.priority || right.lastSeenAt.localeCompare(left.lastSeenAt));
  const pendingCount = (snapshot?.suggestions ?? []).filter((item) => ["new", "snoozed", "accepted"].includes(item.status)).length;
  const error = scanMutation.error ?? actionMutation.error;

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

import { Check, ChevronRight, ClipboardList, Loader2, RefreshCw, Square } from "lucide-react";
import type { PlanActionName, PlanStage, PlanView } from "@hearth/core";
import { executorLabel } from "../lib/labels.ts";

const STAGE_LABELS: Record<PlanStage, string> = {
  planning: "规划中",
  awaiting_approval: "待批准",
  executing: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已退出"
};

export function PlanBar({
  view,
  busy,
  onAction,
  onOpen
}: {
  view: PlanView;
  busy: boolean;
  onAction: (action: PlanActionName) => void;
  onOpen: () => void;
}) {
  const stage = view.stage;
  const canApprove = stage === "awaiting_approval" && Boolean(view.planMarkdown?.trim());
  const canReplan = stage === "awaiting_approval" || stage === "failed";
  const canCancel = !["completed", "cancelled"].includes(stage);
  const canRetry = stage === "failed" && Boolean(view.planMarkdown?.trim());
  const executorText = executorLabel(view.execution?.executorId);
  const attempt = Math.max(1, view.planningAttempt ?? 1);
  const summary = stage === "planning"
    ? `${executorText} 只读调查中，第 ${attempt} 次规划`
    : stage === "awaiting_approval"
      ? `${executorText} 已完成只读规划，等待你批准`
      : stage === "executing"
        ? `${executorText} 正在执行已批准计划`
        : view.objective;

  return (
    <section className={`goal-bar plan-bar ${stage}`} aria-label="当前计划">
      <span className="goal-bar-mark" aria-hidden="true">
        <ClipboardList size={15} />
      </span>
      <button type="button" className="plan-bar-copy" onClick={onOpen} title="查看完整计划">
        <div className="goal-bar-title">
          <strong>{view.title}</strong>
          <span className="goal-state-pill">{STAGE_LABELS[stage]}</span>
          <span className="goal-round-pill">v{view.revision + 1}</span>
          <span className="goal-round-pill">{executorText}</span>
          {view.planningAttempt ? <span className="goal-round-pill">第 {attempt} 次规划</span> : null}
        </div>
        <span className="goal-bar-next">
          {summary}
        </span>
        <ChevronRight size={13} className="plan-bar-chevron" />
      </button>
      <div className="goal-bar-actions">
        {canApprove && (
          <button type="button" className="goal-action primary" disabled={busy} onClick={() => onAction("approve")} title="批准这份计划并开始执行">
            {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
            批准执行
          </button>
        )}
        {canRetry && (
          <button type="button" className="goal-action primary" disabled={busy} onClick={() => onAction("retry")} title="按已批准的计划重新执行">
            {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            重试
          </button>
        )}
        {canReplan && (
          <button type="button" className="goal-action" disabled={busy} onClick={() => onAction("replan")} title="保留目标，重新只读规划">
            <RefreshCw size={13} />重规划
          </button>
        )}
        {canCancel && (
          <button type="button" className="goal-action danger" disabled={busy} onClick={() => onAction("cancel")} title="退出计划模式">
            {busy ? <Loader2 size={13} className="spin" /> : <Square size={12} />}退出
          </button>
        )}
      </div>
    </section>
  );
}

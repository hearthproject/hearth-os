import { Check, CirclePause, CirclePlay, Flag, Loader2, RefreshCw, ShieldCheck, Square } from "lucide-react";
import type { GoalAction, GoalState, GoalView } from "@hearth/core";

const STATE_LABELS: Record<GoalState, string> = {
  draft: "草稿",
  active: "推进中",
  paused: "已暂停",
  blocked: "受阻",
  awaiting_user: "等待你决定",
  validating: "验收中",
  done: "已完成",
  failed: "失败",
  cancelled: "已停止"
};

export function GoalBar({
  view,
  busy,
  onAction
}: {
  view: GoalView;
  busy: boolean;
  onAction: (action: GoalAction) => void;
}) {
  const goal = view.goal;
  const report = view.latestReport;
  const state = goal.currentState;
  const canPause = state === "active";
  const canResume = state === "paused" || state === "blocked" || state === "awaiting_user";
  const canVerify = state === "awaiting_user" && goal.stopReason === "verifier";
  const canApprove = canVerify && report?.verdict === "pass";
  const canReplan = !["done", "cancelled", "failed"].includes(state);
  const roundText = `${goal.roundCount ?? 0}`;

  return (
    <section className={`goal-bar ${state}${goal.armed ? " armed" : ""}`} aria-label="当前目标">
      <span className="goal-bar-mark" aria-hidden="true">
        <Flag size={15} />
      </span>
      <div className="goal-bar-copy">
        <div className="goal-bar-title">
          <strong>{goal.title}</strong>
          <span className="goal-state-pill">{STATE_LABELS[state]}</span>
          <span className="goal-round-pill">第 {roundText} 轮</span>
        </div>
        <span className="goal-bar-next">{goal.nextHandoff ?? goal.objective}</span>
      </div>
      <div className="goal-bar-actions">
        {canVerify && (
          <button
            type="button"
            className="goal-action primary"
            disabled={busy}
            onClick={() => onAction(canApprove ? "approve" : "complete")}
            title={canApprove ? "验收已通过，确认完成目标" : "重新运行独立验收"}
          >
            {busy ? <Loader2 size={13} className="spin" /> : canApprove ? <Check size={13} /> : <ShieldCheck size={13} />}
            {canApprove ? "确认完成" : "验收"}
          </button>
        )}
        {canPause && (
          <button type="button" className="goal-action" disabled={busy} onClick={() => onAction("pause")} title="暂停自动推进">
            <CirclePause size={13} />暂停
          </button>
        )}
        {canResume && (
          <button type="button" className="goal-action" disabled={busy} onClick={() => onAction("resume")} title="继续目标">
            <CirclePlay size={13} />继续
          </button>
        )}
        {canReplan && (
          <button type="button" className="goal-action" disabled={busy} onClick={() => onAction("replan")} title="清空无进展计数并换一条路线">
            <RefreshCw size={13} />重规划
          </button>
        )}
        {!["done", "cancelled"].includes(state) && (
          <button type="button" className="goal-action danger" disabled={busy} onClick={() => onAction("stop")} title="停止目标并取消锚点任务">
            {busy ? <Loader2 size={13} className="spin" /> : <Square size={12} />}停止
          </button>
        )}
      </div>
    </section>
  );
}

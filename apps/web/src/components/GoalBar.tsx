import { Check, CirclePause, CirclePlay, Cpu, Flag, Loader2, PencilLine, RefreshCw, ShieldCheck, Square } from "lucide-react";
import type { GoalAction, GoalState, GoalView } from "@hearth/core";
import { executorLabel } from "../lib/labels.ts";

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

const STOP_REASON_LABELS: Record<string, string> = {
  host_restart: "宿主重启",
  needs_input: "需要补充信息",
  approval: "等待外部动作确认",
  verifier: "等待验收",
  round_limit: "达到轮次上限",
  deadline: "达到截止时间",
  budget: "预算已用尽",
  task_failed: "任务执行失败",
  no_progress: "连续多轮没有进展",
  user_stop: "用户停止"
};

export function GoalBar({
  view,
  busy,
  onAction,
  onManage
}: {
  view: GoalView;
  busy: boolean;
  onAction: (action: GoalAction) => void;
  onManage: (mode: "executor" | "contract") => void;
}) {
  const goal = view.goal;
  const report = view.latestReport;
  const state = goal.currentState;
  const latestRound = view.rounds.at(-1) ?? null;
  const canPause = state === "active";
  const canResume = state === "paused" || state === "blocked" || state === "awaiting_user";
  const canVerify = state === "awaiting_user" && goal.stopReason === "verifier";
  const canApprove = canVerify && report?.verdict === "pass";
  const canReplan = !["done", "cancelled", "failed"].includes(state);
  const canManage = !["done", "cancelled", "failed"].includes(state);
  const executorText = executorLabel(goal.execution?.executorId);
  const latestResult = report?.summary
    ?? latestRound?.summary
    ?? latestRound?.intent?.note
    ?? "还没有完成一轮可报告的结果。";
  const blocker = goal.stopReason
    ? STOP_REASON_LABELS[goal.stopReason] ?? goal.stopReason
    : view.eligibility && !view.eligibility.eligible && view.eligibility.reason !== "ok"
      ? view.eligibility.detail
      : null;
  const nextStep = goal.nextHandoff ?? (state === "active" ? "执行器正在准备下一轮。" : "等待下一步操作。");
  const artifactCount = latestRound?.artifactRefs.length ?? 0;
  const evidenceCount = latestRound?.evidenceRefs.length ?? 0;
  const roundCount = goal.roundCount ?? latestRound?.index ?? 0;
  const maxRounds = goal.maxRounds ? ` / ${goal.maxRounds}` : "";

  return (
    <section className={`goal-bar ${state}${goal.armed ? " armed" : ""}`} aria-label="当前目标">
      <span className="goal-bar-mark" aria-hidden="true">
        <Flag size={15} />
      </span>
      <div className="goal-bar-copy">
        <div className="goal-bar-title">
          <strong>{goal.title}</strong>
          <span className="goal-state-pill">{STATE_LABELS[state]}</span>
          <span className="goal-round-pill">第 {roundCount}{maxRounds} 轮</span>
          <span className="goal-round-pill">{executorText}</span>
        </div>
        <div className="goal-bar-details">
          <div className="goal-bar-detail">
            <span>原始目标</span>
            <p>{goal.originalObjective ?? goal.objective}</p>
          </div>
          {goal.originalObjective && goal.originalObjective !== goal.objective && (
            <div className="goal-bar-detail">
              <span>当前目标</span>
              <p>{goal.objective}</p>
            </div>
          )}
          <div className="goal-bar-detail">
            <span>最近结果</span>
            <p>{latestResult}</p>
          </div>
          <div className="goal-bar-detail">
            <span>下一步</span>
            <p>{nextStep}</p>
          </div>
          <div className="goal-bar-detail">
            <span>进度</span>
            <p>产物 {artifactCount} 个，证据 {evidenceCount} 条，连续无进展 {goal.noProgressCount ?? 0} 次。</p>
          </div>
          {blocker && (
            <div className="goal-bar-detail warning">
              <span>阻塞原因</span>
              <p>{blocker}</p>
            </div>
          )}
        </div>
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
          <button type="button" className="goal-action" disabled={busy} onClick={() => onAction("replan")} title="安全中止当前轮，保留产物与证据后重新规划">
            <RefreshCw size={13} />重规划
          </button>
        )}
        {canManage && (
          <button type="button" className="goal-action" disabled={busy} onClick={() => onManage("executor")} title="切换下一轮使用的执行器">
            <Cpu size={13} />执行器
          </button>
        )}
        {canManage && (
          <button type="button" className="goal-action" disabled={busy} onClick={() => onManage("contract")} title="调整目标契约，保留原始目标与修订历史">
            <PencilLine size={13} />契约
          </button>
        )}
        {!["done", "cancelled"].includes(state) && (
          <button type="button" className="goal-action danger" disabled={busy} onClick={() => onAction("stop")} title="停止目标并取消锚点任务">
            {busy ? <Loader2 size={13} className="spin" /> : <Square size={12} />}停止目标
          </button>
        )}
      </div>
    </section>
  );
}

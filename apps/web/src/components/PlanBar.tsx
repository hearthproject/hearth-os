import { Check, ClipboardList, Loader2, RefreshCw, Square } from "lucide-react";
import type { PlanActionName, PlanStage, PlanView } from "@hearth/core";
import { executorLabel } from "../lib/labels.ts";

const STAGE_LABELS: Record<PlanStage, string> = {
  planning: "规划中",
  awaiting_approval: "待开始",
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
  const progress = stage === "planning"
    ? `${executorText} 正在只读调查，这是第 ${attempt} 次规划。`
    : stage === "awaiting_approval"
      ? `${executorText} 已完成只读调查，计划正文可审阅。`
      : stage === "executing"
        ? `${executorText} 正在执行已批准的计划。`
        : stage === "completed"
          ? "计划执行已完成。"
          : stage === "cancelled"
            ? "计划已退出，锚点任务已取消。"
            : "计划执行失败，可查看错误后重试或重新规划。";
  const nextStep = stage === "planning"
    ? "等待只读规划完成并生成计划正文。"
    : stage === "awaiting_approval"
      ? "审阅计划并确认是否开始执行。"
      : stage === "executing"
        ? "等待执行器完成本轮并报告结果。"
        : stage === "failed"
          ? "修复失败原因后重试，或重新只读规划。"
          : stage === "cancelled"
            ? "可以输入新的计划目标。"
            : "查看执行结果并决定下一步。";
  const planExcerpt = view.planMarkdown?.trim().replace(/\s+/g, " ").slice(0, 360);

  return (
    <section className={`goal-bar plan-bar ${stage}`} aria-label="当前计划">
      <span className="goal-bar-mark" aria-hidden="true">
        <ClipboardList size={15} />
      </span>
      <button type="button" className="plan-bar-copy" onClick={onOpen} aria-label={`查看完整计划：${view.title}`}>
        <div className="goal-bar-title">
          <strong>{view.title}</strong>
          <span className="goal-state-pill">{STAGE_LABELS[stage]}</span>
          <span className="goal-round-pill">修订 {view.revision + 1}</span>
          <span className="goal-round-pill">第 {attempt} 次规划</span>
          <span className="goal-round-pill">{executorText}</span>
        </div>
        <div className="goal-bar-details">
          <div className="goal-bar-detail">
            <span>目标</span>
            <p>{view.objective}</p>
          </div>
          <div className="goal-bar-detail">
            <span>进度</span>
            <p>{progress}</p>
          </div>
          <div className="goal-bar-detail">
            <span>下一步</span>
            <p>{nextStep}</p>
          </div>
          {planExcerpt && (
            <div className="goal-bar-detail">
              <span>计划摘要</span>
              <p>{planExcerpt}{view.planMarkdown && view.planMarkdown.trim().length > planExcerpt.length ? "…" : ""}</p>
            </div>
          )}
          {view.error && (
            <div className="goal-bar-detail warning">
              <span>错误</span>
              <p>{view.error}</p>
            </div>
          )}
        </div>
      </button>
      <div className="goal-bar-actions">
        {canApprove && (
          <button type="button" className="goal-action primary" disabled={busy} onClick={() => onAction("approve")} title="开始执行这份计划">
            {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
            开始执行
          </button>
        )}
        {canRetry && (
          <button type="button" className="goal-action primary" disabled={busy} onClick={() => onAction("retry")} title="按当前计划重新执行">
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
          <button type="button" className="goal-action danger" disabled={busy} onClick={() => onAction("cancel")} title="退出计划模式并取消锚点任务">
            {busy ? <Loader2 size={13} className="spin" /> : <Square size={12} />}退出计划
          </button>
        )}
      </div>
    </section>
  );
}

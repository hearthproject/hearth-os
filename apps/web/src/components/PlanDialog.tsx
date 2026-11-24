import { useState } from "react";
import { Check, ClipboardList, Loader2, RefreshCw, X } from "lucide-react";
import type { PlanActionName, PlanView } from "@hearth/core";
import { Markdown } from "./Markdown.tsx";

export function PlanDialog({
  view,
  busy,
  onClose,
  onAction
}: {
  view: PlanView | null;
  busy: boolean;
  onClose: () => void;
  onAction: (action: PlanActionName, note?: string) => void;
}) {
  const [note, setNote] = useState("");
  if (!view) return null;
  const canApprove = view.stage === "awaiting_approval" && Boolean(view.planMarkdown?.trim());
  const canReplan = view.stage === "awaiting_approval" || view.stage === "failed";

  return (
    <div className="goal-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="goal-dialog plan-dialog" role="dialog" aria-modal="true" aria-label="计划" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <span className="goal-dialog-mark"><ClipboardList size={16} /></span>
          <div>
            <h2>{view.title}</h2>
            <p>批准前只读调查，不会修改文件。批准后会启动新的构建任务执行这份计划。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>
        <div className="plan-dialog-body">
          {view.planMarkdown
            ? <Markdown className="chat-markdown">{view.planMarkdown}</Markdown>
            : <p className="goal-dialog-warning">{view.error ?? "正在只读调查，计划还没有生成。"}</p>}
          {canReplan && (
            <label>
              <span>修改意见（可选）</span>
              <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：不要改前端，只修后端；或者先补一个测试。" />
            </label>
          )}
        </div>
        <footer>
          <button type="button" className="ghost" onClick={onClose}>关闭</button>
          {canReplan && (
            <button type="button" className="ghost" disabled={busy} onClick={() => onAction("replan", note.trim() || undefined)}>
              {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              重新规划
            </button>
          )}
          {canApprove && (
            <button type="button" className="primary" disabled={busy} onClick={() => onAction("approve")}>
              {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
              批准执行
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Check, ClipboardList, Loader2, Pencil, Send, X } from "lucide-react";
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
  const [editing, setEditing] = useState(false);
  const planMarkdown = unwrapMarkdownFence(view?.planMarkdown);
  useEffect(() => {
    setNote("");
    setEditing(false);
  }, [view?.id, view?.stage]);
  if (!view) return null;
  const canApprove = view.stage === "awaiting_approval" && Boolean(planMarkdown.trim());
  const canReplan = view.stage === "awaiting_approval" || view.stage === "failed";

  return (
    <div className="goal-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="goal-dialog plan-dialog" role="dialog" aria-modal="true" aria-label="计划" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <span className="goal-dialog-mark"><ClipboardList size={16} /></span>
          <div>
            <h2>{view.title}</h2>
            <p>计划正文按 Markdown 渲染。批准前只读调查，不会修改文件；执行后会启动构建任务。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>
        <div className="plan-dialog-body">
          {planMarkdown
            ? <Markdown className="chat-markdown plan-dialog-markdown">{planMarkdown}</Markdown>
            : <p className="goal-dialog-warning">{view.error ?? "正在只读调查，计划还没有生成。"}</p>}
          {editing && (
            <div className="plan-dialog-editor">
              <label>
                <span>希望怎么改这份计划？</span>
                <textarea
                  rows={4}
                  autoFocus
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="例如：不要改前端，只修后端；补充回滚步骤；把验证命令写得更具体。"
                />
              </label>
              <div className="plan-dialog-editor-actions">
                <button type="button" className="ghost" onClick={() => setEditing(false)}>收起</button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !note.trim()}
                  onClick={() => onAction("replan", note.trim())}
                >
                  {busy ? <Loader2 size={13} className="spin" /> : <Send size={13} />}
                  提交修改
                </button>
              </div>
            </div>
          )}
        </div>
        <footer className="plan-dialog-actions">
          {canApprove && (
            <button type="button" className="plan-dialog-action primary" disabled={busy} onClick={() => onAction("approve")}>
              {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
              <span>
                <strong>执行这份计划</strong>
                <small>批准后开始修改文件并验证结果</small>
              </span>
            </button>
          )}
          {canReplan && (
            <button
              type="button"
              className="plan-dialog-action"
              disabled={busy}
              onClick={() => setEditing((value) => !value)}
            >
              <Pencil size={15} />
              <span>
                <strong>修改这份计划</strong>
                <small>写下调整意见，让 Agent 重新只读规划</small>
              </span>
            </button>
          )}
          {!canApprove && !canReplan && (
            <p className="plan-dialog-stage">当前阶段没有可执行的计划动作。</p>
          )}
          <button type="button" className="plan-dialog-close" onClick={onClose}>关闭</button>
        </footer>
      </section>
    </div>
  );
}

/** 模型有时会把整篇计划包进一个 markdown 代码块；渲染前先拆掉外层围栏。 */
function unwrapMarkdownFence(value?: string | null): string {
  const text = (value ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const whole = /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/i.exec(text);
  if (whole?.[1]?.trim()) return whole[1].trim();
  const firstFence = text.indexOf("```");
  if (firstFence > 0 && firstFence < 240) {
    const preamble = text.slice(0, firstFence);
    if (!/#\s|##\s|-\s/.test(preamble)) {
      const fenced = /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/i.exec(text.slice(firstFence).trim());
      const inner = fenced?.[1]?.trim();
      if (inner && /^#{1,6}\s/m.test(inner)) return inner;
    }
  }
  return text;
}

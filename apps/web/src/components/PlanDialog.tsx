import { useEffect, useState } from "react";
import { Check, ClipboardList, Loader2, Pencil, Plus, RefreshCw, Send, Trash2, X } from "lucide-react";
import type { PlanActionName, PlanView } from "@hearth/core";
import { Markdown } from "./Markdown.tsx";
import { executorLabel } from "../lib/labels.ts";
import type { ExecutorId, ExecutorView } from "../lib/types.ts";
import {
  appendPlanBlock,
  createPlanBlock,
  nextItemMarker,
  parsePlanBlocks,
  serializePlanBlocks,
  type PlanBlock
} from "../lib/plan-editor.ts";

type PlanEditorMode = "blocks" | "raw";

export function PlanDialog({
  view,
  executors,
  busy,
  onClose,
  onAction
}: {
  view: PlanView | null;
  executors: ExecutorView[];
  busy: boolean;
  onClose: () => void;
  onAction: (action: PlanActionName, options?: { note?: string; planMarkdown?: string; executorId?: ExecutorId }) => void;
}) {
  const [note, setNote] = useState("");
  const [draftPlan, setDraftPlan] = useState("");
  const [editingPlan, setEditingPlan] = useState(false);
  const [editorMode, setEditorMode] = useState<PlanEditorMode>("blocks");
  const [blocks, setBlocks] = useState<PlanBlock[]>([]);
  const [executionExecutorId, setExecutionExecutorId] = useState<ExecutorId>("native");
  const planMarkdown = unwrapMarkdownFence(view?.planMarkdown);
  useEffect(() => {
    setNote("");
    setDraftPlan(planMarkdown);
    setBlocks(parsePlanBlocks(planMarkdown));
    setEditingPlan(false);
    setEditorMode("blocks");
    setExecutionExecutorId(view?.execution?.executorId ?? "native");
  }, [view?.id, view?.stage, planMarkdown, view?.execution?.executorId]);
  if (!view) return null;

  const editedMarkdown = editorMode === "raw" ? draftPlan : serializePlanBlocks(blocks);
  const currentPlan = editingPlan ? editedMarkdown : planMarkdown;
  const canApprove = view.stage === "awaiting_approval" && Boolean(currentPlan.trim());
  const canRetry = view.stage === "failed" && Boolean(planMarkdown.trim());
  const canReplan = view.stage === "awaiting_approval" || view.stage === "failed";
  const planningExecutorText = executorLabel(view.planningExecutorId ?? view.execution?.executorId);
  const executionExecutorText = executorLabel(executionExecutorId);
  const executorOptions = (() => {
    const available = executors.filter((executor) => executor.health.canRun);
    const current = executors.find((executor) => executor.id === executionExecutorId);
    if (current && !available.some((executor) => executor.id === current.id)) return [current, ...available];
    return available.length > 0 ? available : executors;
  })();
  const attempt = Math.max(1, view.planningAttempt ?? 1);
  const replans = Math.max(0, attempt - 1);

  const toggleEditing = () => {
    if (!editingPlan) {
      setDraftPlan(planMarkdown);
      setBlocks(parsePlanBlocks(planMarkdown));
      setEditorMode("blocks");
      setEditingPlan(true);
      return;
    }
    setEditingPlan(false);
  };

  const switchEditorMode = (mode: PlanEditorMode) => {
    if (mode === editorMode) return;
    if (mode === "raw") {
      setDraftPlan(serializePlanBlocks(blocks));
    } else {
      setBlocks(parsePlanBlocks(draftPlan));
    }
    setEditorMode(mode);
  };

  const updateBlock = (id: string, content: string) => {
    setBlocks((current) => current.map((block) => block.id === id ? { ...block, content } : block));
  };

  const removeBlock = (id: string) => {
    setBlocks((current) => current.filter((block) => block.id !== id));
  };

  const insertAfter = (id: string, kind: "item" | "text" = "item") => {
    setBlocks((current) => {
      const index = current.findIndex((block) => block.id === id);
      if (index < 0) return current;
      const created = createPlanBlock(kind, "");
      if (kind === "item") created.marker = nextItemMarker(current, id);
      const next = [...current];
      next.splice(index + 1, 0, created);
      return next;
    });
  };

  const appendBlock = (kind: "item" | "text") => {
    setBlocks((current) => {
      const created = createPlanBlock(kind, "");
      if (kind === "item") {
        const lastItem = [...current].reverse().find((block) => block.kind === "item");
        created.marker = lastItem ? nextItemMarker(current, lastItem.id) : "- ";
      }
      return appendPlanBlock(current, created);
    });
  };

  return (
    <div className="goal-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="goal-dialog plan-dialog" role="dialog" aria-modal="true" aria-label="计划" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <span className="goal-dialog-mark"><ClipboardList size={16} /></span>
          <div>
            <h2>{view.title}</h2>
            <p>{planningExecutorText} 负责只读调查，Hearth 保存方案。确认计划后再开始执行；执行器可以在这里换成 Codex、DSH 或 Hearth，执行前你也可以直接修改计划内容。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>
        <div className="goal-dialog-meta">
          <span><b>规划执行器</b>{planningExecutorText}</span>
          <span>
            <b>执行执行器</b>
            {canApprove || canRetry ? (
              <select
                aria-label="计划执行执行器"
                value={executionExecutorId}
                onChange={(event) => setExecutionExecutorId(event.target.value as ExecutorId)}
              >
                {executorOptions.map((executor) => (
                  <option key={executor.id} value={executor.id}>
                    {executor.name}{executor.health.canRun ? "" : "（当前不可运行）"}
                  </option>
                ))}
              </select>
            ) : executionExecutorText}
          </span>
          <span><b>规划轮次</b>第 {attempt} 次</span>
          {replans > 0 ? <span><b>规划状态</b>已重规划 {replans} 次</span> : null}
          {view.planPath ? <span className="goal-dialog-meta-wide"><b>规范文件</b><code>{view.planPath}</code></span> : null}
          {view.planSha256 ? <span className="goal-dialog-meta-wide"><b>SHA-256</b><code>{view.planSha256}</code></span> : null}
        </div>
        <div className="plan-dialog-body">
          {planMarkdown ? (
            <div className="plan-dialog-plan">
              <div className="plan-dialog-plan-head">
                <span>计划内容</span>
                {view.stage === "awaiting_approval" && (
                  <button type="button" className="ghost" onClick={toggleEditing}>
                    <Pencil size={13} />
                    {editingPlan ? "预览计划" : "编辑计划"}
                  </button>
                )}
              </div>
              {editingPlan && view.stage === "awaiting_approval" && (
                <div className="plan-editor-tabs" role="tablist" aria-label="编辑方式">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={editorMode === "blocks"}
                    className={editorMode === "blocks" ? "active" : ""}
                    onClick={() => switchEditorMode("blocks")}
                  >
                    条目编辑
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={editorMode === "raw"}
                    className={editorMode === "raw" ? "active" : ""}
                    onClick={() => switchEditorMode("raw")}
                  >
                    原文编辑
                  </button>
                </div>
              )}
              {editingPlan && editorMode === "blocks" ? (
                <div className="plan-block-editor">
                  {blocks.map((block) => {
                    if (block.kind === "blank") return null;
                    const rows = block.kind === "code"
                      ? Math.max(3, Math.min(10, block.content.split("\n").length))
                      : Math.max(1, Math.min(6, block.content.split("\n").length));
                    const Field = block.kind === "heading" || (block.kind === "item" && !block.content.includes("\n")) ? "input" : "textarea";
                    return (
                      <div key={block.id} className={`plan-block plan-block-${block.kind}`}>
                        {block.kind !== "code" && block.kind !== "text" && (
                          <span className="plan-block-marker">{block.marker.trim()}</span>
                        )}
                        <Field
                          className="plan-block-field"
                          value={block.content}
                          rows={Field === "textarea" ? rows : undefined}
                          onChange={(event) => updateBlock(block.id, event.target.value)}
                          aria-label={`编辑${blockLabel(block.kind)}`}
                          placeholder={block.kind === "item" ? "输入步骤内容" : ""}
                        />
                        <div className="plan-block-actions">
                          {block.kind !== "code" && (
                            <button
                              type="button"
                              className="plan-block-action"
                              onClick={() => insertAfter(block.id)}
                              title="在下方添加步骤"
                              aria-label="在下方添加步骤"
                            >
                              <Plus size={13} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="plan-block-action danger"
                            onClick={() => removeBlock(block.id)}
                            title="删除这一条"
                            aria-label="删除这一条"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {blocks.length === 0 && <p className="plan-editor-empty">计划正文为空，先添加一条步骤。</p>}
                  <div className="plan-editor-add">
                    <button type="button" onClick={() => appendBlock("item")}><Plus size={13} /> 添加步骤</button>
                    <button type="button" onClick={() => appendBlock("text")}><Plus size={13} /> 添加说明</button>
                  </div>
                </div>
              ) : editingPlan ? (
                <textarea
                  className="plan-dialog-plan-editor"
                  rows={14}
                  value={draftPlan}
                  onChange={(event) => setDraftPlan(event.target.value)}
                  aria-label="编辑计划"
                />
              ) : (
                <Markdown className="chat-markdown plan-dialog-markdown">{currentPlan}</Markdown>
              )}
            </div>
          ) : (
            <p className="goal-dialog-warning">{view.error ?? "正在只读调查，计划还没有生成。"}</p>
          )}
          {canReplan && (
            <div className="plan-dialog-editor">
              <label>
                <span>我的想法</span>
                <textarea
                  rows={3}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="我的想法..."
                  aria-label="我的想法"
                />
              </label>
              <div className="plan-dialog-editor-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !note.trim()}
                  onClick={() => onAction("replan", { note: note.trim() })}
                >
                  {busy ? <Loader2 size={13} className="spin" /> : <Send size={13} />}
                  按我的想法重规划
                </button>
              </div>
            </div>
          )}
        </div>
        <footer className="plan-dialog-actions">
          {canRetry && (
            <button
              type="button"
              className="plan-dialog-action primary"
              disabled={busy}
              onClick={() => onAction("retry", {
                ...(executionExecutorId !== view.execution?.executorId ? { executorId: executionExecutorId } : {})
              })}
            >
              {busy ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
              <span>
                <strong>用 {executionExecutorText} 重试</strong>
                <small>保留已批准的计划和 SHA-256，换执行器重新执行</small>
              </span>
            </button>
          )}
          {canApprove && (
            <button
              type="button"
              className="plan-dialog-action primary"
              disabled={busy}
              onClick={() => onAction("approve", {
                ...(currentPlan.trim() !== planMarkdown.trim() ? { planMarkdown: currentPlan } : {}),
                ...(executionExecutorId !== view.execution?.executorId ? { executorId: executionExecutorId } : {})
              })}
            >
              {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
              <span>
                <strong>开始执行这份计划</strong>
                <small>会按当前计划内容开始执行</small>
              </span>
            </button>
          )}
          {canReplan && !canApprove && (
            <button type="button" className="plan-dialog-action" disabled={busy} onClick={() => onAction("replan", note.trim() ? { note: note.trim() } : {})}>
              <Pencil size={15} />
              <span>
                <strong>重新规划</strong>
                <small>让 Agent 重新只读规划</small>
              </span>
            </button>
          )}
          {!canApprove && !canReplan && !canRetry && (
            <p className="plan-dialog-stage">当前阶段没有可执行的计划动作。</p>
          )}
          <button type="button" className="plan-dialog-close" onClick={onClose}>关闭</button>
        </footer>
      </section>
    </div>
  );
}

function blockLabel(kind: string): string {
  if (kind === "heading") return "标题";
  if (kind === "item") return "步骤";
  if (kind === "code") return "代码块";
  return "说明";
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

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CornerDownRight,
  Loader2,
  MessageSquarePlus,
  PauseCircle,
  Pencil,
  Send,
  Trash2,
  X
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatTime } from "../lib/format.ts";
import type { TaskFollowUpMode, TaskFollowUpRecord, TaskStatus } from "../lib/types.ts";

interface TaskFollowUpPanelProps {
  taskId: string;
  status: TaskStatus;
  followUps: TaskFollowUpRecord[];
}

const TERMINAL_STATUSES: TaskStatus[] = ["completed", "cancelled"];

export function TaskFollowUpPanel({ taskId, status, followUps }: TaskFollowUpPanelProps) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<TaskFollowUpMode>("queue");
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const canCompose = !TERMINAL_STATUSES.includes(status);
  const canSteer = status === "running";
  const terminal = TERMINAL_STATUSES.includes(status);

  useEffect(() => {
    if (!canSteer && mode === "steer") setMode("queue");
  }, [canSteer, mode]);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    void queryClient.invalidateQueries({ queryKey: ["task-follow-ups", taskId] });
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    void queryClient.invalidateQueries({ queryKey: ["conversation"] });
  }

  const createFollowUp = useMutation({
    mutationFn: (payload: { content: string; mode: TaskFollowUpMode }) =>
      api.addFollowUp(taskId, payload.content, payload.mode),
    onSuccess: (record) => {
      setInput("");
      setNotice(record.mode === "steer"
        ? "已请求中止当前轮，任务会带着这条补充立即重跑。"
        : "已加入队列，当前轮结束后会自动继续。");
      invalidate();
    }
  });

  const updateFollowUp = useMutation({
    mutationFn: (payload: { id: string; content: string }) =>
      api.updateFollowUp(taskId, payload.id, payload.content),
    onSuccess: () => {
      setEditingId(null);
      setEditContent("");
      invalidate();
    }
  });

  const deleteFollowUp = useMutation({
    mutationFn: (id: string) => api.deleteFollowUp(taskId, id),
    onSuccess: () => invalidate()
  });

  function submit() {
    const content = input.trim();
    if (!content || createFollowUp.isPending) return;
    createFollowUp.mutate({ content, mode });
  }

  function saveEdit(id: string) {
    const content = editContent.trim();
    if (!content || updateFollowUp.isPending) return;
    updateFollowUp.mutate({ id, content });
  }

  if (terminal && followUps.length === 0) return null;

  const error = createFollowUp.error ?? updateFollowUp.error ?? deleteFollowUp.error;

  return (
    <section className="panel follow-up-panel">
      <div className="panel-head">
        <h2>补充指令</h2>
        <span className="panel-meta">不新建任务 · 保留当前目标与上下文</span>
      </div>
      <div className="follow-up-body">
        <p className="follow-up-explainer">
          <CornerDownRight size={14} />
          <span><strong>轮后继续</strong>：当前轮结束后再执行。<strong>中止本轮</strong>：停止这一步，立刻带上新指令重跑，不是实时注入 token。</span>
        </p>

        {followUps.length > 0 && (
          <ol className="follow-up-list">
            {followUps.map((followUp) => (
              <li key={followUp.id} className={`follow-up-item ${followUp.status}`}>
                <span className="follow-up-mode-icon">
                  {followUp.status === "applied" ? <CheckCircle2 size={15} />
                    : followUp.status === "steering" ? <PauseCircle size={15} />
                      : <CornerDownRight size={15} />}
                </span>
                <div className="follow-up-item-main">
                  {editingId === followUp.id ? (
                    <div className="follow-up-edit">
                      <textarea
                        value={editContent}
                        onChange={(event) => setEditContent(event.target.value)}
                        rows={3}
                        autoFocus
                      />
                      <div className="follow-up-item-actions">
                        <button className="primary-button" onClick={() => saveEdit(followUp.id)} disabled={!editContent.trim() || updateFollowUp.isPending}>
                          {updateFollowUp.isPending ? <Loader2 size={13} className="spin" /> : null} 保存
                        </button>
                        <button className="ghost-button" onClick={() => setEditingId(null)}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p>{followUp.content}</p>
                      <div className="follow-up-item-meta">
                        <span className={`follow-up-status ${followUp.status}`}>{statusLabel(followUp.status)}</span>
                        <span>{followUp.mode === "steer" ? "中止本轮" : "轮后继续"}</span>
                        <span>{formatTime(followUp.createdAt)}</span>
                        {followUp.appliedRunId && <span>运行 {followUp.appliedRunId.slice(0, 8)}</span>}
                      </div>
                      {followUp.error && <p className="form-error">{followUp.error}</p>}
                    </>
                  )}
                </div>
                {followUp.status === "queued" && editingId !== followUp.id && (
                  <div className="follow-up-item-actions">
                    <button
                      className="icon-button"
                      onClick={() => {
                        setEditingId(followUp.id);
                        setEditContent(followUp.content);
                      }}
                      title="编辑排队中的补充"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => deleteFollowUp.mutate(followUp.id)}
                      disabled={deleteFollowUp.isPending}
                      title="删除排队中的补充"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}

        {canCompose && (
          <div className="follow-up-composer">
            <div className="follow-up-mode-row">
              <button
                className={`follow-up-mode ${mode === "queue" ? "active" : ""}`}
                onClick={() => setMode("queue")}
                type="button"
              >
                <CornerDownRight size={14} /> 轮后继续
              </button>
              <button
                className={`follow-up-mode ${mode === "steer" ? "active" : ""}`}
                onClick={() => setMode("steer")}
                disabled={!canSteer}
                type="button"
                title={canSteer ? "中止当前轮并立即应用补充" : "只有正在运行的任务可以中止本轮"}
              >
                <PauseCircle size={14} /> 中止本轮
              </button>
            </div>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={canSteer
                ? "告诉任务要修正什么。Ctrl/⌘ + Enter 发送。"
                : "补充下一步要求，当前轮结束后会继续。Ctrl/⌘ + Enter 发送。"}
              rows={3}
            />
            <div className="follow-up-submit-row">
              <span>{mode === "steer" ? "会先停止当前轮，再带补充重跑" : "会保留当前进度，轮后继续"}</span>
              <button className="primary-button" onClick={submit} disabled={!input.trim() || createFollowUp.isPending}>
                {createFollowUp.isPending ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                {mode === "steer" ? "中止并补充" : "加入队列"}
              </button>
            </div>
          </div>
        )}

        {notice && (
          <div className="follow-up-notice">
            <MessageSquarePlus size={14} />
            <span>{notice}</span>
            <button className="icon-button" onClick={() => setNotice(null)} aria-label="关闭提示"><X size={13} /></button>
          </div>
        )}
        {error && <p className="form-error">{error instanceof Error ? error.message : "补充指令操作失败"}</p>}
      </div>
    </section>
  );
}

function statusLabel(status: TaskFollowUpRecord["status"]): string {
  if (status === "queued") return "排队中";
  if (status === "steering") return "正在中止当前轮";
  if (status === "applied") return "已应用";
  return "已取消";
}

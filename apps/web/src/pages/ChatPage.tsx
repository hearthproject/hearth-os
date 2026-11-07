import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  CheckCircle2,
  FileText,
  ListChecks,
  Loader2,
  MessageCircle,
  Paperclip,
  Plus,
  Settings2,
  ShieldAlert,
  Trash2,
  X
} from "lucide-react";
import { api, chatStream } from "../lib/api.ts";
import { formatBytes, formatTime } from "../lib/format.ts";
import { executorLabel, taskKindLabel } from "../lib/labels.ts";
import type { ChatAttachment, ChatMessageRecord, ConversationListItem, TaskListItem, TaskProposalRecord } from "../lib/types.ts";

const SUGGESTIONS = [
  "整理一份本周工作周报",
  "分析一个网址的内容并给出要点",
  "写一个批量重命名文件的脚本",
  "帮我检查项目里的 TypeScript 错误"
];

interface RoutingState {
  action: "chat" | "task";
  reason: string;
  title: string;
}

export function ChatPage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const [conversationId, setConversationId] = useState<string | null>(() => {
    const returned = (location.state as { conversationId?: string } | null)?.conversationId;
    return returned ?? localStorage.getItem("hearth.conversation");
  });
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [routing, setRouting] = useState<RoutingState | null>(null);
  const [proposals, setProposals] = useState<TaskProposalRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const conversationIdRef = useRef<string | null>(conversationId);

  const conversationsQuery = useQuery({ queryKey: ["conversations"], queryFn: api.conversations, refetchInterval: 15_000 });
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 8_000 });
  const conversationQuery = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => api.conversation(conversationId as string),
    enabled: Boolean(conversationId)
  });
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health });
  const conversations = conversationsQuery.data?.conversations ?? [];
  const tasks = tasksQuery.data?.tasks ?? [];
  const tasksByConversation = new Map<string, TaskListItem[]>();
  for (const task of tasks) {
    if (!task.conversationId) continue;
    const list = tasksByConversation.get(task.conversationId) ?? [];
    list.push(task);
    tasksByConversation.set(task.conversationId, list);
  }
  const current = conversations.find((item) => item.id === conversationId) ?? null;

  useEffect(() => {
    if (!conversationQuery.data || sending) return;
    const nextMessages = conversationQuery.data.messages;
    setMessages((prev) => (nextMessages.length >= prev.length ? nextMessages : prev));
    setProposals(conversationQuery.data.proposals.filter((proposal) => proposal.status === "pending"));
  }, [conversationQuery.data, sending]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: sending ? "auto" : "smooth" });
  }, [messages, streaming, sending]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function selectConversation(id: string | null) {
    if (sending) return;
    setConversationId(id);
    conversationIdRef.current = id;
    setMessages([]);
    setStreaming("");
    setReasoning("");
    setRouting(null);
    setProposals([]);
    setError(null);
    if (id) localStorage.setItem("hearth.conversation", id);
    else localStorage.removeItem("hearth.conversation");
  }

  async function removeConversation(event: MouseEvent, id: string) {
    event.stopPropagation();
    if (sending) return;
    await api.deleteConversation(id);
    if (conversationId === id) selectConversation(null);
    await queryClient.invalidateQueries({ queryKey: ["conversations"] });
  }

  async function pickFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    setError(null);
    if (attachments.length + files.length > 5) {
      setError("每条消息最多 5 个附件");
      return;
    }
    const oversized = files.find((file) => file.size > 25 * 1024 * 1024);
    if (oversized) {
      setError(`“${oversized.name}”超过 25 MB`);
      return;
    }
    setUploading(true);
    try {
      const uploaded = await api.uploadAttachments(files);
      setAttachments((prev) => [...prev, ...uploaded].slice(0, 5));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "上传失败");
    } finally {
      setUploading(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (sending || uploading || (!text && attachments.length === 0)) return;
    const sentAttachments = attachments;
    setInput("");
    setAttachments([]);
    setStreaming("");
    setReasoning("");
    setRouting(null);
    setError(null);
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let answer = "";
    let reasoningText = "";

    try {
      await chatStream(
        {
          ...(conversationId ? { conversationId } : {}),
          ...(text ? { message: text } : {}),
          ...(sentAttachments.length > 0 ? { attachments: sentAttachments } : {})
        },
        {
          signal: controller.signal,
          onEvent: (event, data) => {
            if (event === "conversation") {
              const conversation = data as { id: string };
              setConversationId(conversation.id);
              conversationIdRef.current = conversation.id;
              localStorage.setItem("hearth.conversation", conversation.id);
            } else if (event === "user") {
              setMessages((prev) => [...prev, data as ChatMessageRecord]);
            } else if (event === "routing") {
              setRouting(data as RoutingState);
            } else if (event === "delta") {
              answer += (data as { text: string }).text;
              setStreaming(answer);
            } else if (event === "reasoning") {
              reasoningText += (data as { text: string }).text;
              setReasoning(reasoningText);
            } else if (event === "task") {
              const payload = data as { message: ChatMessageRecord };
              setMessages((prev) => (prev.some((message) => message.id === payload.message.id) ? prev : [...prev, payload.message]));
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
            } else if (event === "proposal") {
              const payload = data as { proposal: TaskProposalRecord; message: ChatMessageRecord };
              setProposals((prev) => (prev.some((proposal) => proposal.id === payload.proposal.id) ? prev : [...prev, payload.proposal]));
              setMessages((prev) => (prev.some((message) => message.id === payload.message.id) ? prev : [...prev, payload.message]));
            } else if (event === "done") {
              const message = data as ChatMessageRecord;
              setStreaming("");
              setReasoning("");
              setMessages((prev) => (prev.some((item) => item.id === message.id) ? prev : [...prev, message]));
            } else if (event === "error") {
              setError((data as { message: string }).message);
            }
          }
        }
      );
    } catch (sendError) {
      if (!controller.signal.aborted) {
        setError(sendError instanceof Error ? sendError.message : "发送失败");
      }
    } finally {
      abortRef.current = null;
      setSending(false);
      setStreaming("");
      setReasoning("");
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      const activeId = conversationIdRef.current;
      if (activeId) void queryClient.invalidateQueries({ queryKey: ["conversation", activeId] });
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  const configured = healthQuery.data?.chatModel.configured ?? true;
  const executorReady = healthQuery.data?.codex.canRun ?? true;
  const isEmpty = messages.length === 0 && !streaming && !sending;

  return (
    <div className="chat-layout">
      <aside className="conversation-rail">
        <button className="new-chat-button" onClick={() => selectConversation(null)} disabled={sending}>
          <Plus size={15} /> 新对话
        </button>
        <div className="conversation-list">
          {conversations.length === 0 && <p className="rail-empty">还没有对话</p>}
          {conversations.map((conversation) => (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              tasks={tasksByConversation.get(conversation.id) ?? []}
              active={conversation.id === conversationId}
              disabled={sending}
              onSelect={() => selectConversation(conversation.id)}
              onDelete={(event) => void removeConversation(event, conversation.id)}
            />
          ))}
        </div>
      </aside>

      <section className="chat-main">
        <header className="chat-header">
          <div>
            <h1>{current?.title ?? "新对话"}</h1>
            <p className="page-meta">说清楚你要完成什么，Hearth 会自动回答或派出任务。</p>
          </div>
          <div className="chat-header-status">
            <span className={`status-chip ${executorReady ? "ok" : "warn"}`}>
              <span className={`status-dot ${executorReady ? "online" : "offline"}`} />
              {executorReady ? "执行器可用" : "执行器未连接"}
            </span>
          </div>
        </header>

        <div className="chat-scroll">
          {isEmpty ? (
            <div className="chat-empty">
              <div className="chat-empty-mark"><MessageCircle size={24} /></div>
              <h2>今天想完成什么？</h2>
              <p>可以直接提问，也可以让 Hearth 去做一份文件、查一个网址、写一段代码。它会自己判断。</p>
              <div className="suggestion-grid">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} className="suggestion-card" onClick={() => setInput(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="message-list">
              {!configured && (
                <ChatNotice icon={<Settings2 size={15} />} tone="warn">
                  还没有接入聊天模型。普通问答需要先到<Link to="/settings">设置</Link>里选择服务商并填写 API Key；执行类任务仍会尝试派出。
                </ChatNotice>
              )}
              {!executorReady && (
                <ChatNotice icon={<Settings2 size={15} />} tone="warn">
                  Codex 执行器当前不可用，任务会排队。到<Link to="/settings">设置</Link>查看连接诊断。
                </ChatNotice>
              )}
              {messages.map((message) => <ChatBubble key={message.id} message={message} conversationId={conversationId} />)}
              {proposals.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  conversationId={conversationId}
                  onResolved={(id) => {
                    setProposals((prev) => prev.filter((item) => item.id !== id));
                    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
                    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
                    if (conversationId) void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
                  }}
                />
              ))}
              {(streaming || reasoning) && <AssistantBubble content={streaming} reasoning={reasoning} streaming />}
              {sending && !streaming && !reasoning && (
                <div className="typing-row">
                  <Loader2 size={14} className="spin" />
                  <span>{routing?.action === "task" ? "正在派出任务…" : routing ? "正在回答…" : "正在判断该由谁处理…"}</span>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {error && (
            <div className="composer-error">
              <span>{error}</span>
              <button className="icon-button" onClick={() => setError(null)} aria-label="关闭"><X size={14} /></button>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="attachment-row">
              {attachments.map((attachment) => (
                <span key={attachment.id} className="attachment-chip">
                  <FileText size={13} />
                  <span>{attachment.name}</span>
                  <small>{formatBytes(attachment.bytes)}</small>
                  <button
                    className="chip-remove"
                    onClick={() => setAttachments((prev) => prev.filter((item) => item.id !== attachment.id))}
                    aria-label={`移除 ${attachment.name}`}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="composer">
            <button
              className="composer-icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending || uploading}
              title="添加附件（单文件不超过 25 MB）"
            >
              {uploading ? <Loader2 size={18} className="spin" /> : <Paperclip size={18} />}
            </button>
            <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => void pickFiles(event)} />
            <textarea
              ref={composerRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="直接说你要做什么，例如：帮我整理这周的会议记录…"
              rows={1}
              disabled={sending}
            />
            <button className="composer-send" onClick={() => void send()} disabled={sending || uploading || (!input.trim() && attachments.length === 0)} title="发送">
              {sending ? <Loader2 size={17} className="spin" /> : <ArrowUp size={18} />}
            </button>
          </div>
          <p className="composer-hint">Enter 发送 · Shift + Enter 换行 · 附件最多 5 个</p>
        </div>
      </section>
    </div>
  );
}

function ConversationItem({
  conversation,
  tasks,
  active,
  disabled,
  onSelect,
  onDelete
}: {
  conversation: ConversationListItem;
  tasks: TaskListItem[];
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
  onDelete: (event: MouseEvent) => void;
}) {
  return (
    <div className={`conversation-item ${active ? "active" : ""}`}>
      <div className="conversation-row">
        <button className="conversation-select" onClick={onSelect} disabled={disabled}>
          <span className="conversation-title">{conversation.title}</span>
          <span className="conversation-preview">{conversation.preview || "新对话"}</span>
        </button>
        <button className="conversation-delete" onClick={onDelete} disabled={disabled} aria-label="删除对话">
          <Trash2 size={13} />
        </button>
      </div>
      {tasks.length > 0 && (
        <div className="conversation-tasks">
          {tasks.map((task) => (
            <Link
              key={task.id}
              className="conversation-task"
              to={`/tasks/${task.id}`}
              state={{ fromChat: true, conversationId: conversation.id }}
              title={`${task.title} · ${task.summary.phase}`}
            >
              <span className={`rail-task-icon ${task.status}`}><ListChecks size={11} /></span>
              <span className="rail-task-title">{task.title}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function ChatBubble({ message, conversationId }: { message: ChatMessageRecord; conversationId: string | null }) {
  if (message.role === "user") {
    return (
      <div className="message-row user">
        <div className="message-bubble user-bubble">
          {message.content && <p className="plain-message">{message.content}</p>}
          {message.attachments.length > 0 && (
            <div className="message-attachments">
              {message.attachments.map((attachment) => (
                <span key={attachment.id} className="message-attachment">
                  <FileText size={12} /> {attachment.name}
                </span>
              ))}
            </div>
          )}
          <time>{formatTime(message.createdAt)}</time>
        </div>
      </div>
    );
  }
  return (
    <div className="message-row assistant">
      <AssistantBubble content={message.content} taskId={message.taskId} createdAt={message.createdAt} conversationId={conversationId} />
    </div>
  );
}

function AssistantBubble({
  content,
  reasoning = "",
  taskId,
  createdAt,
  streaming = false,
  conversationId
}: {
  content: string;
  reasoning?: string;
  taskId?: string | null;
  createdAt?: string;
  streaming?: boolean;
  conversationId?: string | null;
}) {
  const reasoningRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = reasoningRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [reasoning]);

  return (
    <div className={`message-bubble assistant-bubble ${streaming ? "streaming" : ""}`}>
      {reasoning && (
        <div className="reasoning-block">
          <div className="reasoning-label"><Loader2 size={12} className="spin" /> 思考过程</div>
          <div className="reasoning-text" ref={reasoningRef}>{reasoning}</div>
        </div>
      )}
      {content && (
        <div className="chat-markdown">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
          >
            {content}
          </ReactMarkdown>
        </div>
      )}
      {taskId && (
        <Link
          className="task-link-card"
          to={`/tasks/${taskId}`}
          state={{ fromChat: true, ...(conversationId ? { conversationId } : {}) }}
        >
          <CheckCircle2 size={15} />
          <span>任务已派出，查看进度和结果</span>
        </Link>
      )}
      {createdAt && <time>{formatTime(createdAt)}</time>}
    </div>
  );
}

function ChatNotice({ icon, tone, children }: { icon: React.ReactNode; tone: "warn" | "info"; children: React.ReactNode }) {
  return <div className={`chat-notice ${tone}`}>{icon}<span>{children}</span></div>;
}

function ProposalCard({
  proposal,
  conversationId,
  onResolved
}: {
  proposal: TaskProposalRecord;
  conversationId: string | null;
  onResolved: (id: string) => void;
}) {
  const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);

  async function confirm() {
    setBusy("confirm");
    setError(null);
    try {
      const result = await api.confirmTaskProposal(proposal.id);
      setTaskId(result.task.id);
      onResolved(proposal.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "确认失败");
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setBusy("reject");
    setError(null);
    try {
      await api.rejectTaskProposal(proposal.id);
      onResolved(proposal.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "取消失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="proposal-card">
      <div className="proposal-kicker"><ShieldAlert size={13} /> 待确认任务</div>
      <h3>{proposal.title}</h3>
      <p className="proposal-goal">{proposal.goal}</p>
      <div className="proposal-meta">
        <span>{executorLabel(proposal.executorId)}</span>
        <span>{taskKindLabel(proposal.taskKind)}</span>
        <span>产物 {proposal.expectedOutputs.join("、")}</span>
      </div>
      <p className="proposal-reason">{proposal.reason}</p>
      {proposal.permissions.networkHosts.length > 0 && (
        <p className="proposal-permission">联网：{proposal.permissions.networkHosts.join("、")}</p>
      )}
      {error && <p className="form-error">{error}</p>}
      {taskId ? (
        <Link
          className="task-link-card"
          to={`/tasks/${taskId}`}
          state={{ fromChat: true, ...(conversationId ? { conversationId } : {}) }}
        >
          <CheckCircle2 size={15} /> 已确认，查看任务进度
        </Link>
      ) : (
        <div className="proposal-actions">
          <button className="primary-button" onClick={() => void confirm()} disabled={busy !== null}>
            {busy === "confirm" ? <Loader2 size={14} className="spin" /> : null} 确认并执行
          </button>
          <button className="ghost-button" onClick={() => void reject()} disabled={busy !== null}>取消</button>
        </div>
      )}
    </div>
  );
}

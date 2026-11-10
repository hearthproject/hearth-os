import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Brain,
  Check,
  CheckCircle2,
  Copy,
  CornerDownRight,
  Cpu,
  FileText,
  ListChecks,
  Loader2,
  MessageCircle,
  Paperclip,
  PauseCircle,
  Plus,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X
} from "lucide-react";
import { ApiError, api, chatStream } from "../lib/api.ts";
import { TaskStatusIcon } from "../components/TaskStatusIcon.tsx";
import { formatBytes, formatTime } from "../lib/format.ts";
import { executorLabel, taskKindLabel, TASK_STATUS_LABELS } from "../lib/labels.ts";
import type {
  ChatAttachment,
  ChatMessageRecord,
  ConversationDetail,
  ConversationListItem,
  ConversationSettings,
  ConversationSettingsPatch,
  ExecutorId,
  TaskFollowUpMode,
  TaskListItem,
  TaskProposalRecord
} from "../lib/types.ts";

const SUGGESTIONS = [
  "整理一份本周工作周报",
  "分析一个网址的内容并给出要点",
  "写一个批量重命名文件的脚本",
  "帮我检查项目里的 TypeScript 错误"
];

const PENDING_SETTINGS: ConversationSettings = {
  executorEnabled: { native: false, codex: false, "deepseek-harness": false, hermes: false, qoder: false, workbuddy: false, kimi: false },
  approvalMode: "necessary",
  preferredExecutorId: null
};

const EXECUTOR_ORDER: ExecutorId[] = ["deepseek-harness", "codex", "native", "hermes", "qoder", "workbuddy", "kimi"];

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
  const [memoryCount, setMemoryCount] = useState(0);
  const [proposals, setProposals] = useState<TaskProposalRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [followUpTaskId, setFollowUpTaskId] = useState<string | null>(null);
  const [followUpMode, setFollowUpMode] = useState<TaskFollowUpMode>("queue");
  const [followUpNotice, setFollowUpNotice] = useState<string | null>(null);
  const [draftSettings, setDraftSettings] = useState<ConversationSettings | null>(null);
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
    enabled: Boolean(conversationId),
    retry: false
  });
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health });
  const executorsQuery = useQuery({ queryKey: ["executors"], queryFn: api.executors, refetchInterval: 20_000 });
  const conversationDefaultsQuery = useQuery({ queryKey: ["conversationDefaults"], queryFn: api.conversationDefaults, staleTime: Infinity });
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
  const followUpTasks = conversationId
    ? tasks
      .filter((task) => task.conversationId === conversationId && !["completed", "cancelled"].includes(task.status))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    : [];
  const followUpTarget = followUpTasks.find((task) => task.id === followUpTaskId) ?? null;
  const canSteerFollowUp = followUpTarget?.status === "running";
  const followUpBlockedByAttachments = Boolean(followUpTarget && attachments.length > 0);
  const serverDefaults = conversationDefaultsQuery.data?.settings ?? null;
  const conversationSettings = current?.settings
    ?? conversationQuery.data?.conversation.settings
    ?? draftSettings
    ?? serverDefaults
    ?? PENDING_SETTINGS;
  const settingsReady = conversationId
    ? Boolean(current || conversationQuery.data)
    : Boolean(serverDefaults);

  useEffect(() => {
    if (!conversationQuery.data || sending) return;
    const nextMessages = conversationQuery.data.messages;
    setMessages((prev) => (nextMessages.length >= prev.length ? nextMessages : prev));
    setProposals(conversationQuery.data.proposals.filter((proposal) => proposal.status === "pending"));
  }, [conversationQuery.data, sending]);

  useEffect(() => {
    if (!conversationQuery.isError) return;
    if (conversationQuery.error instanceof ApiError && conversationQuery.error.status === 404) {
      resetConversationView(null);
      setError("原对话已失效，已为你开始新对话。");
    }
  }, [conversationQuery.isError, conversationQuery.error]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    if (!followUpTaskId) return;
    const target = tasks.find((task) => task.id === followUpTaskId
      && task.conversationId === conversationId
      && !["completed", "cancelled"].includes(task.status));
    if (!target) setFollowUpTaskId(null);
  }, [conversationId, followUpTaskId, tasks]);

  useEffect(() => {
    if (!canSteerFollowUp && followUpMode === "steer") setFollowUpMode("queue");
  }, [canSteerFollowUp, followUpMode]);

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

  function resetConversationView(id: string | null) {
    setConversationId(id);
    conversationIdRef.current = id;
    setMessages([]);
    setStreaming("");
    setReasoning("");
    setRouting(null);
    setMemoryCount(0);
    setProposals([]);
    setDraftSettings(null);
    setFollowUpTaskId(null);
    setFollowUpMode("queue");
    setFollowUpNotice(null);
    if (id) localStorage.setItem("hearth.conversation", id);
    else localStorage.removeItem("hearth.conversation");
  }

  function selectConversation(id: string | null) {
    if (sending) return;
    resetConversationView(id);
    setError(null);
  }

  function patchSettings(patch: ConversationSettingsPatch) {
    const next: ConversationSettings = {
      executorEnabled: {
        native: patch.executorEnabled?.native ?? conversationSettings.executorEnabled.native,
        codex: patch.executorEnabled?.codex ?? conversationSettings.executorEnabled.codex,
        "deepseek-harness": patch.executorEnabled?.["deepseek-harness"] ?? conversationSettings.executorEnabled["deepseek-harness"],
        hermes: patch.executorEnabled?.hermes ?? conversationSettings.executorEnabled.hermes,
        qoder: patch.executorEnabled?.qoder ?? conversationSettings.executorEnabled.qoder,
        workbuddy: patch.executorEnabled?.workbuddy ?? conversationSettings.executorEnabled.workbuddy,
        kimi: patch.executorEnabled?.kimi ?? conversationSettings.executorEnabled.kimi
      },
      approvalMode: patch.approvalMode ?? conversationSettings.approvalMode,
      preferredExecutorId: patch.preferredExecutorId !== undefined
        ? patch.preferredExecutorId
        : conversationSettings.preferredExecutorId
    };
    if (!conversationId) {
      setDraftSettings(next);
      return;
    }
    const id = conversationId;
    queryClient.setQueryData<ConversationDetail>(["conversation", id], (old) =>
      old ? { ...old, conversation: { ...old.conversation, settings: next } } : old
    );
    queryClient.setQueryData<{ conversations: ConversationListItem[] }>(["conversations"], (old) =>
      old ? {
        conversations: old.conversations.map((item) => item.id === id ? { ...item, settings: next } : item)
      } : old
    );
    void api.updateConversationSettings(id, patch)
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: ["conversations"] });
        await queryClient.invalidateQueries({ queryKey: ["conversation", id] });
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : "保存对话设置失败");
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        void queryClient.invalidateQueries({ queryKey: ["conversation", id] });
      });
  }

  function chooseExecutor(executorId: ExecutorId | "") {
    if (!executorId) {
      patchSettings({ preferredExecutorId: null });
      return;
    }
    patchSettings({
      preferredExecutorId: executorId,
      executorEnabled: { ...conversationSettings.executorEnabled, [executorId]: true }
    });
  }

  function toggleApprovalMode() {
    patchSettings({ approvalMode: conversationSettings.approvalMode === "full" ? "necessary" : "full" });
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
    if (sending || uploading || !settingsReady || (!text && attachments.length === 0)) return;
    if (followUpTarget) {
      if (!text) return;
      if (attachments.length > 0) {
        setError("补充到任务暂不支持附件，请先移除附件或取消任务补充模式");
        return;
      }
      setSending(true);
      setError(null);
      setFollowUpNotice(null);
      try {
        await api.addFollowUp(followUpTarget.id, text, followUpMode);
        setInput("");
        setFollowUpNotice(followUpMode === "steer"
          ? `已请求中止「${followUpTarget.title}」当前轮，并立即应用补充。`
          : `已加入「${followUpTarget.title}」的队列，当前轮结束后继续。`);
        void queryClient.invalidateQueries({ queryKey: ["task", followUpTarget.id] });
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        if (conversationId) void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "补充指令发送失败");
      } finally {
        setSending(false);
      }
      return;
    }
    const sentAttachments = attachments;
    setInput("");
    setAttachments([]);
    setStreaming("");
    setReasoning("");
    setRouting(null);
    setMemoryCount(0);
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
          ...(sentAttachments.length > 0 ? { attachments: sentAttachments } : {}),
          ...(!conversationId ? { settings: conversationSettings } : {})
        },
        {
          signal: controller.signal,
          onEvent: (event, data) => {
            if (event === "conversation") {
              const conversation = data as { id: string; settings?: ConversationSettings };
              setConversationId(conversation.id);
              conversationIdRef.current = conversation.id;
              if (conversation.settings) setDraftSettings(conversation.settings);
              localStorage.setItem("hearth.conversation", conversation.id);
            } else if (event === "user") {
              setMessages((prev) => [...prev, data as ChatMessageRecord]);
            } else if (event === "routing") {
              setRouting(data as RoutingState);
            } else if (event === "memory") {
              const payload = data as { count?: number };
              setMemoryCount(typeof payload.count === "number" ? payload.count : 0);
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
      if (sendError instanceof ApiError && sendError.status === 404) {
        resetConversationView(null);
        setInput(text);
        setError("原对话已失效，已为你开始新对话，请重新发送。");
      } else if (!controller.signal.aborted) {
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
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.preventDefault();
      void send();
    }
  }

  const configured = healthQuery.data?.chatModel.configured ?? true;
  const executorViews = executorsQuery.data?.executors ?? [];
  const executorAvailability = {} as Record<ExecutorId, boolean>;
  for (const id of EXECUTOR_ORDER) {
    executorAvailability[id] = executorViews.find((executor) => executor.id === id)?.health.canRun ?? false;
  }
  const executorReady = EXECUTOR_ORDER.some((id) => executorAvailability[id] && conversationSettings.executorEnabled[id]);
  const allExecutorsOff = !EXECUTOR_ORDER.some((id) => conversationSettings.executorEnabled[id]);
  const selectedExecutorId = conversationSettings.preferredExecutorId;
  const selectedExecutor = executorViews.find((executor) => executor.id === selectedExecutorId) ?? null;
  const selectedExecutorName = selectedExecutor?.name ?? (selectedExecutorId ? executorLabel(selectedExecutorId) : "");
  const selectedExecutorUnavailable = Boolean(selectedExecutorId && !executorAvailability[selectedExecutorId]);
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
                  还没有接入聊天模型。普通问答需要先完成<Link to="/welcome">首次设置</Link>；执行类任务仍会尝试派出。
                </ChatNotice>
              )}
              {!executorReady && (
                <ChatNotice icon={<Settings2 size={15} />} tone="warn">
                  当前没有可用的执行器，任务无法派出。到<Link to="/settings">设置</Link>查看连接诊断。
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
              {memoryCount > 0 && !sending && (
                <div className="chat-memory-note">
                  <Brain size={13} /> 本次回答参考了 {memoryCount} 条记忆
                  <Link to="/settings?tab=automation">自动记忆</Link>
                </div>
              )}
              {sending && !streaming && !reasoning && (
                <div className="typing-row">
                  <Loader2 size={14} className="spin" />
                  <span>{routing?.action === "task" ? "正在派出任务…" : routing ? "正在回答…" : selectedExecutorId ? `正在交给 ${selectedExecutorName} 处理…` : "正在判断是回答还是执行…"}</span>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <div className="composer-toolbar">
            <label className="executor-picker" title="选择本对话锁定的执行器；不会自动切换到其他执行器">
              <Cpu size={15} />
              <span className={`status-dot ${selectedExecutorId ? selectedExecutorUnavailable ? "offline" : "online" : executorReady ? "online" : "offline"}`} />
              <select
                value={selectedExecutorId ?? ""}
                onChange={(event) => chooseExecutor(event.target.value as ExecutorId | "")}
                disabled={!settingsReady}
                aria-label="锁定执行器"
              >
                <option value="">自动匹配（按任务）</option>
                {EXECUTOR_ORDER.map((id) => {
                  const view = executorViews.find((executor) => executor.id === id);
                  return (
                    <option key={id} value={id}>
                      {view?.name ?? executorLabel(id)}{executorAvailability[id] ? "" : " · 不可用"}
                    </option>
                  );
                })}
              </select>
            </label>
            <span className="composer-toolbar-sep" aria-hidden="true" />
            <button
              type="button"
              className={`permission-toggle ${conversationSettings.approvalMode}`}
              onClick={toggleApprovalMode}
              disabled={!settingsReady}
              title={conversationSettings.approvalMode === "full"
                ? "完全权限：所有动作自动决策并执行，点击切回必要审批"
                : "必要审批：只有不可逆的外部动作才询问你，点击切换为完全权限"}
            >
              {conversationSettings.approvalMode === "full" ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}
              <span>{conversationSettings.approvalMode === "full" ? "完全权限" : "必要审批"}</span>
            </button>
            {followUpTasks.length > 0 && (
              <>
                <span className="composer-toolbar-sep" aria-hidden="true" />
                <label className={`followup-picker ${followUpTarget ? "active" : ""}`} title="把这条消息补充到已有任务，而不是新建任务">
                  <CornerDownRight size={15} />
                  <select
                    value={followUpTarget?.id ?? ""}
                    onChange={(event) => {
                      setFollowUpTaskId(event.target.value || null);
                      setFollowUpMode("queue");
                      setFollowUpNotice(null);
                    }}
                    aria-label="补充到任务"
                  >
                    <option value="">新消息</option>
                    {followUpTasks.map((task) => (
                      <option key={task.id} value={task.id}>{task.title}</option>
                    ))}
                  </select>
                </label>
                {followUpTarget && (
                  <button
                    type="button"
                    className={`followup-mode-toggle ${followUpMode}`}
                    onClick={() => setFollowUpMode((current) => current === "queue" ? "steer" : "queue")}
                    disabled={!canSteerFollowUp && followUpMode === "queue"}
                    title={canSteerFollowUp
                      ? (followUpMode === "queue" ? "当前轮结束后继续；点击改为中止当前轮" : "中止当前轮并立即应用；点击改为轮后继续")
                      : "只有运行中的任务可以中止本轮，消息会在当前轮结束后继续"}
                  >
                    {followUpMode === "steer" ? <PauseCircle size={14} /> : <CornerDownRight size={14} />}
                    <span>{followUpMode === "steer" ? "中止本轮" : "轮后继续"}</span>
                  </button>
                )}
              </>
            )}
            {selectedExecutorUnavailable && (
              <span className="composer-toolbar-note">{selectedExecutorName} 当前不可用，任务不会自动切换执行器</span>
            )}
            {allExecutorsOff && (
              <span className="composer-toolbar-note">所有执行器都已关闭，请先选择一个可用执行器</span>
            )}
            {followUpBlockedByAttachments && (
              <span className="composer-toolbar-note">补充到任务暂不支持附件</span>
            )}
          </div>
          {followUpNotice && (
            <div className="composer-followup-notice">
              <CornerDownRight size={14} />
              <span>{followUpNotice}</span>
              <button className="icon-button" onClick={() => setFollowUpNotice(null)} aria-label="关闭提示"><X size={13} /></button>
            </div>
          )}
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
              placeholder={followUpTarget
                ? (followUpMode === "steer" ? "补充修正要求，中止当前轮并重跑…" : "补充下一步要求，当前轮结束后继续…")
                : "直接说你要做什么，例如：帮我整理这周的会议记录…"}
              rows={1}
              disabled={sending}
            />
            <button className="composer-send" onClick={() => void send()} disabled={sending || uploading || !settingsReady || followUpBlockedByAttachments || (!input.trim() && attachments.length === 0)} title={followUpTarget ? "发送补充指令" : "发送"}>
              {sending ? <Loader2 size={17} className="spin" /> : <ArrowUp size={18} />}
            </button>
          </div>
          <p className="composer-hint">
            {followUpTarget
              ? `补充到「${followUpTarget.title}」 · ${followUpMode === "steer" ? "中止当前轮后继续" : "当前轮结束后继续"} · Enter 发送`
              : "Enter 发送 · Shift + Enter 换行 · 附件最多 5 个"}
          </p>
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
              <span className={`rail-task-icon ${task.status}`}><TaskStatusIcon status={task.status} size={12} /></span>
              <span className="rail-task-title">{task.title}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function ChatBubble({ message, conversationId }: { message: ChatMessageRecord; conversationId: string | null }) {
  if (message.kind === "task_status") {
    return <TaskStatusBubble message={message} conversationId={conversationId} />;
  }
  if (message.role === "user") {
    return (
      <div className="message-row user">
        <div className="message-bubble user-bubble">
          {message.content && <CopyButton text={message.content} className="message-copy" />}
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
      <AssistantBubble
        content={message.content}
        copyText={message.content}
        taskId={message.taskId}
        createdAt={message.createdAt}
        conversationId={conversationId}
      />
    </div>
  );
}

function TaskStatusBubble({ message, conversationId }: { message: ChatMessageRecord; conversationId: string | null }) {
  const label = message.taskStatus ? TASK_STATUS_LABELS[message.taskStatus] : "任务状态";
  return (
    <div className="message-row assistant">
      <div className={`message-bubble task-status-bubble ${message.taskStatus ?? "queued"}`}>
        <CopyButton text={message.content} className="message-copy" />
        <div className="task-status-head">
          {message.taskStatus ? <TaskStatusIcon status={message.taskStatus} size={14} /> : <span className="task-status-dot" />}
          <strong>{label}</strong>
          <time>{formatTime(message.createdAt)}</time>
        </div>
        <p className="task-status-text">{message.content}</p>
        {message.taskId && (
          <Link
            className="task-status-link"
            to={`/tasks/${message.taskId}`}
            state={{ fromChat: true, ...(conversationId ? { conversationId } : {}) }}
          >
            查看任务
          </Link>
        )}
      </div>
    </div>
  );
}

function AssistantBubble({
  content,
  copyText,
  reasoning = "",
  taskId,
  createdAt,
  streaming = false,
  conversationId
}: {
  content: string;
  copyText?: string;
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
      {copyText && !streaming && <CopyButton text={copyText} className="message-copy" />}
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

function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>();

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    window.clearTimeout(timer.current);
    try {
      await copyToClipboard(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 1_600);
  }

  const title = state === "copied" ? "已复制" : state === "failed" ? "复制失败" : "复制";
  return (
    <button
      type="button"
      className={`copy-button ${state} ${className}`.trim()}
      onClick={(event) => {
        event.stopPropagation();
        void copy();
      }}
      title={title}
      aria-label={title}
    >
      {state === "copied" ? <Check size={13} /> : state === "failed" ? <X size={13} /> : <Copy size={13} />}
    </button>
  );
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy path for browsers that block the async API.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  document.body.appendChild(area);
  area.focus();
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    document.body.removeChild(area);
  }
  if (!copied) throw new Error("copy failed");
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

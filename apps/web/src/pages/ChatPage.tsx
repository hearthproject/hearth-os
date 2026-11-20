import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { ChatMailDraft } from "../components/ChatMailDraft.tsx";
import { isMailDraftReply } from "../lib/mail-draft.ts";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Check,
  CheckCircle2,
  Copy,
  CornerDownRight,
  FileText,
  Folder,
  Loader2,
  Paperclip,
  PauseCircle,
  RotateCcw,
  Settings2,
  Sparkles,
  ShieldAlert,
  SlidersHorizontal,
  X
} from "lucide-react";
import { ApiError, api, chatStream } from "../lib/api.ts";
import { ChatWorkspacePanel } from "../components/ChatWorkspacePanel.tsx";
import { ProjectDialog } from "../components/ProjectDialog.tsx";
import { TaskStatusIcon } from "../components/TaskStatusIcon.tsx";
import { formatBytes, formatDuration, formatTime, formatTokens } from "../lib/format.ts";
import { getChatSelection, setChatBusy, syncChatSelection, useChatSelection } from "../lib/chat-selection.ts";
import { executorLabel, taskKindLabel, TASK_STATUS_LABELS, approvalModeLabel } from "../lib/labels.ts";
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
  TaskProposalRecord,
  TaskTurn,
  SkillView
} from "../lib/types.ts";

const PENDING_SETTINGS: ConversationSettings = {
  executorEnabled: { native: false, codex: false, "deepseek-harness": false },
  approvalMode: "necessary",
  preferredExecutorId: null
};

const EXECUTOR_ORDER: ExecutorId[] = ["deepseek-harness", "codex", "native"];

interface RoutingState {
  action: "chat" | "task";
  reason: string;
  title: string;
}

export function ChatPage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const selection = useChatSelection();
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
  const [routeMode, setRouteMode] = useState<"auto" | "chat" | "task">("auto");
  const [proposals, setProposals] = useState<TaskProposalRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [followUpTaskId, setFollowUpTaskId] = useState<string | null>(null);
  const [followUpMode, setFollowUpMode] = useState<TaskFollowUpMode>("queue");
  const [followUpNotice, setFollowUpNotice] = useState<string | null>(null);
  const [draftSettings, setDraftSettings] = useState<ConversationSettings | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(() => getChatSelection().pendingProjectId);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(() => new URLSearchParams(location.search).get("skill"));
  const [slashIndex, setSlashIndex] = useState(0);
  const [skillInstallRequest, setSkillInstallRequest] = useState<{ source: string } | null>(null);
  const [skillNotice, setSkillNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const conversationIdRef = useRef<string | null>(conversationId);
  const handledSelectionNonce = useRef(selection.nonce);
  const panelConversationRef = useRef<string | null>(conversationId);

  const conversationsQuery = useQuery({ queryKey: ["conversations"], queryFn: api.conversations, refetchInterval: 15_000 });
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 8_000 });
  const conversationQuery = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => api.conversation(conversationId as string),
    enabled: Boolean(conversationId),
    retry: false
  });
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health });
  const skillsQuery = useQuery({ queryKey: ["skills"], queryFn: api.skills, staleTime: 30_000 });
  const executorsQuery = useQuery({ queryKey: ["executors"], queryFn: api.executors, refetchInterval: 20_000 });
  const conversationDefaultsQuery = useQuery({ queryKey: ["conversationDefaults"], queryFn: api.conversationDefaults, staleTime: Infinity });
  const conversations = conversationsQuery.data?.conversations ?? [];
  const skills = skillsQuery.data?.skills ?? [];
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId) ?? null;
  const slashTerm = input.startsWith("/") && !input.startsWith("//") ? input.slice(1).trim().toLocaleLowerCase() : null;
  const slashMatches = slashTerm === null ? [] : skills.filter((skill) => {
    if (!slashTerm) return true;
    return `${skill.name} ${skill.manifest.description} ${skill.id}`.toLocaleLowerCase().includes(slashTerm);
  }).slice(0, 8);
  const slashOpen = slashTerm !== null && !selectedSkill && !sending;

  const installSkillMutation = useMutation({
    mutationFn: api.installSkill,
    onSuccess: (result) => {
      setSkillInstallRequest(null);
      setSkillNotice(`已安装「${result.skill.name}」。输入 / 就可以使用。`);
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      void queryClient.invalidateQueries({ queryKey: ["library-tree"] });
      void queryClient.invalidateQueries({ queryKey: ["library-status"] });
    },
    onError: (error) => setSkillNotice(error instanceof Error ? error.message : "安装失败")
  });
  const tasks = tasksQuery.data?.tasks ?? [];
  const tasksByConversation = new Map<string, TaskListItem[]>();
  for (const task of tasks) {
    if (!task.conversationId) continue;
    const list = tasksByConversation.get(task.conversationId) ?? [];
    list.push(task);
    tasksByConversation.set(task.conversationId, list);
  }
  const conversationTasks = conversationId ? tasksByConversation.get(conversationId) ?? [] : [];
  const hasMessageAttachments = messages.some((message) => (message.attachments?.length ?? 0) > 0);
  const current = conversations.find((item) => item.id === conversationId) ?? null;
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: api.projects, refetchInterval: 30_000 });
  const projects = projectsQuery.data?.projects ?? [];
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const activeProject = current?.projectId
    ? projectsById.get(current.projectId) ?? null
    : pendingProjectId
      ? projectsById.get(pendingProjectId) ?? null
      : null;
  const followUpTasks = conversationTasks
    .filter((task) => !["completed", "cancelled"].includes(task.status))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const followUpTarget = followUpTasks.find((task) => task.id === followUpTaskId) ?? null;
  const canSteerFollowUp = followUpTarget?.status === "running";
  const followUpBlockedByAttachments = Boolean(followUpTarget && attachments.length > 0);
  const serverDefaults = conversationDefaultsQuery.data?.settings ?? null;
  const rawSettings = current?.settings
    ?? conversationQuery.data?.conversation.settings
    ?? draftSettings
    ?? serverDefaults
    ?? PENDING_SETTINGS;
  const conversationSettings: ConversationSettings = rawSettings;
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
    if (selection.nonce === handledSelectionNonce.current) return;
    handledSelectionNonce.current = selection.nonce;
    if (sending) return;
    resetConversationView(selection.conversationId);
    setPendingProjectId(selection.pendingProjectId);
    setError(null);
  }, [selection.nonce]);

  useEffect(() => {
    syncChatSelection(conversationId, pendingProjectId);
  }, [conversationId, pendingProjectId]);

  useEffect(() => {
    setChatBusy(sending || uploading);
  }, [sending, uploading]);

  useEffect(() => () => setChatBusy(false), []);

  useEffect(() => {
    if (panelConversationRef.current === conversationId) return;
    panelConversationRef.current = conversationId;
    setPanelOpen(false);
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId || panelOpen) return;
    if (conversationTasks.length === 0 && attachments.length === 0 && !hasMessageAttachments) return;
    try {
      if (localStorage.getItem(`hearth.workspace.closed.${conversationId}`) === "1") return;
    } catch {
      // localStorage 不可用时允许自动展开
    }
    setPanelOpen(true);
  }, [conversationId, panelOpen, conversationTasks.length, attachments.length, hasMessageAttachments]);

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
    setSlashIndex(0);
  }, [input]);

  useEffect(() => {
    if (!selectedSkillId) return;
    if (skillsQuery.isLoading) return;
    if (!skills.some((skill) => skill.id === selectedSkillId)) setSelectedSkillId(null);
  }, [selectedSkillId, skills, skillsQuery.isLoading]);

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

  useEffect(() => {
    if (!optionsOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!optionsRef.current?.contains(event.target as Node)) setOptionsOpen(false);
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOptionsOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [optionsOpen]);

  function resetConversationView(id: string | null) {
    setRouteMode("auto");
    setConversationId(id);
    conversationIdRef.current = id;
    setMessages([]);
    setStreaming("");
    setReasoning("");
    setRouting(null);
    setProposals([]);
    setDraftSettings(null);
    setFollowUpTaskId(null);
    setFollowUpMode("queue");
    setFollowUpNotice(null);
    setOptionsOpen(false);
    if (id) localStorage.setItem("hearth.conversation", id);
    else localStorage.removeItem("hearth.conversation");
  }

  function openWorkspace() {
    setPanelOpen(true);
    if (!conversationId) return;
    try {
      localStorage.removeItem(`hearth.workspace.closed.${conversationId}`);
    } catch {
      // localStorage 不可用时只影响下次自动展开
    }
  }

  function closeWorkspace() {
    setPanelOpen(false);
    if (!conversationId) return;
    try {
      localStorage.setItem(`hearth.workspace.closed.${conversationId}`, "1");
    } catch {
      // localStorage 不可用时只影响下次自动展开
    }
  }

  function patchSettings(patch: ConversationSettingsPatch) {
    const next: ConversationSettings = {
      executorEnabled: {
        native: patch.executorEnabled?.native ?? conversationSettings.executorEnabled.native,
        codex: patch.executorEnabled?.codex ?? conversationSettings.executorEnabled.codex,
        "deepseek-harness": patch.executorEnabled?.["deepseek-harness"] ?? conversationSettings.executorEnabled["deepseek-harness"]
      },
      approvalMode: patch.approvalMode ?? conversationSettings.approvalMode,
      executionMode: patch.executionMode ?? conversationSettings.executionMode ?? "standard",
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
    if (routeMode === "chat" && attachments.length > 0) {
      setError("继续聊天模式暂不读取附件。请粘贴文字，或选择派为任务。");
      return;
    }
    if (selectedExecutorUnavailable && routeMode !== "chat") {
      setError(`${selectedExecutorName} 当前不可用，不会自动切换执行器。${selectedExecutor?.health.issues.join("；") ?? "请到设置中测试可用性。"}`);
      return;
    }
    setOptionsOpen(false);
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
    const sentSkillId = selectedSkillId;
    setInput("");
    setAttachments([]);
    if (sentSkillId) setSelectedSkillId(null);
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
          routeMode,
          ...(conversationId ? { conversationId } : {}),
          ...(!conversationId && pendingProjectId ? { projectId: pendingProjectId } : {}),
          ...(text ? { message: text } : {}),
          ...(sentSkillId ? { skillId: sentSkillId } : {}),
          ...(sentAttachments.length > 0 ? { attachments: sentAttachments } : {}),
          ...(!conversationId ? { settings: conversationSettings } : {})
        },
        {
          signal: controller.signal,
          onEvent: (event, data) => {
            if (event === "conversation") {
              const conversation = data as { id: string; settings?: ConversationSettings; projectId?: string | null };
              setConversationId(conversation.id);
              conversationIdRef.current = conversation.id;
              if (conversation.settings) setDraftSettings(conversation.settings);
              setPendingProjectId(null);
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
            } else if (event === "skill_install") {
              const payload = data as { source: string };
              setSkillInstallRequest({ source: payload.source });
              setSkillNotice(null);
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
        if (sentSkillId) setSelectedSkillId(sentSkillId);
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
      if (slashOpen && slashMatches.length > 0) {
        event.preventDefault();
        const match = slashMatches[Math.min(slashIndex, slashMatches.length - 1)];
        if (match) chooseSkill(match.id);
        return;
      }
      event.preventDefault();
      void send();
      return;
    }
    if (slashOpen && (event.key === "ArrowDown" || event.key === "ArrowUp") && slashMatches.length > 0) {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setSlashIndex((current) => (current + offset + slashMatches.length) % slashMatches.length);
      return;
    }
    if (slashOpen && event.key === "Escape") {
      event.preventDefault();
      setInput("");
    }
  }

  function chooseSkill(id: string) {
    setSelectedSkillId(id);
    setInput("");
    setSlashIndex(0);
    requestAnimationFrame(() => composerRef.current?.focus());
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
  const visibleExecutorIds = EXECUTOR_ORDER.filter((id) => executorAvailability[id] || id === selectedExecutorId);

  return (
    <div className="chat-layout">
      <section className="chat-main">
        <header className="chat-header">
          <h1>{current?.title ?? "新对话"}</h1>
          {(current ? projectsById.get(current.projectId ?? "") : activeProject) && (
            <span className="chat-project-chip" title={current ? projectsById.get(current.projectId ?? "")?.path : activeProject?.path}>
              <Folder size={12} />
              {(current ? projectsById.get(current.projectId ?? "") : activeProject)?.name}
            </span>
          )}
          <span className="chat-project-chip" title="工作区内文件读写自动执行；发邮件、访问新域名、操作桌面仍会审批。每个任务可以带自己的审批模式。">
            <ShieldAlert size={12} />
            审批 · {approvalModeLabel(conversationSettings.approvalMode)}
          </span>
        </header>

        <div className="chat-scroll">
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
            {messages.length === 0 && proposals.length === 0 && !streaming && !sending && (
              <div className="chat-empty">
                <div className="chat-empty-mark"><Sparkles size={20} /></div>
                <h2>{activeProject ? `你想在 ${activeProject.name} 中构建什么？` : "你想让 Hearth 帮你完成什么？"}</h2>
                <p>
                  {activeProject
                    ? "描述目标、贴一段报错，或让我先看看现有代码。"
                    : "描述你的目标，Hearth 会规划、执行并交付结果。"}
                </p>
              </div>
            )}
            {messages.map((message, index) => <ChatBubble key={message.id} message={message} conversationId={conversationId} mailDraft={!message.taskId && isMailDraftReply(messages, index)} />)}
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
                <span>{routing?.action === "task" ? "正在派出任务…" : routing ? "正在回答…" : selectedExecutorId ? `正在交给 ${selectedExecutorName} 处理…` : "正在判断是回答还是执行…"}</span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="composer-wrap">
          {!conversationId && (
            <div className="composer-project-row">
              <label className="composer-project">
                <Folder size={13} />
                <select
                  value={pendingProjectId ?? ""}
                  onChange={(event) => setPendingProjectId(event.target.value || null)}
                  disabled={sending}
                  aria-label="选择项目"
                >
                  <option value="">不绑定项目</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id} disabled={!project.available}>
                      {project.name}{project.kind === "git" ? ` · ${project.currentBranch ?? project.defaultBranch}` : " · 文件夹"}
                    </option>
                  ))}
                </select>
              </label>
              {projects.length === 0 && (
                <button type="button" className="link-button" onClick={() => setProjectDialogOpen(true)}>
                  新建项目
                </button>
              )}
            </div>
          )}
          <div className="composer-tools">
            <div className="composer-options-wrap" ref={optionsRef}>
              <button
                type="button"
                className="composer-options-trigger"
                onClick={() => setOptionsOpen((open) => !open)}
                disabled={!settingsReady}
                aria-expanded={optionsOpen}
                aria-haspopup="dialog"
                aria-label="会话选项"
              >
                <SlidersHorizontal size={15} />
                <span>选项</span>
              </button>
              {optionsOpen && (
                <div className="composer-options" role="dialog" aria-label="会话选项">
                  <label className="composer-option">
                    <span>处理方式</span>
                    <select aria-label="消息处理方式" value={routeMode} disabled={sending} onChange={(event) => {
                      setRouteMode(event.target.value as "auto" | "chat" | "task");
                      setFollowUpTaskId(null);
                    }}>
                      <option value="auto">自动判断</option>
                      <option value="chat">继续聊天</option>
                      <option value="task">派为任务</option>
                    </select>
                  </label>
                  <label className="composer-option">
                    <span>执行器</span>
                    <select
                      value={selectedExecutorId ?? ""}
                      onChange={(event) => chooseExecutor(event.target.value as ExecutorId | "")}
                      disabled={!settingsReady}
                      aria-label="锁定执行器"
                    >
                      <option value="">自动匹配</option>
                      {visibleExecutorIds.map((id) => {
                        const view = executorViews.find((executor) => executor.id === id);
                        return (
                          <option key={id} value={id}>
                            {view?.name ?? executorLabel(id)}{executorAvailability[id] ? "" : " · 当前不可用"}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  <label className="composer-option">
                    <span>深度</span>
                    <select
                      aria-label="原生执行深度"
                      value={conversationSettings.executionMode ?? "standard"}
                      disabled={!settingsReady}
                      onChange={(event) => patchSettings({ executionMode: event.target.value as "quick" | "standard" | "deep" })}
                    >
                      <option value="quick">快速</option>
                      <option value="standard">标准</option>
                      <option value="deep">深入</option>
                    </select>
                  </label>
                  {selectedExecutorUnavailable && (
                    <p className="composer-options-note" title={selectedExecutor?.health.issues.join("；")}>
                      {selectedExecutorName} 当前不可用：{selectedExecutor?.health.issues[0] ?? "请到设置中测试可用性"}。不会自动切换执行器
                    </p>
                  )}
                  {allExecutorsOff && (
                    <p className="composer-options-note">所有执行器都已关闭，请先选择一个可用执行器</p>
                  )}
                  {followUpBlockedByAttachments && (
                    <p className="composer-options-note">补充到任务暂不支持附件</p>
                  )}
                </div>
              )}
            </div>
            {selectedSkill && (
              <span className="composer-skill-chip" title={selectedSkill.manifest.description}>
                <Sparkles size={14} />
                <span>使用技能：{selectedSkill.name}</span>
                <button type="button" onClick={() => setSelectedSkillId(null)} aria-label="取消使用技能">
                  <X size={12} />
                </button>
              </span>
            )}
            {followUpTasks.length > 0 && (
              <div className="composer-followup">
                <label className={`followup-chip ${followUpTarget ? "active" : ""}`} title="把这条消息补充到已有任务，而不是新建任务">
                  <CornerDownRight size={14} />
                  <select
                    value={followUpTarget?.id ?? ""}
                    onChange={(event) => {
                      setFollowUpTaskId(event.target.value || null);
                      if (event.target.value) setRouteMode("task");
                      setFollowUpMode("queue");
                      setFollowUpNotice(null);
                    }}
                    aria-label="补充到任务"
                  >
                    <option value="">补充任务</option>
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
              </div>
            )}
          </div>
          {followUpNotice && (
            <div className="composer-followup-notice">
              <CornerDownRight size={14} />
              <span>{followUpNotice}</span>
              <button className="icon-button" onClick={() => setFollowUpNotice(null)} aria-label="关闭提示"><X size={13} /></button>
            </div>
          )}
          {skillNotice && (
            <div className="composer-skill-notice">
              <Sparkles size={14} />
              <span>{skillNotice}</span>
              <button className="icon-button" onClick={() => setSkillNotice(null)} aria-label="关闭提示"><X size={13} /></button>
            </div>
          )}
          {skillInstallRequest && (
            <div className="composer-skill-install">
              <div>
                <strong>安装这个技能？</strong>
                <span title={skillInstallRequest.source}>{skillInstallRequest.source}</span>
              </div>
              <div className="composer-skill-install-actions">
                <button type="button" className="ghost-button" onClick={() => setSkillInstallRequest(null)} disabled={installSkillMutation.isPending}>
                  取消
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => installSkillMutation.mutate(skillInstallRequest.source)}
                  disabled={installSkillMutation.isPending}
                >
                  {installSkillMutation.isPending ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                  确认安装
                </button>
              </div>
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
          {slashOpen && (
            <div className="composer-slash-menu" role="listbox" aria-label="选择技能">
              {slashMatches.length === 0 ? (
                <p className="composer-slash-empty">还没有匹配的技能。可以到资料库安装。</p>
              ) : slashMatches.map((skill, index) => (
                <button
                  key={skill.id}
                  type="button"
                  role="option"
                  aria-selected={index === Math.min(slashIndex, slashMatches.length - 1)}
                  className={`composer-slash-item ${index === Math.min(slashIndex, slashMatches.length - 1) ? "active" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseSkill(skill.id)}
                >
                  <Sparkles size={15} />
                  <span>
                    <strong>{skill.name}</strong>
                    <small>{skill.manifest.description || "已安装的技能"}</small>
                  </span>
                </button>
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
              aria-label="消息"
              placeholder="向 Hearth 提问，或描述你要完成的任务…"
              rows={1}
              disabled={sending}
            />
            <button className="composer-send" onClick={() => void send()} disabled={sending || uploading || !settingsReady || (selectedExecutorUnavailable && routeMode !== "chat") || followUpBlockedByAttachments || (!input.trim() && attachments.length === 0)} title={selectedExecutorUnavailable && routeMode !== "chat" ? "当前锁定的执行器不可用" : followUpTarget ? "发送补充指令" : "发送"}>
              {sending ? <Loader2 size={17} className="spin" /> : <ArrowUp size={18} />}
            </button>
          </div>
        </div>
      </section>
      <ChatWorkspacePanel
        open={panelOpen}
        conversationId={conversationId}
        messages={messages}
        tasks={conversationTasks}
        onOpen={openWorkspace}
        onClose={closeWorkspace}
      />
      {projectDialogOpen && (
        <ProjectDialog
          onClose={() => setProjectDialogOpen(false)}
          onCreated={(project) => {
            setProjectDialogOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["projects"] });
            setPendingProjectId(project.id);
          }}
        />
      )}
    </div>
  );
}

function ChatBubble({ message, conversationId, mailDraft = false }: { message: ChatMessageRecord; conversationId: string | null; mailDraft?: boolean }) {
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
      {mailDraft ? <ChatMailDraft content={message.content} /> :
      <AssistantBubble
        content={message.content}
        copyText={message.content}
        taskId={message.taskId}
        taskStatus={message.taskStatus}
        createdAt={message.createdAt}
        conversationId={conversationId}
      />}
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
            {message.taskStatus === "running" ? "查看任务与执行过程" : "查看任务"}
          </Link>
        )}
      </div>
    </div>
  );
}

function TaskLinkCard({
  taskId,
  taskStatus,
  conversationId
}: {
  taskId: string;
  taskStatus?: ChatMessageRecord["taskStatus"];
  conversationId?: string | null;
}) {
  const queryClient = useQueryClient();
  const [rewinding, setRewinding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taskQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.task(taskId),
    enabled: Boolean(taskId),
    staleTime: 10_000
  });
  const turnsQuery = useQuery({
    queryKey: ["task-turns", taskId],
    queryFn: () => api.taskTurns(taskId),
    enabled: Boolean(taskQuery.data),
    staleTime: 10_000
  });
  const view = taskQuery.data;
  const task = view?.task;
  const status = task?.status ?? taskStatus ?? "queued";
  const latestRun = view?.runs && view.runs.length > 0 ? view.runs[view.runs.length - 1] : null;
  const turns = turnsQuery.data?.turns ?? [];
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const elapsed = latestRun?.startedAt && latestRun.endedAt
    ? new Date(latestRun.endedAt).getTime() - new Date(latestRun.startedAt).getTime()
    : null;
  const verification = latestTurn ? turnVerificationLabel(latestTurn) : "";

  async function rewindLatest(turn: TaskTurn, force = false): Promise<void> {
    setRewinding(true);
    setNotice(null);
    setError(null);
    try {
      await api.rewindTask(taskId, { runId: turn.runId, turn: turn.turn, force });
      setNotice(`已回退第 ${turn.turn} 轮`);
      await queryClient.invalidateQueries({ queryKey: ["task-turns", taskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    } catch (caught) {
      if (!force && caught instanceof ApiError && caught.code === "HISTORY_DRIFT") {
        if (window.confirm(`${caught.message}\n\n强制回退会覆盖后续改动，确定继续？`)) {
          await rewindLatest(turn, true);
          return;
        }
      }
      setError(caught instanceof Error ? caught.message : "回退失败");
    } finally {
      setRewinding(false);
    }
  }

  function requestRewind(turn: TaskTurn): void {
    const confirmed = window.confirm(
      `回退到第 ${turn.turn} 轮执行之前？\n\n会恢复本轮改过的文件，并删除本轮新建的文件。`
    );
    if (confirmed) void rewindLatest(turn);
  }

  return (
    <div className="task-link-card">
      <Link
        className="task-link-main"
        to={`/tasks/${taskId}`}
        state={{ fromChat: true, ...(conversationId ? { conversationId } : {}) }}
      >
        <div className="task-link-head">
          <TaskStatusIcon status={status} size={14} />
          <strong>{TASK_STATUS_LABELS[status]}</strong>
          <span className="task-link-title">{task?.title ?? "任务"}</span>
        </div>
        {view && (
          <div className="task-link-meta">
            <span>{view.artifacts.length} 个文件</span>
            {latestTurn && <span>{latestTurn.files.length} 个改动</span>}
            {verification && <span>{verification}</span>}
            {turns.length > 0 && <span>{turns.length} 轮</span>}
            <span>{formatDuration(elapsed)}</span>
            {latestRun?.usage && <span>{formatTokens(latestRun.usage)} tokens</span>}
          </div>
        )}
      </Link>
      <div className="task-link-actions">
        {latestTurn && (
          <button className="task-link-rewind" onClick={() => requestRewind(latestTurn)} disabled={rewinding}>
            {rewinding ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}
            回退最近一轮
          </button>
        )}
        <Link
          className="task-link-open"
          to={`/tasks/${taskId}`}
          state={{ fromChat: true, ...(conversationId ? { conversationId } : {}) }}
        >
          打开 →
        </Link>
      </div>
      {notice && <p className="task-link-note">{notice}</p>}
      {error && <p className="task-link-error">{error}</p>}
    </div>
  );
}

function turnVerificationLabel(turn: TaskTurn): string {
  const verification = turn.verification;
  if (!verification) return "暂无验证记录";
  if (verification.failedTests.length > 0) return `${verification.failedTests.length} 个测试失败`;
  if (verification.browserAssertions.some((item) => !item.passed)) return "页面断言失败";
  if (verification.diagnostics.length > 0) return `${verification.diagnostics.length} 条诊断`;
  if (verification.toolCalls > 0 && verification.exitCodes.some((code) => code === 0)) return "测试通过";
  if (verification.browserAssertions.length > 0) return "页面断言通过";
  return "已执行验证";
}

function AssistantBubble({
  content,
  copyText,
  reasoning = "",
  taskId,
  taskStatus,
  createdAt,
  streaming = false,
  conversationId
}: {
  content: string;
  copyText?: string;
  reasoning?: string;
  taskId?: string | null;
  taskStatus?: ChatMessageRecord["taskStatus"];
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
        <TaskLinkCard taskId={taskId} taskStatus={taskStatus} conversationId={conversationId ?? null} />
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
  const [projectId, setProjectId] = useState("");
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const projects = projectsQuery.data?.projects.filter((project) => project.available) ?? [];

  async function confirm() {
    setBusy("confirm");
    setError(null);
    try {
      const result = await api.confirmTaskProposal(proposal.id, projectId || undefined);
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
      {projects.length > 0 && (
        <label className="proposal-project">
          <span>在本地项目中执行（可选）</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={busy !== null}>
            <option value="">不绑定项目</option>
            {projects.map((project) => (
              <option value={project.id} key={project.id}>{project.name} · {project.currentBranch ?? project.defaultBranch}</option>
            ))}
          </select>
          {projectId && <small>将使用 native 执行器，并自动创建独立 Git Worktree。</small>}
        </label>
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

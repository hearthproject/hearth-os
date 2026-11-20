import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { ChatMailDraft } from "../components/ChatMailDraft.tsx";
import { isMailDraftReply } from "../lib/mail-draft.ts";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Check,
  Copy,
  FileText,
  Folder,
  Loader2,
  Paperclip,
  Settings2,
  Sparkles,
  ShieldAlert,
  X
} from "lucide-react";
import { ApiError, api, chatStream } from "../lib/api.ts";
import { ChatWorkspacePanel } from "../components/ChatWorkspacePanel.tsx";
import { ProjectDialog } from "../components/ProjectDialog.tsx";
import { InlineRun, type RunInfo } from "../components/InlineRun.tsx";
import { TaskStatusIcon } from "../components/TaskStatusIcon.tsx";
import { formatBytes, formatTime } from "../lib/format.ts";
import { getChatSelection, setChatBusy, syncChatSelection, useChatSelection } from "../lib/chat-selection.ts";
import { executorLabel, TASK_STATUS_LABELS, approvalModeLabel } from "../lib/labels.ts";
import type {
  ChatAttachment,
  ChatMessageRecord,
  ConversationDetail,
  ConversationListItem,
  ConversationSettings,
  ConversationSettingsPatch,
  ExecutorId,
  TaskListItem,
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

interface TimelineMessage {
  kind: "message";
  key: string;
  at: string;
  message: ChatMessageRecord;
}

interface TimelineRun {
  kind: "run";
  key: string;
  at: string;
  task: RunInfo;
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
  const [liveRuns, setLiveRuns] = useState<RunInfo[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [routing, setRouting] = useState<RoutingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftSettings, setDraftSettings] = useState<ConversationSettings | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(() => getChatSelection().pendingProjectId);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(() => new URLSearchParams(location.search).get("skill"));
  const [slashIndex, setSlashIndex] = useState(0);
  const [skillInstallRequest, setSkillInstallRequest] = useState<{ source: string } | null>(null);
  const [skillNotice, setSkillNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
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
  const latestTask = [...conversationTasks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
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

  const visibleMessages = messages.filter((message) => !isTaskNoise(message));
  const runs: RunInfo[] = [];
  const seenRuns = new Set<string>();
  for (const task of conversationTasks) {
    if (seenRuns.has(task.id)) continue;
    seenRuns.add(task.id);
    runs.push({
      id: task.id,
      title: task.title,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      executorId: task.executorId ?? null
    });
  }
  for (const task of liveRuns) {
    if (seenRuns.has(task.id)) continue;
    seenRuns.add(task.id);
    runs.push(task);
  }
  const timeline: Array<TimelineMessage | TimelineRun> = [
    ...visibleMessages.map((message): TimelineMessage => ({ kind: "message", key: `m:${message.id}`, at: message.createdAt, message })),
    ...runs.map((task): TimelineRun => ({ kind: "run", key: `r:${task.id}`, at: task.createdAt, task }))
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  useEffect(() => {
    if (!conversationQuery.data || sending) return;
    const nextMessages = conversationQuery.data.messages;
    setMessages((prev) => (nextMessages.length >= prev.length ? nextMessages : prev));
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
  }, [messages, streaming, sending, runs.length]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function resetConversationView(id: string | null) {
    setConversationId(id);
    conversationIdRef.current = id;
    setMessages([]);
    setLiveRuns([]);
    setStreaming("");
    setReasoning("");
    setRouting(null);
    setDraftSettings(null);
    if (id) localStorage.setItem("hearth.conversation", id);
    else localStorage.removeItem("hearth.conversation");
  }

  function openWorkspace() {
    setPanelOpen(true);
  }

  function closeWorkspace() {
    setPanelOpen(false);
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
    if (selectedExecutorUnavailable) {
      setError(`${selectedExecutorName} 当前不可用，不会自动切换执行器。${selectedExecutor?.health.issues.join("；") ?? "请到设置中测试可用性。"}`);
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
          routeMode: "auto",
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
              const payload = data as { task: { id: string; title: string; status: RunInfo["status"]; createdAt: string; updatedAt: string; executorId?: string | null } };
              const task = payload.task;
              if (task?.id) {
                setLiveRuns((prev) => [
                  ...prev.filter((item) => item.id !== task.id),
                  {
                    id: task.id,
                    title: task.title,
                    status: task.status,
                    createdAt: task.createdAt,
                    updatedAt: task.updatedAt,
                    executorId: task.executorId ?? null
                  }
                ]);
              }
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              void queryClient.invalidateQueries({ queryKey: ["conversations"] });
            } else if (event === "skill_install") {
              const payload = data as { source: string };
              setSkillInstallRequest({ source: payload.source });
              setSkillNotice(null);
            } else if (event === "done") {
              const message = data as ChatMessageRecord;
              setStreaming("");
              setReasoning("");
              if (!isTaskNoise(message)) {
                setMessages((prev) => (prev.some((item) => item.id === message.id) ? prev : [...prev, message]));
              }
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
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
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
          {latestTask && (latestTask.status !== "completed" && latestTask.status !== "cancelled") && (
            <span className={`chat-run-chip ${latestTask.status}`} title={latestTask.title}>
              <TaskStatusIcon status={latestTask.status} size={12} />
              {TASK_STATUS_LABELS[latestTask.status]}
            </span>
          )}
          {(current ? projectsById.get(current.projectId ?? "") : activeProject) && (
            <span className="chat-project-chip" title={current ? projectsById.get(current.projectId ?? "")?.path : activeProject?.path}>
              <Folder size={12} />
              {(current ? projectsById.get(current.projectId ?? "") : activeProject)?.name}
            </span>
          )}
          <span className="chat-project-chip" title="工作区内文件读写自动执行；发邮件、访问新域名、操作桌面仍会审批。">
            <ShieldAlert size={12} />
            审批 · {approvalModeLabel(conversationSettings.approvalMode)}
          </span>
        </header>

        <div className="chat-scroll">
          <div className="message-list">
            {!configured && (
              <ChatNotice icon={<Settings2 size={15} />} tone="warn">
                还没有接入聊天模型。普通问答需要先完成<Link to="/welcome">首次设置</Link>；执行请求仍会尝试运行。
              </ChatNotice>
            )}
            {!executorReady && (
              <ChatNotice icon={<Settings2 size={15} />} tone="warn">
                当前没有可用的执行器，无法执行。到<Link to="/settings">设置</Link>查看连接诊断。
              </ChatNotice>
            )}
            {visibleMessages.length === 0 && runs.length === 0 && !streaming && !sending && (
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
            {timeline.map((item) => item.kind === "message" ? (
              <ChatBubble
                key={item.key}
                message={item.message}
                mailDraft={!item.message.taskId && isMailDraftReply(visibleMessages, visibleMessages.indexOf(item.message))}
              />
            ) : (
              <InlineRun key={item.key} task={item.task} />
            ))}
            {(streaming || reasoning) && <AssistantBubble content={streaming} reasoning={reasoning} streaming />}
            {sending && !streaming && !reasoning && (
              <div className="typing-row">
                <Loader2 size={14} className="spin" />
                <span>{routing?.action === "task" ? "正在执行…" : routing ? "正在回答…" : selectedExecutorId ? `正在交给 ${selectedExecutorName} 处理…` : "正在判断是回答还是执行…"}</span>
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
            <label className="composer-executor" title={selectedExecutorUnavailable ? selectedExecutor?.health.issues.join("；") : "锁定执行器后不会自动切换"}>
              <select
                value={selectedExecutorId ?? ""}
                onChange={(event) => chooseExecutor(event.target.value as ExecutorId | "")}
                disabled={!settingsReady || sending}
                aria-label="选择执行器"
              >
                <option value="">执行器 · 自动匹配</option>
                {visibleExecutorIds.map((id) => {
                  const view = executorViews.find((executor) => executor.id === id);
                  return (
                    <option key={id} value={id}>
                      {view?.name ?? executorLabel(id)}{executorAvailability[id] ? "" : " · 不可用"}
                    </option>
                  );
                })}
              </select>
            </label>
            {selectedExecutorUnavailable && (
              <span className="composer-executor-warning">{selectedExecutorName} 当前不可用，不会自动切换</span>
            )}
            {selectedSkill && (
              <span className="composer-skill-chip" title={selectedSkill.manifest.description}>
                <Sparkles size={14} />
                <span>使用技能：{selectedSkill.name}</span>
                <button type="button" onClick={() => setSelectedSkillId(null)} aria-label="取消使用技能">
                  <X size={12} />
                </button>
              </span>
            )}
          </div>
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
              placeholder="向 Hearth 提问，或描述你要完成的事…"
              rows={1}
              disabled={sending}
            />
            <button
              className="composer-send"
              onClick={() => void send()}
              disabled={sending || uploading || !settingsReady || selectedExecutorUnavailable || (!input.trim() && attachments.length === 0)}
              title={selectedExecutorUnavailable ? "当前锁定的执行器不可用" : "发送"}
            >
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

function isTaskNoise(message: ChatMessageRecord): boolean {
  if (message.kind === "task_status") return true;
  if (message.role !== "assistant") return false;
  return message.content.startsWith("已派出任务：") || message.content.startsWith("任务「");
}

function ChatBubble({ message, mailDraft = false }: { message: ChatMessageRecord; mailDraft?: boolean }) {
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
        createdAt={message.createdAt}
      />}
    </div>
  );
}

function AssistantBubble({
  content,
  copyText,
  reasoning = "",
  createdAt,
  streaming = false
}: {
  content: string;
  copyText?: string;
  reasoning?: string;
  createdAt?: string;
  streaming?: boolean;
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

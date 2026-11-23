import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { ChatMailDraft } from "../components/ChatMailDraft.tsx";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { isMailDraftReply } from "../lib/mail-draft.ts";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FileText,
  Folder,
  Gauge,
  Loader2,
  PanelRightOpen,
  Paperclip,
  Settings2,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import { ApiError, api, chatStream } from "../lib/api.ts";
import { attachmentPreviewTarget, artifactPreviewTarget, ChatWorkspacePanel, type PreviewTarget } from "../components/ChatWorkspacePanel.tsx";
import { InlineRun, type RunInfo } from "../components/InlineRun.tsx";
import { formatBytes, formatDuration, formatTime } from "../lib/format.ts";
import { getChatSelection, setChatBusy, syncChatSelection, useChatSelection } from "../lib/chat-selection.ts";
import { executorLabel } from "../lib/labels.ts";
import type {
  ChatAttachment,
  ChatMessageRecord,
  ConversationDetail,
  ConversationListItem,
  ConversationSettings,
  ConversationSettingsPatch,
  ExecutorId,
  ReasoningEffort,
  SkillView
} from "../lib/types.ts";

const PENDING_SETTINGS: ConversationSettings = {
  executorEnabled: { native: true, codex: false, "deepseek-harness": false },
  approvalMode: "full",
  preferredExecutorId: "native"
};

const EXECUTOR_ORDER: ExecutorId[] = ["deepseek-harness", "codex", "native"];

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

interface OutgoingMessage {
  text: string;
  attachments: ChatAttachment[];
  skillId: string | null;
}

interface ChatExecution {
  reasoning: string;
  durationMs: number;
}

interface ContextBreakdown {
  system?: number;
  history?: number;
  personal?: number;
  memory?: number;
  library?: number;
  skill?: number;
  attachments?: number;
  user?: number;
  task?: number;
}

interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  contextWindowTokens?: number;
  source?: "estimated" | "measured";
  model?: string;
  reasoningEffort?: ReasoningEffort;
  breakdown?: ContextBreakdown;
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
  const [streamingStatus, setStreamingStatus] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [queue, setQueue] = useState<OutgoingMessage[]>([]);
  const [chatExecutions, setChatExecutions] = useState<Record<string, ChatExecution>>({});
  const [error, setError] = useState<string | null>(null);
  const [draftSettings, setDraftSettings] = useState<ConversationSettings | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(() => getChatSelection().pendingProjectId);
  const [panelOpen, setPanelOpen] = useState(false);
  const [workspacePreview, setWorkspacePreview] = useState<PreviewTarget | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(() => new URLSearchParams(location.search).get("skill"));
  const [slashIndex, setSlashIndex] = useState(0);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [savingEffort, setSavingEffort] = useState(false);
  const [reasoningDraft, setReasoningDraft] = useState<ReasoningEffort | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [skillInstallRequest, setSkillInstallRequest] = useState<{ source: string } | null>(null);
  const [skillNotice, setSkillNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const conversationIdRef = useRef<string | null>(conversationId);
  const handledSelectionNonce = useRef(selection.nonce);
  const panelConversationRef = useRef<string | null>(conversationId);
  const queuedDispatchRef = useRef(false);
  const dragDepthRef = useRef(0);

  const conversationsQuery = useQuery({ queryKey: ["conversations"], queryFn: api.conversations, refetchInterval: 30_000 });
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 30_000 });
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
  const selectedSkill = useMemo(() => skills.find((skill) => skill.id === selectedSkillId) ?? null, [skills, selectedSkillId]);
  const slashTerm = input.startsWith("/") && !input.startsWith("//") ? input.slice(1).trim().toLocaleLowerCase() : null;
  const slashMatches = useMemo(() => slashTerm === null ? [] : skills.filter((skill) => {
    if (!slashTerm) return true;
    return `${skill.name} ${skill.manifest.description} ${skill.id}`.toLocaleLowerCase().includes(slashTerm);
  }).slice(0, 8), [slashTerm, skills]);
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
  const conversationTasks = useMemo(
    () => conversationId ? tasks.filter((task) => task.conversationId === conversationId) : [],
    [tasks, conversationId]
  );
  const current = useMemo(() => conversations.find((item) => item.id === conversationId) ?? null, [conversations, conversationId]);
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: api.projects, refetchInterval: 30_000 });
  const projects = projectsQuery.data?.projects ?? [];
  const projectsById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
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

  const visibleMessages = useMemo(() => messages.filter((message) => !isTaskNoise(message)), [messages]);
  const runs = useMemo(() => {
    const next: RunInfo[] = [];
    const seen = new Set<string>();
    for (const task of conversationTasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      next.push({
        id: task.id,
        title: task.title,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        executorId: task.executorId ?? null
      });
    }
    for (const task of liveRuns) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      next.push(task);
    }
    return next;
  }, [conversationTasks, liveRuns]);
  const hasRunningTask = runs.some((task) => task.status === "running" || task.status === "queued");
  const pendingApprovalsQuery = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => api.approvals({ status: "pending", limit: 50 }),
    enabled: Boolean(conversationId),
    refetchInterval: 5_000,
    staleTime: 1_000
  });
  const pinnedApprovals = useMemo(() => {
    const taskIds = new Set(conversationTasks.map((task) => task.id));
    if (taskIds.size === 0) return [];
    return (pendingApprovalsQuery.data?.approvals ?? []).filter((approval) => taskIds.has(approval.taskId));
  }, [pendingApprovalsQuery.data, conversationTasks]);
  useEffect(() => {
    if (!hasRunningTask) setIsCancelling(false);
  }, [hasRunningTask]);
  const timeline = useMemo<Array<TimelineMessage | TimelineRun>>(() => [
    ...visibleMessages.map((message): TimelineMessage => ({ kind: "message", key: `m:${message.id}`, at: message.createdAt, message })),
    ...runs.map((task): TimelineRun => ({ kind: "run", key: `r:${task.id}`, at: task.createdAt, task }))
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), [visibleMessages, runs]);
  const mailDraftIds = useMemo(() => new Set(visibleMessages.flatMap((message, index) =>
    !message.taskId && isMailDraftReply(visibleMessages, index) ? [message.id] : []
  )), [visibleMessages]);

  useEffect(() => {
    if (!conversationQuery.data || sending) return;
    const nextMessages = conversationQuery.data.messages;
    setMessages((prev) => (nextMessages.length >= prev.length ? nextMessages : prev));
  }, [conversationQuery.data, sending]);

  useEffect(() => {
    if (!conversationQuery.isError) return;
    if (conversationQuery.error instanceof ApiError && conversationQuery.error.status === 404) {
      recoverMissingConversation();
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
    if (conversationId || pendingProjectId || projects.length === 0) return;
    const firstAvailable = projects.find((project) => project.available) ?? projects[0];
    if (firstAvailable) setPendingProjectId(firstAvailable.id);
  }, [conversationId, pendingProjectId, projects]);

  useEffect(() => {
    setChatBusy(sending || uploading);
  }, [sending, uploading]);

  useEffect(() => () => setChatBusy(false), []);

  useEffect(() => {
    if (panelConversationRef.current === conversationId) return;
    panelConversationRef.current = conversationId;
    setPanelOpen(false);
    setWorkspacePreview(null);
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
    const frame = window.requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: sending || streaming ? "auto" : "smooth", block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, streaming, sending, runs.length]);

  useEffect(() => {
    if (sending || queuedDispatchRef.current || queue.length === 0) return;
    if (hasRunningTask) return;
    const [next, ...rest] = queue;
    if (!next) return;
    queuedDispatchRef.current = true;
    setQueue(rest);
    void dispatch(next).finally(() => {
      queuedDispatchRef.current = false;
    });
  }, [queue, sending, hasRunningTask]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function resetConversationView(id: string | null) {
    setConversationId(id);
    conversationIdRef.current = id;
    setMessages([]);
    setLiveRuns([]);
    setStreaming("");
    setStreamingStatus("");
    setReasoning("");
    setDraftSettings(null);
    setContextUsage(null);
    setWorkspacePreview(null);
    setDraggingFiles(false);
    dragDepthRef.current = 0;
    setModelMenuOpen(false);
    if (id) localStorage.setItem("hearth.conversation", id);
    else localStorage.removeItem("hearth.conversation");
  }

  function recoverMissingConversation() {
    const staleId = conversationIdRef.current;
    if (staleId) {
      void queryClient.cancelQueries({ queryKey: ["conversation", staleId], exact: true });
      queryClient.removeQueries({ queryKey: ["conversation", staleId], exact: true });
    }
    resetConversationView(null);
    setPendingProjectId(null);
    syncChatSelection(null, null);
    setError("原对话已失效，已为你开始新对话。");
  }

  function openWorkspace() {
    setPanelOpen(true);
  }

  function closeWorkspace() {
    setPanelOpen(false);
  }

  const openPreview = useCallback((preview: PreviewTarget) => {
    setWorkspacePreview(preview);
    setPanelOpen(true);
  }, []);

  function patchSettings(patch: ConversationSettingsPatch) {
    const next: ConversationSettings = {
      executorEnabled: {
        native: patch.executorEnabled?.native ?? conversationSettings.executorEnabled.native,
        codex: patch.executorEnabled?.codex ?? conversationSettings.executorEnabled.codex,
        "deepseek-harness": patch.executorEnabled?.["deepseek-harness"] ?? conversationSettings.executorEnabled["deepseek-harness"]
      },
      approvalMode: "full",
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
    if (!executorId) return;
    // Persist globally: the next conversation must keep the same executor.
    void api.saveExecutorSettings({ preferredExecutorId: executorId })
      .then(() => {
        queryClient.setQueryData<{ settings: ConversationSettings }>(["conversationDefaults"], (old) =>
          old ? { ...old, settings: { ...old.settings, preferredExecutorId: executorId } } : old
        );
        return Promise.all([
          queryClient.invalidateQueries({ queryKey: ["conversationDefaults"] }),
          queryClient.invalidateQueries({ queryKey: ["executorSettings"] }),
          queryClient.invalidateQueries({ queryKey: ["executors"] })
        ]);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "保存执行器失败"));
    patchSettings({
      preferredExecutorId: executorId,
      executorEnabled: { ...conversationSettings.executorEnabled, [executorId]: true }
    });
  }

  function changeReasoningEffort(effort: ReasoningEffort) {
    setReasoningDraft(effort);
    setSavingEffort(true);
    void api.saveExecutorSettings({ reasoningEffort: effort })
      .then(() => Promise.all([
        queryClient.invalidateQueries({ queryKey: ["health"] }),
        queryClient.invalidateQueries({ queryKey: ["executorSettings"] })
      ]))
      .catch((caught) => {
        setReasoningDraft(null);
        setError(caught instanceof Error ? caught.message : "保存推理强度失败");
      })
      .finally(() => setSavingEffort(false));
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    if (uploading) {
      setError("附件正在上传，请稍候再添加");
      return;
    }
    setError(null);
    if (attachments.length + files.length > 5) {
      setError(`每条消息最多 5 个附件，还可以添加 ${Math.max(0, 5 - attachments.length)} 个`);
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

  function pickFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void uploadFiles(files);
  }

  function onComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
      .map((file, index) => clipboardFile(file, index));
    if (files.length === 0) return;
    event.preventDefault();
    void uploadFiles(files);
  }

  function hasFiles(event: DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function onComposerDragEnter(event: DragEvent<HTMLElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDraggingFiles(true);
  }

  function onComposerDragOver(event: DragEvent<HTMLElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!draggingFiles) setDraggingFiles(true);
  }

  function onComposerDragLeave(event: DragEvent<HTMLElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDraggingFiles(false);
  }

  function onComposerDrop(event: DragEvent<HTMLElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    void uploadFiles(Array.from(event.dataTransfer.files));
  }

  async function send() {
    const text = input.trim();
    if (uploading || !settingsReady || (!text && attachments.length === 0)) return;
    if (selectedExecutorUnavailable) {
      setError(`${selectedExecutorName} 当前不可用，不会自动切换执行器。${selectedExecutor?.health.issues.join("；") ?? "请到设置中测试可用性。"}`);
      return;
    }
    const outgoing: OutgoingMessage = { text, attachments, skillId: selectedSkillId };
    setInput("");
    setAttachments([]);
    if (selectedSkillId) setSelectedSkillId(null);
    setError(null);
    if (sending || hasRunningTask) {
      setQueue((prev) => [...prev, outgoing]);
      return;
    }
    await dispatch(outgoing);
  }

  async function stopRunningTask() {
    const task = stoppableTask;
    if (isCancelling) return;
    setQueue([]);
    abortRef.current?.abort();
    if (!task) return;
    setIsCancelling(true);
    try {
      await api.cancel(task.id);
      setLiveRuns((prev) => prev.map((run) => run.id === task.id ? { ...run, status: "cancelled" } : run));
    } catch (caught) {
      setError(caught instanceof Error ? `停止失败：${caught.message}` : "停止失败，请重试");
    } finally {
      setIsCancelling(false);
    }
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    void queryClient.invalidateQueries({ queryKey: ["conversation"] });
  }

  async function dispatch(outgoing: OutgoingMessage) {
    const { text, attachments: sentAttachments, skillId: sentSkillId } = outgoing;
    const startedAt = Date.now();
    setStreaming("");
    setReasoning("");
    setStreamingStatus("正在理解你的问题…");
    setSending(true);
    const historyTokens = estimateTokensFast(visibleMessages.map((message) => message.content).join("\n"));
    const userTokens = estimateTokensFast(text);
    const attachmentTokens = estimateAttachmentTokens(sentAttachments);
    setContextUsage({
      inputTokens: Math.max(0, historyTokens + userTokens + attachmentTokens),
      outputTokens: 0,
      source: "estimated",
      breakdown: {
        ...(historyTokens ? { history: historyTokens } : {}),
        ...(userTokens ? { user: userTokens } : {}),
        ...(attachmentTokens ? { attachments: attachmentTokens } : {})
      }
    });
    const controller = new AbortController();
    abortRef.current = controller;
    let answer = "";
    let reasoningText = "";
    // Streaming deltas arrive per token. Re-parsing the whole markdown answer
    // on every token is O(n²) and makes long replies stutter, so coalesce UI
    // updates into ~15fps frames while keeping the buffer authoritative.
    let streamTimer: number | null = null;
    const flushStream = () => {
      streamTimer = null;
      setStreaming(answer);
      setReasoning(reasoningText);
    };
    const scheduleStream = () => {
      if (streamTimer !== null) return;
      streamTimer = window.setTimeout(flushStream, 66);
    };
    const stopStreamTimer = () => {
      if (streamTimer === null) return;
      window.clearTimeout(streamTimer);
      streamTimer = null;
    };

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
              const routing = data as { action?: "chat" | "task" };
              setStreamingStatus(routing.action === "task" ? "正在派发任务…" : "正在准备回答…");
            } else if (event === "delta") {
              const firstContent = !answer;
              answer += (data as { text: string }).text;
              if (firstContent) setStreamingStatus("正在生成回答…");
              scheduleStream();
            } else if (event === "reasoning") {
              if (!reasoningText) setStreamingStatus("正在思考…");
              reasoningText += (data as { text: string }).text;
              scheduleStream();
            } else if (event === "usage") {
              const usage = data as Partial<ContextUsage>;
              setContextUsage({
                inputTokens: Math.max(0, usage.inputTokens ?? 0),
                outputTokens: Math.max(0, usage.outputTokens ?? 0),
                ...(usage.contextWindowTokens ? { contextWindowTokens: usage.contextWindowTokens } : {}),
                ...(usage.source ? { source: usage.source } : {}),
                ...(usage.model ? { model: usage.model } : {}),
                ...(usage.reasoningEffort ? { reasoningEffort: usage.reasoningEffort } : {}),
                ...(usage.breakdown ? { breakdown: usage.breakdown } : {})
              });
            } else if (event === "task") {
              const payload = data as { task: { id: string; title: string; status: RunInfo["status"]; createdAt: string; updatedAt: string; executorId?: string | null } };
              const task = payload.task;
              if (task?.id) {
                setStreamingStatus("任务已派出，正在执行…");
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
              stopStreamTimer();
              setStreaming("");
              setReasoning("");
              if (!isTaskNoise(message)) {
                setMessages((prev) => (prev.some((item) => item.id === message.id) ? prev : [...prev, message]));
              }
              if (!message.taskId && reasoningText.trim()) {
                setChatExecutions((prev) => ({
                  ...prev,
                  [message.id]: { reasoning: reasoningText, durationMs: Date.now() - startedAt }
                }));
              }
            } else if (event === "error") {
              setError((data as { message: string }).message);
            }
          }
        }
      );
    } catch (sendError) {
      if (sendError instanceof ApiError && sendError.status === 404) {
        recoverMissingConversation();
        setInput(text);
        if (sentSkillId) setSelectedSkillId(sentSkillId);
        setError("原对话已失效，已为你开始新对话，请重新发送。");
      } else if (!controller.signal.aborted) {
        setError(sendError instanceof Error ? sendError.message : "发送失败");
      }
    } finally {
      stopStreamTimer();
      abortRef.current = null;
      setSending(false);
      setStreaming("");
      setStreamingStatus("");
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
  const executorAvailability = useMemo(() => {
    const availability = {} as Record<ExecutorId, boolean>;
    for (const id of EXECUTOR_ORDER) {
      availability[id] = executorViews.find((executor) => executor.id === id)?.health.canRun ?? false;
    }
    return availability;
  }, [executorViews]);
  const executorReady = EXECUTOR_ORDER.some((id) => executorAvailability[id] && conversationSettings.executorEnabled[id]);
  const selectedExecutorId = serverDefaults?.preferredExecutorId ?? conversationSettings.preferredExecutorId ?? "native";
  const selectedExecutor = executorViews.find((executor) => executor.id === selectedExecutorId) ?? null;
  const selectedExecutorName = selectedExecutor?.name ?? (selectedExecutorId ? executorLabel(selectedExecutorId) : "");
  const selectedExecutorUnavailable = Boolean(selectedExecutorId && !executorAvailability[selectedExecutorId]);
  const visibleExecutorIds = EXECUTOR_ORDER.filter((id) => executorAvailability[id] || id === selectedExecutorId);
  const isWorking = sending || hasRunningTask;
  const stoppableTask = useMemo(
    () => runs.find((task) => task.status === "running" || task.status === "queued"),
    [runs]
  );
  const hasDraft = Boolean(input.trim() || attachments.length > 0);
  const canSubmit = !uploading && settingsReady && !selectedExecutorUnavailable && hasDraft;
  const modelSettings = healthQuery.data?.chatModel.settings;
  const modelName = modelSettings?.model?.trim() || "未配置模型";
  const providerName = modelSettings?.providerName ?? "";
  const reasoningEffort: ReasoningEffort = reasoningDraft ?? modelSettings?.reasoningEffort ?? "max";
  const contextWindowTokens = contextUsage?.contextWindowTokens ?? modelSettings?.contextWindowTokens ?? 328_000;
  const fallbackHistoryTokens = useMemo(
    () => estimateTokensFast(visibleMessages.map((message) => message.content).join("\n")),
    [visibleMessages]
  );
  const fallbackAttachmentTokens = useMemo(
    () => estimateAttachmentTokens(visibleMessages.flatMap((message) => message.attachments ?? [])),
    [visibleMessages]
  );
  const contextBreakdown = contextUsage?.breakdown ?? {};
  const measuredTokens = Math.max(
    fallbackHistoryTokens + fallbackAttachmentTokens,
    (contextUsage?.inputTokens ?? 0) + (contextUsage?.outputTokens ?? 0)
  );
  // A task run reports tokens consumed by that executor, which is a lifetime
  // processing count. It is not another copy of the active conversation
  // context. Mixing both inflated the gauge and made task-heavy chats look
  // nearly full even when the next model request was small.
  const usedTokens = measuredTokens;
  const contextPercent = contextWindowTokens > 0 ? Math.min(100, Math.round((usedTokens / contextWindowTokens) * 100)) : 0;
  const contextBreakdownRows = ([
    ["系统", contextBreakdown.system ?? 0],
    ["对话历史", contextBreakdown.history ?? fallbackHistoryTokens],
    ["个人上下文", contextBreakdown.personal ?? 0],
    ["记忆", contextBreakdown.memory ?? 0],
    ["资料库", contextBreakdown.library ?? 0],
    ["技能", contextBreakdown.skill ?? 0],
    ["附件", contextBreakdown.attachments ?? fallbackAttachmentTokens],
    ["本轮输入", contextBreakdown.user ?? 0]
  ] satisfies Array<[string, number]>).filter(([, tokens]) => tokens > 0);
  const contextUsageLabel = contextUsage?.source === "measured" ? "模型实测" : "估算";
  const contextTitle = [
    `上下文窗口：已用 ${formatTokens(usedTokens)} / ${formatTokens(contextWindowTokens)}（${contextPercent}%）`,
    ...contextBreakdownRows.map(([label, tokens]) => `${label} ${formatTokens(tokens)}`),
    `统计口径：${contextUsageLabel}`
  ].join("\n");

  return (
    <div className={`chat-layout ${panelOpen ? "with-workspace" : ""}`}>
      <section className="chat-main">
        <header className="chat-header">
          <div className="chat-title-group">
            <span className="chat-header-mark" aria-hidden="true"><Folder size={16} /></span>
            <h1>{current?.title ?? "新对话"}</h1>
            {(current ? projectsById.get(current.projectId ?? "") : activeProject) && (
              <span className="chat-project-chip" title={current ? projectsById.get(current.projectId ?? "")?.path : activeProject?.path}>
                <Folder size={12} />
                {(current ? projectsById.get(current.projectId ?? "") : activeProject)?.name}
              </span>
            )}
          </div>
          <button
            type="button"
            className="icon-button chat-artifacts-button"
            onClick={openWorkspace}
            title="查看对话产物"
            aria-label="查看对话产物"
          >
            <PanelRightOpen size={16} />
          </button>
        </header>

        <div className="chat-scroll">
          <div className="message-list">
            {isCancelling && (
              <div className="chat-stopping">
                <Loader2 size={16} className="spin" />
                <span>正在停止任务，请稍候……</span>
              </div>
            )}
            {!configured && (
              <ChatNotice icon={<Settings2 size={15} />} tone="warn">
                还没有接入聊天模型。普通问答需要先完成<Link to="/welcome">首次设置</Link>；需要派任务时请选择可用的执行器。
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
                mailDraft={mailDraftIds.has(item.message.id)}
                execution={chatExecutions[item.message.id]}
                onPreview={openPreview}
              />
            ) : (
              <InlineRun key={item.key} task={item.task} />
            ))}
            {(streaming || reasoning) && <AssistantBubble content={streaming} reasoning={reasoning} streaming />}
            {sending && !streaming && !reasoning && (
              <div className="typing-row" role="status" aria-live="polite">
                <Loader2 size={14} className="spin" />
                <span>{streamingStatus || "正在处理…"}</span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div
          className={`composer-wrap ${draggingFiles ? "drag-active" : ""}`}
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          {pinnedApprovals.length > 0 && (
            <div className="composer-approvals" role="region" aria-label="待确认的操作">
              <div className="composer-approvals-head">
                <ShieldCheck size={14} />
                <span>需要你确认后才能继续</span>
              </div>
              {pinnedApprovals.map((approval) => (
                <ApprovalCard key={approval.id} approval={approval} />
              ))}
            </div>
          )}
          {draggingFiles && (
            <div className="composer-drop-overlay" role="status" aria-live="polite">
              <Paperclip size={20} />
              <strong>松开即可添加附件</strong>
              <span>支持图片、文档和任意文件，单文件不超过 25 MB</span>
            </div>
          )}
          {!conversationId && projects.length > 0 && (
            <div className="composer-project-row">
              <label className="composer-project">
                <Folder size={13} />
                <select
                  value={pendingProjectId ?? ""}
                  onChange={(event) => setPendingProjectId(event.target.value)}
                  disabled={sending}
                  aria-label="选择项目"
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id} disabled={!project.available}>
                      {project.name}{project.kind === "git" ? ` · ${project.currentBranch ?? project.defaultBranch}` : " · 文件夹"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <div className="composer-tools">
            <span className="composer-access" title="所有工具、外部命令与网络访问均无需审批">
              <ShieldCheck size={13} />
              完全权限
            </span>
            <div className="composer-model-wrap">
              <button
                type="button"
                className="composer-model"
                onClick={() => setModelMenuOpen((open) => !open)}
                aria-expanded={modelMenuOpen}
                title={`${modelName} · 推理强度 ${reasoningEffortLabel(reasoningEffort)}`}
              >
                <Brain size={13} />
                <span className="composer-model-name">{modelName}</span>
                <span className="composer-effort">{reasoningEffortLabel(reasoningEffort)}</span>
                {savingEffort ? <Loader2 size={11} className="spin" /> : <ChevronDown size={12} />}
              </button>
              <button
                type="button"
                className="composer-context"
                onClick={() => setModelMenuOpen(true)}
                title={contextTitle}
                aria-label={contextTitle}
              >
                <Gauge size={12} />
                {contextPercent}% · {formatTokens(usedTokens)}/{formatTokens(contextWindowTokens)}
              </button>
              {modelMenuOpen && (
                <>
                  <button type="button" className="composer-model-backdrop" aria-label="关闭模型设置" onClick={() => setModelMenuOpen(false)} />
                  <div className="composer-model-popover" role="dialog" aria-label="模型与推理强度">
                    <div className="model-popover-head">
                      <Brain size={14} />
                      <span>模型与推理</span>
                    </div>
                    <div className="model-popover-identity">
                      <strong>{modelName}</strong>
                      <span>{providerName || "当前对话模型"}</span>
                    </div>
                    <div className="model-popover-row">
                      <span>推理强度</span>
                      <strong>{reasoningEffortLabel(reasoningEffort)}</strong>
                    </div>
                    <input
                      className="model-effort-slider"
                      type="range"
                      min={0}
                      max={2}
                      step={1}
                      value={EFFORT_ORDER.indexOf(reasoningEffort)}
                      disabled={savingEffort || !configured}
                      onChange={(event) => changeReasoningEffort(EFFORT_ORDER[Number(event.target.value)] ?? "max")}
                      aria-label="选择推理强度"
                    />
                    <div className="model-effort-scale">
                      <span>低</span>
                      <span>高</span>
                      <span>极高</span>
                    </div>
                    <div className="model-popover-context">
                      <span>上下文窗口</span>
                      <strong>{formatTokens(contextWindowTokens)}</strong>
                    </div>
                    <div className="model-context-usage">
                      <div className="model-context-usage-head">
                        <span>已用 {formatTokens(usedTokens)}</span>
                        <strong>{contextPercent}%</strong>
                      </div>
                      <div className="model-context-bar" aria-hidden="true">
                        <span style={{ width: `${contextPercent}%` }} />
                      </div>
                      {contextBreakdownRows.map(([label, tokens]) => (
                        <div key={label} className="model-context-row">
                          <span>{label}</span>
                          <strong>{formatTokens(tokens)}</strong>
                        </div>
                      ))}
                      <p>{contextUsageLabel}。包含系统提示、对话历史、个人上下文、记忆、资料库、技能和附件。</p>
                    </div>
                    <p className="model-popover-note">调整会立即生效，并在所有对话中保持。思考默认开启。</p>
                  </div>
                </>
              )}
            </div>
            <label className="composer-executor" title={selectedExecutorUnavailable ? selectedExecutor?.health.issues.join("；") : "锁定执行器后不会自动切换"}>
              <select
                value={selectedExecutorId ?? ""}
                onChange={(event) => chooseExecutor(event.target.value as ExecutorId | "")}
                disabled={!settingsReady || sending}
                aria-label="选择执行器"
              >
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
          {isWorking && (
            <div className={`composer-working ${sending ? "dispatching" : "running"}`} role="status" aria-live="polite">
              <span className="composer-working-dot" aria-hidden="true" />
              <span>{sending ? "Hearth 正在处理这条消息" : "Hearth 正在执行任务"}</span>
              <strong>{hasDraft ? "发送后会加入队列" : "可继续输入并排队"}</strong>
            </div>
          )}
          {queue.length > 0 && (
            <div className="composer-queue" aria-live="polite">
              <span className="composer-queue-label"><Clock size={12} />待发送 · {queue.length}</span>
              {queue.map((item, index) => (
                <span key={`${index}:${item.text}`} className="composer-queue-chip" title={item.text}>
                  <span>{item.text || `${item.attachments.length} 个附件`}</span>
                  <button
                    type="button"
                    onClick={() => setQueue((prev) => prev.filter((_, current) => current !== index))}
                    aria-label="取消排队"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
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
                  <button type="button" className="attachment-open" onClick={() => openPreview(attachmentPreviewTarget(attachment))} title="在侧边栏预览">
                    <FileText size={13} />
                    <span>{attachment.name}</span>
                    <small>{formatBytes(attachment.bytes)}</small>
                  </button>
                  <button
                    type="button"
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
              disabled={uploading}
              title="添加附件，也可以直接粘贴或拖入文件（单文件不超过 25 MB）"
            >
              {uploading ? <Loader2 size={18} className="spin" /> : <Paperclip size={18} />}
            </button>
            <input ref={fileInputRef} type="file" multiple hidden onChange={pickFiles} />
            <textarea
              ref={composerRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onComposerKeyDown}
              onPaste={onComposerPaste}
              aria-label="消息"
              placeholder={isWorking ? "继续输入，发送后会加入队列…" : "向 Hearth 提问，或描述你要完成的事…"}
              rows={1}
            />
            <button
              type="button"
              className={`composer-send ${isWorking ? "working" : ""} ${stoppableTask ? "stopping" : ""}`}
              onClick={() => (stoppableTask || sending ? void stopRunningTask() : void send())}
              disabled={isCancelling || (!canSubmit && !stoppableTask && !sending)}
              aria-busy={isWorking}
              title={stoppableTask
                ? `停止任务：${stoppableTask.title}`
                : sending ? "停止回复" : selectedExecutorUnavailable
                  ? "当前锁定的执行器不可用"
                  : isWorking
                    ? "加入队列"
                    : "发送"}
            >
              {uploading
                ? <Loader2 size={17} className="spin" />
                : stoppableTask || sending
                  ? <span className="stop-icon" />
                  : isWorking && !hasDraft
                    ? <Loader2 size={17} className="spin" />
                    : <ArrowUp size={18} />}
            </button>
          </div>
        </div>
      </section>
      <ChatWorkspacePanel
        open={panelOpen}
        messages={messages}
        tasks={conversationTasks}
        preview={workspacePreview}
        onPreviewChange={setWorkspacePreview}
        onOpen={openWorkspace}
        onClose={closeWorkspace}
      />
    </div>
  );
}

const EFFORT_ORDER: ReasoningEffort[] = ["low", "high", "max"];

function reasoningEffortLabel(effort: ReasoningEffort): string {
  if (effort === "low") return "低";
  if (effort === "high") return "高";
  return "极高";
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(Math.max(0, Math.round(value)));
}

function estimateTokensFast(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function estimateAttachmentTokens(attachments: Array<Pick<ChatAttachment, "bytes" | "mimeType">>): number {
  return attachments.reduce((total, attachment) => {
    if (attachment.mimeType.startsWith("image/")) return total + 1_000;
    return total + Math.min(32_000, Math.max(1, Math.ceil(attachment.bytes / 4)));
  }, 0);
}

function clipboardFile(file: File, index: number): File {
  if (file.name && file.name !== "image.png") return file;
  const extension = file.type.startsWith("image/") ? file.type.slice("image/".length).replace("jpeg", "jpg") : "bin";
  return new File([file], `pasted-${Date.now()}-${index + 1}.${extension}`, {
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified
  });
}

function isTaskNoise(message: ChatMessageRecord): boolean {
  if (message.kind === "task_status") return true;
  if (message.role !== "assistant") return false;
  return message.content.startsWith("已派出任务：");
}

const ChatBubble = memo(function ChatBubble({
  message,
  mailDraft = false,
  execution,
  onPreview
}: {
  message: ChatMessageRecord;
  mailDraft?: boolean;
  execution?: ChatExecution | undefined;
  onPreview: (preview: PreviewTarget) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="message-row user">
        <div className="message-bubble user-bubble">
          {message.content && <CopyButton text={message.content} className="message-copy" />}
          {message.content && <p className="plain-message">{message.content}</p>}
          {message.attachments.length > 0 && (
            <div className="message-attachments">
              {message.attachments.map((attachment) => (
                <button
                  key={attachment.id}
                  type="button"
                  className="message-attachment"
                  onClick={() => onPreview(attachmentPreviewTarget(attachment))}
                  title="在侧边栏预览"
                >
                  <FileText size={12} /> {attachment.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="message-row assistant">
      {execution && <ChatExecutionSummary execution={execution} />}
      {mailDraft ? <ChatMailDraft content={message.content} /> :
      <AssistantBubble
        content={message.taskId ? stripDeliverySection(message.content) : message.content}
        copyText={message.content}
        createdAt={message.createdAt}
      />}
      {message.taskId && message.kind !== "task_status" && <TaskAnswerFiles taskId={message.taskId} onPreview={onPreview} />}
    </div>
  );
});

function ChatExecutionSummary({ execution }: { execution: ChatExecution }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-execution">
      <button type="button" className="chat-execution-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>共用时 {formatDuration(execution.durationMs)}</span>
      </button>
      {open && <p className="chat-execution-reasoning">{execution.reasoning}</p>}
    </div>
  );
}

const TaskAnswerFiles = memo(function TaskAnswerFiles({ taskId, onPreview }: { taskId: string; onPreview: (preview: PreviewTarget) => void }) {
  const taskQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.task(taskId),
    staleTime: 30_000
  });
  const task = taskQuery.data?.task;
  const files = deliverableFiles(task, taskQuery.data?.artifacts ?? []);
  if (files.length === 0) return null;
  return (
    <div className="answer-files">
      {files.map((file) => (
        <button key={file.id} type="button" onClick={() => onPreview(artifactPreviewTarget(file))} title={`${file.relativePath}\n点击在侧边栏预览`}>
          <FileText size={12} />
          {fileName(file.relativePath)}
          <small>{formatBytes(file.bytes)}</small>
        </button>
      ))}
    </div>
  );
});

const AssistantBubble = memo(function AssistantBubble({
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
});

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

const INTERNAL_ARTIFACT_NAMES = new Set(["run-manifest.json", "pr-preview.json"]);

function deliverableFiles(
  task: { expectedOutputs?: string[] } | undefined,
  artifacts: Array<{ id: string; taskId: string; relativePath: string; mimeType: string; bytes: number }>
): Array<{ id: string; taskId: string; relativePath: string; mimeType: string; bytes: number }> {
  return artifacts.filter((artifact) => {
    const path = artifact.relativePath.replace(/\\/g, "/");
    const name = path.split("/").pop() ?? path;
    if (INTERNAL_ARTIFACT_NAMES.has(name)) return false;
    if (path.startsWith("inputs/") || path.startsWith("runtime/") || path.startsWith(".hearth/")) return false;
    if (path.toLowerCase().endsWith(".json") && !isExpectedPath(path, task?.expectedOutputs)) return false;
    return true;
  }).slice(0, 6);
}

function isExpectedPath(path: string, expectedOutputs: string[] | undefined): boolean {
  if (!expectedOutputs) return true;
  return expectedOutputs.some((expected) => {
    const normalized = expected.replace(/\\/g, "/").replace(/\/+$/, "");
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

function fileName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function stripDeliverySection(content: string): string {
  // Older answers embedded the file list in markdown; files are chips now.
  const marker = "\n\n**交付文件**";
  const index = content.indexOf(marker);
  return index === -1 ? content : content.slice(0, index);
}

function ChatNotice({ icon, tone, children }: { icon: React.ReactNode; tone: "warn" | "info"; children: React.ReactNode }) {
  return <div className={`chat-notice ${tone}`}>{icon}<span>{children}</span></div>;
}

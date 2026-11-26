import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { GoalBar } from "../components/GoalBar.tsx";
import { GoalDialog } from "../components/GoalDialog.tsx";
import { GoalManageDialog, type GoalManageMode } from "../components/GoalManageDialog.tsx";
import { PlanBar } from "../components/PlanBar.tsx";
import { PlanDialog } from "../components/PlanDialog.tsx";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Clock,
  Copy,
  Crosshair,
  FileText,
  Folder,
  Gauge,
  GitBranch,
  Loader2,
  PanelRightOpen,
  Paperclip,
  Pause,
  Play,
  Plug,
  Power,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  X
} from "lucide-react";
import { ApiError, api, chatStream, type GoalSettingsInput } from "../lib/api.ts";
import { attachmentPreviewTarget, artifactPreviewTarget, type PreviewTarget } from "../lib/workspace-preview.ts";
import type { RunInfo } from "../components/InlineRun.tsx";
const InlineRun = lazy(() => import("../components/InlineRun.tsx").then((module) => ({ default: module.InlineRun })));
const ChatWorkspacePanel = lazy(() => import("../components/ChatWorkspacePanel.tsx").then((module) => ({ default: module.ChatWorkspacePanel })));
const Markdown = lazy(() => import("../components/Markdown.tsx").then((module) => ({ default: module.Markdown })));
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "@hearth/core/constants";
import type {
  ContextUsageSnapshot,
  GoalAction,
  GoalContractPatch,
  GoalExecutionProfile,
  McpRegistryCandidate,
  McpServerView
} from "@hearth/core";
import { formatBytes, formatDuration, formatTime } from "../lib/format.ts";
import { getChatSelection, requestChat, setChatBusy, syncChatSelection, useChatSelection } from "../lib/chat-selection.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { executorLabel } from "../lib/labels.ts";
import type {
  ChatAttachment,
  ChatMessageRecord,
  ConversationDetail,
  ConversationListItem,
  ConversationSettings,
  ConversationSettingsPatch,
  ExecutorId,
  PlanActionName,
  ReasoningCapabilityView,
  ReasoningEffort,
  TaskFollowUpMode,
  TaskResumeReference
} from "../lib/types.ts";

const PENDING_SETTINGS: ConversationSettings = {
  executorEnabled: { native: true, codex: false, "deepseek-harness": false },
  approvalMode: "full",
  preferredExecutorId: "native"
};

const WORKSPACE_WIDTH_KEY = "hearth.workspace-width";
const DEFAULT_WORKSPACE_WIDTH = 460;
const MIN_WORKSPACE_WIDTH = 320;
const MAX_WORKSPACE_WIDTH = 760;
const MIN_CHAT_WIDTH = 420;

function clampWorkspaceWidth(width: number): number {
  const maxByWindow = Math.max(MIN_WORKSPACE_WIDTH, window.innerWidth - MIN_CHAT_WIDTH - 24);
  return Math.round(Math.min(Math.max(width, MIN_WORKSPACE_WIDTH), Math.min(MAX_WORKSPACE_WIDTH, maxByWindow)));
}

function initialWorkspaceWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WORKSPACE_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampWorkspaceWidth(stored);
  } catch {
    // Storage can be unavailable; the default width still works.
  }
  return clampWorkspaceWidth(DEFAULT_WORKSPACE_WIDTH);
}

function compactMcpValues(values: Record<string, string>): Record<string, string> | undefined {
  const entries = Object.entries(values).filter(([, value]) => value.trim().length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const EXECUTOR_ORDER: ExecutorId[] = ["deepseek-harness", "codex", "native"];
const TERMINAL_GOAL_STATES = new Set(["done", "cancelled", "failed"]);

type ComposerModeId = "full" | "plan" | "goal";
type ComposerCommandId = "plan" | "goal" | "skill" | "mcp";
interface ComposerCommand {
  id: ComposerCommandId;
  command: string;
  description: string;
}
const COMPOSER_COMMANDS: ComposerCommand[] = [
  { id: "plan", command: "/plan", description: "先只读调查，给出计划，然后开始执行" },
  { id: "goal", command: "/goal", description: "多轮推进一个目标，直到验收完成" },
  { id: "skill", command: "/skill", description: "搜索、安装并选择本次任务使用的技能" },
  { id: "mcp", command: "/mcp", description: "搜索、安装并选择本次任务使用的 MCP 工具" }
];
const MAX_SELECTED_MCP_SERVERS = 8;

interface ComposerModeOption {
  id: ComposerModeId;
  label: string;
}
const COMPOSER_MODES: ComposerModeOption[] = [
  { id: "full", label: "完全访问" },
  { id: "plan", label: "计划" },
  { id: "goal", label: "目标" }
];

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
  mcpServerIds: string[];
  goalMode?: boolean;
  goalSettings?: GoalSettingsInput;
  planMode?: boolean;
}

interface ChatExecution {
  reasoning: string;
  durationMs: number;
}

interface ContextBreakdown {
  system?: number;
  conversation?: number;
  conversation_tasks?: number;
  history?: number;
  personal?: number;
  memory?: number;
  library?: number;
  skill?: number;
  attachments?: number;
  user?: number;
  task?: number;
  executor?: number;
  tools?: number;
  tool_results?: number;
  other?: number;
  [key: string]: number | undefined;
}

interface ContextUsage extends Omit<ContextUsageSnapshot, "reasoningEffort" | "breakdown" | "contextWindowTokens" | "model" | "measuredAt"> {
  contextWindowTokens?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  breakdown?: ContextBreakdown;
  measuredAt: string;
}

function asContextUsage(snapshot: ContextUsageSnapshot | null | undefined): ContextUsage | null {
  if (!snapshot) return null;
  const { reasoningEffort, ...rest } = snapshot;
  return {
    ...rest,
    ...(reasoningEffort ? { reasoningEffort: reasoningEffort as ReasoningEffort } : {})
  };
}

/**
 * Provider measurements beat estimates; a task hand-off beats a pre-dispatch
 * estimate; and a timestamp breaks ties between two measurements.
 */
function preferContextUsage(previous: ContextUsage | null, next: ContextUsage | null): ContextUsage | null {
  if (!next) return previous;
  if (!previous) return next;
  if (next.source === "pending") {
    // A new task hand-off replaces a chat measurement (its window may differ),
    // but never replaces a measured snapshot from another task.
    return previous.source === "measured" && previous.scope === "task" ? previous : next;
  }
  if (previous.source === "pending" && next.source === "estimated") return previous;
  const previousRank = previous.source === "measured" ? 2 : previous.source === "estimated" ? 1 : 0;
  const nextRank = next.source === "measured" ? 2 : next.source === "estimated" ? 1 : 0;
  if (previousRank !== nextRank) return nextRank > previousRank ? next : previous;
  const previousAt = Date.parse(previous.measuredAt ?? "") || 0;
  const nextAt = Date.parse(next.measuredAt ?? "") || 0;
  return nextAt >= previousAt ? next : previous;
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
  const [goalMode, setGoalMode] = useState(false);
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const [goalSettings, setGoalSettings] = useState<GoalSettingsInput>({
    reviewPolicy: "human_on_risk"
  });
  const [goalBusy, setGoalBusy] = useState(false);
  const [goalManageMode, setGoalManageMode] = useState<GoalManageMode | null>(null);
  const [planMode, setPlanMode] = useState(false);
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [queue, setQueue] = useState<OutgoingMessage[]>([]);
  const [chatExecutions, setChatExecutions] = useState<Record<string, ChatExecution>>({});
  const [error, setError] = useState<string | null>(null);
  const [draftSettings, setDraftSettings] = useState<ConversationSettings | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(() => getChatSelection().pendingProjectId);
  const [panelOpen, setPanelOpen] = useState(false);
  const [workspaceWidth, setWorkspaceWidth] = useState<number>(initialWorkspaceWidth);
  const [workspacePreview, setWorkspacePreview] = useState<PreviewTarget | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(() => new URLSearchParams(location.search).get("skill"));
  const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<string[]>(() =>
    (new URLSearchParams(location.search).get("mcp") ?? "").split(",").map((item) => item.trim()).filter(Boolean)
  );
  const mcpParamApplied = useRef(false);
  const [mcpPanelOpen, setMcpPanelOpen] = useState(false);
  const [skillPanelOpen, setSkillPanelOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillSourceInput, setSkillSourceInput] = useState("");
  const [skillRegistry, setSkillRegistry] = useState<Array<{ repo: string; source: string; skillPath: string | null; ref: string | null; description: string }>>([]);
  const [skillRegistryQuery, setSkillRegistryQuery] = useState<string | null>(null);
  const [skillRegistryBusy, setSkillRegistryBusy] = useState(false);
  const [mcpQuery, setMcpQuery] = useState("");
  const [mcpNotice, setMcpNotice] = useState<string | null>(null);
  const [mcpInstallCandidate, setMcpInstallCandidate] = useState<McpRegistryCandidate | null>(null);
  const [mcpInstallValues, setMcpInstallValues] = useState<{ env: Record<string, string>; headers: Record<string, string> }>({ env: {}, headers: {} });
  const [slashIndex, setSlashIndex] = useState(0);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [savingEffort, setSavingEffort] = useState(false);
  const [reasoningDraft, setReasoningDraft] = useState<ReasoningEffort | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [followUpNotice, setFollowUpNotice] = useState<string | null>(null);
  const [resumeReferences, setResumeReferences] = useState<Record<string, TaskResumeReference>>({});
  const [isLeavingProject, setIsLeavingProject] = useState(false);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [skillInstallRequest, setSkillInstallRequest] = useState<{ source: string } | null>(null);
  const [skillNotice, setSkillNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const conversationIdRef = useRef<string | null>(conversationId);
  const handledSelectionNonce = useRef(selection.nonce);
  const panelConversationRef = useRef<string | null>(conversationId);
  const queuedDispatchRef = useRef(false);
  const dragDepthRef = useRef(0);
  const workspaceResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const workspaceWidthRef = useRef(workspaceWidth);

  const conversationsQuery = useQuery({ queryKey: ["conversations"], queryFn: api.conversations, refetchInterval: 30_000 });
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 30_000 });
  const conversationQuery = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => api.conversation(conversationId as string),
    enabled: Boolean(conversationId),
    retry: false
  });
  const goalsQuery = useQuery({
    queryKey: ["goals", conversationId],
    queryFn: () => api.goals(conversationId as string),
    enabled: Boolean(conversationId),
    staleTime: 10_000
  });
  const goalViews = goalsQuery.data?.goals ?? [];
  const currentGoal = goalViews.find((view) => !TERMINAL_GOAL_STATES.has(view.goal.currentState)) ?? goalViews[0] ?? null;
  const hasActiveGoal = Boolean(currentGoal && !TERMINAL_GOAL_STATES.has(currentGoal.goal.currentState));
  const plansQuery = useQuery({
    queryKey: ["plans", conversationId],
    queryFn: () => api.plans(conversationId as string),
    enabled: Boolean(conversationId),
    staleTime: 5_000
  });
  const planViews = plansQuery.data?.plans ?? [];
  const currentPlan = planViews.find((view) => !["completed", "cancelled"].includes(view.stage))
    ?? planViews[0]
    ?? null;
  const hasActivePlan = Boolean(currentPlan && !["completed", "cancelled"].includes(currentPlan.stage));
  // 执行模式是单选：目标 > 计划 > 完全访问，后选的模式会替换前一个。
  const activeMode: ComposerModeId = (goalMode || hasActiveGoal) ? "goal" : planMode ? "plan" : "full";
  const activeModeOption = COMPOSER_MODES.find((mode) => mode.id === activeMode) ?? COMPOSER_MODES[0]!;
  const skillsQuery = useQuery({ queryKey: ["skills"], queryFn: api.skills, staleTime: 30_000 });
  const mcpServersQuery = useQuery({ queryKey: ["mcpServers"], queryFn: api.mcpServers, staleTime: 15_000 });
  const executorsQuery = useQuery({ queryKey: ["executors"], queryFn: api.executors, refetchInterval: 20_000 });
  const modelRegistryQuery = useQuery({ queryKey: ["modelRegistry"], queryFn: api.modelRegistry, staleTime: 30_000 });
  const executorSettingsQuery = useQuery({ queryKey: ["executorSettings"], queryFn: api.executorSettings, staleTime: 30_000 });
  const conversationDefaultsQuery = useQuery({ queryKey: ["conversationDefaults"], queryFn: api.conversationDefaults, staleTime: Infinity });
  const conversations = conversationsQuery.data?.conversations ?? [];
  const skills = skillsQuery.data?.skills ?? [];
  const mcpServers = mcpServersQuery.data?.servers ?? [];
  useEffect(() => {
    if (mcpParamApplied.current || mcpServers.length === 0) return;
    mcpParamApplied.current = true;
    setSelectedMcpServerIds((current) => current.filter((id) => {
      const server = mcpServers.find((item) => item.id === id);
      return Boolean(server?.enabled && server.status === "ready");
    }));
  }, [mcpServers]);
  const selectedSkill = useMemo(() => skills.find((skill) => skill.id === selectedSkillId) ?? null, [skills, selectedSkillId]);
  const selectedMcpServers = useMemo(
    () => selectedMcpServerIds.flatMap((id) => {
      const server = mcpServers.find((item) => item.id === id);
      return server ? [server] : [];
    }),
    [mcpServers, selectedMcpServerIds]
  );
  const isGoalCommand = /^\/goal(?:\s|$)/i.test(input.trimStart());
  const isPlanCommand = /^\/plan(?:\s|$)/i.test(input.trimStart());
  const isFullCommand = /^\/full(?:\s|$)/i.test(input.trimStart());
  const isMcpCommand = /^\/mcp(?:\s|$)/i.test(input.trimStart());
  const isSkillCommand = /^\/skill(?:\s|$)/i.test(input.trimStart());
  const commandHasArgument = /^\/(?:goal|plan|full|mcp|skill)\s+\S/i.test(input.trimStart());
  const slashTerm = !commandHasArgument && input.startsWith("/") && !input.startsWith("//")
    ? input.slice(1).trim().toLocaleLowerCase()
    : null;
  const slashCommandMatches = useMemo(() => slashTerm === null ? [] : COMPOSER_COMMANDS.filter((command) => {
    if (!slashTerm) return true;
    return `${command.command} ${command.description}`.toLocaleLowerCase().includes(slashTerm);
  }), [slashTerm]);
  const slashSkillMatches = useMemo(() => slashTerm === null ? [] : skills.filter((skill) => {
    if (!slashTerm) return true;
    return `${skill.name} ${skill.descriptionZh ?? skill.manifest.description} ${skill.id}`.toLocaleLowerCase().includes(slashTerm);
  }).slice(0, 8), [slashTerm, skills]);
  const slashMcpMatches = useMemo(() => slashTerm === null ? [] : mcpServers.filter((server) => {
    if (!slashTerm) return true;
    return `${server.name} ${server.tools.map((tool) => tool.name).join(" ")}`.toLocaleLowerCase().includes(slashTerm);
  }).slice(0, 6), [slashTerm, mcpServers]);
  const slashMatches = useMemo(
    () => [
      ...slashCommandMatches.map((command) => ({ kind: "command" as const, command })),
      ...slashSkillMatches.map((skill) => ({ kind: "skill" as const, skill })),
      ...slashMcpMatches.map((server) => ({ kind: "mcp" as const, server }))
    ],
    [slashCommandMatches, slashSkillMatches, slashMcpMatches]
  );
  const slashOpen = slashTerm !== null && !selectedSkill && !sending;

  const installSkillMutation = useMutation({
    mutationFn: api.installSkill,
    onSuccess: (result) => {
      setSkillInstallRequest(null);
      setSkillSourceInput("");
      setSelectedSkillId(result.skill.id);
      setSkillNotice(`已安装「${result.skill.name}」，已加入本轮任务。`);
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      void queryClient.invalidateQueries({ queryKey: ["library-tree"] });
      void queryClient.invalidateQueries({ queryKey: ["library-status"] });
    },
    onError: (error) => setSkillNotice(error instanceof Error ? error.message : "安装失败")
  });
  async function searchSkillRegistry(query: string): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed || skillRegistryBusy) return;
    setSkillRegistryBusy(true);
    setSkillNotice(null);
    try {
      const result = await api.searchSkillRegistry({ q: trimmed });
      setSkillRegistry(result.candidates);
      setSkillRegistryQuery(trimmed);
      if (result.candidates.length === 0) setSkillNotice(`没有找到与「${trimmed}」匹配的 GitHub 技能，换个关键词试试。`);
    } catch (error) {
      setSkillNotice(error instanceof Error ? error.message : "技能搜索失败");
    } finally {
      setSkillRegistryBusy(false);
    }
  }
  const mcpSearchMutation = useMutation({
    mutationFn: (query: string) => api.searchMcpRegistry({ q: query, limit: 20 }),
    onError: (error) => setMcpNotice(error instanceof Error ? error.message : "MCP Registry 搜索失败")
  });
  const installMcpMutation = useMutation({
    mutationFn: (input: { candidate: McpRegistryCandidate; env: Record<string, string>; headers: Record<string, string> }) => {
      const env = compactMcpValues(input.env);
      const headers = compactMcpValues(input.headers);
      return api.installMcpRegistry({
        serverName: input.candidate.serverName,
        ...(env ? { env } : {}),
        ...(headers ? { headers } : {})
      });
    },
    onSuccess: ({ server }) => {
      setMcpNotice(`已安装「${server.name}」，并加入本次任务。`);
      setMcpInstallCandidate(null);
      setMcpInstallValues({ env: {}, headers: {} });
      setSelectedMcpServerIds((current) => current.includes(server.id)
        ? current
        : current.length >= MAX_SELECTED_MCP_SERVERS ? current : [...current, server.id]);
      void queryClient.invalidateQueries({ queryKey: ["mcpServers"] });
      void queryClient.invalidateQueries({ queryKey: ["library-tree"] });
      void queryClient.invalidateQueries({ queryKey: ["library-status"] });
    },
    onError: (error) => setMcpNotice(error instanceof Error ? error.message : "MCP 安装失败")
  });
  const probeMcpMutation = useMutation({
    mutationFn: api.probeMcpServer,
    onSuccess: ({ server }) => {
      setMcpNotice(server.status === "ready" ? `「${server.name}」已连接。` : `连接失败：${server.error ?? "未知错误"}`);
      void queryClient.invalidateQueries({ queryKey: ["mcpServers"] });
      void queryClient.invalidateQueries({ queryKey: ["library-tree"] });
    },
    onError: (error) => setMcpNotice(error instanceof Error ? error.message : "MCP 连接失败")
  });
  const toggleMcpMutation = useMutation({
    mutationFn: ({ server, enabled }: { server: McpServerView; enabled: boolean }) =>
      api.updateMcpServer(server.id, { enabled }),
    onSuccess: ({ server }) => {
      if (!server.enabled) {
        setSelectedMcpServerIds((current) => current.filter((id) => id !== server.id));
        setMcpNotice(`已停用「${server.name}」。`);
      } else {
        setMcpNotice(server.status === "ready"
          ? `已启用并连接「${server.name}」。`
          : `已启用「${server.name}」，但连接失败：${server.error ?? "未知错误"}`);
      }
      void queryClient.invalidateQueries({ queryKey: ["mcpServers"] });
      void queryClient.invalidateQueries({ queryKey: ["library-tree"] });
    },
    onError: (error) => setMcpNotice(error instanceof Error ? error.message : "MCP 状态更新失败")
  });
  const deleteMcpMutation = useMutation({
    mutationFn: api.deleteMcpServer,
    onSuccess: (_result, serverId) => {
      const server = mcpServers.find((item) => item.id === serverId);
      setSelectedMcpServerIds((current) => current.filter((id) => id !== serverId));
      setMcpNotice(server ? `已从资料库移除「${server.name}」。` : "已移除 MCP 服务器。");
      void queryClient.invalidateQueries({ queryKey: ["mcpServers"] });
      void queryClient.invalidateQueries({ queryKey: ["library-tree"] });
      void queryClient.invalidateQueries({ queryKey: ["library-status"] });
    },
    onError: (error) => setMcpNotice(error instanceof Error ? error.message : "MCP 卸载失败")
  });
  const tasks = tasksQuery.data?.tasks ?? [];
  const conversationTasks = useMemo(
    () => conversationId ? tasks.filter((task) => task.conversationId === conversationId) : [],
    [tasks, conversationId]
  );
  // The system-prompt inspector is only meaningful for the most recent native
  // task: that is the run whose measured usage the popover is showing.
  const latestNativeTaskId = useMemo(() => {
    const native = conversationTasks
      .filter((task) => (task.executorId ?? "native") === "native")
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return native[0]?.id ?? null;
  }, [conversationTasks]);
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
  useEffect(() => {
    // 只在当前会话的设置真正加载完成后同步计划模式；否则切换会话时会沿用它会话的旧值。
    if (!settingsReady) return;
    setPlanMode(conversationSettings.collaborationMode === "plan");
  }, [conversationId, settingsReady, conversationSettings.collaborationMode]);

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
  const runningTask = useMemo(() => runs.find((task) => task.status === "running") ?? null, [runs]);
  const queuedTask = useMemo(() => runs.find((task) => task.status === "queued") ?? null, [runs]);
  const pausedTask = useMemo(() => runs.find((task) => task.status === "paused") ?? null, [runs]);
  const hasRunningTask = Boolean(runningTask || queuedTask);
  const pausedTaskQuery = useQuery({
    queryKey: ["task", pausedTask?.id],
    queryFn: () => api.task(pausedTask?.id as string),
    enabled: Boolean(pausedTask?.id)
  });
  useEffect(() => {
    const reference = pausedTaskQuery.data?.resume;
    if (!pausedTask || !reference) return;
    setResumeReferences((current) => current[pausedTask.id] ? current : { ...current, [pausedTask.id]: reference });
  }, [pausedTask?.id, pausedTaskQuery.data?.resume]);
  useEffect(() => {
    if (!conversationQuery.data || sending) return;
    const persisted = asContextUsage(conversationQuery.data.contextUsage);
    if (!persisted) return;
    // While a task runs, only its own measured snapshot may replace the
    // pending placeholder; an older chat measurement belongs to another model.
    if (hasRunningTask && persisted.scope !== "task") return;
    setContextUsage((previous) => preferContextUsage(previous, persisted));
  }, [conversationQuery.data?.contextUsage, conversationId, sending, hasRunningTask]);
  useEffect(() => {
    if (!conversationId || !hasRunningTask) return;
    // Executors report measured prompt usage while the task runs. Refresh the
    // persisted snapshot every few seconds so the gauge is not stuck at the
    // pre-dispatch placeholder.
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [conversationId, hasRunningTask, queryClient]);
  useEffect(() => {
    if (!hasRunningTask) setIsCancelling(false);
  }, [hasRunningTask]);
  const timeline = useMemo<Array<TimelineMessage | TimelineRun>>(() => [
    ...visibleMessages.map((message): TimelineMessage => ({ kind: "message", key: `m:${message.id}`, at: message.createdAt, message })),
    ...runs.map((task): TimelineRun => ({ kind: "run", key: `r:${task.id}`, at: task.createdAt, task }))
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), [visibleMessages, runs]);

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
    if (mcpServersQuery.isLoading || selectedMcpServerIds.length === 0) return;
    const usable = new Set(mcpServers.filter((server) => server.enabled && server.status === "ready").map((server) => server.id));
    setSelectedMcpServerIds((current) => {
      const next = current.filter((id) => usable.has(id));
      return next.length === current.length ? current : next;
    });
  }, [mcpServers, mcpServersQuery.isLoading, selectedMcpServerIds.length]);

  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
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

  useEffect(() => {
    workspaceWidthRef.current = workspaceWidth;
    try {
      localStorage.setItem(WORKSPACE_WIDTH_KEY, String(workspaceWidth));
    } catch {
      // Width persistence is optional.
    }
  }, [workspaceWidth]);

  useEffect(() => {
    const onWindowResize = () => setWorkspaceWidth((width) => clampWorkspaceWidth(width));
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

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
    // 模式属于会话：切走后必须清掉当前会话的目标/计划选择，避免串到平行会话。
    setGoalMode(false);
    setPlanMode(false);
    setGoalDialogOpen(false);
    setPlanDialogOpen(false);
    setGoalManageMode(null);
    setMcpPanelOpen(false);
    setSkillPanelOpen(false);
    setMcpNotice(null);
    setSkillNotice(null);
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

  function beginWorkspaceResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    workspaceResizeRef.current = { startX: event.clientX, startWidth: workspaceWidthRef.current };
  }

  function moveWorkspaceResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = workspaceResizeRef.current;
    if (!drag) return;
    const next = clampWorkspaceWidth(drag.startWidth + drag.startX - event.clientX);
    setWorkspaceWidth(next);
  }

  function endWorkspaceResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!workspaceResizeRef.current) return;
    workspaceResizeRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already be gone.
    }
  }

  function nudgeWorkspaceResize(delta: number) {
    setWorkspaceWidth((width) => clampWorkspaceWidth(width + delta));
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

  async function changeModel(profileId: string) {
    if (!selectedExecutorId || switchingModel) return;
    if (selectedExecutor?.modelBinding?.profileId === profileId) return;
    setSwitchingModel(true);
    setError(null);
    try {
      await api.saveExecutorModelBinding(selectedExecutorId, {
        profileId,
        protocolOverride: null,
        modelOverride: null
      });
      setReasoningDraft(null);
      setContextUsage(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["executors"] }),
        queryClient.invalidateQueries({ queryKey: ["health"] }),
        queryClient.invalidateQueries({ queryKey: ["modelRegistry"] }),
        queryClient.invalidateQueries({ queryKey: ["conversationDefaults"] }),
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["executorSettings"] }),
        ...(conversationId ? [queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] })] : [])
      ]);
      setModelMenuOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? `切换模型失败：${caught.message}` : "切换模型失败，请重试");
    } finally {
      setSwitchingModel(false);
    }
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

  async function persistBuildMode(): Promise<void> {
    setPlanMode(false);
    setGoalMode(false);
    setGoalDialogOpen(false);
    setPlanDialogOpen(false);
    if (conversationId) {
      await api.updateConversationSettings(conversationId, { collaborationMode: "build" });
    }
  }

  async function exitToBuildMode(note?: string): Promise<boolean> {
    if (planBusy || goalBusy) return false;
    setError(null);
    setPlanBusy(true);
    setGoalBusy(true);
    try {
      if (hasActivePlan && currentPlan) {
        await api.planAction(currentPlan.id, "cancel", {
          expectedRevision: currentPlan.revision,
          ...(note ? { note } : {})
        });
      }
      if (hasActiveGoal && currentGoal) {
        await api.goalAction(currentGoal.goal.goalId, "stop", {
          ...(currentGoal.goal.revision !== undefined ? { expectedRevision: currentGoal.goal.revision } : {}),
          ...(note ? { note } : {})
        });
      }
      await persistBuildMode();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["plans", conversationId] }),
        queryClient.invalidateQueries({ queryKey: ["goals", conversationId] }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] })
      ]);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? `退出当前模式失败：${caught.message}` : "退出当前模式失败，请重试");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["plans", conversationId] }),
        queryClient.invalidateQueries({ queryKey: ["goals", conversationId] }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] })
      ]);
      return false;
    } finally {
      setPlanBusy(false);
      setGoalBusy(false);
    }
  }

  async function runGoalAction(action: GoalAction, options: {
    expectedRevision?: number;
    note?: string;
    execution?: GoalExecutionProfile;
    contract?: GoalContractPatch;
  } = {}): Promise<void> {
    const view = currentGoal;
    if (!view || goalBusy) return;
    setGoalBusy(true);
    setError(null);
    try {
      await api.goalAction(view.goal.goalId, action, {
        ...options,
        ...((options.expectedRevision ?? view.goal.revision) !== undefined
          ? { expectedRevision: options.expectedRevision ?? view.goal.revision }
          : {})
      });
      if (action === "stop") await persistBuildMode();
      await queryClient.invalidateQueries({ queryKey: ["goals", conversationId] });
      await queryClient.invalidateQueries({ queryKey: ["plans", conversationId] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    } catch (caught) {
      setError(caught instanceof Error ? `目标操作失败：${caught.message}` : "目标操作失败，请重试");
    } finally {
      setGoalBusy(false);
    }
  }

  async function handleGoalCommand(text: string): Promise<void> {
    const match = text.match(/^\/goal(?:\s+([\s\S]*))?$/i);
    const argument = match?.[1]?.trim() ?? "";
    if (!argument || /^status$/i.test(argument)) {
      await goalsQuery.refetch();
      if (!hasActiveGoal) setError("当前会话还没有目标。发送 /goal <目标> 创建。");
      return;
    }
    const action = argument.toLowerCase();
    if (["pause", "resume", "stop", "replan", "complete", "approve"].includes(action)) {
      if (!currentGoal) {
        setError("当前会话没有可操作的目标。");
        return;
      }
      await runGoalAction(action as "pause" | "resume" | "stop" | "replan" | "complete" | "approve");
      return;
    }
    if (hasActiveGoal || goalMode) {
      if (!(await exitToBuildMode("切换到新的目标"))) return;
    }
    const outgoing: OutgoingMessage = {
      text: argument,
      attachments: [],
      skillId: null,
      mcpServerIds: selectedMcpServerIds,
      goalMode: true,
      goalSettings
    };
    await dispatch(outgoing);
  }

  async function runPlanAction(action: PlanActionName, note?: string): Promise<void> {
    const view = currentPlan;
    if (!view || planBusy) return;
    setPlanBusy(true);
    setError(null);
    try {
      await api.planAction(view.id, action, {
        expectedRevision: view.revision,
        ...(note ? { note } : {})
      });
      if (action === "approve" || action === "cancel") await persistBuildMode();
      await queryClient.invalidateQueries({ queryKey: ["plans", conversationId] });
      await queryClient.invalidateQueries({ queryKey: ["goals", conversationId] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    } catch (caught) {
      setError(caught instanceof Error ? `计划操作失败：${caught.message}` : "计划操作失败，请重试");
    } finally {
      setPlanBusy(false);
    }
  }

  async function handlePlanCommand(text: string): Promise<void> {
    const match = text.match(/^\/plan(?:\s+([\s\S]*))?$/i);
    const argument = match?.[1]?.trim() ?? "";
    if (!argument || /^status$/i.test(argument)) {
      await plansQuery.refetch();
      if (!hasActivePlan) setError("当前会话还没有计划。发送 /plan <目标> 开始。");
      else setPlanDialogOpen(true);
      return;
    }
    const action = argument.toLowerCase();
    if (["approve", "cancel", "replan", "retry"].includes(action)) {
      if (!currentPlan) {
        setError("当前会话没有可操作的计划。");
        return;
      }
      await runPlanAction(action as PlanActionName);
      return;
    }
    if (hasActiveGoal || goalMode) {
      if (!(await exitToBuildMode("切换到计划模式"))) return;
    }
    setGoalMode(false);
    setPlanMode(true);
    await dispatch({ text: argument, attachments: [], skillId: null, mcpServerIds: selectedMcpServerIds, planMode: true });
  }

  function handleMcpCommand(text: string): void {
    const match = text.match(/^\/mcp(?:\s+([\s\S]*))?$/i);
    const query = match?.[1]?.trim() ?? "";
    setMcpPanelOpen(true);
    setMcpInstallCandidate(null);
    setMcpNotice(null);
    if (query) {
      setMcpQuery(query);
      mcpSearchMutation.mutate(query);
    }
  }

  async function togglePlanMode(): Promise<void> {
    if (hasActivePlan || hasActiveGoal) {
      await exitToBuildMode();
      return;
    }
    if (goalMode) {
      setGoalMode(false);
      setPlanMode(true);
      if (conversationId) {
        await api.updateConversationSettings(conversationId, { collaborationMode: "plan" }).catch((caught) => {
          setError(caught instanceof Error ? caught.message : "保存计划模式失败");
        });
      }
      return;
    }
    const next = !planMode;
    setPlanMode(next);
    if (conversationId) {
      await api.updateConversationSettings(conversationId, { collaborationMode: next ? "plan" : "build" }).catch((caught) => {
        setError(caught instanceof Error ? caught.message : "保存模式失败");
      });
    }
  }

  async function send(oppositeFollowUp = false) {
    const text = input.trim();
    if (uploading || !settingsReady || (!text && attachments.length === 0)) return;
    if (selectedExecutorUnavailable) {
      setError(`${selectedExecutorName} 当前不可用，不会自动切换执行器。${selectedExecutor?.health.issues.join("；") ?? "请到设置中测试可用性。"}`);
      return;
    }
    if (pausedTask && !runningTask && !queuedTask) {
      setError("当前任务已暂停。请先点击继续，或查看任务证据后重新执行。");
      return;
    }
    if (text && isGoalCommand && attachments.length === 0) {
      setInput("");
      setGoalDialogOpen(false);
      await handleGoalCommand(text);
      return;
    }
    if (text && isPlanCommand && attachments.length === 0) {
      setInput("");
      setPlanDialogOpen(false);
      await handlePlanCommand(text);
      return;
    }
    if (text && isMcpCommand && attachments.length === 0) {
      setInput("");
      handleMcpCommand(text);
      return;
    }
    if (text && isSkillCommand && attachments.length === 0) {
      setInput("");
      handleSkillCommand(text);
      return;
    }
    if (text && isFullCommand && attachments.length === 0) {
      setInput("");
      await resetToFullMode();
      return;
    }

    const outgoing: OutgoingMessage = {
      text,
      attachments,
      skillId: selectedSkillId,
      mcpServerIds: selectedMcpServerIds,
      ...(goalMode ? { goalMode: true, goalSettings } : {}),
      ...(planMode ? { planMode: true } : {})
    };
    const canUseTaskFollowUp = Boolean(
      runningTask
      && text
      && attachments.length === 0
      && !selectedSkillId
      && selectedMcpServerIds.length === 0
    );
    const clearComposer = () => {
      setInput("");
      setAttachments([]);
      if (selectedSkillId) setSelectedSkillId(null);
      if (selectedMcpServerIds.length > 0) setSelectedMcpServerIds([]);
      if (goalMode) setGoalMode(false);
    };

    if (canUseTaskFollowUp && runningTask) {
      const defaultMode = executorSettingsQuery.data?.settings.followUpMode ?? "queue";
      const mode: TaskFollowUpMode = oppositeFollowUp
        ? defaultMode === "queue" ? "steer" : "queue"
        : defaultMode;
      setError(null);
      setFollowUpNotice(null);
      try {
        await api.addFollowUp(runningTask.id, text, mode);
        clearComposer();
        setFollowUpNotice(mode === "queue"
          ? "已排队。当前轮结束后会立即处理这条消息。"
          : "已提交引导。执行器会在安全中断当前回合后应用这条指令。");
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["task", runningTask.id] }),
          queryClient.invalidateQueries({ queryKey: ["tasks"] }),
          queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] })
        ]);
      } catch (caught) {
        setError(caught instanceof Error ? `${mode === "queue" ? "排队" : "引导"}失败：${caught.message}` : "追加消息失败，请重试");
      }
      return;
    }

    clearComposer();
    setError(null);
    setFollowUpNotice(null);
    if (sending || hasRunningTask) {
      setQueue((prev) => [...prev, outgoing]);
      return;
    }
    await dispatch(outgoing);
  }

  async function cancelQueuedTask() {
    if (!queuedTask || isCancelling) return;
    setIsCancelling(true);
    setError(null);
    try {
      await api.cancel(queuedTask.id);
      setLiveRuns((prev) => prev.map((run) => run.id === queuedTask.id ? { ...run, status: "cancelled" } : run));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] })
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? `取消排队失败：${caught.message}` : "取消排队失败，请重试");
    } finally {
      setIsCancelling(false);
    }
  }

  async function pauseRunningTask() {
    if (!runningTask || isPausing || isCancelling) return;
    setIsPausing(true);
    setError(null);
    try {
      const result = await api.pause(runningTask.id);
      const resume = result.resume;
      if (resume) {
        setResumeReferences((current) => ({ ...current, [runningTask.id]: resume }));
      } else {
        setResumeReferences((current) => {
          const next = { ...current };
          delete next[runningTask.id];
          return next;
        });
      }
      setLiveRuns((prev) => prev.map((run) => run.id === runningTask.id
        ? { ...run, status: result.task.status }
        : run));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["task", runningTask.id] }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] })
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? `暂停失败：${caught.message}` : "暂停失败，请重试");
    } finally {
      setIsPausing(false);
    }
  }

  async function resumePausedTask() {
    if (!pausedTask || isResuming) return;
    const reference = resumeReferences[pausedTask.id] ?? pausedTaskQuery.data?.resume ?? null;
    if (!reference) {
      setError("这个任务没有可用的恢复检查点，无法继续。请查看任务证据后重新执行。");
      return;
    }
    setIsResuming(true);
    setError(null);
    try {
      const resumed = await api.resume(pausedTask.id, reference);
      setLiveRuns((prev) => prev.map((run) => run.id === pausedTask.id
        ? { ...run, status: resumed.status }
        : run));
      setResumeReferences((current) => {
        const next = { ...current };
        delete next[pausedTask.id];
        return next;
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["task", pausedTask.id] }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] })
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? `继续失败：${caught.message}` : "继续失败，请重试");
    } finally {
      setIsResuming(false);
    }
  }


  async function leaveProjectConversation() {
    if (!(current?.projectId || pendingProjectId) || selection.busy || isLeavingProject) return;
    setIsLeavingProject(true);
    setError(null);
    try {
      // Keep the current project conversation and its history; switch to a
      // fresh standalone conversation instead of unbinding or deleting it.
      const conversation = await api.createConversation();
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      requestChat(conversation.id);
    } catch (caught) {
      setError(caught instanceof Error ? `退出项目失败：${caught.message}` : "退出项目失败，请重试");
    } finally {
      setIsLeavingProject(false);
    }
  }

  async function dispatch(outgoing: OutgoingMessage) {
    const {
      text,
      attachments: sentAttachments,
      skillId: sentSkillId,
      mcpServerIds: sentMcpServerIds,
      goalMode: sentGoalMode,
      goalSettings: sentGoalSettings,
      planMode: sentPlanMode
    } = outgoing;
    const startedAt = Date.now();
    setStreaming("");
    setReasoning("");
    setStreamingStatus("正在执行中…");
    setSending(true);
    const historyTokens = estimateTokensFast(visibleMessages.map((message) => message.content).join("\n"));
    const userTokens = estimateTokensFast(text);
    const attachmentTokens = estimateAttachmentTokens(sentAttachments);
    const priorMeasured = contextUsage?.source === "measured" ? contextUsage.inputTokens : 0;
    setContextUsage({
      inputTokens: Math.max(historyTokens + userTokens + attachmentTokens, priorMeasured + userTokens),
      outputTokens: 0,
      source: "estimated",
      scope: "task",
      measuredAt: new Date().toISOString(),
      ...(contextUsage?.contextWindowTokens ? { contextWindowTokens: contextUsage.contextWindowTokens } : {}),
      ...(contextUsage?.model ? { model: contextUsage.model } : {}),
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
          ...(conversationId ? { conversationId } : {}),
          ...(!conversationId && pendingProjectId ? { projectId: pendingProjectId } : {}),
          ...(text ? { message: text } : {}),
          ...(sentSkillId ? { skillId: sentSkillId } : {}),
          ...(sentMcpServerIds.length > 0 ? { mcpServerIds: sentMcpServerIds } : {}),
          ...(sentAttachments.length > 0 ? { attachments: sentAttachments } : {}),
          ...(sentGoalMode ? { goalMode: true, goalSettings: sentGoalSettings ?? {} } : {}),
          ...(sentPlanMode ? { planMode: true } : {}),
          ...(!conversationId ? { settings: conversationSettings } : {})
        },
        {
          signal: controller.signal,
          onEvent: (event, data) => {
            if (event === "conversation") {
              const conversation = data as {
                id: string;
                title: string;
                createdAt: string;
                updatedAt: string;
                settings: ConversationSettings;
                projectId?: string | null;
              };
              setConversationId(conversation.id);
              conversationIdRef.current = conversation.id;
              if (conversation.settings) setDraftSettings(conversation.settings);
              setPendingProjectId(null);
              localStorage.setItem("hearth.conversation", conversation.id);
              queryClient.setQueryData<ConversationDetail>(["conversation", conversation.id], (old) =>
                old ? { ...old, conversation } : old
              );
              queryClient.setQueryData<{ conversations: ConversationListItem[] }>(["conversations"], (old) => {
                if (!old) return old;
                const existing = old.conversations.find((item) => item.id === conversation.id);
                if (!existing) {
                  return {
                    conversations: [
                      { ...conversation, messageCount: 0, preview: "" },
                      ...old.conversations
                    ]
                  };
                }
                return {
                  conversations: old.conversations.map((item) =>
                    item.id === conversation.id ? { ...item, ...conversation } : item
                  )
                };
              });
            } else if (event === "status") {
              const status = data as { message?: string };
              setStreamingStatus(status.message || "正在执行中…");
            } else if (event === "routing") {
              setStreamingStatus("正在进入统一执行器…");
            } else if (event === "user") {
              setMessages((prev) => [...prev, data as ChatMessageRecord]);

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
              const nextUsage: ContextUsage = {
                inputTokens: Math.max(0, usage.inputTokens ?? 0),
                outputTokens: Math.max(0, usage.outputTokens ?? 0),
                ...(usage.contextWindowTokens ? { contextWindowTokens: usage.contextWindowTokens } : {}),
                ...(usage.model ? { model: usage.model } : {}),
                ...(usage.reasoningEffort ? { reasoningEffort: usage.reasoningEffort } : {}),
                ...(usage.breakdown ? { breakdown: usage.breakdown } : {}),
                source: usage.source ?? "estimated",
                scope: usage.scope ?? "task",
                measuredAt: usage.measuredAt ?? new Date().toISOString()
              };
              setContextUsage((previous) => preferContextUsage(previous, nextUsage));
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
              void queryClient.invalidateQueries({ queryKey: ["plans"] });
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
              setStreamingStatus("已完成");              if (!isTaskNoise(message)) {
                setMessages((prev) => (prev.some((item) => item.id === message.id) ? prev : [...prev, message]));
              }
              if (!message.taskId && reasoningText.trim()) {
                setChatExecutions((prev) => ({
                  ...prev,
                  [message.id]: { reasoning: reasoningText, durationMs: Date.now() - startedAt }
                }));
              }
            } else if (event === "error") {
              setStreamingStatus("执行失败");
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
        if (sentMcpServerIds.length > 0) setSelectedMcpServerIds(sentMcpServerIds);
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
      void queryClient.invalidateQueries({ queryKey: ["plans"] });
      const activeId = conversationIdRef.current;
      if (activeId) void queryClient.invalidateQueries({ queryKey: ["conversation", activeId] });
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      void togglePlanMode();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (slashOpen && slashMatches.length > 0) {
        event.preventDefault();
        const match = slashMatches[Math.min(slashIndex, slashMatches.length - 1)];
        if (match?.kind === "command") chooseComposerCommand(match.command.id);
        else if (match?.kind === "skill") chooseSkill(match.skill.id);
        else if (match?.kind === "mcp") chooseMcpServer(match.server);
        return;
      }
      event.preventDefault();
      void send(event.ctrlKey || event.metaKey);
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
    setSkillPanelOpen(false);
    setSlashIndex(0);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function chooseMcpServer(server: McpServerView) {
    setInput("");
    setSlashIndex(0);
    toggleMcpServer(server);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function toggleMcpServer(server: McpServerView): void {
    if (!server.enabled || server.status !== "ready") {
      setMcpNotice(server.error ?? "这个 MCP 服务器尚未连接成功，请先重试连接。");
      return;
    }
    setSelectedMcpServerIds((current) => {
      if (current.includes(server.id)) return current.filter((id) => id !== server.id);
      if (current.length >= MAX_SELECTED_MCP_SERVERS) {
        setMcpNotice(`一次任务最多选择 ${MAX_SELECTED_MCP_SERVERS} 个 MCP 服务器。`);
        return current;
      }
      return [...current, server.id];
    });
  }

  function runMcpSearch(): void {
    const query = mcpQuery.trim();
    if (!query) {
      setMcpNotice("输入用途或名称搜索 MCP Registry。");
      return;
    }
    setMcpNotice(null);
    setMcpInstallCandidate(null);
    mcpSearchMutation.mutate(query);
  }

  function beginMcpInstall(candidate: McpRegistryCandidate): void {
    if (!candidate.installable) {
      setMcpNotice(candidate.unsupportedReason ?? "这个 MCP 服务器暂时不能安装。");
      return;
    }
    const needsConfiguration = [...candidate.envVariables, ...candidate.headerVariables]
      .some((variable) => variable.defaultValue === null);
    if (!needsConfiguration) {
      installMcpMutation.mutate({ candidate, env: {}, headers: {} });
      return;
    }
    const env = Object.fromEntries(candidate.envVariables
      .filter((variable) => variable.defaultValue === null)
      .map((variable) => [variable.name, ""]));
    const headers = Object.fromEntries(candidate.headerVariables
      .filter((variable) => variable.defaultValue === null)
      .map((variable) => [variable.name, ""]));
    setMcpNotice(null);
    setMcpInstallCandidate(candidate);
    setMcpInstallValues({ env, headers });
  }

  function setMcpInstallValue(kind: "env" | "headers", name: string, value: string): void {
    setMcpInstallValues((current) => ({ ...current, [kind]: { ...current[kind], [name]: value } }));
  }

  function submitMcpInstall(): void {
    if (!mcpInstallCandidate) return;
    installMcpMutation.mutate({ candidate: mcpInstallCandidate, ...mcpInstallValues });
  }

  function removeMcpServer(server: McpServerView): void {
    if (!window.confirm(`从资料库移除 MCP 服务器“${server.name}”？`)) return;
    deleteMcpMutation.mutate(server.id);
  }

  async function chooseComposerCommand(id: ComposerCommandId) {
    setInput("");
    setSlashIndex(0);
    if (id === "mcp") {
      setMcpPanelOpen(true);
      setSkillPanelOpen(false);
      setMcpNotice(null);
      void mcpServersQuery.refetch();
      requestAnimationFrame(() => composerRef.current?.focus());
      return;
    }
    if (id === "skill") {
      setSkillPanelOpen(true);
      setMcpPanelOpen(false);
      setSkillNotice(null);
      void skillsQuery.refetch();
      requestAnimationFrame(() => composerRef.current?.setSelectionRange?.(0, 0));
      return;
    }
    if (hasActivePlan || hasActiveGoal || goalMode || planMode) {
      if (!(await exitToBuildMode("切换到新的执行模式"))) {
        requestAnimationFrame(() => composerRef.current?.focus());
        return;
      }
    }
    if (id === "plan") {
      if (goalMode) setGoalMode(false);
      setGoalDialogOpen(false);
      setPlanMode(true);
      if (conversationId) {
        void api.updateConversationSettings(conversationId, { collaborationMode: "plan" }).catch(() => undefined);
      }
    } else {
      setGoalDialogOpen(true);
    }
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function handleSkillCommand(text: string): void {
    const match = text.match(/^\/skill(?:\s+([\s\S]*))?$/i);
    const query = match?.[1]?.trim() ?? "";
    setSkillPanelOpen(true);
    setMcpPanelOpen(false);
    setSkillNotice(null);
    if (query) {
      setSkillQuery(query);
      void searchSkillRegistry(query);
    }
    void skillsQuery.refetch();
  }

  async function resetToFullMode(): Promise<void> {
    setInput("");
    setSlashIndex(0);
    await exitToBuildMode("退出当前执行模式");
    requestAnimationFrame(() => composerRef.current?.focus());
  }

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
  const visibleExecutorIds = EXECUTOR_ORDER.filter((id) => executorAvailability[id] === true);
  const selectedExecutorVisible = visibleExecutorIds.includes(selectedExecutorId);
  const configured = Boolean(selectedExecutor?.effectiveModel);
  const effectiveModel = selectedExecutor?.effectiveModel ?? null;
  const capabilityKey = effectiveModel ? `${effectiveModel.protocol}|${effectiveModel.baseUrl}|${effectiveModel.model}` : "";
  const capabilityQuery = useQuery({
    queryKey: ["modelCapability", capabilityKey],
    queryFn: () => api.modelCapability({
      ...(effectiveModel?.protocol ? { protocol: effectiveModel.protocol } : {}),
      ...(effectiveModel?.baseUrl ? { baseUrl: effectiveModel.baseUrl } : {}),
      ...(effectiveModel?.model ? { model: effectiveModel.model } : {})
    }),
    enabled: configured && modelMenuOpen,
    staleTime: 5 * 60_000
  });
  const capability = capabilityQuery.data?.capability ?? null;
  const selectedBinding = selectedExecutor?.modelBinding
    ?? modelRegistryQuery.data?.bindings.find((binding) => binding.executorId === selectedExecutorId)
    ?? null;
  const compatibleModelProfiles = (modelRegistryQuery.data?.profiles ?? [])
    .filter((profile) => selectedBinding?.allowedProtocols.includes(profile.protocol));
  const isWorking = sending || hasRunningTask;
  const hasDraft = Boolean(input.trim() || attachments.length > 0);
  const canSubmit = !uploading && settingsReady && !selectedExecutorUnavailable && hasDraft;
  const pausedResumeReference = pausedTask
    ? resumeReferences[pausedTask.id] ?? pausedTaskQuery.data?.resume ?? null
    : null;
  const controlState = sending
    ? "sending"
    : runningTask
      ? "running"
      : pausedTask
        ? "paused"
        : queuedTask
          ? "queued"
          : "idle";
  const primaryControlDisabled = controlState === "sending"
    || (controlState === "running" && (isPausing || isCancelling))
    || (controlState === "paused" && (isResuming || !pausedResumeReference))
    || (controlState === "queued" && (isCancelling || isPausing))
    || (controlState === "idle" && !canSubmit);
  const primaryControlTitle = controlState === "sending"
    ? "正在创建任务"
    : controlState === "running"
      ? `暂停任务：${runningTask?.title ?? "当前任务"}`
      : controlState === "paused"
        ? pausedResumeReference ? `继续任务：${pausedTask?.title ?? "当前任务"}` : "任务缺少可用的恢复检查点"
        : controlState === "queued"
          ? `取消排队：${queuedTask?.title ?? "当前任务"}`
          : selectedExecutorUnavailable
            ? "当前锁定的执行器不可用"
            : hasDraft
              ? "发送"
              : "输入内容后发送";
  function onPrimaryControl(): void {
    if (controlState === "running") {
      void pauseRunningTask();
    } else if (controlState === "paused") {
      void resumePausedTask();
    } else if (controlState === "queued") {
      void cancelQueuedTask();
    } else if (controlState === "idle") {
      void send();
    }
  }
  const modelName = effectiveModel?.model?.trim() || "未绑定模型";
  const providerName = effectiveModel?.providerName ?? "";
  const reasoningEffort: ReasoningEffort = reasoningDraft
    ?? executorSettingsQuery.data?.settings.reasoningEffort
    ?? effectiveModel?.reasoningEffort
    ?? "max";
  const contextWindowTokens = contextUsage?.contextWindowTokens
    ?? effectiveModel?.contextWindowTokens
    ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const contextBreakdown = contextUsage?.breakdown ?? {};
  const waitingForExecutorUsage = contextUsage?.source === "pending";
  const usageUnknown = !contextUsage || waitingForExecutorUsage;
  // "Used" is the prompt token count of the last model request. Provider
  // measurements are authoritative; an estimate is only shown while a chat
  // request is in flight. Never present a visible-message guess as actual
  // context consumption.
  const usedTokens = contextUsage ? Math.max(0, contextUsage.inputTokens) : 0;
  const contextPercentValue = contextWindowTokens > 0 ? Math.min(100, (usedTokens / contextWindowTokens) * 100) : 0;
  const contextPercent = Math.round(contextPercentValue);
  const contextPercentLabel = usedTokens > 0 && contextPercentValue < 0.1
    ? "<0.1%"
    : usedTokens > 0 && contextPercentValue < 1
      ? `${contextPercentValue.toFixed(1)}%`
      : `${contextPercent}%`;
  const contextCompactAt = Math.floor(contextWindowTokens * 0.8);
  const contextBreakdownLabels: Record<string, string> = {
    system: "系统提示词",
    project: "项目",
    conversation: "对话摘要",
    conversation_tasks: "会话任务",
    history: "对话历史",
    personal: "个人上下文",
    memory: "记忆",
    library: "资料库",
    skill: "技能",
    attachments: "附件",
    user: "本轮输入",
    task: "任务上下文",
    executor: "执行器",
    tools: "工具定义",
    tool_results: "工具输出",
    other: "其他"
  };
  const baseBreakdownRows = Object.entries(contextBreakdown)
    .filter(([, tokens]) => typeof tokens === "number" && tokens > 0)
    .map(([key, tokens]) => [contextBreakdownLabels[key] ?? key, tokens as number] as [string, number]);
  const contextBreakdownRows = usageUnknown
    ? []
    : contextUsage?.source === "measured"
      ? (() => {
          const rows = [...baseBreakdownRows];
          const described = baseBreakdownRows.reduce((sum, [, tokens]) => sum + tokens, 0);
          if (usedTokens > described) rows.push(["其他", usedTokens - described]);
          return rows;
        })()
      : baseBreakdownRows;
  const contextUsageLabel = waitingForExecutorUsage
    ? "等待执行器实测"
    : !contextUsage
      ? "尚未实测"
      : contextUsage.source === "measured"
        ? contextUsage.scope === "task" ? "执行器实测（最近一次任务）" : "模型实测"
        : "估算";
  const contextTitle = [
    usageUnknown
      ? `上下文窗口：${formatTokens(contextWindowTokens)}，等待本轮请求的实测用量`
      : `上下文窗口：已用 ${formatTokens(usedTokens)} / ${formatTokens(contextWindowTokens)}（${contextPercentLabel}）`,
    ...contextBreakdownRows.map(([label, tokens]) => `${label} ${formatTokens(tokens)}`),
    `统计口径：${contextUsageLabel}`,
    `自动压缩：${formatTokens(contextCompactAt)}（80%）`
  ].join("\n");

  return (
    <div
      className={`chat-layout ${panelOpen ? "with-workspace" : ""}`}
      style={panelOpen ? { gridTemplateColumns: `minmax(0, 1fr) ${workspaceWidth}px` } : undefined}
    >
      <section className="chat-main">
        <header className="chat-header">
          <div className="chat-title-group">
            <span className="chat-header-mark" aria-hidden="true"><Folder size={16} /></span>
            <h1>{current?.title ?? "新对话"}</h1>
            {activeProject && (
              <>
                <span className="chat-project-chip" title={activeProject.path}>
                  <Folder size={12} />
                  <span className="chat-project-name">{activeProject.name}</span>
                  <code className="chat-project-path">{activeProject.path}</code>
                </span>
                {activeProject.kind === "git" && (activeProject.currentBranch || activeProject.defaultBranch) && (
                  <span className="chat-branch-chip" title={activeProject.currentBranch ?? activeProject.defaultBranch ?? ""}>
                    <GitBranch size={12} />
                    <span>{activeProject.currentBranch ?? activeProject.defaultBranch}</span>
                  </span>
                )}
                {(current?.projectId || pendingProjectId) && (
                  <button
                    type="button"
                    className="chat-project-exit"
                    onClick={() => void leaveProjectConversation()}
                    disabled={selection.busy || isLeavingProject}
                    title="退出项目并打开普通对话"
                    aria-label="退出项目并打开普通对话"
                  >
                    {isLeavingProject ? <Loader2 size={12} className="spin" /> : <X size={12} />}
                  </button>
                )}
              </>
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
            {currentPlan && (
              <PlanBar
                view={currentPlan}
                busy={planBusy}
                onAction={(action) => void runPlanAction(action)}
                onOpen={() => setPlanDialogOpen(true)}
              />
            )}
            {currentGoal && (
              <GoalBar
                view={currentGoal}
                busy={goalBusy}
                onAction={(action) => void runGoalAction(action)}
                onManage={setGoalManageMode}
              />
            )}
            {isCancelling && (
              <div className="chat-stopping">
                <Loader2 size={16} className="spin" />
                <span>正在停止任务，请稍候……</span>
              </div>
            )}
            {!configured && (
              <ChatNotice icon={<Settings2 size={15} />} tone="warn">
                当前执行器尚未绑定模型。请到<Link to="/settings">设置</Link>绑定兼容的模型档案后再发送消息。
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
                execution={chatExecutions[item.message.id]}
                onPreview={openPreview}
              />
            ) : (
              <Suspense key={item.key} fallback={<span className="inline-run-placeholder" aria-hidden="true" />}>
                <InlineRun task={item.task} />
              </Suspense>
            ))}
            {sending && (
              <div className="typing-row run-status-row" role="status" aria-live="polite">
                <Loader2 size={14} className="spin" />
                <span>{streamingStatus || "正在执行中…"}</span>
              </div>
            )}
            {(streaming || reasoning) && <AssistantBubble content={streaming} reasoning={reasoning} streaming />}
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
                  onChange={(event) => setPendingProjectId(event.target.value || null)}
                  disabled={sending}
                  aria-label="选择项目"
                >
                  <option value="">不绑定项目</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id} disabled={!project.available}>
                      {project.name} — {project.path}{project.kind === "git" ? "" : " · 文件夹"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <div className="composer-tools">
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
                {savingEffort || switchingModel ? <Loader2 size={11} className="spin" /> : <ChevronDown size={12} />}
              </button>
              {contextPercent > 0 && (
                <button
                  type="button"
                  className="composer-context"
                  onClick={() => setModelMenuOpen(true)}
                  title={contextTitle}
                  aria-label={contextTitle}
                >
                  <Gauge size={12} />
                  {usageUnknown ? "—" : contextPercentLabel}
                </button>
              )}
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
                      <span>{providerName || "当前执行器未绑定模型"}</span>
                    </div>
                    <div className="model-profile-section">
                      <span className="model-profile-label">模型档案</span>
                      <div className="model-profile-list" role="listbox" aria-label="模型档案">
                        {compatibleModelProfiles.map((profile) => {
                          const active = profile.id === selectedBinding?.profileId;
                          return (
                            <button
                              key={profile.id}
                              type="button"
                              role="option"
                              aria-selected={active}
                              className={`model-profile-option${active ? " active" : ""}`}
                              disabled={switchingModel || savingEffort}
                              onClick={() => void changeModel(profile.id)}
                            >
                              <span>
                                <strong>{profile.name}</strong>
                                <small>{profile.model} · {profile.providerName}</small>
                              </span>
                              {switchingModel && !active
                                ? <Loader2 size={13} className="spin" />
                                : active ? <Check size={13} /> : null}
                            </button>
                          );
                        })}
                        {compatibleModelProfiles.length === 0 && (
                          <p className="model-profile-empty">这个执行器还没有兼容的模型档案。</p>
                        )}
                      </div>
                    </div>
                    <div className="model-effort-grid" role="group" aria-label="推理强度">
                      {(capability?.levels ?? EFFORT_ORDER).map((effort) => (
                        <button
                          key={effort}
                          type="button"
                          className={`model-effort-option${effort === reasoningEffort ? " active" : ""}${effort === capability?.defaultLevel ? " recommended" : ""}`}
                          aria-pressed={effort === reasoningEffort}
                          title={effortNativeLabel(capability, effort)}
                          disabled={savingEffort || switchingModel || !configured}
                          onClick={() => changeReasoningEffort(effort)}
                        >
                          {EFFORT_META[effort].label}
                          {effort === capability?.defaultLevel ? <span className="effort-default-dot" aria-hidden="true" /> : null}
                        </button>
                      ))}
                    </div>
                    {capability ? (
                      <p className="model-effort-hint">
                        {capability.note}
                        {!capability.levels.includes(reasoningEffort)
                          ? ` 当前“${EFFORT_META[reasoningEffort].label}”该模型不支持，请求时会自动映射。`
                          : ""}
                        {savingEffort ? " · 保存中" : ""}
                      </p>
                    ) : (
                      <p className="model-effort-hint">
                        {EFFORT_META[reasoningEffort].description}{savingEffort ? " · 保存中" : ""}
                      </p>
                    )}
                    <div className="model-popover-context">
                      <span>上下文窗口</span>
                      <strong>{formatTokens(contextWindowTokens)}</strong>
                    </div>
                    <div className="model-context-usage">
                      <div className="model-context-usage-head">
                        <span>{usageUnknown ? "已用 —" : `已用 ${formatTokens(usedTokens)}`}</span>
                        <strong>{usageUnknown ? "等待实测" : contextPercentLabel}</strong>
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
                      {contextUsage?.scope === "task" && latestNativeTaskId && (
                        <button
                          type="button"
                          className="model-context-row model-context-action"
                          onClick={() => {
                            setModelMenuOpen(false);
                            openPreview({
                              name: "系统上下文.md",
                              url: api.taskSystemContextUrl(latestNativeTaskId),
                              mimeType: "text/markdown",
                              bytes: null
                            });
                          }}
                          title="查看本轮实际发送给模型的系统提示词原文"
                        >
                          <span>查看系统提示词原文</span>
                          <strong>打开</strong>
                        </button>
                      )}
                      <p>{contextUsageLabel}。已用为本轮实际输入；到达窗口 80%（{formatTokens(contextCompactAt)}）自动压缩。</p>
                      <p>系统提示词包含身份与执行契约、工具说明、环境权限和任务约束；点击上方“查看原文”可核对逐段内容。</p>
                    </div>
                    <p className="model-popover-note">调整会立即生效，并在所有对话中保持。</p>
                  </div>
                </>
              )}
            </div>
            {activeMode !== "full" && (
              <div className="composer-mode-wrap">
                <button
                  type="button"
                  className={`composer-mode-chip mode-${activeMode}`}
                  aria-label={`当前模式：${activeModeOption.label}，点击退出当前模式`}
                  title={`当前模式：${activeModeOption.label}。点 × 退出模式，输入 / 切换模式。`}
                  onClick={() => {
                    if (activeMode === "goal") setGoalManageMode("contract");
                    else setPlanDialogOpen(true);
                  }}
                >
                  {activeMode === "plan" ? <ClipboardList size={14} /> : <Crosshair size={14} />}
                  <span>{activeModeOption.label}</span>
                </button>
                <button
                  type="button"
                  className="composer-mode-clear"
                  aria-label="退出当前模式"
                  title="退出当前模式，回到完全访问"
                  disabled={planBusy || goalBusy}
                  onClick={() => void exitToBuildMode("退出当前执行模式")}
                >
                  {(planBusy || goalBusy) ? <Loader2 size={11} className="spin" /> : <X size={11} />}
                </button>
              </div>
            )}
            <label className="composer-executor" title={selectedExecutorUnavailable ? selectedExecutor?.health.issues.join("；") : "锁定执行器后不会自动切换"}>
              <select
                value={selectedExecutorId}
                onChange={(event) => chooseExecutor(event.target.value as ExecutorId | "")}
                disabled={!settingsReady || sending || visibleExecutorIds.length === 0}
                aria-label="选择执行器"
              >
                {!selectedExecutorVisible && (
                  <option value={selectedExecutorId} disabled>
                    {selectedExecutorName} · 不可用
                  </option>
                )}
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
          {skillPanelOpen && (
            <section className="composer-mcp-panel composer-skill-panel" aria-label="技能">
              <div className="composer-mcp-header">
                <div>
                  <strong><Sparkles size={14} />技能</strong>
                  <span>安装到资料库，仅本轮任务使用所选技能。已选 {selectedSkill ? 1 : 0}/1</span>
                </div>
                <button className="icon-button" type="button" onClick={() => setSkillPanelOpen(false)} aria-label="关闭技能面板">
                  <X size={14} />
                </button>
              </div>
              <form
                className="composer-mcp-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  void searchSkillRegistry(skillQuery);
                }}
              >
                <Search size={14} />
                <input
                  value={skillQuery}
                  onChange={(event) => setSkillQuery(event.target.value)}
                  placeholder="搜索已安装技能或 GitHub，例如 pdf、browser、写周报"
                  aria-label="搜索技能"
                />
                <button type="submit" className="ghost-button" disabled={skillRegistryBusy || !skillQuery.trim()}>
                  {skillRegistryBusy ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
                  搜索
                </button>
              </form>
              {skillNotice && (
                <div className="composer-mcp-notice">
                  <span>{skillNotice}</span>
                  <button className="icon-button" type="button" onClick={() => setSkillNotice(null)} aria-label="关闭提示"><X size={12} /></button>
                </div>
              )}
              <div className="composer-mcp-section">
                <div className="composer-mcp-section-title">
                  <strong>已安装</strong>
                  <span>点一行即可启用；也可在输入框用 / 直接召唤</span>
                </div>
                {skills.length === 0 ? (
                  <p className="composer-mcp-empty">还没有安装技能。搜索后一键安装，或直接对 Hearth 说“帮我安装 xxx 技能”。</p>
                ) : (
                  <div className="composer-mcp-grid">
                    {skills
                      .filter((skill) => {
                        const term = skillQuery.trim().toLocaleLowerCase();
                        if (!term || skillRegistryQuery) return true;
                        return `${skill.name} ${skill.descriptionZh ?? ""} ${skill.manifest.description ?? ""}`.toLocaleLowerCase().includes(term);
                      })
                      .map((skill) => {
                        const selected = selectedSkillId === skill.id;
                        return (
                          <div key={skill.id} className={`composer-mcp-server ${selected ? "selected" : ""}`}>
                            <button
                              type="button"
                              className="composer-mcp-select"
                              onClick={() => selected ? setSelectedSkillId(null) : chooseSkill(skill.id)}
                              aria-pressed={selected}
                              title={skill.descriptionZh ?? skill.manifest.description ?? skill.name}
                            >
                              <Sparkles size={14} />
                              <span>
                                <strong>{skill.name}</strong>
                                <small>{skill.descriptionZh ?? skill.manifest.description ?? "已安装的技能"}</small>
                              </span>
                              {selected && <Check size={14} />}
                            </button>
                            <div className="composer-mcp-actions">
                              <button
                                type="button"
                                onClick={() => void api.updateSkill(skill.id).then((result) => {
                                  setSkillNotice(result.changed ? `已更新「${skill.name}」。` : `「${skill.name}」已是最新版本。`);
                                  void queryClient.invalidateQueries({ queryKey: ["skills"] });
                                }).catch((error: unknown) => setSkillNotice(error instanceof Error ? error.message : "更新失败"))}
                                title="检查并更新"
                                aria-label={`更新 ${skill.name}`}
                              >
                                <RefreshCw size={12} />
                                更新
                              </button>
                              <button
                                type="button"
                                className="danger"
                                onClick={() => {
                                  if (!window.confirm(`从资料库移除技能“${skill.name}”？`)) return;
                                  void api.deleteSkill(skill.id).then(() => {
                                    if (selectedSkillId === skill.id) setSelectedSkillId(null);
                                    setSkillNotice(`已从资料库移除「${skill.name}」。`);
                                    void queryClient.invalidateQueries({ queryKey: ["skills"] });
                                  }).catch((error: unknown) => setSkillNotice(error instanceof Error ? error.message : "移除失败"));
                                }}
                                title="从资料库移除"
                                aria-label={`从资料库移除 ${skill.name}`}
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
              {skillRegistryBusy || skillRegistry.length > 0 ? (
                <div className="composer-mcp-section">
                  <div className="composer-mcp-section-title">
                    <strong>GitHub 结果</strong>
                    <span>{skillRegistryBusy ? "正在搜索" : `${skillRegistry.length} 个候选`}</span>
                  </div>
                  {skillRegistryBusy ? (
                    <p className="composer-mcp-empty"><Loader2 size={12} className="spin" /> 正在搜索包含 SKILL.md 的仓库</p>
                  ) : (
                    <div className="composer-mcp-grid composer-mcp-results">
                      {skillRegistry.map((candidate) => (
                        <div key={`${candidate.repo}:${candidate.skillPath ?? ""}`} className="composer-mcp-candidate">
                          <div className="composer-mcp-candidate-head">
                            <div>
                              <strong>{candidate.repo}</strong>
                              <span>{candidate.skillPath ?? "仓库根目录"}{candidate.ref ? ` · ${candidate.ref}` : ""}</span>
                            </div>
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => installSkillMutation.mutate(candidate.source)}
                              disabled={installSkillMutation.isPending}
                            >
                              {installSkillMutation.isPending ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                              安装
                            </button>
                          </div>
                          {candidate.description && <p>{candidate.description}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
              <div className="composer-mcp-section">
                <div className="composer-mcp-section-title">
                  <strong>从地址安装</strong>
                  <span>GitHub 仓库、本地目录或 Skill 名称</span>
                </div>
                <form
                  className="composer-mcp-search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!skillSourceInput.trim()) return;
                    installSkillMutation.mutate(skillSourceInput.trim());
                  }}
                >
                  <FileText size={14} />
                  <input
                    value={skillSourceInput}
                    onChange={(event) => setSkillSourceInput(event.target.value)}
                    placeholder="https://github.com/owner/repo 或 D:\\skills\\my-skill"
                    aria-label="技能来源"
                  />
                  <button type="submit" className="ghost-button" disabled={installSkillMutation.isPending || !skillSourceInput.trim()}>
                    {installSkillMutation.isPending ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
                    安装
                  </button>
                </form>
              </div>
            </section>
          )}
          {mcpPanelOpen && (
            <section className="composer-mcp-panel" aria-label="MCP 工具">
              <div className="composer-mcp-header">
                <div>
                  <strong><Plug size={14} />MCP 工具</strong>
                  <span>安装到资料库，仅为本轮任务连接所选服务器。已选 {selectedMcpServerIds.length}/{MAX_SELECTED_MCP_SERVERS}</span>
                </div>
                <button className="icon-button" type="button" onClick={() => setMcpPanelOpen(false)} aria-label="关闭 MCP 工具">
                  <X size={14} />
                </button>
              </div>
              <form
                className="composer-mcp-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  runMcpSearch();
                }}
              >
                <Search size={14} />
                <input
                  value={mcpQuery}
                  onChange={(event) => setMcpQuery(event.target.value)}
                  placeholder="搜索 MCP Registry，例如 github、browser、database"
                  aria-label="搜索 MCP Registry"
                />
                <button type="submit" className="ghost-button" disabled={mcpSearchMutation.isPending || !mcpQuery.trim()}>
                  {mcpSearchMutation.isPending ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
                  搜索
                </button>
              </form>
              {mcpNotice && (
                <div className="composer-mcp-notice">
                  <span>{mcpNotice}</span>
                  <button className="icon-button" type="button" onClick={() => setMcpNotice(null)} aria-label="关闭提示"><X size={12} /></button>
                </div>
              )}
              <div className="composer-mcp-section">
                <div className="composer-mcp-section-title">
                  <strong>已安装</strong>
                  {mcpServersQuery.isFetching && <Loader2 size={12} className="spin" />}
                </div>
                {mcpServers.length === 0 ? (
                  <p className="composer-mcp-empty">还没有安装 MCP 服务器。搜索 Registry 后一键安装。</p>
                ) : (
                  <div className="composer-mcp-grid">
                    {mcpServers.map((server) => {
                      const selected = selectedMcpServerIds.includes(server.id);
                      const ready = server.enabled && server.status === "ready";
                      return (
                        <div key={server.id} className={`composer-mcp-server ${selected ? "selected" : ""}`}>
                          <button
                            type="button"
                            className="composer-mcp-select"
                            onClick={() => toggleMcpServer(server)}
                            disabled={!ready}
                            aria-pressed={selected}
                          >
                            <Plug size={14} />
                            <span>
                              <strong>{server.name}</strong>
                              <small>{ready ? `${server.tools.length} 个工具 · 可用` : server.enabled ? `连接异常 · ${server.error ?? "未就绪"}` : "已停用"}</small>
                            </span>
                            {selected && <Check size={14} />}
                          </button>
                          <div className="composer-mcp-actions">
                            {!ready && server.enabled && (
                              <button
                                type="button"
                                onClick={() => probeMcpMutation.mutate(server.id)}
                                disabled={probeMcpMutation.isPending || toggleMcpMutation.isPending || deleteMcpMutation.isPending}
                                title="重试连接"
                                aria-label={`重新连接 ${server.name}`}
                              >
                                {probeMcpMutation.isPending ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                                重试
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => toggleMcpMutation.mutate({ server, enabled: !server.enabled })}
                              disabled={toggleMcpMutation.isPending || deleteMcpMutation.isPending}
                              title={server.enabled ? "停用" : "启用"}
                              aria-label={`${server.enabled ? "停用" : "启用"} ${server.name}`}
                            >
                              <Power size={12} />
                              {server.enabled ? "停用" : "启用"}
                            </button>
                            <button
                              type="button"
                              className="danger"
                              onClick={() => removeMcpServer(server)}
                              disabled={toggleMcpMutation.isPending || deleteMcpMutation.isPending}
                              title="从资料库移除"
                              aria-label={`从资料库移除 ${server.name}`}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {(mcpSearchMutation.data || mcpSearchMutation.isPending) && (
                <div className="composer-mcp-section">
                  <div className="composer-mcp-section-title">
                    <strong>Registry 结果</strong>
                    <span>{mcpSearchMutation.data ? `${mcpSearchMutation.data.candidates.length} 个候选` : "正在搜索"}</span>
                  </div>
                  {mcpSearchMutation.data && mcpSearchMutation.data.candidates.length === 0 ? (
                    <p className="composer-mcp-empty">没有找到匹配的 MCP 服务器，换个关键词试试。</p>
                  ) : (
                    <div className="composer-mcp-grid composer-mcp-results">
                      {mcpSearchMutation.data?.candidates.map((candidate) => {
                        const installed = mcpServers.find((server) => server.registryServerId === candidate.serverName);
                        const editing = mcpInstallCandidate?.serverName === candidate.serverName;
                        return (
                          <div key={`${candidate.serverName}:${candidate.version}`} className="composer-mcp-candidate">
                            <div className="composer-mcp-candidate-head">
                              <div>
                                <strong>{candidate.title}</strong>
                                <span>{candidate.serverName} · {candidate.version} · {candidate.runtime}</span>
                              </div>
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() => beginMcpInstall(candidate)}
                                disabled={!candidate.installable || installMcpMutation.isPending || Boolean(installed)}
                              >
                                {installed ? <Check size={13} /> : <Plug size={13} />}
                                {installed ? "已安装" : "安装"}
                              </button>
                            </div>
                            <p>{candidate.description || "Registry 没有提供说明。"}</p>
                            {!candidate.installable && <small className="composer-mcp-unsupported">{candidate.unsupportedReason}</small>}
                            {editing && (
                              <form
                                className="composer-mcp-install-form"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  submitMcpInstall();
                                }}
                              >
                                <strong>连接所需配置</strong>
                                {candidate.envVariables.filter((variable) => variable.defaultValue === null).map((variable) => (
                                  <label key={`env:${variable.name}`}>
                                    <span>{variable.name}{variable.required ? " *" : " · 可选"}</span>
                                    <input
                                      type={variable.secret ? "password" : "text"}
                                      value={mcpInstallValues.env[variable.name] ?? ""}
                                      onChange={(event) => setMcpInstallValue("env", variable.name, event.target.value)}
                                      placeholder={variable.placeholder || variable.description || "环境变量值"}
                                      required={variable.required}
                                      autoComplete="off"
                                    />
                                  </label>
                                ))}
                                {candidate.headerVariables.filter((variable) => variable.defaultValue === null).map((variable) => (
                                  <label key={`header:${variable.name}`}>
                                    <span>{variable.name}{variable.required ? " *" : " · 可选"} · HTTP Header</span>
                                    <input
                                      type={variable.secret ? "password" : "text"}
                                      value={mcpInstallValues.headers[variable.name] ?? ""}
                                      onChange={(event) => setMcpInstallValue("headers", variable.name, event.target.value)}
                                      placeholder={variable.placeholder || variable.description || "Header 值"}
                                      required={variable.required}
                                      autoComplete="off"
                                    />
                                  </label>
                                ))}
                                <div className="composer-mcp-install-actions">
                                  <button type="button" className="ghost-button" onClick={() => setMcpInstallCandidate(null)} disabled={installMcpMutation.isPending}>取消</button>
                                  <button type="submit" className="primary-button" disabled={installMcpMutation.isPending}>
                                    {installMcpMutation.isPending ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
                                    安装并连接
                                  </button>
                                </div>
                              </form>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
          {queuedTask && controlState !== "queued" && (
            <div className="composer-task-queue" aria-live="polite">
              <span className="composer-task-queue-label"><Clock size={12} />排队任务：{queuedTask.title}</span>
              <button type="button" onClick={() => void cancelQueuedTask()} disabled={isCancelling}>
                {isCancelling ? <Loader2 size={12} className="spin" /> : <Square size={10} />}
                取消排队
              </button>
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
          <div className="composer">
            {(selectedSkill || selectedMcpServers.length > 0) && (
              <div className="composer-context-chips" aria-label="本轮启用的技能与 MCP">
                {selectedSkill && (
                  <span className="composer-skill-chip" title={selectedSkill.descriptionZh ?? selectedSkill.manifest.description ?? "已安装的技能"}>
                    <Sparkles size={13} />
                    <span>技能：{selectedSkill.name}</span>
                    <button type="button" onClick={() => setSelectedSkillId(null)} aria-label="取消使用技能">
                      <X size={11} />
                    </button>
                  </span>
                )}
                {selectedMcpServers.map((server) => (
                  <span
                    key={server.id}
                    className="composer-skill-chip composer-mcp-chip"
                    title={mcpServerDescription(server)}
                  >
                    <Plug size={13} />
                    <span>MCP：{server.name}</span>
                    <button
                      type="button"
                      onClick={() => setSelectedMcpServerIds((current) => current.filter((id) => id !== server.id))}
                      aria-label={`取消使用 ${server.name}`}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {slashOpen && (
              <div className="composer-slash-menu" role="listbox" aria-label="选择命令或技能">
                {slashMatches.length === 0 ? (
                  <p className="composer-slash-empty">没有匹配的命令。输入 / 查看全部命令和技能。</p>
                ) : slashMatches.map((entry, index) => {
                  const active = index === Math.min(slashIndex, slashMatches.length - 1);
                  if (entry.kind === "command") {
                    return (
                      <button
                        key={`command:${entry.command.id}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={`composer-slash-item ${active ? "active" : ""}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => chooseComposerCommand(entry.command.id)}
                      >
                        <span className="composer-slash-glyph">/</span>
                        <span>
                          <strong>{entry.command.command}</strong>
                          <small>{entry.command.description}</small>
                        </span>
                      </button>
                    );
                  }
                  if (entry.kind === "mcp") {
                    const selected = selectedMcpServerIds.includes(entry.server.id);
                    const ready = entry.server.enabled && entry.server.status === "ready";
                    return (
                      <button
                        key={`mcp:${entry.server.id}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={`composer-slash-item ${active ? "active" : ""}`}
                        disabled={!ready}
                        title={mcpServerDescription(entry.server)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => chooseMcpServer(entry.server)}
                      >
                        <Plug size={15} />
                        <span>
                          <strong>{entry.server.name}</strong>
                          <small>{ready ? mcpServerDescription(entry.server) : `MCP 未就绪：${entry.server.error ?? "请先连接"}`}</small>
                        </span>
                        {selected && <Check size={13} />}
                      </button>
                    );
                  }
                  return (
                    <button
                      key={`skill:${entry.skill.id}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`composer-slash-item ${active ? "active" : ""}`}
                      title={entry.skill.descriptionZh ?? entry.skill.manifest.description ?? "已安装的技能"}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => chooseSkill(entry.skill.id)}
                    >
                      <Sparkles size={15} />
                      <span>
                        <strong>{entry.skill.name}</strong>
                        <small>{entry.skill.descriptionZh ?? entry.skill.manifest.description ?? "已安装的技能"}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <textarea
              ref={composerRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onComposerKeyDown}
              onPaste={onComposerPaste}
              aria-label="消息"
              placeholder={isWorking ? "继续输入，Enter 按设置排队或引导…" : pausedTask ? "任务已暂停，点击继续后恢复执行…" : "向 Hearth 提问，输入 / 选择命令或技能…"}
              rows={1}
            />
            <button
              type="button"
              className={`composer-send ${isWorking ? "working" : ""}${controlState === "paused" ? " paused" : ""}${controlState === "queued" ? " queue-control" : ""}`}
              onClick={onPrimaryControl}
              disabled={primaryControlDisabled}
              aria-busy={controlState === "sending" || controlState === "running" || controlState === "paused" || controlState === "queued"}
              aria-label={primaryControlTitle}
              title={primaryControlTitle}
            >
              {controlState === "sending"
                ? <Loader2 size={17} className="spin" />
                : controlState === "running"
                  ? isPausing ? <Loader2 size={17} className="spin" /> : <Pause size={17} />
                  : controlState === "paused"
                    ? isResuming ? <Loader2 size={17} className="spin" /> : <Play size={17} />
                    : controlState === "queued"
                      ? isCancelling ? <Loader2 size={17} className="spin" /> : <Square size={15} />
                      : uploading
                        ? <Loader2 size={17} className="spin" />
                        : <ArrowUp size={18} />}
            </button>
          </div>
        </div>
      </section>
      <GoalDialog
        open={goalDialogOpen}
        hasActiveGoal={hasActiveGoal}
        initial={goalSettings}
        onClose={() => setGoalDialogOpen(false)}
        onConfirm={(settings) => {
          setGoalSettings(settings);
          setPlanMode(false);
          if (conversationId) {
            void api.updateConversationSettings(conversationId, { collaborationMode: "build" }).catch(() => undefined);
          }
          setGoalMode(true);
          setGoalDialogOpen(false);
        }}
      />
      <PlanDialog
        view={planDialogOpen ? currentPlan : null}
        busy={planBusy}
        onClose={() => setPlanDialogOpen(false)}
        onAction={(action, note) => void runPlanAction(action, note)}
      />
      <GoalManageDialog
        mode={goalManageMode}
        view={currentGoal}
        executors={executorViews}
        busy={goalBusy}
        onClose={() => setGoalManageMode(null)}
        onSwitchExecutor={(execution, note) => void runGoalAction("switch_executor", { execution, note })
          .then(() => setGoalManageMode(null))}
        onAmendContract={(contract, note) => void runGoalAction("amend_contract", { contract, note })
          .then(() => setGoalManageMode(null))}
      />
      {panelOpen && (
        <>
          <div
            className="workspace-resizer"
            style={{ right: workspaceWidth }}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整对话栏与预览栏宽度"
            aria-valuemin={MIN_WORKSPACE_WIDTH}
            aria-valuemax={MAX_WORKSPACE_WIDTH}
            aria-valuenow={workspaceWidth}
            tabIndex={0}
            title="拖拽调整对话栏与预览栏宽度"
            onPointerDown={beginWorkspaceResize}
            onPointerMove={moveWorkspaceResize}
            onPointerUp={endWorkspaceResize}
            onPointerCancel={endWorkspaceResize}
            onDoubleClick={() => setWorkspaceWidth(clampWorkspaceWidth(DEFAULT_WORKSPACE_WIDTH))}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                nudgeWorkspaceResize(24);
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                nudgeWorkspaceResize(-24);
              }
            }}
          />
          <Suspense fallback={null}>
            <ChatWorkspacePanel
              open
              messages={messages}
              tasks={conversationTasks}
              preview={workspacePreview}
              onPreviewChange={setWorkspacePreview}
              onOpen={openWorkspace}
              onClose={closeWorkspace}
            />
          </Suspense>
        </>
      )}
    </div>
  );
}

const EFFORT_ORDER: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "max"];

function mcpServerDescription(server: McpServerView): string {
  const recorded = typeof server.manifest.description === "string" ? server.manifest.description.trim() : "";
  if (recorded) return recorded;
  const names = server.tools.slice(0, 3).map((tool) => tool.name).join("、");
  const suffix = server.tools.length > 3 ? " 等" : "";
  if (names) return `本轮可调用 ${server.tools.length} 个工具：${names}${suffix}`;
  if (server.error) return `MCP 连接异常：${server.error}`;
  return server.enabled ? "已启用的 MCP 服务器，为本轮任务提供工具" : "已停用的 MCP 服务器";
}

const EFFORT_META: Record<ReasoningEffort, { label: string; description: string }> = {
  off: { label: "关闭", description: "关闭模型思考，速度最快；目前仅 DeepSeek 等支持思考开关的模型生效。" },
  minimal: { label: "极简", description: "低强度思考（DeepSeek 上与“低”相同），适合简单任务。" },
  low: { label: "低", description: "轻量思考，速度优先。" },
  medium: { label: "中", description: "速度与质量平衡，适合大多数对话。" },
  high: { label: "高", description: "更深推理，适合代码、分析与长任务。" },
  max: { label: "极高", description: "最深推理，最慢但复杂任务最稳。" }
};

function reasoningEffortLabel(effort: ReasoningEffort): string {
  return EFFORT_META[effort].label;
}

/** Human-readable tooltip: what this UI level actually sends for the current model. */
function effortNativeLabel(capability: ReasoningCapabilityView | null, effort: ReasoningEffort): string {
  const base = EFFORT_META[effort].description;
  if (!capability) return base;
  const native = capability.nativeValues?.[effort] ?? effort;
  const mapped = native !== effort ? ` → ${native}` : "";
  return `${base}${mapped ? `（实际发送 ${mapped.replace(" → ", "")}）` : ""}`;
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
  execution,
  onPreview
}: {
  message: ChatMessageRecord;
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
      <AssistantBubble
        content={message.taskId ? stripDeliverySection(message.content) : message.content}
        copyText={message.content}
        createdAt={message.createdAt}
      />
      {message.attachments.length > 0 && (
        <div className="message-attachments assistant-attachments">
          {message.attachments.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              className="message-attachment"
              onClick={() => onPreview(attachmentPreviewTarget(attachment))}
              title="在侧边栏预览或下载"
            >
              <FileText size={12} /> {attachment.name}
            </button>
          ))}
        </div>
      )}
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
      {content && (streaming ? (
        <div className="chat-markdown chat-streaming-text">{content}</div>
      ) : (
        <Suspense fallback={<div className="chat-markdown chat-streaming-text">{content}</div>}>
          <Markdown className="chat-markdown">{content}</Markdown>
        </Suspense>
      ))}
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

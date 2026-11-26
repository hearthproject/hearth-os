import type {
  ApprovalDecisionResult,
  ApprovalListItem,
  AttachmentUploadResult,
  ChatAttachment,
  ConversationDetail,
  ConversationListItem,
  ConversationRecord,
  ConversationSettings,
  ConversationSettingsPatch,
  ArtifactListItem,
  BackupRestoreResult,
  BackupSnapshot,
  BrowserStatusView,
  BrowserTakeoverKind,
  ExecutorId,
  ExecutorBootstrapResult,
  ExecutorBootstrapStreamEvent,
  ExecutorInstallProgress,
  ExecutorModelBindingPatch,
  ExecutorModelBindingView,
  ExecutorListResponse,
  ExecutorProbeResult,
  ExecutorSettingsPatch,
  ExecutorSettingsResponse,
  EventEnvelope,
  FeishuDomain,
  FeishuIntegrationResponse,
  FeishuPairingCodeResponse,
  FeishuTestResponse,
  HealthResponse,
  FolderBrowseResult,
  ImBridgeView,
  WechatQrStatusView,
  WechatQrView,
  LocalProjectView,
  ProjectDossierView,
  WorkstyleView,
  McpServerView,
  McpRegistrySearchView,
  MaintenanceSnapshot,
  MemorySnapshot,
  ModelListResponse,
  ModelProfilePatch,
  ReasoningCapabilityView,
  ModelProfileView,
  ModelProtocol,
  ModelRegistryResponse,
  ModelRegistryView,
  ModelSettingsResponse,
  ModelTestResponse,
  OnboardingSnapshot,
  OnboardingVerificationView,
  SettingsStorageResponse,
  ScheduleInput,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleRunSnapshot,
  ScheduleSnapshot,
  SecuritySnapshot,
  SourceConnection,
  SourceItem,
  TaskFollowUpMode,
  TaskFollowUpRecord,
  TaskListItem,
  TaskPauseResult,
  TaskResumeReference,
  TaskRecord,
  TrashItem,
  TrashKind,
  TaskView,
  BackgroundToolJob,
  PlanView,
  PlanActionName
} from "./types.ts";
import type {
  GoalAction,
  GoalContract,
  GoalContractPatch,
  GoalExecutionProfile,
  GoalView,
  LibraryNode,
  LibraryRoot,
  LibrarySearchResult,
  LibraryStatus,
  LibraryTreeNode,
  LibraryTrashEntry,
  SkillView,
  WebSearchProvider,
  WebSearchSettingsView
} from "@hearth/core";

export interface ChatStreamBody {
  conversationId?: string;
  projectId?: string;
  message?: string;
  skillId?: string;
  mcpServerIds?: string[];
  attachments?: ChatAttachment[];
  url?: string;
  goalMode?: boolean;
  goalSettings?: GoalSettingsInput;
  planMode?: boolean;
  planId?: string;
  settings?: ConversationSettingsPatch;
}

export interface GoalSettingsInput {
  maxRounds?: number;
  reviewPolicy?: "auto" | "human_on_risk" | "human_on_complete";
  deadline?: string;
  forbiddenActions?: string[];
  evidenceRequirements?: string[];
  criteria?: string[];
  commandsApproved?: boolean;
}

export interface ChatStreamHandlers {
  onEvent: (event: string, data: unknown) => void;
  signal?: AbortSignal;
}

export interface ExecutorBootstrapStreamHandlers {
  onProgress?: (progress: ExecutorInstallProgress) => void;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof body === "object" && body && "message" in body ? String(body.message) : `请求失败（${response.status}）`;
    const code = typeof body === "object" && body && "error" in body ? String(body.error) : null;
    throw new ApiError(message, response.status, code);
  }
  return body as T;
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

export const api = {
  goals: (conversationId: string) =>
    request<{ goals: GoalView[] }>(`/api/goals${query({ conversationId, includeTerminal: true })}`),
  goal: (id: string) => request<GoalView>(`/api/goals/${encodeURIComponent(id)}`),
  createGoal: (body: {
    objective: string;
    conversationId?: string;
    projectId?: string;
    execution: {
      executorId: "native" | "codex" | "deepseek-harness";
      taskKind: "delivery" | "workspace" | "general";
      expectedOutputs?: string[];
      workspacePath?: string;
      networkHosts?: string[];
      executionMode?: "quick" | "standard" | "deep";
    };
    criteria?: Array<{ description: string; validator: "file" | "git" | "command" | "schema" | "manual" | "llm_review"; check: string }>;
    forbiddenActions?: string[];
    evidenceRequirements?: string[];
    reviewPolicy?: "auto" | "human_on_risk" | "human_on_complete";
    maxRounds?: number;
    deadline?: string;
    commandsApproved?: boolean;
  }) => request<{ goal: GoalView; task?: TaskRecord }>("/api/goals", {
    method: "POST",
    body: JSON.stringify(body)
  }),
  goalAction: (id: string, action: GoalAction, options: {
    expectedRevision?: number;
    note?: string;
    maxRounds?: number;
    execution?: GoalExecutionProfile;
    contract?: GoalContractPatch;
  } = {}) =>
    request<GoalView>(`/api/goals/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: JSON.stringify({ action, ...options })
    }),
  plans: (conversationId: string) =>
    request<{ plans: PlanView[] }>(`/api/plans${query({ conversationId, includeTerminal: true })}`),
  plan: (id: string) => request<PlanView>(`/api/plans/${encodeURIComponent(id)}`),
  createPlan: (body: {
    conversationId: string;
    projectId?: string;
    title?: string;
    objective: string;
    textInput?: string;
    execution?: {
      executorId: "native" | "codex" | "deepseek-harness";
      taskKind: "delivery" | "workspace" | "general";
      workspacePath?: string;
      networkHosts?: string[];
      executionMode?: "quick" | "standard" | "deep";
    };
    start?: boolean;
  }) => request<{ plan: PlanView }>("/api/plans", {
    method: "POST",
    body: JSON.stringify(body)
  }),
  planAction: (id: string, action: PlanActionName, options: { expectedRevision?: number; note?: string } = {}) =>
    request<PlanView>(`/api/plans/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: JSON.stringify({ action, ...options })
    }),
  conversationDefaults: () => request<{ settings: ConversationSettings }>("/api/conversation-defaults"),
  conversations: () => request<{ conversations: ConversationListItem[] }>("/api/conversations"),
  conversation: (id: string) => request<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}`),
  createConversation: (title?: string, settings?: ConversationSettingsPatch) => request<ConversationRecord>("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ ...(title ? { title } : {}), ...(settings ? { settings } : {}) })
  }),
  updateConversationSettings: (id: string, settings: ConversationSettingsPatch) =>
    request<ConversationRecord>(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ settings })
    }),
  deleteConversation: (id: string, cancelRunning = false) => request<void>(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    ...(cancelRunning ? { body: JSON.stringify({ cancelRunning: true }) } : {})
  }),
  trash: (params: { kind?: TrashKind | "all"; olderThanDays?: 7 | 15 | 30 } = {}) =>
    request<{ items: TrashItem[]; total: number }>(`/api/trash${query(params)}`),
  restoreTrash: (items: Array<{ kind: TrashKind; id: string }>) => request<{ restoredConversations: string[]; restoredTasks: string[] }>("/api/trash/restore", {
    method: "POST",
    body: JSON.stringify({ items })
  }),
  purgeTrash: (items: Array<{ kind: TrashKind; id: string }>) => request<{ purgedConversations: number; purgedTasks: number; removedAttachments: number }>("/api/trash/purge", {
    method: "POST",
    body: JSON.stringify({ items })
  }),
  projects: () => request<{ projects: LocalProjectView[] }>("/api/projects"),
  browseFolders: (path?: string) => request<{ folders: FolderBrowseResult }>(`/api/projects/folders${query({ path })}`),
  createProject: (input: { name?: string; path: string; defaultBranch?: string }) => request<{ project: LocalProjectView }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  deleteProject: (id: string) => request<void>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  projectDossier: (id: string) =>
    request<{ dossier: ProjectDossierView | null }>(`/api/projects/${encodeURIComponent(id)}/dossier`),
  compileProjectDossier: (id: string) =>
    request<{ dossier: ProjectDossierView }>(`/api/projects/${encodeURIComponent(id)}/dossier/compile`, { method: "POST" }),
  workstyle: () => request<{ workstyle: WorkstyleView }>("/api/profile/workstyle"),
  updateWorkstyle: (content: string) =>
    request<{ workstyle: WorkstyleView }>("/api/profile/workstyle", { method: "PUT", body: JSON.stringify({ content }) }),
  resetWorkstyle: () =>
    request<{ workstyle: WorkstyleView }>("/api/profile/workstyle/reset", { method: "POST" }),
  mcpServers: () => request<{ servers: McpServerView[] }>("/api/mcp/servers"),
  createMcpServer: (input: { name: string; transport?: "stdio" | "streamable-http"; command?: string; args?: string[]; url?: string | null; env?: Record<string, string>; headers?: Record<string, string>; enabled?: boolean }) => request<{ server: McpServerView }>("/api/mcp/servers", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  updateMcpServer: (id: string, input: { name?: string; transport?: "stdio" | "streamable-http"; command?: string; args?: string[]; url?: string | null; env?: Record<string, string>; headers?: Record<string, string>; enabled?: boolean }) => request<{ server: McpServerView }>(`/api/mcp/servers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  }),
  probeMcpServer: (id: string) => request<{ server: McpServerView }>(`/api/mcp/servers/${encodeURIComponent(id)}/probe`, { method: "POST" }),
  deleteMcpServer: (id: string) => request<void>(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  searchMcpRegistry: (input: { q: string; limit?: number }) => request<McpRegistrySearchView>(`/api/mcp/registry/search${query(input)}`),
  installMcpRegistry: (input: {
    serverName: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    enabled?: boolean;
  }) => request<{ server: McpServerView }>("/api/mcp/registry/install", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  webSearchSettings: () => request<WebSearchSettingsView>("/api/web-search/settings"),
  saveWebSearchSettings: (input: { enabled?: boolean; provider?: WebSearchProvider; apiKey?: string; searxngUrl?: string }) => request<WebSearchSettingsView>("/api/web-search/settings", {
    method: "PATCH",
    body: JSON.stringify(input)
  }),
  modelRegistry: () => request<ModelRegistryResponse>("/api/model-registry"),
  createModelProfile: (input: ModelProfilePatch) => request<{ profile: ModelProfileView }>("/api/model-profiles", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  updateModelProfile: (id: string, input: ModelProfilePatch) => request<{ profile: ModelProfileView }>(`/api/model-profiles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  }),
  deleteModelProfile: (id: string) => request<void>(`/api/model-profiles/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setChatProfile: (profileId: string | null) => request<{ registry: ModelRegistryView; chatConfigured: boolean }>("/api/model-registry/chat-profile", {
    method: "PUT",
    body: JSON.stringify({ profileId })
  }),
  saveExecutorModelBinding: (id: ExecutorId, input: ExecutorModelBindingPatch) => request<{ binding: ExecutorModelBindingView; probe: ExecutorProbeResult | null; health: ExecutorProbeResult["health"] }>(`/api/executors/${encodeURIComponent(id)}/model-binding`, {
    method: "PUT",
    body: JSON.stringify(input)
  }),
  autoBindExecutor: (id: ExecutorId) => request<{ binding: ExecutorModelBindingView; probe: ExecutorProbeResult | null; health: ExecutorProbeResult["health"] }>(`/api/executors/${encodeURIComponent(id)}/model-binding/auto`, {
    method: "POST"
  }),
  bootstrapExecutor: (id: ExecutorId) => request<ExecutorBootstrapResult>(`/api/executors/${encodeURIComponent(id)}/bootstrap`, {
    method: "POST"
  }),
  bootstrapExecutorStream: (id: ExecutorId, handlers: ExecutorBootstrapStreamHandlers = {}) =>
    streamExecutorBootstrap(id, handlers),
  settingsStorage: () => request<SettingsStorageResponse>("/api/settings/storage"),
  saveModelSettings: (input: {
    providerId?: string;
    providerName?: string;
    protocol?: ModelProtocol;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }) => request<ModelSettingsResponse>("/api/model-settings", {
    method: "PUT",
    body: JSON.stringify(input)
  }),
  modelCapability: (input: { providerId?: string; providerName?: string; protocol?: ModelProtocol; baseUrl?: string; model?: string; apiKey?: string }) =>
    request<{ capability: ReasoningCapabilityView }>("/api/model-capabilities", { method: "POST", body: JSON.stringify(input) }),
  fetchModels: (input: { providerId?: string; providerName?: string; protocol?: ModelProtocol; baseUrl?: string; model?: string; apiKey?: string }) =>
    request<ModelListResponse>("/api/model-settings/models", { method: "POST", body: JSON.stringify(input) }),
  testModel: (input: { providerId?: string; providerName?: string; protocol?: ModelProtocol; baseUrl?: string; model?: string; apiKey?: string }) =>
    request<ModelTestResponse>("/api/model-settings/test", { method: "POST", body: JSON.stringify(input) }),
  executorSettings: () => request<ExecutorSettingsResponse>("/api/executor-settings"),
  executors: () => request<ExecutorListResponse>("/api/executors"),
  saveExecutorSettings: (input: ExecutorSettingsPatch) => request<ExecutorSettingsResponse>("/api/executor-settings", {
    method: "PUT",
    body: JSON.stringify(input)
  }),
  probeExecutor: (id: ExecutorId) => request<ExecutorProbeResult>(`/api/executors/${encodeURIComponent(id)}/probe`, { method: "POST" }),
  schedules: () => request<ScheduleSnapshot>("/api/schedules"),
  createSchedule: (input: ScheduleInput) => request<ScheduleRecord>("/api/schedules", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  updateSchedule: (id: string, input: Partial<ScheduleInput>) => request<ScheduleRecord>(`/api/schedules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  }),
  deleteSchedule: (id: string) => request<void>(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }),
  runSchedule: (id: string) => request<ScheduleRunRecord>(`/api/schedules/${encodeURIComponent(id)}/run`, { method: "POST" }),
  scheduleRuns: (id: string) => request<ScheduleRunSnapshot>(`/api/schedules/${encodeURIComponent(id)}/runs`),
  uploadAttachments: async (files: File[]): Promise<ChatAttachment[]> => {
    const form = new FormData();
    for (const file of files) form.append("file", file, file.name);
    const response = await fetch("/api/attachments", { method: "POST", body: form });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const message = typeof body === "object" && body && "message" in body ? String(body.message) : `上传失败（${response.status}）`;
      throw new Error(message);
    }
    return (body as AttachmentUploadResult).attachments;
  },
  health: () => request<HealthResponse>("/api/health"),
  onboarding: () => request<OnboardingSnapshot>("/api/onboarding"),
  completeOnboarding: (skipped = false) => request<OnboardingSnapshot>("/api/onboarding/complete", {
    method: "POST",
    body: JSON.stringify({ skipped })
  }),
  verifyOnboarding: () =>
    request<{ verification: OnboardingVerificationView; onboarding: OnboardingSnapshot }>("/api/onboarding/verify", { method: "POST" }),
  feishu: () => request<FeishuIntegrationResponse>("/api/integrations/feishu"),
  saveFeishu: (input: {
    enabled?: boolean;
    appId?: string;
    appSecret?: string;
    allowedOpenIds?: string[];
    domain?: FeishuDomain;
  }) => request<FeishuIntegrationResponse>("/api/integrations/feishu", {
    method: "PUT",
    body: JSON.stringify(input)
  }),
  testFeishu: (input: { appId?: string; appSecret?: string; domain?: FeishuDomain } = {}) =>
    request<FeishuTestResponse>("/api/integrations/feishu/test", { method: "POST", body: JSON.stringify(input) }),
  reconnectFeishu: () => request<FeishuIntegrationResponse>("/api/integrations/feishu/reconnect", { method: "POST" }),
  im: () => request<ImBridgeView>("/api/integrations/im"),
  saveImWechat: (input: {
    enabled?: boolean;
    token?: string;
    baseUrl?: string;
    conversationId?: string | null;
    projectId?: string | null;
  }) => request<ImBridgeView>("/api/integrations/im/wechat", {
    method: "PUT",
    body: JSON.stringify(input)
  }),
  startWechatQr: () => request<WechatQrView>("/api/integrations/im/wechat/qrcode", { method: "POST" }),
  pollWechatQr: (qrcode: string) =>
    request<WechatQrStatusView>(`/api/integrations/im/wechat/qrcode/status?qrcode=${encodeURIComponent(qrcode)}`),
  reconnectWechat: () => request<ImBridgeView>("/api/integrations/im/wechat/reconnect", { method: "POST" }),
  saveImQq: (input: {
    enabled?: boolean;
    appId?: string;
    clientSecret?: string;
    sandbox?: boolean;
    conversationId?: string | null;
    projectId?: string | null;
  }) => request<ImBridgeView>("/api/integrations/im/qq", {
    method: "PUT",
    body: JSON.stringify(input)
  }),
  reconnectQq: () => request<ImBridgeView>("/api/integrations/im/qq/reconnect", { method: "POST" }),
  createFeishuPairingCode: (conversationId?: string) =>
    request<FeishuPairingCodeResponse>("/api/integrations/feishu/pairing-code", {
      method: "POST",
      body: JSON.stringify(conversationId ? { conversationId } : {})
    }),
  security: () => request<SecuritySnapshot>("/api/security"),
  setKillSwitch: (enabled: boolean, reason?: string) => request<SecuritySnapshot>("/api/security/kill-switch", {
    method: "POST",
    body: JSON.stringify(reason ? { enabled, reason } : { enabled })
  }),
  backups: () => request<BackupSnapshot>("/api/backups"),
  createBackup: (passphrase: string) => request<BackupSnapshot["records"][number]>("/api/backups", {
    method: "POST",
    body: JSON.stringify({ passphrase })
  }),
  restoreBackup: (id: string, passphrase: string) => request<BackupRestoreResult>(`/api/backups/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    body: JSON.stringify({ passphrase })
  }),
  restoreBackupFile: (envelope: string, passphrase: string) => request<BackupRestoreResult>("/api/backups/restore", {
    method: "POST",
    body: JSON.stringify({ envelope, passphrase })
  }),
  backupDownloadUrl: (id: string) => `/api/backups/${encodeURIComponent(id)}/download`,
  maintenance: () => request<MaintenanceSnapshot>("/api/maintenance"),
  runMaintenance: () => request<MaintenanceSnapshot["latest"]>("/api/maintenance/run", { method: "POST" }),
  diagnosticsUrl: "/api/diagnostics",
  memory: () => request<MemorySnapshot>("/api/memory"),
  libraryStatus: () => request<LibraryStatus & { roots: LibraryRoot[]; trashCount: number }>("/api/library/status"),
  libraryTree: (depth = 2, parentId?: string) =>
    request<{ nodes: LibraryTreeNode[] }>(`/api/library/tree${query({ depth, parentId })}`),
  librarySearch: (search: string, limit = 20) =>
    request<LibrarySearchResult>(`/api/library/search${query({ q: search, limit })}`),
  libraryNode: (id: string) => request<{
    node: LibraryNode;
    document: { content: string; extractor: string; language: string | null; charCount: number } | null;
    chunkCount: number;
    children: LibraryNode[];
  }>(`/api/library/nodes/${encodeURIComponent(id)}`),
  librarySummarizeNode: (id: string, force = false) => request<{
    summary: { nodeId: string; content: string; stale: false; generated: boolean; model: string | null };
  }>(`/api/library/nodes/${encodeURIComponent(id)}/summary`, {
    method: "POST",
    body: JSON.stringify({ force })
  }),
  libraryReindex: () => request<{ result: { indexed: number; unchanged: number; skipped: number; failed: number; chunks: number; embedded: number; semanticError: string | null } }>("/api/library/reindex", { method: "POST" }),
  librarySaveHandoff: (input: {
    title: string;
    markdown: string;
    memories: Array<{ id: string; content: string; updatedAt: string }>;
    zipBase64?: string;
    archiveName?: string;
  }) => request<{
    node: LibraryNode;
    document: { content: string; extractor: string; language: string | null; charCount: number } | null;
    files: { markdown: string; archive: string | null };
  }>("/api/library/handoffs", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  libraryDeleteNode: (id: string, reason?: string) => request<{ entry: LibraryTrashEntry }>(`/api/library/nodes/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify(reason ? { reason } : {})
  }),
  libraryTrash: () => request<{ entries: LibraryTrashEntry[] }>("/api/library/trash"),
  libraryRestoreTrash: (id: string) => request<{ entry: LibraryTrashEntry; restoredMemoryId: string | null }>(`/api/library/trash/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  libraryPurgeTrash: (id: string) => request<{ ok: boolean }>(`/api/library/trash/${encodeURIComponent(id)}`, { method: "DELETE" }),
  libraryAddRoot: (path: string) => request<{ root: LibraryRoot }>("/api/library/roots", {
    method: "POST",
    body: JSON.stringify({ path })
  }),
  skills: () => request<{ skills: SkillView[] }>("/api/skills"),
  searchSkillRegistry: (input: { q: string }) => request<{
    query: string;
    candidates: Array<{ repo: string; source: string; skillPath: string | null; ref: string | null; description: string }>;
  }>(`/api/skills/registry/search${query(input)}`),
  skill: (id: string) => request<{ skill: SkillView }>(`/api/skills/${encodeURIComponent(id)}`),
  installSkill: (source: string) => request<{ skill: SkillView; changed: boolean; replacedFiles: number }>("/api/skills/install", {
    method: "POST",
    body: JSON.stringify({ source, confirmed: true })
  }),
  updateSkill: (id: string) => request<{ skill: SkillView; changed: boolean; replacedFiles: number }>(`/api/skills/${encodeURIComponent(id)}/update`, { method: "POST" }),
  deleteSkill: (id: string) => request<{ skill: SkillView; removedFiles: boolean }>(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" }),
  backgroundTools: (params: { taskId?: string; status?: string; limit?: number } = {}) =>
    request<{ jobs: BackgroundToolJob[] }>("/api/background-tools" + query(params)),
  sources: () => request<{ sources: SourceConnection[] }>("/api/sources"),
  sourceItems: (id: string) => request<{ items: SourceItem[] }>(`/api/sources/${encodeURIComponent(id)}/items`),
  sourceContentUrl: (sourceId: string, itemId: string) =>
    `/api/sources/${encodeURIComponent(sourceId)}/items/${encodeURIComponent(itemId)}/content`,
  tasks: () => request<{ tasks: TaskListItem[] }>("/api/tasks"),
  artifacts: () => request<{ artifacts: ArtifactListItem[] }>("/api/artifacts"),
  task: (id: string) => request<TaskView>(`/api/tasks/${encodeURIComponent(id)}`),
  taskSystemContextUrl: (id: string) =>
    `/api/tasks/${encodeURIComponent(id)}/system-context?format=markdown`,
  browserStatus: (id: string) => request<BrowserStatusView>(`/api/tasks/${encodeURIComponent(id)}/browser`),
  browserTakeover: (id: string, input: { kind?: BrowserTakeoverKind; reason?: string } = {}) =>
    request<{ browser: BrowserStatusView }>(`/api/tasks/${encodeURIComponent(id)}/browser/takeover`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  browserRelease: (id: string) =>
    request<{ browser: BrowserStatusView }>(`/api/tasks/${encodeURIComponent(id)}/browser/release`, { method: "POST" }),
  browserConnect: (id: string, token?: string, profileDirName?: string) =>
    request<{ browser: BrowserStatusView }>(`/api/tasks/${encodeURIComponent(id)}/browser/connect`, {
      method: "POST",
      body: JSON.stringify({
        ...(token ? { token } : {}),
        ...(profileDirName ? { profileDirName } : {})
      })
    }),
  browserClose: (id: string) =>
    request<{ closed: boolean }>(`/api/tasks/${encodeURIComponent(id)}/browser/close`, { method: "POST" }),
  addFollowUp: (id: string, content: string, mode: TaskFollowUpMode) =>
    request<TaskFollowUpRecord>(`/api/tasks/${encodeURIComponent(id)}/follow-ups`, {
      method: "POST",
      body: JSON.stringify({ content, mode })
    }),
  approvals: (params: { taskId?: string; status?: string; limit?: number; offset?: number; brief?: boolean } = {}) =>
    request<{ approvals: ApprovalListItem[]; total: number }>(`/api/approvals${query(params)}`),
  retry: (id: string, message?: string) => request<TaskRecord>(`/api/tasks/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    ...(message ? { body: JSON.stringify({ message }) } : {})
  }),
  cancel: (id: string) => request<TaskRecord>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  pause: (id: string) => request<TaskPauseResult>(`/api/tasks/${encodeURIComponent(id)}/pause`, { method: "POST" }),
  resume: (id: string, reference: TaskResumeReference, options: { acknowledge?: boolean; note?: string } = {}) => request<TaskRecord>(`/api/tasks/${encodeURIComponent(id)}/resume`, {
    method: "POST",
    body: JSON.stringify({ resume: reference, ...options })
  }),
  decideApproval: (id: string, decision: "approve" | "reject" | "approve_always", parameterHash: string) =>
    request<ApprovalDecisionResult>(`/api/approvals/${encodeURIComponent(id)}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, parameterHash })
    }),
  artifactUrl: (taskId: string, artifactId: string) =>
    `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`,
  exportArtifact: (taskId: string, artifactId: string, destination: string) =>
    request<{ path: string; bytes: number }>(
      `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}/export`,
      { method: "POST", body: JSON.stringify({ destination }) }
    ),
  attachmentUrl: (attachmentId: string) =>
    `/api/attachments/${encodeURIComponent(attachmentId)}`
};

async function streamExecutorBootstrap(
  id: ExecutorId,
  handlers: ExecutorBootstrapStreamHandlers
): Promise<ExecutorBootstrapResult> {
  const response = await fetch(`/api/executors/${encodeURIComponent(id)}/bootstrap/stream`, {
    method: "POST",
    headers: { accept: "application/x-ndjson" },
    ...(handlers.signal ? { signal: handlers.signal } : {})
  });
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    const message = typeof payload === "object" && payload && "message" in payload ? String(payload.message) : `执行器安装失败（${response.status}）`;
    const code = typeof payload === "object" && payload && "error" in payload ? String(payload.error) : null;
    throw new ApiError(message, response.status, code);
  }
  if (!response.body) throw new Error("服务没有返回安装进度");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ExecutorBootstrapResult | null = null;

  const dispatch = (line: string) => {
    if (!line.trim() || result) return;
    let event: ExecutorBootstrapStreamEvent;
    try {
      event = JSON.parse(line) as ExecutorBootstrapStreamEvent;
    } catch {
      throw new Error("执行器安装进度响应格式不正确");
    }
    if (event.type === "progress") {
      handlers.onProgress?.(event);
    } else if (event.type === "error") {
      throw new ApiError(event.message, 500, event.code ?? null);
    } else if (event.type === "complete") {
      result = event.result;
    }
  };
  const dispatchBuffer = (flush = false) => {
    if (flush) buffer += decoder.decode();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      dispatch(line);
      newline = buffer.indexOf("\n");
    }
    if (flush && buffer.trim()) {
      dispatch(buffer.trim());
      buffer = "";
    }
  };

  while (!result) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    dispatchBuffer();
  }
  dispatchBuffer(true);
  if (!result) throw new Error("执行器安装连接提前结束，请重试。");
  return result;
}

export function subscribeToEvents(onEvent: (event: string, envelope?: EventEnvelope) => void): () => void {
  const source = new EventSource("/api/events");
  const dispatch = (name: string, raw: string) => {
    let envelope: EventEnvelope | undefined;
    try {
      envelope = raw ? JSON.parse(raw) as EventEnvelope : undefined;
    } catch {
      envelope = undefined;
    }
    onEvent(name, envelope);
  };
  source.onmessage = (message) => dispatch("message", message.data);
  const eventNames = [
    "task.created", "task.updated", "task.progress", "task.follow-up.created", "task.follow-up.updated",
    "chat.message.created", "chat.message.updated", "run.created", "run.updated",
    "approval.created", "approval.updated", "artifact.published", "effect.created", "effect.updated",
    "source.created", "source.updated", "source.item.updated", "source.cleared",
    "memory.settings.updated", "memory.created", "memory.updated", "memory.version.recorded",
    "memory.recalled", "memory.conflict.created", "memory.conflict.updated", "memory.forgotten",
    "security.kill-switch.updated", "security.audit",
    "context.item.appended", "context.summary.updated", "context.settings.updated", "context.task.deleted",
    "execution.diagnosed", "execution.handoff.prepared", "execution.handoff.started", "execution.handoff.completed", "execution.handoff.failed",
    "schedule.created", "schedule.updated", "schedule.run.created", "schedule.run.updated",
    "device.paired", "device.updated", "device.pairing-requested", "device.pairing-updated",
    "desktop.session.created", "desktop.session.updated", "desktop.frame.updated",
    "desktop.command.created", "desktop.command.updated",
    "tool.job.updated"
  ];
  for (const name of eventNames) source.addEventListener(name, (event) => dispatch(name, (event as MessageEvent).data));
  for (const name of ["goal.created", "goal.updated", "goal.round.started", "goal.round.settled", "goal.completion.recorded", "goal.result.rejected"]) {
    source.addEventListener(name, (event) => dispatch(name, (event as MessageEvent).data));
  }
  for (const name of ["plan.created", "plan.updated", "plan.stage.changed", "plan.completed"]) {
    source.addEventListener(name, (event) => dispatch(name, (event as MessageEvent).data));
  }
  return () => source.close();
}

export async function chatStream(body: ChatStreamBody, handlers: ChatStreamHandlers): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(handlers.signal ? { signal: handlers.signal } : {})
  });
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    const message = typeof payload === "object" && payload && "message" in payload ? String(payload.message) : `发送失败（${response.status}）`;
    const code = typeof payload === "object" && payload && "error" in payload ? String(payload.error) : null;
    throw new ApiError(message, response.status, code);
  }
  if (!response.body) throw new Error("服务没有返回聊天内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  const emit = (event: string, data: unknown) => {
    if (event === "done" || event === "error" || event === "end") terminal = true;
    handlers.onEvent(event, data);
  };
  const dispatchBlocks = (flush = false) => {
    if (flush) buffer += decoder.decode();
    let match = buffer.match(/\r?\n\r?\n/);
    while (match?.index !== undefined) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      dispatchSseBlock(block, emit);
      match = buffer.match(/\r?\n\r?\n/);
    }
    if (flush && buffer.trim()) {
      dispatchSseBlock(buffer, emit);
      buffer = "";
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    dispatchBlocks();
  }
  dispatchBlocks(true);
  if (!terminal) throw new Error("聊天连接提前结束，请重试。");
}

function dispatchSseBlock(block: string, onEvent: (event: string, data: unknown) => void): void {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return;
  const raw = data.join("\n");
  try {
    onEvent(event, JSON.parse(raw));
  } catch {
    onEvent(event, raw);
  }
}

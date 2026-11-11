import type {
  ApprovalDecisionResult,
  ApprovalListItem,
  AttentionItem,
  AttachmentUploadResult,
  ChatAttachment,
  CodexProbeResponse,
  ConfirmHandoffResponse,
  ContextMetricsResponse,
  ContextSettingsPatch,
  ContextSettingsResponse,
  ConversationDetail,
  ConversationListItem,
  ConversationRecord,
  ConversationSettings,
  ConversationSettingsPatch,
  ArtifactListItem,
  BackupRestoreResult,
  BackupSnapshot,
  CreateTaskRequest,
  DesktopActionRequest,
  DesktopCommandView,
  DesktopDashboard,
  DesktopSessionView,
  DeviceCapabilityKind,
  DeviceView,
  ExecutorId,
  ExecutorModelBindingPatch,
  ExecutorInstallResponse,
  ExecutorModelBindingView,
  ExecutorListResponse,
  ExecutorProbeResult,
  ExecutorSettingsPatch,
  ExecutorSettingsResponse,
  EventWindow,
  EventEnvelope,
  FeishuDomain,
  FeishuIntegrationResponse,
  FeishuTestResponse,
  GitDiffScope,
  GitDiffView,
  GitFileView,
  GitRepositoryView,
  MailAccountInput,
  MailAccountView,
  MailSyncResult,
  MailTestResult,
  HealthResponse,
  HermesProbeResponse,
  LocalProjectView,
  MaintenanceSnapshot,
  CreateMemoryRequest,
  CreateMethodRequest,
  CreateSyncPeerRequest,
  CorrectMemoryRequest,
  MethodSnapshot,
  MemorySnapshot,
  ModelListResponse,
  ModelProfilePatch,
  ModelProfileView,
  ModelProtocol,
  ModelRegistryResponse,
  ModelRegistryView,
  ModelSettingsResponse,
  ModelTestResponse,
  OnboardingSnapshot,
  SettingsStorageResponse,
  OutboxDraft,
  OutboxDraftListItem,
  OutboxDraftRequest,
  OutboxSubmitResult,
  PairingRequestView,
  ProactiveSettings,
  ProactiveSnapshot,
  ProactiveSuggestion,
  ReconcileItem,
  RunListItem,
  RunManifest,
  ScheduleInput,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleRunSnapshot,
  ScheduleSnapshot,
  SecuritySnapshot,
  SourceConnection,
  SourceItem,
  SourceKind,
  SourceReadResult,
  EffectListItem,
  StatsSnapshot,
  SyncConflict,
  SyncPeerResult,
  SyncPullResult,
  SyncSnapshot,
  SystemStatus,
  TaskContextResponse,
  TaskFollowUpMode,
  TaskFollowUpRecord,
  TaskHandoffsResponse,
  TaskListItem,
  TaskProposalRecord,
  TaskRecord,
  TrashItem,
  TrashKind,
  TaskTemplate,
  TaskView,
  BackgroundToolJob,
  CommitmentRecord,
  DecisionRecord,
  IntakeDecisionRecord,
  IntakeRouteResult,
  OntologyEntityView,
  PreparedActionRecord,
  ThreadDeliveryView,
  ThreadSubscriptionRecord,
  WatchdogEvent,
  WatchdogSettingsView,
  WatchdogSnapshot
} from "./types.ts";

export interface ChatStreamBody {
  conversationId?: string;
  message?: string;
  attachments?: ChatAttachment[];
  url?: string;
  settings?: ConversationSettingsPatch;
}

export interface ChatStreamHandlers {
  onEvent: (event: string, data: unknown) => void;
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
  conversationDefaults: () => request<{ settings: ConversationSettings }>("/api/conversation-defaults"),
  conversations: () => request<{ conversations: ConversationListItem[] }>("/api/conversations"),
  conversation: (id: string) => request<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}`),
  createConversation: (title?: string, settings?: ConversationSettingsPatch) => request<ConversationRecord>("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ ...(title ? { title } : {}), ...(settings ? { settings } : {}) })
  }),
  renameConversation: (id: string, title: string) => request<ConversationRecord>(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ title })
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
  deleteTask: (id: string, cancelRunning = false) => request<void>(`/api/tasks/${encodeURIComponent(id)}`, {
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
  modelSettings: () => request<ModelSettingsResponse>("/api/model-settings"),
  projects: () => request<{ projects: LocalProjectView[] }>("/api/projects"),
  createProject: (input: { name?: string; path: string; defaultBranch?: string }) => request<{ project: LocalProjectView }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  updateProject: (id: string, input: { name?: string; defaultBranch?: string }) => request<{ project: LocalProjectView }>(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  }),
  deleteProject: (id: string) => request<void>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
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
  saveExecutorModelBinding: (id: ExecutorId, input: ExecutorModelBindingPatch) => request<{ binding: ExecutorModelBindingView }>(`/api/executors/${encodeURIComponent(id)}/model-binding`, {
    method: "PUT",
    body: JSON.stringify(input)
  }),
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
  fetchModels: (input: { providerId?: string; providerName?: string; protocol?: ModelProtocol; baseUrl?: string; model?: string; apiKey?: string }) =>
    request<ModelListResponse>("/api/model-settings/models", { method: "POST", body: JSON.stringify(input) }),
  testModel: (input: { providerId?: string; providerName?: string; protocol?: ModelProtocol; baseUrl?: string; model?: string; apiKey?: string }) =>
    request<ModelTestResponse>("/api/model-settings/test", { method: "POST", body: JSON.stringify(input) }),
  probeCodex: () => request<CodexProbeResponse>("/api/codex/probe", { method: "POST" }),
  executorSettings: () => request<ExecutorSettingsResponse>("/api/executor-settings"),
  executors: () => request<ExecutorListResponse>("/api/executors"),
  saveExecutorSettings: (input: ExecutorSettingsPatch) => request<ExecutorSettingsResponse>("/api/executor-settings", {
    method: "PUT",
    body: JSON.stringify(input)
  }),
  probeExecutor: (id: ExecutorId) => request<ExecutorProbeResult>(`/api/executors/${encodeURIComponent(id)}/probe`, { method: "POST" }),
  installExecutor: (id: ExecutorId) => request<ExecutorInstallResponse>(`/api/executors/${encodeURIComponent(id)}/install`, { method: "POST" }),
  executorInstall: (id: ExecutorId) => request<ExecutorInstallResponse>(`/api/executors/${encodeURIComponent(id)}/install`),
  probeHermes: () => request<HermesProbeResponse>("/api/hermes/probe", { method: "POST" }),
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
  resetOnboarding: () => request<OnboardingSnapshot>("/api/onboarding/reset", { method: "POST" }),
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
  mailAccounts: () => request<{ accounts: MailAccountView[] }>("/api/mail/accounts"),
  createMailAccount: (input: MailAccountInput) => request<{ account: MailAccountView }>("/api/mail/accounts", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  updateMailAccount: (id: string, input: MailAccountInput) => request<{ account: MailAccountView }>(`/api/mail/accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  }),
  deleteMailAccount: (id: string) => request<void>(`/api/mail/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testMailAccount: (id: string) => request<MailTestResult>(`/api/mail/accounts/${encodeURIComponent(id)}/test`, { method: "POST" }),
  syncMailAccount: (id: string) => request<MailSyncResult>(`/api/mail/accounts/${encodeURIComponent(id)}/sync`, { method: "POST" }),
  system: () => request<SystemStatus>("/api/system"),
  stopSystem: () => request<SystemStatus>("/api/system/stop", { method: "POST" }),
  startSystem: () => request<SystemStatus>("/api/system/start", { method: "POST" }),
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
  createMemory: (input: CreateMemoryRequest) => request<MemorySnapshot["memories"][number]>("/api/memory", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  updateMemorySettings: (input: Partial<MemorySnapshot["settings"]>) => request<MemorySnapshot["settings"]>("/api/memory/settings", {
    method: "PATCH",
    body: JSON.stringify(input)
  }),
  confirmMemory: (id: string) => request<MemorySnapshot["memories"][number]>("/api/memory/" + encodeURIComponent(id) + "/confirm", { method: "POST" }),
  correctMemory: (id: string, input: CorrectMemoryRequest) => request<MemorySnapshot["memories"][number]>("/api/memory/" + encodeURIComponent(id), {
    method: "PATCH",
    body: JSON.stringify(input)
  }),
  forgetMemory: (id: string) => request<MemorySnapshot["memories"][number]>("/api/memory/" + encodeURIComponent(id) + "/forget", { method: "POST" }),
  markMemorySensitive: (id: string, sensitivity: MemorySnapshot["memories"][number]["sensitivity"], allowRecall?: boolean) =>
    request<MemorySnapshot["memories"][number]>("/api/memory/" + encodeURIComponent(id) + "/sensitive", {
      method: "POST",
      body: JSON.stringify({ sensitivity, ...(allowRecall === undefined ? {} : { allowRecall }) })
    }),
  resolveMemoryConflict: (id: string, input: { resolution: "keep_left" | "keep_right" | "merged"; note?: string; content?: string }) =>
    request<MemorySnapshot["conflicts"][number]>("/api/memory/conflicts/" + encodeURIComponent(id) + "/resolve", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  recallMemory: (input: { taskId: string; runId?: string; text?: string; maxItems?: number; maxChars?: number }) =>
    request<{ memories: MemorySnapshot["memories"]; recalls: MemorySnapshot["recalls"]; contextPack: string; usedChars: number; budget: { maxItems: number; maxChars: number } }>("/api/memory/recall", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  exportMemories: () => { window.location.assign("/api/memory/export"); },
  methods: () => request<MethodSnapshot>("/api/methods"),
  generateMethod: (input: { taskId: string; name?: string; summary?: string }) => request<MethodSnapshot["methods"][number]>("/api/methods/generate", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  createMethod: (input: CreateMethodRequest) => request<MethodSnapshot["methods"][number]>("/api/methods", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  recordMethodTrial: (id: string, taskId: string) => request<MethodSnapshot["methods"][number]>("/api/methods/" + encodeURIComponent(id) + "/trials", {
    method: "POST",
    body: JSON.stringify({ taskId })
  }),
  evaluateMethod: (id: string, input: { baselineTaskIds: string[]; trialTaskIds: string[]; notes?: string }) => request<MethodSnapshot["evaluations"][number]>("/api/methods/" + encodeURIComponent(id) + "/evaluate", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  promoteMethod: (id: string) => request<MethodSnapshot["methods"][number]>("/api/methods/" + encodeURIComponent(id) + "/promote", { method: "POST" }),
  rollbackMethod: (id: string, reason: string) => request<MethodSnapshot["methods"][number]>("/api/methods/" + encodeURIComponent(id) + "/rollback", {
    method: "POST",
    body: JSON.stringify({ reason })
  }),
  rejectMethod: (id: string, reason?: string) => request<MethodSnapshot["methods"][number]>("/api/methods/" + encodeURIComponent(id) + "/reject", {
    method: "POST",
    body: JSON.stringify(reason === undefined ? {} : { reason })
  }),
  methodSettings: () => request<{ settings: MethodSnapshot["settings"] }>("/api/methods/settings"),
  saveMethodSettings: (patch: { autoLearn?: boolean }) => request<{ settings: MethodSnapshot["settings"] }>("/api/methods/settings", {
    method: "PATCH",
    body: JSON.stringify(patch)
  }),
  methodPairing: (id: string) => request<{ baselineTaskIds: string[]; trialTaskIds: string[]; notes: string[] }>(
    "/api/methods/" + encodeURIComponent(id) + "/pairing"
  ),
  assignTaskMethod: (taskId: string, methodId: string | null) => request<TaskRecord>(
    `/api/tasks/${encodeURIComponent(taskId)}/method`,
    { method: "PATCH", body: JSON.stringify({ methodId }) }
  ),
  sync: () => request<SyncSnapshot>("/api/sync"),
  createSyncPeer: (input: CreateSyncPeerRequest) => request<SyncPeerResult>("/api/sync/peers", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  pullSyncPeer: (id: string) => request<SyncPullResult>("/api/sync/peers/" + encodeURIComponent(id) + "/pull", { method: "POST" }),
  rotateSyncPeer: (id: string) => request<SyncPeerResult>("/api/sync/peers/" + encodeURIComponent(id) + "/rotate", { method: "POST" }),
  revokeSyncPeer: (id: string) => request<SyncSnapshot["peers"][number]>("/api/sync/peers/" + encodeURIComponent(id) + "/revoke", { method: "POST" }),
  resolveSyncConflict: (id: string, resolution: "local" | "remote") => request<SyncConflict>("/api/sync/conflicts/" + encodeURIComponent(id) + "/resolve", {
    method: "POST",
    body: JSON.stringify({ resolution })
  }),
  attention: () => request<{
    items: AttentionItem[];
    budget: { dailyLimit: number; quietStart: string; quietEnd: string; cooldownSeconds: number };
    governor: { shadowMode: boolean; minFeedbackSamples: number };
  }>("/api/attention"),
  attentionExplain: (id: string) => request<{
    item: AttentionItem;
    score: Record<string, number>;
    whyYouSeeThis: string;
    feedback: { total: number; accepted: number; ignored: number; wrong: number; bias: number };
    aggregation: { key: string; peers: number };
  }>("/api/attention/" + encodeURIComponent(id) + "/explain"),
  attentionFeedback: (id: string, action: "accept" | "ignore" | "snooze" | "resolve" | "wrong") =>
    request<{ record: unknown; stats: { total: number; accepted: number; ignored: number; wrong: number; bias: number } }>(
      "/api/attention/" + encodeURIComponent(id) + "/feedback",
      { method: "POST", body: JSON.stringify({ action }) }
    ),
  attentionAck: (id: string) => request<AttentionItem>("/api/attention/" + encodeURIComponent(id) + "/ack", { method: "POST" }),
  attentionIgnore: (id: string) => request<AttentionItem>("/api/attention/" + encodeURIComponent(id) + "/ignore", { method: "POST" }),
  attentionResolve: (id: string) => request<AttentionItem>("/api/attention/" + encodeURIComponent(id) + "/resolve", { method: "POST" }),
  attentionSnooze: (id: string, minutes = 60) => request<AttentionItem>("/api/attention/" + encodeURIComponent(id) + "/snooze", {
    method: "POST",
    body: JSON.stringify({ minutes })
  }),
  updateAttentionGovernor: (input: { shadowMode?: boolean; minFeedbackSamples?: number }) =>
    request<{ shadowMode: boolean; minFeedbackSamples: number }>("/api/attention/governor", {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  ontologyEntities: (search?: string, kind?: string) => request<{ entities: OntologyEntityView[] }>(
    "/api/ontology/entities" + query({ query: search, kind })
  ),
  ontologyCommitments: (status?: string) => request<{ commitments: CommitmentRecord[] }>(
    "/api/ontology/commitments" + query({ status })
  ),
  ontologyDecisions: (status?: string) => request<{ decisions: DecisionRecord[] }>(
    "/api/ontology/decisions" + query({ status })
  ),
  correctEntity: (id: string, input: { key: string; value: unknown; evidenceRef?: string }) =>
    request<Record<string, unknown>>("/api/ontology/entities/" + encodeURIComponent(id) + "/correct", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  forgetOntologyEvidence: (evidenceRef: string) =>
    request<Record<string, unknown>>("/api/ontology/forget", { method: "POST", body: JSON.stringify({ evidenceRef }) }),
  preparedActions: (params: { taskId?: string; status?: string; limit?: number } = {}) =>
    request<{ actions: PreparedActionRecord[] }>("/api/prepared-actions" + query(params)),
  commitPreparedAction: (id: string, input: { approvalRef?: string } = {}) =>
    request<PreparedActionRecord>("/api/prepared-actions/" + encodeURIComponent(id) + "/commit", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  discardPreparedAction: (id: string) =>
    request<PreparedActionRecord>("/api/prepared-actions/" + encodeURIComponent(id) + "/discard", { method: "POST" }),
  backgroundTools: (params: { taskId?: string; status?: string; limit?: number } = {}) =>
    request<{ jobs: BackgroundToolJob[] }>("/api/background-tools" + query(params)),
  stopBackgroundTool: (id: string, reason?: string) =>
    request<BackgroundToolJob>("/api/background-tools/" + encodeURIComponent(id) + "/stop", {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {})
    }),
  threadSubscriptions: (params: { threadKey?: string; taskId?: string; status?: string } = {}) =>
    request<{ subscriptions: ThreadSubscriptionRecord[] }>("/api/thread-subscriptions" + query(params)),
  threadDeliveries: (limit = 50) =>
    request<{ deliveries: ThreadDeliveryView[] }>("/api/thread-subscriptions/deliveries" + query({ limit })),
  threadSubscriptionAction: (id: string, action: "pause" | "resume" | "end") =>
    request<ThreadSubscriptionRecord>("/api/thread-subscriptions/" + encodeURIComponent(id) + "/" + action, { method: "POST" }),
  watchdog: () => request<WatchdogSnapshot>("/api/watchdog"),
  scanWatchdog: () => request<{ events: WatchdogEvent[]; settings: WatchdogSettingsView }>("/api/watchdog/scan", { method: "POST" }),
  updateWatchdogSettings: (input: Partial<WatchdogSettingsView>) =>
    request<WatchdogSettingsView>("/api/watchdog/settings", { method: "PATCH", body: JSON.stringify(input) }),
  intakeDecisions: (limit = 100) => request<{ decisions: IntakeDecisionRecord[] }>("/api/intake/decisions" + query({ limit })),
  routeIntake: (input: { sourceRef: string; text: string; sender?: string; channel?: string }) =>
    request<IntakeRouteResult>("/api/intake/route", { method: "POST", body: JSON.stringify(input) }),
  heartbeat: (limit = 50) => request<{ runs: Array<Record<string, unknown>>; last: Record<string, unknown> | null }>(
    "/api/heartbeat" + query({ limit })
  ),
  proactive: () => request<ProactiveSnapshot>("/api/proactive"),
  scanProactive: () => request<{ created: number; updated: number; delivered: number; suggestions: ProactiveSuggestion[] }>("/api/proactive/scan", { method: "POST" }),
  updateProactiveSettings: (input: Partial<Omit<ProactiveSettings, "triggers" | "updatedAt">> & {
    triggers?: Partial<ProactiveSettings["triggers"]>;
  }) => request<ProactiveSettings>("/api/proactive/settings", {
    method: "PATCH",
    body: JSON.stringify(input)
  }),
  pauseProactive: (input: { minutes?: number; off?: boolean; resume?: boolean }) => request<ProactiveSettings>("/api/proactive/pause", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  acceptSuggestion: (id: string) => request<ProactiveSuggestion>("/api/suggestions/" + encodeURIComponent(id) + "/accept", { method: "POST" }),
  convertSuggestion: (id: string, input: { title?: string; goal?: string; textInput?: string } = {}) => request<{ suggestion: ProactiveSuggestion; taskId: string }>("/api/suggestions/" + encodeURIComponent(id) + "/convert", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  ignoreSuggestion: (id: string) => request<ProactiveSuggestion>("/api/suggestions/" + encodeURIComponent(id) + "/ignore", { method: "POST" }),
  snoozeSuggestion: (id: string, minutes = 60) => request<ProactiveSuggestion>("/api/suggestions/" + encodeURIComponent(id) + "/snooze", {
    method: "POST",
    body: JSON.stringify({ minutes })
  }),
  templates: () => request<{ templates: TaskTemplate[] }>("/api/templates"),
  sources: () => request<{ sources: SourceConnection[] }>("/api/sources"),
  readySourceItems: (limit = 100) => request<{ items: SourceItem[] }>(`/api/source-items${query({ limit })}`),
  sourceItems: (id: string) => request<{ items: SourceItem[] }>(`/api/sources/${encodeURIComponent(id)}/items`),
  createSource: (input: {
    kind: SourceKind;
    displayName?: string;
    rootPath?: string;
    allowedHosts?: string[];
    account?: string;
  }) => request<SourceConnection>("/api/sources", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  readSource: (id: string, url?: string) => request<SourceReadResult>(`/api/sources/${encodeURIComponent(id)}/read`, {
    method: "POST",
    body: JSON.stringify(url ? { url } : {})
  }),
  disconnectSource: (id: string) => request<SourceConnection>(`/api/sources/${encodeURIComponent(id)}/disconnect`, { method: "POST" }),
  reconnectSource: (id: string) => request<SourceConnection>(`/api/sources/${encodeURIComponent(id)}/reconnect`, { method: "POST" }),
  clearSource: (id: string) => request<SourceConnection>(`/api/sources/${encodeURIComponent(id)}/clear`, { method: "POST" }),
  sourceContentUrl: (sourceId: string, itemId: string) =>
    `/api/sources/${encodeURIComponent(sourceId)}/items/${encodeURIComponent(itemId)}/content`,
  tasks: () => request<{ tasks: TaskListItem[] }>("/api/tasks"),
  artifacts: () => request<{ artifacts: ArtifactListItem[] }>("/api/artifacts"),
  task: (id: string) => request<TaskView>(`/api/tasks/${encodeURIComponent(id)}`),
  followUps: (id: string) => request<{ followUps: TaskFollowUpRecord[] }>(`/api/tasks/${encodeURIComponent(id)}/follow-ups`),
  addFollowUp: (id: string, content: string, mode: TaskFollowUpMode) =>
    request<TaskFollowUpRecord>(`/api/tasks/${encodeURIComponent(id)}/follow-ups`, {
      method: "POST",
      body: JSON.stringify({ content, mode })
    }),
  updateFollowUp: (id: string, followUpId: string, content: string) =>
    request<TaskFollowUpRecord>(`/api/tasks/${encodeURIComponent(id)}/follow-ups/${encodeURIComponent(followUpId)}`, {
      method: "PATCH",
      body: JSON.stringify({ content })
    }),
  deleteFollowUp: (id: string, followUpId: string) =>
    request<TaskFollowUpRecord>(`/api/tasks/${encodeURIComponent(id)}/follow-ups/${encodeURIComponent(followUpId)}`, { method: "DELETE" }),
  gitView: (id: string) => request<GitRepositoryView>(`/api/tasks/${encodeURIComponent(id)}/git`),
  gitDiff: (id: string, scope: GitDiffScope, path?: string) =>
    request<GitDiffView>(`/api/tasks/${encodeURIComponent(id)}/git/diff${query({ scope, path })}`),
  gitFile: (id: string, path: string, fromHead = false) =>
    request<GitFileView>(`/api/tasks/${encodeURIComponent(id)}/git/file${query({ path, fromHead })}`),
  taskContext: (id: string, params: { limit?: number; before?: number } = {}) =>
    request<TaskContextResponse>(`/api/tasks/${encodeURIComponent(id)}/context${query(params)}`),
  taskHandoffs: (id: string) => request<TaskHandoffsResponse>(`/api/tasks/${encodeURIComponent(id)}/handoffs`),
  confirmHandoff: (id: string, executorId: ExecutorId) =>
    request<ConfirmHandoffResponse>(`/api/tasks/${encodeURIComponent(id)}/handoff`, {
      method: "POST",
      body: JSON.stringify({ executorId })
    }),
  deleteTaskContext: (id: string) => request<{ taskId: string; deletedItems: number; deletedBlobs: number; deletedHandoffs: number; createdAt: string }>(`/api/tasks/${encodeURIComponent(id)}/context`, { method: "DELETE" }),
  contextSettings: () => request<ContextSettingsResponse>("/api/context/settings"),
  contextMetrics: () => request<ContextMetricsResponse>("/api/context/metrics"),
  saveContextSettings: (patch: ContextSettingsPatch) => request<ContextSettingsResponse>("/api/context/settings", {
    method: "PATCH",
    body: JSON.stringify(patch)
  }),
  stats: () => request<StatsSnapshot>("/api/stats"),
  runs: (params: { taskId?: string; status?: string; limit?: number; offset?: number } = {}) =>
    request<{ runs: RunListItem[]; total: number }>(`/api/runs${query(params)}`),
  approvals: (params: { taskId?: string; status?: string; limit?: number; offset?: number; brief?: boolean } = {}) =>
    request<{ approvals: ApprovalListItem[]; total: number }>(`/api/approvals${query(params)}`),
  effects: (params: { taskId?: string; status?: string; limit?: number; offset?: number } = {}) =>
    request<{ effects: EffectListItem[]; total: number }>(`/api/effects${query(params)}`),
  reconcile: (params: { status?: string } = {}) =>
    request<{ items: ReconcileItem[]; total: number }>(`/api/reconcile${query(params)}`),
  checkReconcile: (id: string) =>
    request<ReconcileItem>(`/api/reconcile/${encodeURIComponent(id)}/check`, { method: "POST" }),
  resolveReconcile: (id: string, resolution: "committed" | "absent" | "abandoned", note: string) =>
    request<ReconcileItem>(`/api/reconcile/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution, note })
    }),
  createReconcileTask: (id: string, note?: string) =>
    request<TaskRecord>(`/api/reconcile/${encodeURIComponent(id)}/task`, {
      method: "POST",
      body: JSON.stringify({ ...(note ? { note } : {}) })
    }),
  outbox: () => request<{ drafts: OutboxDraftListItem[] }>("/api/outbox"),
  outboxDraft: (id: string) => request<OutboxDraftListItem>(`/api/outbox/${encodeURIComponent(id)}`),
  createOutboxDraft: (input: OutboxDraftRequest) => request<OutboxDraft>("/api/outbox", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  updateOutboxDraft: (id: string, input: OutboxDraftRequest) => request<OutboxDraft>(`/api/outbox/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  }),
  discardOutboxDraft: (id: string) => request<OutboxDraft>(`/api/outbox/${encodeURIComponent(id)}/discard`, { method: "POST" }),
  submitOutboxDraft: (id: string) => request<OutboxSubmitResult>(`/api/outbox/${encodeURIComponent(id)}/submit`, { method: "POST" }),
  desktop: () => request<DesktopDashboard>("/api/desktop"),
  desktopSession: (id: string) => request<DesktopSessionView>(`/api/desktop/sessions/${encodeURIComponent(id)}`),
  createDesktopSession: (deviceId: string, targetApp?: string) => request<DesktopSessionView>("/api/desktop/sessions", {
    method: "POST",
    body: JSON.stringify({ deviceId, ...(targetApp ? { targetApp } : {}) })
  }),
  observeDesktop: (sessionId: string, targetApp?: string) => request<DesktopSessionView>(`/api/desktop/sessions/${encodeURIComponent(sessionId)}/observe`, {
    method: "POST",
    body: JSON.stringify(targetApp ? { targetApp } : {})
  }),
  pauseDesktop: (sessionId: string) => request<DesktopSessionView>(`/api/desktop/sessions/${encodeURIComponent(sessionId)}/pause`, { method: "POST" }),
  resumeDesktop: (sessionId: string) => request<DesktopSessionView>(`/api/desktop/sessions/${encodeURIComponent(sessionId)}/resume`, { method: "POST" }),
  takeOverDesktop: (sessionId: string) => request<DesktopSessionView>(`/api/desktop/sessions/${encodeURIComponent(sessionId)}/takeover`, { method: "POST" }),
  releaseDesktop: (sessionId: string) => request<DesktopSessionView>(`/api/desktop/sessions/${encodeURIComponent(sessionId)}/release`, { method: "POST" }),
  terminateDesktop: (sessionId: string) => request<DesktopSessionView>(`/api/desktop/sessions/${encodeURIComponent(sessionId)}/terminate`, { method: "POST" }),
  desktopAction: (sessionId: string, input: DesktopActionRequest) => request<DesktopCommandView>(`/api/desktop/sessions/${encodeURIComponent(sessionId)}/actions`, {
    method: "POST",
    body: JSON.stringify(input)
  }),
  approvePairing: (id: string) => request<DeviceView>(`/api/devices/pairing-requests/${encodeURIComponent(id)}/approve`, { method: "POST" }),
  rejectPairing: (id: string) => request<PairingRequestView>(`/api/devices/pairing-requests/${encodeURIComponent(id)}/reject`, { method: "POST" }),
  approveDeviceCapability: (deviceId: string, kind: DeviceCapabilityKind, apps: string[]) =>
    request<DeviceView>(`/api/devices/${encodeURIComponent(deviceId)}/capabilities/${encodeURIComponent(kind)}/approve`, {
      method: "POST",
      body: JSON.stringify({ apps })
    }),
  revokeDeviceCapability: (deviceId: string, kind: DeviceCapabilityKind) =>
    request<DeviceView>(`/api/devices/${encodeURIComponent(deviceId)}/capabilities/${encodeURIComponent(kind)}/revoke`, { method: "POST" }),
  revokeDevice: (deviceId: string) => request<DeviceView>(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, { method: "POST" }),
  rotateDeviceToken: (deviceId: string) => request<{ device: DeviceView; token: string }>(`/api/devices/${encodeURIComponent(deviceId)}/rotate-token`, { method: "POST" }),
  taskEvents: (id: string, params: { after?: number; before?: number; limit?: number; type?: string } = {}) =>
    request<EventWindow>(`/api/tasks/${encodeURIComponent(id)}/events${query(params)}`),
  manifest: (taskId: string, artifactId: string) =>
    request<RunManifest>(`/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`),
  createTask: (input: CreateTaskRequest) => request<TaskRecord>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  retry: (id: string, message?: string) => request<TaskRecord>(`/api/tasks/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    ...(message ? { body: JSON.stringify({ message }) } : {})
  }),
  extendBudget: (id: string) => request<TaskRecord>(`/api/tasks/${encodeURIComponent(id)}/budget/extend`, { method: "POST" }),
  confirmTaskProposal: (id: string) => request<{ proposal: TaskProposalRecord; task: TaskRecord }>(
    `/api/task-proposals/${encodeURIComponent(id)}/confirm`,
    { method: "POST" }
  ),
  rejectTaskProposal: (id: string) => request<TaskProposalRecord>(
    `/api/task-proposals/${encodeURIComponent(id)}/reject`,
    { method: "POST" }
  ),
  cancel: (id: string) => request<TaskRecord>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  setTaskOrganization: (id: string, patch: { pinned?: boolean; archived?: boolean }) =>
    request<TaskRecord>(`/api/tasks/${encodeURIComponent(id)}/organization`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    }),
  decideApproval: (id: string, decision: "approve" | "reject", parameterHash: string) =>
    request<ApprovalDecisionResult>(`/api/approvals/${encodeURIComponent(id)}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, parameterHash })
    }),
  artifactUrl: (taskId: string, artifactId: string) =>
    `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`,
  downloadExport: () => {
    window.location.assign("/api/export");
  }
};

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
    "proactive.settings.updated", "suggestion.created", "suggestion.updated", "suggestion.event",
    "memory.settings.updated", "memory.created", "memory.updated", "memory.version.recorded",
    "memory.recalled", "memory.conflict.created", "memory.conflict.updated", "memory.forgotten",
    "method.candidate.created", "method.candidate.updated", "method.evaluation.recorded", "method.trial.recorded",
    "sync.peer.created", "sync.peer.updated", "sync.conflict.created", "sync.conflict.updated",
    "security.kill-switch.updated", "security.audit",
    "context.item.appended", "context.summary.updated", "context.settings.updated", "context.task.deleted",
    "execution.diagnosed", "execution.handoff.prepared", "execution.handoff.started", "execution.handoff.completed", "execution.handoff.failed",
    "outbox.created", "outbox.updated",
    "schedule.created", "schedule.updated", "schedule.run.created", "schedule.run.updated",
    "device.paired", "device.updated", "device.pairing-requested", "device.pairing-updated",
    "desktop.session.created", "desktop.session.updated", "desktop.frame.updated",
    "desktop.command.created", "desktop.command.updated",
    "prepared-action.updated", "tool.job.updated", "thread-subscription.updated",
    "watchdog.recorded", "intake.recorded"
  ];
  for (const name of eventNames) source.addEventListener(name, (event) => dispatch(name, (event as MessageEvent).data));
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
    throw new Error(message);
  }
  if (!response.body) throw new Error("服务没有返回聊天内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      dispatchSseBlock(block, handlers.onEvent);
      boundary = buffer.indexOf("\n\n");
    }
  }
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

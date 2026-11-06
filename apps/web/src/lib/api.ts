import type {
  ApprovalDecisionResult,
  ApprovalListItem,
  AttachmentUploadResult,
  ChatAttachment,
  CodexProbeResponse,
  ConversationDetail,
  ConversationListItem,
  ConversationRecord,
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
  EventWindow,
  HealthResponse,
  MaintenanceSnapshot,
  CreateMemoryRequest,
  CreateMethodRequest,
  CreateSyncPeerRequest,
  CorrectMemoryRequest,
  MethodSnapshot,
  MemorySnapshot,
  ModelListResponse,
  ModelProtocol,
  ModelSettingsResponse,
  ModelTestResponse,
  OutboxDraft,
  OutboxDraftListItem,
  OutboxDraftRequest,
  OutboxSubmitResult,
  PairingRequestView,
  ProactiveSettings,
  ProactiveSnapshot,
  ProactiveSuggestion,
  RunListItem,
  RunManifest,
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
  TaskListItem,
  TaskProposalRecord,
  TaskRecord,
  TaskTemplate,
  TaskView
} from "./types.ts";

export interface ChatStreamBody {
  conversationId?: string;
  message?: string;
  attachments?: ChatAttachment[];
  url?: string;
}

export interface ChatStreamHandlers {
  onEvent: (event: string, data: unknown) => void;
  signal?: AbortSignal;
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
    throw new Error(message);
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
  conversations: () => request<{ conversations: ConversationListItem[] }>("/api/conversations"),
  conversation: (id: string) => request<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}`),
  createConversation: (title?: string) => request<ConversationRecord>("/api/conversations", {
    method: "POST",
    body: JSON.stringify(title ? { title } : {})
  }),
  renameConversation: (id: string, title: string) => request<ConversationRecord>(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ title })
  }),
  deleteConversation: (id: string) => request<void>(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  modelSettings: () => request<ModelSettingsResponse>("/api/model-settings"),
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
  stats: () => request<StatsSnapshot>("/api/stats"),
  runs: (params: { taskId?: string; status?: string; limit?: number; offset?: number } = {}) =>
    request<{ runs: RunListItem[]; total: number }>(`/api/runs${query(params)}`),
  approvals: (params: { taskId?: string; status?: string; limit?: number; offset?: number; brief?: boolean } = {}) =>
    request<{ approvals: ApprovalListItem[]; total: number }>(`/api/approvals${query(params)}`),
  effects: (params: { taskId?: string; status?: string; limit?: number; offset?: number } = {}) =>
    request<{ effects: EffectListItem[]; total: number }>(`/api/effects${query(params)}`),
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
  confirmTaskProposal: (id: string) => request<{ proposal: TaskProposalRecord; task: TaskRecord }>(
    `/api/task-proposals/${encodeURIComponent(id)}/confirm`,
    { method: "POST" }
  ),
  rejectTaskProposal: (id: string) => request<TaskProposalRecord>(
    `/api/task-proposals/${encodeURIComponent(id)}/reject`,
    { method: "POST" }
  ),
  cancel: (id: string) => request<TaskRecord>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
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

export function subscribeToEvents(onEvent: () => void): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = onEvent;
  const eventNames = [
    "task.created", "task.updated", "task.progress", "run.created", "run.updated",
    "approval.created", "approval.updated", "artifact.published", "effect.created", "effect.updated",
    "source.created", "source.updated", "source.item.updated", "source.cleared",
    "proactive.settings.updated", "suggestion.created", "suggestion.updated", "suggestion.event",
    "memory.settings.updated", "memory.created", "memory.updated", "memory.version.recorded",
    "memory.recalled", "memory.conflict.created", "memory.conflict.updated", "memory.forgotten",
    "method.candidate.created", "method.candidate.updated", "method.evaluation.recorded", "method.trial.recorded",
    "sync.peer.created", "sync.peer.updated", "sync.conflict.created", "sync.conflict.updated",
    "security.kill-switch.updated", "security.audit",
    "outbox.created", "outbox.updated",
    "device.paired", "device.updated", "device.pairing-requested", "device.pairing-updated",
    "desktop.session.created", "desktop.session.updated", "desktop.frame.updated",
    "desktop.command.created", "desktop.command.updated"
  ];
  for (const name of eventNames) source.addEventListener(name, onEvent);
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

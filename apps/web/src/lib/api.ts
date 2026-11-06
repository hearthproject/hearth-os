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
  CreateTaskRequest,
  DesktopActionRequest,
  DesktopCommandView,
  DesktopDashboard,
  DesktopSessionView,
  DeviceCapabilityKind,
  DeviceView,
  EventWindow,
  HealthResponse,
  ModelListResponse,
  ModelSettingsResponse,
  ModelTestResponse,
  OutboxDraft,
  OutboxDraftListItem,
  OutboxDraftRequest,
  OutboxSubmitResult,
  PairingRequestView,
  RunListItem,
  RunManifest,
  SourceConnection,
  SourceItem,
  SourceKind,
  SourceReadResult,
  EffectListItem,
  StatsSnapshot,
  SystemStatus,
  TaskListItem,
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
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }) => request<ModelSettingsResponse>("/api/model-settings", {
    method: "PUT",
    body: JSON.stringify(input)
  }),
  fetchModels: (input: { providerId?: string; providerName?: string; baseUrl?: string; model?: string; apiKey?: string }) =>
    request<ModelListResponse>("/api/model-settings/models", { method: "POST", body: JSON.stringify(input) }),
  testModel: (input: { providerId?: string; providerName?: string; baseUrl?: string; model?: string; apiKey?: string }) =>
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
  taskEvents: (id: string, params: { after?: number; before?: number; limit?: number; type?: string } = {}) =>
    request<EventWindow>(`/api/tasks/${encodeURIComponent(id)}/events${query(params)}`),
  manifest: (taskId: string, artifactId: string) =>
    request<RunManifest>(`/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`),
  createTask: (input: CreateTaskRequest) => request<TaskRecord>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  retry: (id: string) => request<TaskRecord>(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  cancel: (id: string) => request<TaskRecord>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  decideApproval: (id: string, decision: "approve" | "reject", parameterHash: string) =>
    request<ApprovalDecisionResult>(`/api/approvals/${encodeURIComponent(id)}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, parameterHash })
    }),
  artifactUrl: (taskId: string, artifactId: string) =>
    `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`,
  downloadBackup: () => {
    window.location.assign("/api/backup");
  },
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

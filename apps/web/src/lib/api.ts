import type {
  ApprovalDecisionResult,
  ApprovalListItem,
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
  CreateMemoryRequest,
  CorrectMemoryRequest,
  MemorySnapshot,
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
  health: () => request<HealthResponse>("/api/health"),
  system: () => request<SystemStatus>("/api/system"),
  stopSystem: () => request<SystemStatus>("/api/system/stop", { method: "POST" }),
  startSystem: () => request<SystemStatus>("/api/system/start", { method: "POST" }),
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
    "proactive.settings.updated", "suggestion.created", "suggestion.updated", "suggestion.event",
    "memory.settings.updated", "memory.created", "memory.updated", "memory.version.recorded",
    "memory.recalled", "memory.conflict.created", "memory.conflict.updated",
    "outbox.created", "outbox.updated",
    "device.paired", "device.updated", "device.pairing-requested", "device.pairing-updated",
    "desktop.session.created", "desktop.session.updated", "desktop.frame.updated",
    "desktop.command.created", "desktop.command.updated"
  ];
  for (const name of eventNames) source.addEventListener(name, onEvent);
  return () => source.close();
}

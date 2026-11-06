import type {
  ApprovalDecisionResult,
  ApprovalListItem,
  ArtifactListItem,
  CreateTaskRequest,
  EventWindow,
  HealthResponse,
  RunListItem,
  RunManifest,
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
      "content-type": "application/json",
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
  templates: () => request<{ templates: TaskTemplate[] }>("/api/templates"),
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
    "approval.created", "approval.updated", "artifact.published", "effect.created", "effect.updated"
  ];
  for (const name of eventNames) source.addEventListener(name, onEvent);
  return () => source.close();
}

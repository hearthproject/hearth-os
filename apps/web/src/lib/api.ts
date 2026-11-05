import type { ArtifactListItem, CreateTaskRequest, HealthResponse, TaskRecord, TaskTemplate, TaskView } from "./types.ts";

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

export const api = {
  health: () => request<HealthResponse>("/api/health"),
  templates: () => request<{ templates: TaskTemplate[] }>("/api/templates"),
  tasks: () => request<{ tasks: TaskRecord[] }>("/api/tasks"),
  artifacts: () => request<{ artifacts: ArtifactListItem[] }>("/api/artifacts"),
  task: (id: string) => request<TaskView>(`/api/tasks/${encodeURIComponent(id)}`),
  createTask: (input: CreateTaskRequest) => request<TaskRecord>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  retry: (id: string) => request<TaskRecord>(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  cancel: (id: string) => request<TaskRecord>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  artifactUrl: (taskId: string, artifactId: string) =>
    `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`
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

import type {
  EvalTaskRequest,
  JudgeRequest,
  JudgeResponse
} from "@hearth/eval-core";

export class HearthClientError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "HearthClientError";
    this.code = code;
    this.status = status;
  }
}

export interface HearthTask {
  id: string;
  status: string;
  nextAction?: string | null;
  error?: { message?: string } | null;
  externalRef?: string | null;
  artifacts?: Array<{ relativePath: string; mimeType: string; bytes: number }>;
  runs?: Array<{ attempt: number; status: string; usage?: { inputTokens?: number; outputTokens?: number } | null }>;
  approvals?: unknown[];
  [key: string]: unknown;
}

export interface HearthTaskView {
  task: HearthTask;
  artifacts?: Array<{ relativePath: string; absolutePath: string; mimeType: string; bytes: number }>;
  runs?: Array<{ attempt: number; status: string; usage?: { inputTokens?: number; outputTokens?: number } | null }>;
  approvals?: unknown[];
  events?: unknown[];
}

export interface HearthClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class HearthClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HearthClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async createTask(body: EvalTaskRequest): Promise<{ task: HearthTask; created: boolean }> {
    return this.request("/api/eval/tasks", { method: "POST", body: JSON.stringify(body) });
  }

  async getTask(taskId: string): Promise<HearthTaskView> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}`);
  }

  async judge(body: JudgeRequest): Promise<JudgeResponse> {
    return this.request("/api/eval/judge", { method: "POST", body: JSON.stringify(body) });
  }

  async cancelTask(taskId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: "{}" });
  }

  async system(): Promise<Record<string, unknown>> {
    return this.request("/api/system");
  }

  async health(): Promise<Record<string, unknown>> {
    return this.request("/api/health");
  }

  async executors(): Promise<Record<string, unknown>> {
    return this.request("/api/executors");
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        signal: controller.signal
      });
      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) as unknown : null;
      } catch {
        payload = text;
      }
      if (!response.ok) {
        const record = asRecord(payload);
        throw new HearthClientError(
          typeof record?.error === "string" ? record.error : "HEARTH_HTTP_ERROR",
          typeof record?.message === "string" ? record.message : `Hearth 返回 HTTP ${response.status}`,
          response.status
        );
      }
      return payload as T;
    } catch (error) {
      if (error instanceof HearthClientError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new HearthClientError("HEARTH_TIMEOUT", `请求 Hearth 超时：${path}`);
      }
      throw new HearthClientError("HEARTH_UNREACHABLE", error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function isTerminalTaskStatus(status: string): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}

export function isWaitingTaskStatus(status: string): boolean {
  return ["waiting_input", "waiting_approval", "recoverable", "queued"].includes(status);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

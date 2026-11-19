import type { KnowledgeSettings } from "./settings.ts";

export type KnowledgeContextType = "memory" | "resource" | "skill";

export interface KnowledgeHit {
  uri: string;
  contextType: KnowledgeContextType | "unknown";
  level: number | null;
  score: number | null;
  abstract: string | null;
  tags: string[];
}

export interface KnowledgeFindInput {
  query: string;
  targetUri?: string;
  limit: number;
  timeoutMs: number;
  contextTypes?: KnowledgeContextType[];
  minScore?: number | null;
  levels?: number[];
}

export interface KnowledgeWriteInput {
  uri: string;
  content: string;
  mode?: "create" | "replace" | "append";
  processingMode?: "vectors_only" | "semantic_and_vectors";
  deferProcessing?: boolean;
  tags?: string[];
  wait?: boolean;
}

export type KnowledgeReindexMode = "vectors_only" | "semantic_and_vectors";

export interface KnowledgeHealth {
  ok: boolean;
  latencyMs: number;
  version: string | null;
  authMode: string | null;
  detail: string | null;
}

export interface KnowledgeClientOptions {
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  circuitThreshold?: number;
  circuitCooldownMs?: number;
  actorPeerId?: string;
}

export class KnowledgeClientError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 502) {
    super(message);
    this.name = "KnowledgeClientError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface RequestOptions {
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2500;

export class KnowledgeClient {
  private readonly settings: KnowledgeSettings;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;
  private readonly circuitThreshold: number;
  private readonly circuitCooldownMs: number;
  private readonly actorPeerId: string | null;
  private failures = 0;
  private openUntil = 0;

  constructor(settings: KnowledgeSettings, options: KnowledgeClientOptions = {}) {
    this.settings = settings;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? (() => new Date());
    this.circuitThreshold = options.circuitThreshold ?? 3;
    this.circuitCooldownMs = options.circuitCooldownMs ?? 60_000;
    this.actorPeerId = options.actorPeerId ?? null;
  }

  get baseUrl(): string {
    return this.settings.baseUrl.replace(/\/+$/, "");
  }

  get peerScope(): "actor" | "all" {
    return this.settings.recall.peerScope;
  }

  async health(): Promise<KnowledgeHealth> {
    const startedAt = this.clock().getTime();
    try {
      const payload = await this.rawRequest("GET", "/health", { timeoutMs: 2000 });
      const latencyMs = this.clock().getTime() - startedAt;
      const record = isRecord(payload) ? payload : {};
      return {
        ok: record.healthy !== false && record.status !== "error",
        latencyMs,
        version: typeof record.version === "string" ? record.version : null,
        authMode: typeof record.auth_mode === "string" ? record.auth_mode : null,
        detail: null
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: this.clock().getTime() - startedAt,
        version: null,
        authMode: null,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async find(input: KnowledgeFindInput): Promise<KnowledgeHit[]> {
    const body: Record<string, unknown> = {
      query: input.query,
      limit: input.limit,
      level: input.levels ?? [1, 2]
    };
    if (input.targetUri) body.target_uri = input.targetUri;
    if (input.contextTypes && input.contextTypes.length > 0) body.context_type = input.contextTypes;
    if (input.minScore !== null && input.minScore !== undefined) body.score_threshold = input.minScore;

    const result = await this.request("POST", "/api/v1/search/find", {
      body,
      timeoutMs: input.timeoutMs
    });
    return extractHits(result);
  }

  async read(uri: string, options: { timeoutMs?: number } = {}): Promise<string> {
    const result = await this.request("GET", "/api/v1/content/read", {
      query: { uri, offset: 0, limit: -1 },
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    });
    if (typeof result === "string") return result;
    if (isRecord(result) && typeof result.content === "string") return result.content;
    throw new KnowledgeClientError("KNOWLEDGE_BAD_RESPONSE", "读取结果不是文本");
  }

  async write(input: KnowledgeWriteInput): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      uri: input.uri,
      content: input.content,
      mode: input.mode ?? "create",
      processing_mode: input.processingMode ?? "vectors_only",
      wait: input.wait ?? false
    };
    if (input.deferProcessing !== undefined) body.defer_processing = input.deferProcessing;
    if (input.tags && input.tags.length > 0) {
      body.tags = input.tags;
      body.tag_mode = "replace";
    }
    const result = await this.request("POST", "/api/v1/content/write", {
      body,
      timeoutMs: 30_000
    });
    return isRecord(result) ? result : {};
  }

  async remove(uri: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.request("DELETE", "/api/v1/fs", {
      query: { uri, recursive: options.recursive ?? true, wait: false },
      timeoutMs: 10_000
    });
  }

  async reindex(
    uri: string,
    options: { mode?: KnowledgeReindexMode; wait?: boolean; recursive?: boolean } = {}
  ): Promise<Record<string, unknown>> {
    const result = await this.request("POST", "/api/v1/content/reindex", {
      body: {
        uri,
        mode: options.mode ?? "vectors_only",
        wait: options.wait ?? false,
        recursive: options.recursive ?? true
      },
      timeoutMs: 10_000
    });
    return isRecord(result) ? result : {};
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    if (this.openUntil > this.clock().getTime()) {
      throw new KnowledgeClientError("KNOWLEDGE_CIRCUIT_OPEN", "知识库连续失败，已暂停请求", 503);
    }
    try {
      const payload = await this.rawRequest(method, path, options);
      this.failures = 0;
      if (!isRecord(payload)) {
        throw new KnowledgeClientError("KNOWLEDGE_BAD_RESPONSE", "知识库返回格式异常");
      }
      if (payload.status === "error") {
        const error = isRecord(payload.error) ? payload.error : {};
        const message = typeof error.message === "string" ? error.message : "知识库返回错误";
        throw new KnowledgeClientError("KNOWLEDGE_BAD_RESPONSE", message, 502);
      }
      return ("result" in payload ? payload.result : payload) as T;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private async rawRequest(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: RequestOptions
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      if (this.settings.apiKey) headers["X-API-Key"] = this.settings.apiKey;
      if (this.peerScope === "actor" && this.actorPeerId) {
        headers["X-OpenViking-Actor-Peer"] = this.actorPeerId;
      }
      const response = await this.fetchImpl(url, {
        method,
        headers,
        signal: controller.signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
      });
      const text = await response.text();
      const json = text ? parseJson(text) : {};
      if (!response.ok) {
        const error = isRecord(json) && isRecord(json.error) ? json.error : {};
        const message =
          typeof error.message === "string" ? error.message : `知识库请求失败（HTTP ${response.status}）`;
        throw new KnowledgeClientError("KNOWLEDGE_BAD_RESPONSE", message, response.status);
      }
      return json;
    } catch (error) {
      if (error instanceof KnowledgeClientError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new KnowledgeClientError("KNOWLEDGE_TIMEOUT", "知识库请求超时", 504);
      }
      throw new KnowledgeClientError(
        "KNOWLEDGE_UNREACHABLE",
        error instanceof Error ? error.message : "知识库不可达",
        502
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.circuitThreshold) {
      this.openUntil = this.clock().getTime() + this.circuitCooldownMs;
      this.failures = 0;
    }
  }
}

function extractHits(payload: unknown): KnowledgeHit[] {
  if (!isRecord(payload)) return [];
  const groups: Array<[KnowledgeContextType, unknown]> = [
    ["memory", payload.memories],
    ["resource", payload.resources],
    ["skill", payload.skills]
  ];
  const hits: KnowledgeHit[] = [];
  const seen = new Set<string>();
  for (const [contextType, group] of groups) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      const hit = toHit(entry, contextType);
      if (!hit || seen.has(hit.uri)) continue;
      seen.add(hit.uri);
      hits.push(hit);
    }
  }
  return hits.sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
}

function toHit(entry: unknown, fallbackType: KnowledgeContextType): KnowledgeHit | null {
  if (!isRecord(entry)) return null;
  const uri = typeof entry.uri === "string" ? entry.uri : null;
  if (!uri) return null;
  const contextType =
    typeof entry.context_type === "string" && isContextType(entry.context_type)
      ? entry.context_type
      : fallbackType;
  return {
    uri,
    contextType,
    level: typeof entry.level === "number" ? entry.level : null,
    score: typeof entry.score === "number" ? entry.score : null,
    abstract: typeof entry.abstract === "string" && entry.abstract.trim() ? entry.abstract : null,
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : []
  };
}

function isContextType(value: string): value is KnowledgeContextType {
  return value === "memory" || value === "resource" || value === "skill";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

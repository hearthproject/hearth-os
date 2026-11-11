import type { AgentTool } from "@hearth/agent-runtime";
import type { WebSearchProvider, WebSearchResponse, WebSearchResult, WebSearchSettingsView } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";
import type { SecretBox } from "./secrets.ts";

const SETTINGS_KEY = "extensions.web-search.v1";
const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8888";
const MAX_RESULTS = 10;

interface StoredWebSearchSettings {
  enabled: boolean;
  provider: WebSearchProvider;
  tavilyApiKeyCipher: string | null;
  searxngUrl: string;
  updatedAt: string | null;
}

export interface WebSearchSettingsPatch {
  enabled?: boolean | undefined;
  provider?: WebSearchProvider | undefined;
  apiKey?: string | undefined;
  searxngUrl?: string | undefined;
}

export class WebSearchError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "WebSearchError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class WebSearchService {
  private readonly store: HearthStore;
  private readonly secretBox: SecretBox;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { store: HearthStore; secretBox: SecretBox; fetchImpl?: typeof fetch }) {
    this.store = options.store;
    this.secretBox = options.secretBox;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  view(): WebSearchSettingsView {
    const settings = this.stored();
    const apiKey = this.apiKey(settings);
    return {
      enabled: settings.enabled,
      provider: settings.provider,
      searxngUrl: settings.searxngUrl,
      hasApiKey: Boolean(apiKey),
      apiKeyMasked: maskKey(apiKey),
      updatedAt: settings.updatedAt
    };
  }

  update(patch: WebSearchSettingsPatch): WebSearchSettingsView {
    const current = this.stored();
    const provider = patch.provider ?? current.provider;
    if (provider !== "tavily" && provider !== "searxng") throw new WebSearchError("INVALID_SEARCH_PROVIDER", "不支持的搜索服务");
    const searxngUrl = patch.searxngUrl === undefined ? current.searxngUrl : normalizeSearchBaseUrl(patch.searxngUrl);
    let tavilyApiKeyCipher = current.tavilyApiKeyCipher;
    if (patch.apiKey !== undefined) {
      const key = patch.apiKey.trim();
      tavilyApiKeyCipher = key ? this.secretBox.encrypt(key) : null;
    }
    const next: StoredWebSearchSettings = {
      enabled: patch.enabled ?? current.enabled,
      provider,
      tavilyApiKeyCipher,
      searxngUrl,
      updatedAt: new Date().toISOString()
    };
    if (next.enabled && next.provider === "tavily" && !next.tavilyApiKeyCipher) {
      throw new WebSearchError("TAVILY_KEY_REQUIRED", "启用 Tavily 搜索前请先保存 API Key");
    }
    if (next.enabled && next.provider === "searxng" && !next.searxngUrl) {
      throw new WebSearchError("SEARXNG_URL_REQUIRED", "启用 SearXNG 搜索前请填写实例地址");
    }
    this.store.setAppSetting(SETTINGS_KEY, JSON.stringify(next), next.updatedAt ?? undefined);
    return this.view();
  }

  async search(query: string, options: { maxResults?: number; signal?: AbortSignal } = {}): Promise<WebSearchResponse> {
    const settings = this.stored();
    if (!settings.enabled) throw new WebSearchError("WEB_SEARCH_DISABLED", "网页搜索尚未启用，请先在设置中配置", 409);
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new WebSearchError("SEARCH_QUERY_REQUIRED", "搜索内容不能为空");
    if (normalizedQuery.length > 500) throw new WebSearchError("SEARCH_QUERY_TOO_LONG", "搜索内容不能超过 500 个字符");
    const maxResults = Math.min(MAX_RESULTS, Math.max(1, Math.trunc(options.maxResults ?? 5)));
    const results = settings.provider === "tavily"
      ? await this.searchTavily(normalizedQuery, maxResults, this.apiKey(settings), options.signal)
      : await this.searchSearxng(normalizedQuery, maxResults, settings.searxngUrl, options.signal);
    return { query: normalizedQuery, provider: settings.provider, results, fetchedAt: new Date().toISOString() };
  }

  tool(): AgentTool {
    const service = this;
    return {
      definition: {
        name: "web_search",
        description: "搜索公开网页资料并返回标题、链接和摘要。用于研究任务定位来源，随后可用 fetch_url 读取获批网页。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索问题或关键词" },
            maxResults: { type: "number", description: "最多返回多少条，默认 5，最大 10" }
          },
          required: ["query"],
          additionalProperties: false
        }
      },
      async execute(input, context) {
        if (!context.permissions.networkHosts.includes("*")) throw new Error("当前任务未获公共网络搜索权限");
        const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
        const query = typeof args.query === "string" ? args.query : "";
        const maxResults = Number(args.maxResults);
        const response = await service.search(query, {
          maxResults: Number.isFinite(maxResults) ? maxResults : 5,
          signal: context.signal
        });
        const content = response.results.map((result, index) => [
          `${index + 1}. ${result.title}`,
          result.url,
          result.snippet
        ].filter(Boolean).join("\n")).join("\n\n");
        return { content: content || `没有找到“${response.query}”的公开搜索结果` };
      }
    };
  }

  private stored(): StoredWebSearchSettings {
    const raw = this.store.getAppSetting(SETTINGS_KEY);
    if (!raw) return { enabled: false, provider: "tavily", tavilyApiKeyCipher: null, searxngUrl: DEFAULT_SEARXNG_URL, updatedAt: null };
    try {
      const parsed = JSON.parse(raw) as Partial<StoredWebSearchSettings>;
      return {
        enabled: parsed.enabled === true,
        provider: parsed.provider === "searxng" ? "searxng" : "tavily",
        tavilyApiKeyCipher: typeof parsed.tavilyApiKeyCipher === "string" ? parsed.tavilyApiKeyCipher : null,
        searxngUrl: normalizeSearchBaseUrl(typeof parsed.searxngUrl === "string" ? parsed.searxngUrl : DEFAULT_SEARXNG_URL),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
      };
    } catch {
      return { enabled: false, provider: "tavily", tavilyApiKeyCipher: null, searxngUrl: DEFAULT_SEARXNG_URL, updatedAt: null };
    }
  }

  private apiKey(settings: StoredWebSearchSettings): string {
    if (!settings.tavilyApiKeyCipher) return "";
    try {
      return this.secretBox.decrypt(settings.tavilyApiKeyCipher);
    } catch {
      return "";
    }
  }

  private async searchTavily(query: string, maxResults: number, apiKey: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
    if (!apiKey) throw new WebSearchError("TAVILY_KEY_REQUIRED", "Tavily API Key 尚未配置", 409);
    const response = await this.request("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, search_depth: "basic", include_answer: false }),
      ...(signal ? { signal } : {})
    });
    const payload = await response.json() as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> };
    return normalizeResults(payload.results ?? []).slice(0, maxResults);
  }

  private async searchSearxng(query: string, maxResults: number, baseUrl: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
    if (!baseUrl) throw new WebSearchError("SEARXNG_URL_REQUIRED", "SearXNG 实例地址尚未配置", 409);
    const url = new URL("search", `${baseUrl.replace(/\/$/, "")}/`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("safesearch", "1");
    url.searchParams.set("language", "zh-CN");
    const response = await this.request(url, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
    const payload = await response.json() as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> };
    return normalizeResults(payload.results ?? []).slice(0, maxResults);
  }

  private async request(url: string | URL, init: RequestInit): Promise<Response> {
    try {
      const response = await this.fetchImpl(url, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(20_000) });
      if (!response.ok) throw new WebSearchError("SEARCH_HTTP_ERROR", `搜索服务返回 HTTP ${response.status}`, 502);
      return response;
    } catch (error) {
      if (error instanceof WebSearchError) throw error;
      throw new WebSearchError("SEARCH_UNAVAILABLE", `搜索服务不可用：${error instanceof Error ? error.message : String(error)}`, 502);
    }
  }
}

function normalizeResults(values: Array<{ title?: unknown; url?: unknown; content?: unknown }>): WebSearchResult[] {
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const value of values) {
    if (typeof value.url !== "string") continue;
    let url: URL;
    try {
      url = new URL(value.url);
    } catch {
      continue;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) continue;
    const normalized = url.href;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    results.push({
      title: cleanText(typeof value.title === "string" ? value.title : url.hostname, 200) || url.hostname,
      url: normalized,
      snippet: cleanText(typeof value.content === "string" ? value.content : "", 500)
    });
  }
  return results;
}

function cleanText(value: string, max: number): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeSearchBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new WebSearchError("INVALID_SEARXNG_URL", "SearXNG 地址格式不正确");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebSearchError("INVALID_SEARXNG_URL", "SearXNG 只支持 http 或 https 地址");
  if (url.username || url.password) throw new WebSearchError("INVALID_SEARXNG_URL", "SearXNG 地址不能包含用户名或密码");
  return url.href.replace(/\/$/, "");
}

function maskKey(value: string): string | null {
  if (!value) return null;
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 2)}••••${value.slice(-4)}`;
}

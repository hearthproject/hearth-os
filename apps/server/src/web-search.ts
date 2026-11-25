import { load as loadHtml } from "cheerio";
import { fetchWebSnapshot, type AgentTool, type FetchWebOptions } from "@hearth/agent-runtime";
import type {
  WebSearchProvider,
  WebSearchResponse,
  WebSearchResult,
  WebSearchSettingsView,
  WebSearchSource
} from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";
import type { SecretBox } from "./secrets.ts";

const SETTINGS_KEY = "extensions.web-search.v1";
const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8888";
const MAX_RESULTS = 10;
const MAX_QUERY_CHARS = 500;
const MAX_READ_TOP = 3;
const SEARCH_TIMEOUT_MS = 20_000;

interface StoredWebSearchSettings {
  version: 2;
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

export interface BrowserSearchFallback {
  search(query: string, maxResults: number, signal?: AbortSignal): Promise<Array<Omit<WebSearchResult, "rank">>>;
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

/**
 * Search is a built-in capability. The legacy Tavily and SearXNG settings are
 * still honoured for existing installations, while fresh installations use
 * public feeds and optional browser fallback without asking for credentials.
 */
export class WebSearchService {
  private readonly store: HearthStore;
  private readonly secretBox: SecretBox;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveHost: FetchWebOptions["resolveHost"] | undefined;
  private browserFallback: BrowserSearchFallback | null = null;

  constructor(options: {
    store: HearthStore;
    secretBox: SecretBox;
    fetchImpl?: typeof fetch;
    resolveHost?: FetchWebOptions["resolveHost"];
  }) {
    this.store = options.store;
    this.secretBox = options.secretBox;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolveHost = options.resolveHost;
  }

  setBrowserFallback(fallback: BrowserSearchFallback | null): void {
    this.browserFallback = fallback;
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
    if (provider !== "auto" && provider !== "tavily" && provider !== "searxng") {
      throw new WebSearchError("INVALID_SEARCH_PROVIDER", "不支持的搜索服务");
    }
    const searxngUrl = patch.searxngUrl === undefined ? current.searxngUrl : normalizeSearchBaseUrl(patch.searxngUrl);
    let tavilyApiKeyCipher = current.tavilyApiKeyCipher;
    if (patch.apiKey !== undefined) {
      const key = patch.apiKey.trim();
      tavilyApiKeyCipher = key ? this.secretBox.encrypt(key) : null;
    }
    const next: StoredWebSearchSettings = {
      version: 2,
      enabled: patch.enabled ?? current.enabled,
      provider,
      tavilyApiKeyCipher,
      searxngUrl,
      updatedAt: new Date().toISOString()
    };
    if (next.enabled && next.provider === "tavily" && !next.tavilyApiKeyCipher) {
      throw new WebSearchError("TAVILY_KEY_REQUIRED", "选择 Tavily 优先搜索前请先保存 API Key");
    }
    if (next.enabled && next.provider === "searxng" && !next.searxngUrl) {
      throw new WebSearchError("SEARXNG_URL_REQUIRED", "选择 SearXNG 优先搜索前请填写实例地址");
    }
    this.store.setAppSetting(SETTINGS_KEY, JSON.stringify(next), next.updatedAt ?? undefined);
    return this.view();
  }

  async search(query: string, options: { maxResults?: number; signal?: AbortSignal } = {}): Promise<WebSearchResponse> {
    const settings = this.stored();
    if (!settings.enabled) {
      throw new WebSearchError("WEB_SEARCH_DISABLED", "网页搜索已通过环境变量停用", 409);
    }
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new WebSearchError("SEARCH_QUERY_REQUIRED", "搜索内容不能为空");
    if (normalizedQuery.length > MAX_QUERY_CHARS) {
      throw new WebSearchError("SEARCH_QUERY_TOO_LONG", `搜索内容不能超过 ${MAX_QUERY_CHARS} 个字符`);
    }
    const maxResults = Math.min(MAX_RESULTS, Math.max(1, Math.trunc(options.maxResults ?? 5)));
    const providers = this.providerOrder(settings);
    const attemptedProviders: WebSearchSource[] = [];
    const failures: string[] = [];
    for (const provider of providers) {
      attemptedProviders.push(provider);
      try {
        const raw = await this.searchProvider(provider, settings, normalizedQuery, maxResults, options.signal);
        const results = rankResults(raw, maxResults);
        if (results.length > 0) {
          return {
            query: normalizedQuery,
            provider,
            attemptedProviders,
            results,
            fetchedAt: new Date().toISOString()
          };
        }
        failures.push(`${provider}: 没有结果`);
      } catch (error) {
        failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new WebSearchError(
      "SEARCH_UNAVAILABLE",
      `内置搜索暂时不可用（${failures.join("；").slice(0, 800)}）`,
      502
    );
  }

  tool(): AgentTool {
    const service = this;
    return {
      definition: {
        name: "web_search",
        description: "搜索公开网页资料并返回带序号、标题、链接和摘要的来源。可设置 readTop 直接读取前几条正文，避免只凭搜索摘要回答。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索问题或关键词" },
            maxResults: { type: "number", description: `最多返回多少条，默认 5，最大 ${MAX_RESULTS}` },
            readTop: { type: "number", description: `同时读取前几条结果的正文，最多 ${MAX_READ_TOP} 条` }
          },
          required: ["query"],
          additionalProperties: false
        },
        executionMode: "sequential",
        timeoutMs: 120_000
      },
      async execute(input, context) {
        if (!context.permissions.networkHosts.includes("*")) throw new Error("当前任务未获公共网络搜索权限");
        const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
        const query = typeof args.query === "string" ? args.query : "";
        const maxResultsValue = Number(args.maxResults);
        const readTopValue = Number(args.readTop);
        const response = await service.search(query, {
          maxResults: Number.isFinite(maxResultsValue) ? maxResultsValue : 5,
          signal: context.signal
        });
        const readTop = Number.isFinite(readTopValue)
          ? Math.min(MAX_READ_TOP, Math.max(0, Math.trunc(readTopValue)))
          : 0;
        const sections = response.results.map((result) => [
          `${result.rank}. ${result.title}`,
          result.url,
          result.publishedAt ? `发布时间：${result.publishedAt}` : "",
          result.snippet
        ].filter(Boolean).join("\n"));
        for (const result of response.results.slice(0, readTop)) {
          try {
            const snapshot = await fetchWebSnapshot(result.url, {
              allowedHosts: context.permissions.networkHosts,
              maxChars: 12_000,
              signal: context.signal,
              fetchImpl: service.fetchImpl,
              ...(service.resolveHost ? { resolveHost: service.resolveHost } : {})
            });
            sections.push([
              `### 正文 ${result.rank}：${snapshot.title || result.title}`,
              snapshot.finalUrl,
              snapshot.markdown
            ].join("\n"));
          } catch (error) {
            sections.push(`### 正文 ${result.rank} 读取失败\n${result.url}\n${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const content = sections.join("\n\n");
        return {
          content: content || `没有找到“${response.query}”的公开搜索结果`,
          metadata: { provider: response.provider, attemptedProviders: response.attemptedProviders, count: response.results.length }
        };
      }
    };
  }

  private providerOrder(settings: StoredWebSearchSettings): WebSearchSource[] {
    const order: WebSearchSource[] = [];
    if (settings.provider === "tavily" && this.apiKey(settings)) order.push("tavily");
    if (settings.provider === "searxng" && settings.searxngUrl) order.push("searxng");
    if (process.env.HEARTH_SEARCH_RELAY_URL?.trim()) order.push("relay");
    order.push("bing-rss", "duckduckgo");
    if (this.browserFallback) order.push("browser");
    return [...new Set(order)];
  }

  private async searchProvider(
    provider: WebSearchSource,
    settings: StoredWebSearchSettings,
    query: string,
    maxResults: number,
    signal?: AbortSignal
  ): Promise<Array<Omit<WebSearchResult, "rank">>> {
    switch (provider) {
      case "tavily": return this.searchTavily(query, maxResults, this.apiKey(settings), signal);
      case "searxng": return this.searchSearxng(query, maxResults, settings.searxngUrl, signal);
      case "relay": return this.searchRelay(query, maxResults, signal);
      case "bing-rss": return this.searchBingRss(query, maxResults, signal);
      case "duckduckgo": return this.searchDuckDuckGo(query, maxResults, signal);
      case "browser":
        if (!this.browserFallback) return [];
        return this.browserFallback.search(query, maxResults, signal);
    }
  }

  private stored(): StoredWebSearchSettings {
    const environmentEnabled = process.env.HEARTH_WEB_SEARCH !== "0";
    const raw = this.store.getAppSetting(SETTINGS_KEY);
    if (!raw) return defaultSettings(environmentEnabled);
    try {
      const parsed = JSON.parse(raw) as Partial<StoredWebSearchSettings>;
      const schemaVersion = parsed.version === 2 ? 2 : 1;
      return {
        version: 2,
        enabled: environmentEnabled && (schemaVersion === 2 ? parsed.enabled !== false : true),
        provider: parsed.provider === "tavily" || parsed.provider === "searxng" ? parsed.provider : "auto",
        tavilyApiKeyCipher: typeof parsed.tavilyApiKeyCipher === "string" ? parsed.tavilyApiKeyCipher : null,
        searxngUrl: normalizeSearchBaseUrl(typeof parsed.searxngUrl === "string" ? parsed.searxngUrl : DEFAULT_SEARXNG_URL),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
      };
    } catch {
      return defaultSettings(environmentEnabled);
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

  private async searchTavily(
    query: string,
    maxResults: number,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<Array<Omit<WebSearchResult, "rank">>> {
    if (!apiKey) throw new WebSearchError("TAVILY_KEY_REQUIRED", "Tavily API Key 尚未配置", 409);
    const response = await this.request("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, search_depth: "basic", include_answer: false }),
      ...(signal ? { signal } : {})
    });
    const payload = await response.json() as { results?: unknown[] };
    return normalizeJsonResults(payload.results ?? []);
  }

  private async searchSearxng(
    query: string,
    maxResults: number,
    baseUrl: string,
    signal?: AbortSignal
  ): Promise<Array<Omit<WebSearchResult, "rank">>> {
    if (!baseUrl) throw new WebSearchError("SEARXNG_URL_REQUIRED", "SearXNG 实例地址尚未配置", 409);
    const url = new URL("search", `${baseUrl.replace(/\/$/, "")}/`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("safesearch", "1");
    url.searchParams.set("language", "zh-CN");
    const response = await this.request(url, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
    const payload = await response.json() as { results?: unknown[] };
    return normalizeJsonResults(payload.results ?? []);
  }

  private async searchRelay(
    query: string,
    maxResults: number,
    signal?: AbortSignal
  ): Promise<Array<Omit<WebSearchResult, "rank">>> {
    const raw = process.env.HEARTH_SEARCH_RELAY_URL?.trim();
    if (!raw) return [];
    const url = new URL(raw);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(maxResults));
    const response = await this.request(url, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
    const payload = await response.json() as { results?: unknown[]; web?: { results?: unknown[] } };
    return normalizeJsonResults(payload.results ?? payload.web?.results ?? []);
  }

  private async searchBingRss(
    query: string,
    _maxResults: number,
    signal?: AbortSignal
  ): Promise<Array<Omit<WebSearchResult, "rank">>> {
    const url = new URL("https://www.bing.com/search");
    url.searchParams.set("format", "rss");
    url.searchParams.set("q", query);
    const response = await this.request(url, {
      headers: { accept: "application/rss+xml,text/xml,application/xml;q=0.9" },
      ...(signal ? { signal } : {})
    });
    const xml = await response.text();
    const $ = loadHtml(xml, { xmlMode: true });
    const results: Array<Omit<WebSearchResult, "rank">> = [];
    $("item").each((_index, item) => {
      const node = $(item);
      const urlValue = node.find("link").first().text().trim() || node.find("guid").first().text().trim();
      const published = node.find("pubDate").first().text().trim();
      results.push({
        title: cleanText(node.find("title").first().text(), 200) || hostnameOf(urlValue),
        url: urlValue,
        snippet: cleanText(node.find("description").first().text(), 500),
        ...(published ? { publishedAt: published.slice(0, 100) } : {})
      });
    });
    return results;
  }

  private async searchDuckDuckGo(
    query: string,
    _maxResults: number,
    signal?: AbortSignal
  ): Promise<Array<Omit<WebSearchResult, "rank">>> {
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", query);
    const response = await this.request(url, {
      headers: { accept: "text/html,application/xhtml+xml" },
      ...(signal ? { signal } : {})
    });
    const $ = loadHtml(await response.text());
    const results: Array<Omit<WebSearchResult, "rank">> = [];
    $(".result").each((_index, item) => {
      const node = $(item);
      const link = node.find(".result__a").first();
      const href = unwrapDuckDuckGoUrl(link.attr("href") ?? "");
      if (!href) return;
      results.push({
        title: cleanText(link.text(), 200) || hostnameOf(href),
        url: href,
        snippet: cleanText(node.find(".result__snippet").first().text(), 500)
      });
    });
    return results;
  }

  private async request(url: string | URL, init: RequestInit): Promise<Response> {
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: init.signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS)
      });
      if (!response.ok) throw new WebSearchError("SEARCH_HTTP_ERROR", `搜索服务返回 HTTP ${response.status}`, 502);
      return response;
    } catch (error) {
      if (error instanceof WebSearchError) throw error;
      throw new WebSearchError(
        "SEARCH_UNAVAILABLE",
        `搜索服务不可用：${error instanceof Error ? error.message : String(error)}`,
        502
      );
    }
  }
}

function defaultSettings(enabled: boolean): StoredWebSearchSettings {
  return {
    version: 2,
    enabled,
    provider: "auto",
    tavilyApiKeyCipher: null,
    searxngUrl: DEFAULT_SEARXNG_URL,
    updatedAt: null
  };
}

function rankResults(values: Array<Omit<WebSearchResult, "rank">>, maxResults: number): WebSearchResult[] {
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const value of values) {
    const cleaned = normalizeResult(value);
    if (!cleaned || seen.has(cleaned.url)) continue;
    seen.add(cleaned.url);
    results.push({ rank: results.length + 1, ...cleaned });
    if (results.length >= maxResults) break;
  }
  return results;
}

function normalizeJsonResults(values: unknown[]): Array<Omit<WebSearchResult, "rank">> {
  const results: Array<Omit<WebSearchResult, "rank">> = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const url = stringValue(record.url) || stringValue(record.href) || stringValue(record.link);
    const title = stringValue(record.title) || stringValue(record.name) || hostnameOf(url);
    const snippet = stringValue(record.content)
      || stringValue(record.snippet)
      || stringValue(record.description)
      || stringValue(record.text);
    const publishedAt = stringValue(record.publishedAt)
      || stringValue(record.published_at)
      || stringValue(record.published)
      || stringValue(record.date);
    results.push({
      title: cleanText(title, 200),
      url,
      snippet: cleanText(snippet, 500),
      ...(publishedAt ? { publishedAt: publishedAt.slice(0, 100) } : {})
    });
  }
  return results;
}

function normalizeResult(value: Omit<WebSearchResult, "rank">): Omit<WebSearchResult, "rank"> | null {
  if (typeof value.url !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  url.hash = "";
  return {
    title: cleanText(value.title, 200) || url.hostname,
    url: url.href,
    snippet: cleanText(value.snippet, 500),
    ...(value.publishedAt ? { publishedAt: value.publishedAt } : {})
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cleanText(value: string, max: number): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
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
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebSearchError("INVALID_SEARXNG_URL", "SearXNG 只支持 http 或 https 地址");
  }
  if (url.username || url.password) {
    throw new WebSearchError("INVALID_SEARXNG_URL", "SearXNG 地址不能包含用户名或密码");
  }
  return url.href.replace(/\/$/, "");
}

function unwrapDuckDuckGoUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value, "https://duckduckgo.com");
    const wrapped = url.searchParams.get("uddg");
    return wrapped ? decodeURIComponent(wrapped) : url.href;
  } catch {
    return "";
  }
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function maskKey(value: string): string | null {
  if (!value) return null;
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 2)}••••${value.slice(-4)}`;
}

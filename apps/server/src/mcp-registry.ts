import type {
  McpRegistryCandidate,
  McpRegistrySearchView,
  McpRegistryVariable,
  McpTransport
} from "@hearth/core";

const DEFAULT_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";
const MAX_SEARCH_RESULTS = 30;
const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  expiresAt: number;
  value: McpRegistrySearchView;
}

export class McpRegistryError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "McpRegistryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Read-only client for the official MCP Registry, with safe candidate normalization. */
export class McpRegistryClient {
  private readonly fetchImpl: typeof fetch;
  private readonly registryUrl: string;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: { fetchImpl?: typeof fetch; registryUrl?: string } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.registryUrl = normalizeRegistryUrl(options.registryUrl ?? process.env.HEARTH_MCP_REGISTRY_URL ?? DEFAULT_REGISTRY_URL);
  }

  async search(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<McpRegistrySearchView> {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length > 200) throw new McpRegistryError("MCP_REGISTRY_QUERY_TOO_LONG", "搜索词不能超过 200 个字符");
    const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.trunc(options.limit ?? 20)));
    const cacheKey = `${normalizedQuery.toLocaleLowerCase()}:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const url = new URL(this.registryUrl);
    if (normalizedQuery) url.searchParams.set("search", normalizedQuery);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("version", "latest");
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": "Hearth/0.6 MCP registry client" },
        redirect: "error",
        signal: options.signal ?? AbortSignal.timeout(20_000)
      });
    } catch (error) {
      throw new McpRegistryError(
        "MCP_REGISTRY_UNAVAILABLE",
        `MCP Registry 无法访问：${error instanceof Error ? error.message : String(error)}`,
        502
      );
    }
    if (!response.ok) {
      throw new McpRegistryError("MCP_REGISTRY_HTTP_ERROR", `MCP Registry 返回 HTTP ${response.status}`, 502);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new McpRegistryError("MCP_REGISTRY_INVALID_RESPONSE", "MCP Registry 返回了无法解析的数据", 502);
    }
    const candidates = normalizeRegistryResponse(payload);
    const value: McpRegistrySearchView = {
      query: normalizedQuery,
      candidates,
      total: candidates.length,
      registryUrl: this.registryUrl,
      fetchedAt: new Date().toISOString()
    };
    this.cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  }

  async find(serverName: string, signal?: AbortSignal): Promise<McpRegistryCandidate> {
    const clean = serverName.trim();
    if (!clean) throw new McpRegistryError("MCP_REGISTRY_SERVER_REQUIRED", "请选择要安装的 MCP 服务器");
    const result = await this.search(clean, { limit: MAX_SEARCH_RESULTS, ...(signal ? { signal } : {}) });
    const exact = result.candidates.find((candidate) => candidate.serverName === clean);
    if (!exact) throw new McpRegistryError("MCP_REGISTRY_SERVER_NOT_FOUND", `Registry 中找不到“${clean}”`, 404);
    return exact;
  }
}

export function normalizeRegistryResponse(payload: unknown): McpRegistryCandidate[] {
  const wrappers = payload && typeof payload === "object" && Array.isArray((payload as { servers?: unknown }).servers)
    ? (payload as { servers: unknown[] }).servers
    : Array.isArray(payload)
      ? payload
      : [];
  const candidates: McpRegistryCandidate[] = [];
  const seen = new Set<string>();
  for (const wrapper of wrappers) {
    const record = wrapper && typeof wrapper === "object"
      ? (wrapper as Record<string, unknown>).server ?? wrapper
      : null;
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const candidate = normalizeRegistryServer(record as Record<string, unknown>);
    if (!candidate || seen.has(`${candidate.serverName}:${candidate.version}`)) continue;
    seen.add(`${candidate.serverName}:${candidate.version}`);
    candidates.push(candidate);
  }
  return candidates;
}

function normalizeRegistryServer(server: Record<string, unknown>): McpRegistryCandidate | null {
  const serverName = stringValue(server.name).trim();
  if (!serverName || serverName.length > 200) return null;
  const version = stringValue(server.version).trim() || "latest";
  const packages = arrayValue(server.packages);
  const remotes = arrayValue(server.remotes);
  const npm = packages.find((item) => item.registryType === "npm");
  const pypi = packages.find((item) => item.registryType === "pypi");
  const pkg = npm ?? pypi ?? null;
  const remote = remotes.find((item) => item.type === "streamable-http" && typeof item.url === "string" && item.url.trim());
  let transport: McpTransport = "stdio";
  let runtime = "unsupported";
  let command = "";
  let args: string[] = [];
  let url: string | null = null;
  let packageName: string | null = null;
  let packageVersion: string | null = null;
  let envVariables: McpRegistryVariable[] = [];
  let headerVariables: McpRegistryVariable[] = [];
  let unsupportedReason: string | null = null;

  if (pkg) {
    const runtimeHint = stringValue(pkg.runtimeHint).trim().toLocaleLowerCase();
    const identifier = stringValue(pkg.identifier).trim();
    const pkgVersion = stringValue(pkg.version).trim() || version;
    if (identifier && (pkg.registryType === "npm" || (pkg.registryType === "pypi" && runtimeHint === "uvx"))) {
      runtime = pkg.registryType === "npm" ? "npx" : "uvx";
      command = runtime;
      packageName = identifier;
      packageVersion = pkgVersion;
      const runtimeArgs = normalizeArguments(pkg.runtimeArguments);
      const packageArgs = normalizeArguments(pkg.packageArguments);
      const packageSpec = runtime === "npx" ? `${identifier}@${pkgVersion}` : `${identifier}==${pkgVersion}`;
      args = [...runtimeArgs, packageSpec, ...packageArgs];
    } else {
      unsupportedReason = pkg.registryType === "pypi"
        ? "这个 Python 包没有声明 uvx 启动方式"
        : `暂不支持 ${stringValue(pkg.registryType) || "未知"} 安装包`;
    }
    envVariables = normalizeVariables(pkg.environmentVariables);
  } else if (remote) {
    transport = "streamable-http";
    runtime = "remote";
    url = String(remote.url);
    headerVariables = normalizeVariables(remote.headers);
  } else if (remotes.some((item) => item.type === "sse")) {
    unsupportedReason = "这个服务只提供旧版 SSE 传输，Hearth 当前使用 Streamable HTTP";
  } else {
    unsupportedReason = "Registry 条目没有可用的 npm、uvx 或 Streamable HTTP 入口";
  }

  return {
    serverName,
    title: stringValue(server.title).trim() || serverName,
    description: stringValue(server.description).trim().slice(0, 2_000),
    version,
    transport,
    runtime,
    packageName,
    packageVersion,
    command,
    args,
    url,
    requiredEnv: envVariables.filter((item) => item.required).map((item) => item.name),
    requiredHeaders: headerVariables.filter((item) => item.required).map((item) => item.name),
    envVariables,
    headerVariables,
    homepage: stringValue(server.websiteUrl) || null,
    repositoryUrl: recordValue(server.repository)?.url ? String(recordValue(server.repository)?.url) : null,
    installable: !unsupportedReason,
    unsupportedReason
  };
}

function normalizeArguments(value: unknown): string[] {
  const args: string[] = [];
  for (const entry of arrayValue(value)) {
    const type = stringValue(entry.type);
    const name = stringValue(entry.name).trim();
    const rawValue = stringValue(entry.value);
    if (type === "named" && name) {
      args.push(rawValue ? `--${name}=${rawValue}` : `--${name}`);
    } else if (type === "positional" && rawValue) {
      args.push(rawValue);
    }
  }
  return args;
}

function normalizeVariables(value: unknown): McpRegistryVariable[] {
  return arrayValue(value).flatMap((entry) => {
    const name = stringValue(entry.name).trim();
    if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) return [];
    return [{
      name,
      description: stringValue(entry.description).trim().slice(0, 1_000),
      required: entry.isRequired === true,
      secret: entry.isSecret === true,
      placeholder: stringValue(entry.placeholder) || null,
      defaultValue: stringValue(entry.default) || null
    }];
  });
}

function arrayValue(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeRegistryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpRegistryError("MCP_REGISTRY_URL_INVALID", "MCP Registry 地址不合法");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new McpRegistryError("MCP_REGISTRY_URL_INVALID", "MCP Registry 必须使用 HTTPS，本机调试地址除外");
  }
  if (url.username || url.password) throw new McpRegistryError("MCP_REGISTRY_URL_INVALID", "MCP Registry 地址不能包含凭据");
  url.hash = "";
  return url.href;
}

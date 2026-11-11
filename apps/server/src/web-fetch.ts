import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { extractMarkdown } from "@hearth/agent-runtime";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export interface WebSnapshot {
  requestedUrl: string;
  finalUrl: string;
  fetchedAt: string;
  status: number;
  contentType: string;
  title: string;
  markdown: string;
  bytes: number;
  sha256: string;
}

export interface FetchWebOptions {
  allowedHosts: string[];
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<Array<{ address: string; family: number }>>;
}

export class WebInputError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly finalUrl: string | null;

  constructor(code: string, message: string, details: { status?: number; finalUrl?: string } = {}) {
    super(message);
    this.name = "WebInputError";
    this.code = code;
    this.status = details.status ?? null;
    this.finalUrl = details.finalUrl ?? null;
  }
}

export async function fetchWebSnapshot(rawUrl: string, options: FetchWebOptions): Promise<WebSnapshot> {
  const allowedHosts = new Set(options.allowedHosts.map(normalizeHost));
  const fetchImpl = options.fetchImpl ?? fetch;
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new WebInputError("invalid_url", `网页地址无效：${rawUrl}`);
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertSafeUrl(current, allowedHosts, options);
    const response = await fetchWithTimeout(fetchImpl, current, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new WebInputError("bad_redirect", `网页返回 ${response.status} 但没有跳转地址：${current.href}`);
      if (redirects === MAX_REDIRECTS) throw new WebInputError("too_many_redirects", `网页跳转超过 ${MAX_REDIRECTS} 次：${rawUrl}`);
      current = new URL(location, current);
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new WebInputError("http_error", `网页返回 HTTP ${response.status}：${current.href}`, {
        status: response.status,
        finalUrl: current.href
      });
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/^(text\/html|application\/xhtml\+xml|text\/plain)(;|$)/i.test(contentType)) {
      await response.body?.cancel();
      throw new WebInputError("unsupported_content_type", `网页内容类型不支持：${contentType || "未知"}`);
    }

    const bytes = await readLimited(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
    const html = decodeBody(bytes, contentType);
    if (isChallengePage(html)) {
      throw new WebInputError("access_challenge", `网页要求登录、验证码或浏览器验证：${current.href}`, {
        status: response.status,
        finalUrl: current.href
      });
    }
    const extracted = extractMarkdown(html, current.href);
    if (!extracted.markdown) throw new WebInputError("empty_content", `网页没有可提取的正文：${current.href}`);

    return {
      requestedUrl: rawUrl,
      finalUrl: current.href,
      fetchedAt: new Date().toISOString(),
      status: response.status,
      contentType: contentType || "text/html",
      title: extracted.title,
      markdown: extracted.markdown,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  }

  throw new WebInputError("too_many_redirects", `网页跳转超过 ${MAX_REDIRECTS} 次：${rawUrl}`);
}

async function assertSafeUrl(url: URL, allowedHosts: Set<string>, options: FetchWebOptions): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebInputError("unsupported_protocol", `只允许 http/https 网页：${url.href}`);
  }
  if (url.username || url.password) {
    throw new WebInputError("credentials_in_url", `网页地址不能包含用户名或密码：${url.href}`);
  }
  const host = normalizeHost(url.hostname);
  if (!allowedHosts.has(host)) {
    throw new WebInputError("host_not_allowed", `网页主机不在任务白名单中：${host}`);
  }
  if (options.allowPrivate) return;
  if (isForbiddenHostname(host)) throw new WebInputError("private_host", `不允许访问本机或内网主机：${host}`);

  if (isIP(host)) {
    assertPublicAddress(host);
    return;
  }

  const addresses = options.resolveHost ? await options.resolveHost(host) : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0) throw new WebInputError("dns_error", `无法解析网页主机：${host}`);
  for (const address of addresses) assertPublicAddress(address.address);
}

function assertPublicAddress(address: string): void {
  if (isPrivateAddress(address)) {
    throw new WebInputError("private_address", `网页解析到了内网地址：${address}`);
  }
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const a = octets[0] ?? 0;
    const b = octets[1] ?? 0;
    const c = octets[2] ?? 0;
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  if (version === 6) {
    const value = address.toLowerCase();
    if (value === "::" || value === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(value)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(value)) return true;
    if (/^ff[0-9a-f]{2}:/.test(value)) return true;
    if (value.startsWith("2001:db8:")) return true;
    if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
  }
  return false;
}

function isForbiddenHostname(host: string): boolean {
  return host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
    || host.endsWith(".home.arpa")
    || host === "metadata.google.internal";
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: URL, timeoutMs: number): Promise<Response> {
  try {
    return await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent": "Hearth/0.1 (+local task runner)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1"
      }
    });
  } catch (error) {
    if (error instanceof WebInputError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new WebInputError("fetch_failed", `网页访问失败：${url.href}（${message}）`);
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WebInputError("too_large", `网页超过大小限制：${declared} bytes`);
  }
  if (!response.body) throw new WebInputError("empty_body", "网页响应没有正文");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new WebInputError("too_large", `网页超过大小限制：${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([^;"'\s]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function normalizeHost(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

function isChallengePage(html: string): boolean {
  const sample = html.slice(0, 80_000);
  return /<input[^>]+type=["']password["']/i.test(sample)
    || /just a moment\.\.\./i.test(sample)
    || /enable javascript and cookies to continue/i.test(sample)
    || /cf-chl-|captcha|verify you are human/i.test(sample);
}

export { extractMarkdown };

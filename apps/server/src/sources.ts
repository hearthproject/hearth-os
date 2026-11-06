import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  SourceConnection,
  SourceCoverage,
  SourceError,
  SourceItem,
  SourceKind
} from "@hearth/core";
import { SOURCE_KINDS } from "@hearth/core";
import { fetchWebSnapshot, WebInputError, type WebSnapshot } from "./web-fetch.ts";
import type { HearthService } from "./service.ts";

const MAX_FILES = 2_000;
const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".csv", ".json", ".html", ".htm"]);

export interface SourceRegistryOptions {
  contentRoot: string;
  webFetch?: typeof fetchWebSnapshot;
  now?: () => Date;
}

export interface CreateSourceInput {
  kind: SourceKind;
  displayName?: string | undefined;
  rootPath?: string | undefined;
  allowedHosts?: string[] | undefined;
  account?: string | undefined;
}

export interface ReadSourceInput {
  url?: string | undefined;
}

export interface SourceReadResult {
  source: SourceConnection;
  items: SourceItem[];
  changed: number;
}

export class SourceRegistryError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "SourceRegistryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class SourceRegistry {
  private readonly service: HearthService;
  private readonly contentRoot: string;
  private readonly webFetch: typeof fetchWebSnapshot;
  private readonly now: () => Date;

  constructor(service: HearthService, options: SourceRegistryOptions) {
    this.service = service;
    this.contentRoot = resolve(options.contentRoot);
    this.webFetch = options.webFetch ?? fetchWebSnapshot;
    this.now = options.now ?? (() => new Date());
  }

  list(): SourceConnection[] {
    return this.service.store.listSources();
  }

  get(id: string): SourceConnection {
    const source = this.service.store.getSource(id);
    if (!source) throw new SourceRegistryError("SOURCE_NOT_FOUND", "来源不存在", 404);
    return source;
  }

  items(id: string): SourceItem[] {
    this.get(id);
    return this.service.store.listSourceItems(id);
  }

  getItem(itemId: string): SourceItem {
    const item = this.service.store.getSourceItem(itemId);
    if (!item) throw new SourceRegistryError("SOURCE_ITEM_NOT_FOUND", "来源条目不存在", 404);
    return item;
  }

  create(input: CreateSourceInput): SourceConnection {
    if (!SOURCE_KINDS.includes(input.kind)) throw new SourceRegistryError("INVALID_SOURCE_KIND", "来源类型不受支持");
    const now = this.timestamp();
    let provider: string;
    let rootPath: string | null = null;
    let allowedHosts: string[] = [];
    let status: SourceConnection["status"] = "connected";
    let lastError: SourceError | null = null;
    let displayName = input.displayName?.trim();

    if (input.kind === "file" || input.kind === "knowledge") {
      if (!input.rootPath?.trim()) throw new SourceRegistryError("ROOT_PATH_REQUIRED", "本地来源必须填写目录或文件路径");
      const canonical = canonicalLocalRoot(input.rootPath);
      rootPath = canonical.path;
      provider = input.kind === "file" ? "local-files" : "local-knowledge";
      displayName ||= canonical.name;
    } else if (input.kind === "web") {
      allowedHosts = normalizeHosts(input.allowedHosts ?? []);
      if (allowedHosts.length === 0) throw new SourceRegistryError("ALLOWED_HOSTS_REQUIRED", "网页来源至少要允许一个主机");
      provider = "public-web";
      displayName ||= `网页 · ${allowedHosts.slice(0, 3).join("、")}`;
    } else {
      provider = "unconfigured";
      status = "needs_user";
      lastError = {
        code: "credentials_required",
        message: input.kind === "email" ? "尚未配置邮件账户凭据，不能读取邮件" : "尚未配置日历账户凭据，不能读取日历",
        at: now
      };
      displayName ||= input.kind === "email" ? "邮件账户（待配置）" : "日历账户（待配置）";
    }

    const source: SourceConnection = {
      id: randomUUID(),
      kind: input.kind,
      provider,
      displayName: displayName || input.kind,
      account: input.account?.trim() || null,
      rootPath,
      allowedHosts,
      status,
      readOnly: true,
      itemCount: 0,
      lastReadAt: null,
      lastError,
      createdAt: now,
      updatedAt: now
    };
    this.publish("source.created", source);
    return this.get(source.id);
  }

  async read(id: string, input: ReadSourceInput = {}): Promise<SourceReadResult> {
    const source = this.get(id);
    if (source.status === "disconnected") {
      throw new SourceRegistryError("SOURCE_DISCONNECTED", "来源已断开，先重新连接再读取", 409);
    }
    if (source.kind === "email" || source.kind === "calendar") {
      throw new SourceRegistryError("CREDENTIALS_REQUIRED", source.lastError?.message ?? "这个来源还没有可用的登录凭据", 409);
    }
    if (source.kind === "web" && !input.url?.trim()) {
      throw new SourceRegistryError("URL_REQUIRED", "读取网页来源时必须提供 URL", 400);
    }

    this.updateSource(id, { status: "reading", lastError: null });
    try {
      const result = source.kind === "web"
        ? await this.readWeb(source, input.url)
        : this.readLocal(source);
      const current = this.updateSource(id, {
        status: "connected",
        lastError: null,
        lastReadAt: this.timestamp(),
        itemCount: this.service.store.listSourceItems(id).length
      });
      return { source: current, items: this.service.store.listSourceItems(id), changed: result.changed };
    } catch (error) {
      const sourceError = toSourceError(error, this.timestamp());
      const nextStatus: SourceConnection["status"] = error instanceof WebInputError && error.code === "access_challenge"
        ? "needs_user"
        : "error";
      this.updateSource(id, { status: nextStatus, lastError: sourceError });
      throw new SourceRegistryError(sourceError.code, sourceError.message, 422);
    }
  }

  disconnect(id: string): SourceConnection {
    this.get(id);
    return this.updateSource(id, { status: "disconnected", lastError: null });
  }

  reconnect(id: string): SourceConnection {
    const source = this.get(id);
    if (source.kind === "email" || source.kind === "calendar") {
      throw new SourceRegistryError("CREDENTIALS_REQUIRED", source.lastError?.message ?? "这个来源还没有可用的登录凭据", 409);
    }
    return this.updateSource(id, { status: "connected", lastError: null });
  }

  clear(id: string): SourceConnection {
    const source = this.get(id);
    const sourceContent = join(this.contentRoot, source.id);
    if (existsSync(sourceContent)) rmSync(sourceContent, { recursive: true, force: true });
    this.publish("source.cleared", { sourceId: id });
    return this.updateSource(id, { itemCount: 0, lastReadAt: null, lastError: null });
  }

  readItemContent(itemId: string): string {
    const item = this.getItem(itemId);
    if (!item.contentPath) throw new SourceRegistryError("SOURCE_CONTENT_UNAVAILABLE", "这个来源条目没有保存正文", 404);
    if (!isPathInside(this.contentRoot, item.contentPath) || !existsSync(item.contentPath)) {
      throw new SourceRegistryError("SOURCE_CONTENT_UNAVAILABLE", "来源正文已不可用，请重新读取", 410);
    }
    return readFileSync(item.contentPath, "utf8");
  }

  private readLocal(source: SourceConnection): { changed: number } {
    if (!source.rootPath) throw new SourceRegistryError("ROOT_PATH_REQUIRED", "本地来源缺少根路径");
    const root = canonicalLocalRoot(source.rootPath);
    const entries = collectLocalEntries(root.path);
    let changed = 0;
    for (const entry of entries) {
      const now = this.timestamp();
      if (entry.kind === "symlink") {
        const item = this.failedItem(source, entry.relativePath, entry.absolutePath, "symlink_rejected", "来源目录中的符号链接不会被跟随", now);
        this.publishItem(item);
        changed += item.status === "failed" ? 1 : 0;
        continue;
      }
      const result = this.readLocalFile(source, root.path, entry);
      if (result.changed) changed += 1;
    }
    return { changed };
  }

  private readLocalFile(
    source: SourceConnection,
    root: string,
    entry: { relativePath: string; absolutePath: string }
  ): { changed: boolean } {
    const now = this.timestamp();
    try {
      const actual = realpathSync(entry.absolutePath);
      if (!isPathInside(root, actual)) {
        this.publishItem(this.failedItem(source, entry.relativePath, entry.absolutePath, "path_escape", "文件真实路径越过来源根目录", now));
        return { changed: true };
      }
      const stat = statSync(actual);
      if (!stat.isFile()) throw new SourceRegistryError("UNSUPPORTED_SOURCE_ENTRY", "来源条目不是文件");
      if (stat.size > MAX_FILE_BYTES) {
        this.publishItem(this.failedItem(source, entry.relativePath, entry.absolutePath, "too_large", `文件超过 ${MAX_FILE_BYTES} bytes`, now));
        return { changed: true };
      }
      const bytes = readFileSync(actual);
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      const existing = this.service.store.findSourceItem(source.id, entry.relativePath);
      if (existing?.contentHash === contentHash && existing.status === "ready") return { changed: false };

      const duplicate = this.service.store.findSourceItemByHash(contentHash);
      const contentPath = duplicate?.contentPath ?? this.storeContent(source.id, contentHash, extname(actual), bytes);
      const item: SourceItem = {
        id: existing?.id ?? randomUUID(),
        sourceId: source.id,
        itemKey: entry.relativePath,
        label: basename(actual),
        locator: entry.relativePath.replace(/\\/g, "/"),
        contentPath,
        contentHash,
        bytes: bytes.byteLength,
        title: basename(actual, extname(actual)),
        status: "ready",
        coverage: textCoverage(bytes.toString("utf8")),
        duplicateOf: duplicate && duplicate.id !== existing?.id ? duplicate.id : null,
        error: null,
        fetchedAt: now
      };
      this.publishItem(item);
      return { changed: true };
    } catch (error) {
      const sourceError = toSourceError(error, now);
      this.publishItem(this.failedItem(source, entry.relativePath, entry.absolutePath, sourceError.code, sourceError.message, now));
      return { changed: true };
    }
  }

  private async readWeb(source: SourceConnection, rawUrl: string | undefined): Promise<{ changed: number }> {
    if (!rawUrl?.trim()) throw new SourceRegistryError("URL_REQUIRED", "读取网页来源时必须提供 URL");
    const snapshot = await this.webFetch(rawUrl, { allowedHosts: source.allowedHosts });
    return this.storeWebSnapshot(source, snapshot);
  }

  private storeWebSnapshot(source: SourceConnection, snapshot: WebSnapshot): { changed: number } {
    const existing = this.service.store.findSourceItem(source.id, snapshot.finalUrl);
    if (existing?.contentHash === snapshot.sha256 && existing.status === "ready") return { changed: 0 };
    const duplicate = this.service.store.findSourceItemByHash(snapshot.sha256);
    const bytes = Buffer.from(snapshot.markdown, "utf8");
    const contentPath = duplicate?.contentPath ?? this.storeContent(source.id, snapshot.sha256, ".md", bytes);
    const item: SourceItem = {
      id: existing?.id ?? randomUUID(),
      sourceId: source.id,
      itemKey: snapshot.finalUrl,
      label: snapshot.title || snapshot.finalUrl,
      locator: snapshot.finalUrl,
      contentPath,
      contentHash: snapshot.sha256,
      bytes: bytes.byteLength,
      title: snapshot.title || null,
      status: "ready",
      coverage: textCoverage(snapshot.markdown),
      duplicateOf: duplicate && duplicate.id !== existing?.id ? duplicate.id : null,
      error: null,
      fetchedAt: snapshot.fetchedAt
    };
    this.publishItem(item);
    return { changed: 1 };
  }

  private failedItem(
    source: SourceConnection,
    itemKey: string,
    locator: string,
    code: string,
    message: string,
    at: string
  ): SourceItem {
    const existing = this.service.store.findSourceItem(source.id, itemKey);
    return {
      id: existing?.id ?? randomUUID(),
      sourceId: source.id,
      itemKey,
      label: basename(locator),
      locator: locator.replace(/\\/g, "/"),
      contentPath: null,
      contentHash: null,
      bytes: 0,
      title: basename(locator, extname(locator)),
      status: "failed",
      coverage: emptyCoverage(["这个条目没有读取成功"]),
      duplicateOf: null,
      error: { code, message, at },
      fetchedAt: at
    };
  }

  private storeContent(sourceId: string, hash: string, extension: string, bytes: Uint8Array): string {
    const extensionName = SUPPORTED_EXTENSIONS.has(extension.toLowerCase()) ? extension.toLowerCase() : ".txt";
    const target = join(this.contentRoot, sourceId, `${hash}${extensionName}`);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) writeFileSync(target, bytes);
    return target;
  }

  private publishItem(item: SourceItem): void {
    this.publish("source.item.updated", item);
  }

  private updateSource(id: string, patch: Record<string, unknown>): SourceConnection {
    this.publish("source.updated", { id, ...patch, updatedAt: this.timestamp() });
    return this.get(id);
  }

  private publish(type: string, payload: unknown): void {
    const event = this.service.store.appendEvent({ type, payload });
    this.service.bus.publish(event);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function canonicalLocalRoot(rawPath: string): { path: string; name: string } {
  const candidate = resolve(rawPath);
  if (!existsSync(candidate)) throw new SourceRegistryError("ROOT_PATH_NOT_FOUND", `来源路径不存在：${candidate}`);
  const actual = realpathSync(candidate);
  const actualStat = statSync(actual);
  if (!actualStat.isDirectory() && !actualStat.isFile()) {
    throw new SourceRegistryError("ROOT_PATH_INVALID", "来源路径不是文件或目录");
  }
  return { path: actual, name: basename(actual) || actual };
}

function normalizeHosts(hosts: string[]): string[] {
  const result = new Set<string>();
  for (const raw of hosts) {
    const host = raw.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
    if (!host) continue;
    if (host.includes("*") || host.includes("/") || host.includes("@") || host.includes(":")) {
      throw new SourceRegistryError("INVALID_ALLOWED_HOST", `网页主机格式不正确：${raw}`);
    }
    result.add(host);
  }
  return [...result];
}

function collectLocalEntries(root: string): Array<
  | { kind: "file"; relativePath: string; absolutePath: string }
  | { kind: "symlink"; relativePath: string; absolutePath: string }
> {
  const result: Array<
    | { kind: "file"; relativePath: string; absolutePath: string }
    | { kind: "symlink"; relativePath: string; absolutePath: string }
  > = [];
  const rootStat = statSync(root);
  if (rootStat.isFile()) {
    if (SUPPORTED_EXTENSIONS.has(extname(root).toLowerCase())) {
      result.push({ kind: "file", relativePath: basename(root), absolutePath: root });
    }
    return result;
  }

  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw new SourceRegistryError("SOURCE_TOO_DEEP", `来源目录超过 ${MAX_DEPTH} 层`);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath);
      if (entry.isSymbolicLink()) {
        result.push({ kind: "symlink", relativePath, absolutePath });
      } else if (entry.isDirectory()) {
        walk(absolutePath, depth + 1);
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        result.push({ kind: "file", relativePath, absolutePath });
      }
      if (result.length > MAX_FILES) throw new SourceRegistryError("SOURCE_TOO_MANY_FILES", `来源超过 ${MAX_FILES} 个文件`);
    }
  };
  walk(root, 0);
  return result;
}

function textCoverage(text: string): SourceCoverage {
  const paragraphs = text.split(/\n\s*\n/).filter((part) => part.trim()).length;
  return {
    complete: true,
    pages: null,
    paragraphs,
    sheets: [],
    gaps: []
  };
}

function emptyCoverage(gaps: string[]): SourceCoverage {
  return { complete: false, pages: null, paragraphs: null, sheets: [], gaps };
}

function toSourceError(error: unknown, at: string): SourceError {
  if (error instanceof WebInputError) return { code: error.code, message: error.message, at };
  if (error instanceof SourceRegistryError) return { code: error.code, message: error.message, at };
  return { code: "source_read_failed", message: error instanceof Error ? error.message : String(error), at };
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

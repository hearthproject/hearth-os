import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  SkillActionDefinition,
  SkillManifest,
  SkillPermissions,
  SkillPlatform,
  SkillRecord,
  SkillUsageEvent,
  SkillVersion,
  SkillView
} from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";
import type { LibraryService } from "../library/service.ts";
import { isSensitivePath } from "../library/paths.ts";

const execFileAsync = promisify(execFile);
const MAX_FILES = 1_000;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_ENTRIES = 2_000;
const MAX_PROMPT_CHARS = 60_000;
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "__pycache__", ".venv", "dist", "build", ".next", ".cache"]);

export class SkillError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "SkillError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface SkillCommandResult {
  stdout: string;
  stderr: string;
}

export type SkillCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number }
) => Promise<SkillCommandResult>;

export interface SkillServiceOptions {
  store: HearthStore;
  root: string;
  library?: LibraryService;
  commandRunner?: SkillCommandRunner;
  fetchText?: (url: string) => Promise<string>;
}

export interface InstallSkillInput {
  source: string;
  ref?: string | null;
  path?: string | null;
  name?: string | null;
}

export interface SkillMutationResult {
  skill: SkillView;
  changed: boolean;
  replacedFiles: number;
}

export interface ParsedGitHubSource {
  kind: "github";
  original: string;
  cloneUrl: string;
  repo: string;
  ref: string | null;
  path: string | null;
}

export interface ParsedFileSource {
  kind: "file";
  original: string;
  path: string;
}

export type ParsedSkillSource = ParsedGitHubSource | ParsedFileSource;

interface SkillDocument {
  name: string;
  description: string;
  version: string;
  category: string;
  platforms: SkillPlatform[];
  tools: string[];
  permissions: SkillPermissions;
  body: string;
}

function defaultCommandRunner(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<SkillCommandResult> {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 5 * 60 * 1000,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    encoding: "utf8"
  }).then((result) => ({ stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") }), (error: unknown) => {
    const failure = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
    throw new SkillError(
      "SKILL_COMMAND_FAILED",
      String(failure.stderr || failure.stdout || failure.message || `${command} 执行失败`).trim(),
      502
    );
  });
}

export function parseSkillSource(raw: string): ParsedSkillSource {
  const source = raw.trim().replace(/^["']|["']$/g, "");
  if (!source) throw new SkillError("SKILL_SOURCE_REQUIRED", "请填写 Skill 的 GitHub 地址或本地目录");
  if (/^https?:\/\//i.test(source)) {
    const parsed = new URL(source);
    if (parsed.hostname === "raw.githubusercontent.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length < 4) throw new SkillError("INVALID_GITHUB_SOURCE", "这个 GitHub 地址不完整");
      const [owner, repo, ref, ...rest] = parts;
      return {
        kind: "github",
        original: source,
        cloneUrl: `https://github.com/${owner}/${repo}.git`,
        repo: `${owner}/${repo}`,
        ref: ref ?? null,
        path: rest.join("/")
      };
    }
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
      throw new SkillError("UNSUPPORTED_SKILL_SOURCE", "目前支持 GitHub 地址或本地目录");
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) throw new SkillError("INVALID_GITHUB_SOURCE", "GitHub 地址至少要包含仓库名");
    const [owner, repo, marker, ref, ...rest] = parts;
    if (!owner || !repo) throw new SkillError("INVALID_GITHUB_SOURCE", "GitHub 地址至少要包含仓库名");
    const tree = marker === "tree" || marker === "blob";
    const repoPath = tree ? rest.join("/") : parts.slice(2).join("/");
    return {
      kind: "github",
      original: source,
      cloneUrl: `https://github.com/${owner}/${repo.replace(/\.git$/i, "")}.git`,
      repo: `${owner}/${repo.replace(/\.git$/i, "")}`,
      ref: tree && ref ? ref : null,
      path: repoPath || null
    };
  }
  if (/^file:\/\//i.test(source)) return { kind: "file", original: source, path: fileURLToPath(source) };
  if (/^[a-z]+:\/\//i.test(source)) throw new SkillError("UNSUPPORTED_SKILL_SOURCE", "目前支持 GitHub 地址或本地目录");
  return { kind: "file", original: source, path: resolve(source) };
}

export class SkillService {
  private readonly store: HearthStore;
  private readonly root: string;
  private readonly library: LibraryService | null;
  private readonly commandRunner: SkillCommandRunner;
  private readonly fetchText: (url: string) => Promise<string>;
  private describeZh: ((description: string) => Promise<string | null>) | null = null;
  private descriptionBackfillStarted = false;

  constructor(options: SkillServiceOptions) {
    this.store = options.store;
    this.root = resolve(options.root);
    this.library = options.library ?? null;
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.fetchText = options.fetchText ?? (async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new SkillError("SKILL_DOWNLOAD_FAILED", `下载 Skill 失败（${response.status}）`, 502);
      return response.text();
    });
    mkdirSync(this.root, { recursive: true });
  }

  setDescriptionTranslator(translator: (description: string) => Promise<string | null>): void {
    this.describeZh = translator;
  }

  /** 启动后为历史技能补齐中文描述；失败时保留原文，不阻塞启动。 */
  async backfillChineseDescriptions(limit = 60): Promise<void> {
    if (this.descriptionBackfillStarted || !this.describeZh) return;
    this.descriptionBackfillStarted = true;
    for (const skill of this.store.listSkills()) {
      if (skill.status === "archived") continue;
      if (chineseDescription(skill) || limit <= 0) continue;
      try {
        const manifest = await this.localizeManifest(skill.manifest);
        if (!manifest.metadata.hearth.descriptionZh) continue;
        this.persist(this.edit(skill, { manifest }), "description-localized");
        limit -= 1;
      } catch {
        // 翻译失败不影响技能本身。
      }
    }
  }

  list(): SkillView[] {
    return this.store.listSkills()
      .filter((skill) => skill.status !== "archived")
      .map((skill) => this.view(skill));
  }

  get(id: string): SkillView | null {
    const skill = this.store.getSkill(id);
    return skill ? this.view(skill) : null;
  }

  async install(input: InstallSkillInput): Promise<SkillMutationResult> {
    const source = parseSkillSource(input.source);
    const staging = this.stagingDirectory("install");
    let cloneRoot: string | null = null;
    try {
      const prepared = source.kind === "github"
        ? await this.prepareGitHubSource(source, input, staging)
        : this.prepareFileSource(source, input.path ?? null);
      cloneRoot = prepared.temporaryRoot;
      const skillRoot = this.findSkillRoot(prepared.skillRoot);
      const document = readSkillDocument(skillRoot, input.name ?? null);
      const id = this.uniqueId(slugify(document.name));
      const destination = join(this.root, id);
      const copy = this.copySkillTree(skillRoot, destination);
      const now = new Date().toISOString();
      const manifest = await this.localizeManifest(manifestFor(document, "imported", now, false));
      const record = this.record({
        id,
        document,
        manifest,
        path: destination,
        contentHash: copy.contentHash,
        origin: "imported",
        sourceUrl: this.sourceUrlFor(source),
        sourceRef: source.kind === "github" ? input.ref || source.ref : null,
        createdAt: now,
        updatedAt: now,
        changeReport: `从${source.kind === "github" ? " GitHub" : "本地目录"}安装`
      });
      this.persist(record, "installed");
      this.refreshLibrary(record);
      return { skill: this.view(record), changed: true, replacedFiles: copy.files };
    } finally {
      if (cloneRoot) rmSync(cloneRoot, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  }

  async update(id: string): Promise<SkillMutationResult> {
    const current = this.store.getSkill(id);
    if (!current) throw new SkillError("SKILL_NOT_FOUND", "没有找到这个 Skill", 404);
    if (!current.sourceUrl) throw new SkillError("SKILL_SOURCE_MISSING", "这个 Skill 没有记录来源，不能自动更新");
    const source = parseSkillSource(current.sourceUrl);
    const staging = this.stagingDirectory("update");
    const replaceTarget = join(this.root, `.replace-${id}-${randomUUID().slice(0, 8)}`);
    let cloneRoot: string | null = null;
    try {
      const prepared = source.kind === "github"
        ? await this.prepareGitHubSource(source, { ref: current.sourceRef, path: null }, staging)
        : this.prepareFileSource(source, null);
      cloneRoot = prepared.temporaryRoot;
      const skillRoot = this.findSkillRoot(prepared.skillRoot);
      const document = readSkillDocument(skillRoot, current.name);
      const copy = this.copySkillTree(skillRoot, replaceTarget);
      if (copy.contentHash === current.contentHash) {
        rmSync(replaceTarget, { recursive: true, force: true });
        const checked = this.edit(current, { lastCheckedAt: new Date().toISOString() });
        this.persist(checked, "checked");
        return { skill: this.view(checked), changed: false, replacedFiles: 0 };
      }
      const now = new Date().toISOString();
      this.recordVersion(current, "手动更新前保存");
      const manifest = await this.localizeManifest(manifestFor(document, current.origin, now, current.pinned));
      const record = this.edit(current, {
        name: document.name,
        version: document.version === current.version ? bumpVersion(current.version, now) : document.version,
        contentHash: copy.contentHash,
        manifest,
        permissions: document.permissions,
        updatedAt: now,
        lastCheckedAt: now,
        changeReport: `手动更新：${shortHash(current.contentHash)} → ${shortHash(copy.contentHash)}`
      });
      this.replaceDirectory(current.path, replaceTarget, staging);
      record.path = current.path;
      this.persist(record, "updated");
      this.refreshLibrary(record);
      return { skill: this.view(record), changed: true, replacedFiles: copy.files };
    } finally {
      if (cloneRoot) rmSync(cloneRoot, { recursive: true, force: true });
      rmSync(replaceTarget, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  }

  remove(id: string): { skill: SkillView; removedFiles: boolean } {
    const current = this.store.getSkill(id);
    if (!current) throw new SkillError("SKILL_NOT_FOUND", "没有找到这个 Skill", 404);
    const view = this.view(current);
    this.store.appendEvent({ type: "skill.deleted", payload: { id, name: current.name } });
    const target = resolve(current.path);
    if (isInside(this.root, target) && existsSync(target)) rmSync(target, { recursive: true, force: true });
    this.library?.tree.removeSkill(id);
    this.library?.markDirty();
    return { skill: view, removedFiles: true };
  }

  use(id: string, input: { taskId?: string | null; runId?: string | null; note?: string | null } = {}): {
    skill: SkillView;
    prompt: string;
  } {
    const current = this.store.getSkill(id);
    if (!current) throw new SkillError("SKILL_NOT_FOUND", "没有找到这个 Skill", 404);
    const file = join(current.path, "SKILL.md");
    if (!existsSync(file)) throw new SkillError("SKILL_DOCUMENT_MISSING", "这个 Skill 缺少 SKILL.md", 409);
    const raw = readFileSync(file, "utf8");
    const now = new Date().toISOString();
    const updated = this.edit(current, { lastUsedAt: now, updatedAt: now });
    this.persist(updated, "used");
    const usage: SkillUsageEvent = {
      id: randomUUID(),
      skillId: id,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      status: "completed",
      source: "manual",
      note: input.note?.trim() || "用户在对话框中选择使用",
      createdAt: now
    };
    this.store.appendEvent({ type: "skill.usage.recorded", payload: usage });
    return {
      skill: this.view(updated),
      prompt: renderSkillPrompt(updated, raw)
    };
  }

  private async prepareGitHubSource(
    source: ParsedGitHubSource,
    input: Pick<InstallSkillInput, "ref" | "path">,
    staging: string
  ): Promise<{ skillRoot: string; temporaryRoot: string }> {
    const temporaryRoot = mkdtempSync(join(staging, "repo-"));
    const checkout = join(temporaryRoot, "checkout");
    const ref = input.ref?.trim() || source.ref;
    const cloneArgs = ["clone", "--depth", "1"];
    if (ref) cloneArgs.push("--branch", ref);
    cloneArgs.push(source.cloneUrl, checkout);
    try {
      await this.commandRunner("git", cloneArgs, { timeoutMs: 5 * 60 * 1000 });
    } catch (error) {
      if (!ref) throw error;
      rmSync(checkout, { recursive: true, force: true });
      await this.commandRunner("git", ["clone", source.cloneUrl, checkout], { timeoutMs: 5 * 60 * 1000 });
      await this.commandRunner("git", ["checkout", ref], { cwd: checkout, timeoutMs: 2 * 60 * 1000 });
    }
    const requested = input.path?.trim() || source.path;
    return {
      skillRoot: requested ? safeJoin(checkout, requested) : checkout,
      temporaryRoot
    };
  }

  private prepareFileSource(source: ParsedFileSource, path: string | null): { skillRoot: string; temporaryRoot: string | null } {
    const candidate = path?.trim() ? (isAbsolute(path) ? path : join(source.path, path)) : source.path;
    if (!existsSync(candidate)) throw new SkillError("SKILL_SOURCE_NOT_FOUND", "这个目录或文件不存在", 404);
    return { skillRoot: candidate, temporaryRoot: null };
  }

  private findSkillRoot(candidate: string): string {
    const stat = statSync(candidate);
    if (stat.isFile()) {
      if (basename(candidate).toLowerCase() !== "skill.md") {
        throw new SkillError("SKILL_DOCUMENT_REQUIRED", "请选择包含 SKILL.md 的目录");
      }
      return dirname(candidate);
    }
    const direct = join(candidate, "SKILL.md");
    if (existsSync(direct)) return candidate;
    const found: string[] = [];
    const queue: Array<{ path: string; depth: number }> = [{ path: candidate, depth: 0 }];
    let scanned = 0;
    while (queue.length > 0 && scanned < MAX_SEARCH_ENTRIES) {
      const item = queue.shift()!;
      if (item.depth > 5) continue;
      for (const entry of readdirSync(item.path, { withFileTypes: true })) {
        scanned += 1;
        if (scanned > MAX_SEARCH_ENTRIES) break;
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const child = join(item.path, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) queue.push({ path: child, depth: item.depth + 1 });
        else if (entry.name.toLowerCase() === "skill.md") found.push(dirname(child));
      }
    }
    if (found.length === 1) return found[0]!;
    if (found.length === 0) throw new SkillError("SKILL_DOCUMENT_REQUIRED", "这个来源里没有找到 SKILL.md", 404);
    const choices = found.slice(0, 8).map((item) => relative(candidate, item) || ".").join("、");
    throw new SkillError("MULTIPLE_SKILLS", `这个来源包含多个 Skill（${choices}），请在来源地址后指定具体目录`);
  }

  private copySkillTree(sourceRoot: string, destination: string): { files: number; contentHash: string; bytes: number } {
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    const hash = createHash("sha256");
    let files = 0;
    let bytes = 0;
    const visit = (current: string, relativeRoot: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        const rel = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRECTORIES.has(entry.name) || isSensitivePath(`${rel}/placeholder`)) continue;
          visit(join(current, entry.name), rel);
          continue;
        }
        if (!entry.isFile() || isSensitivePath(rel) || entry.name === ".DS_Store") continue;
        const sourceFile = join(current, entry.name);
        const size = lstatSync(sourceFile).size;
        if (size > MAX_FILE_BYTES) throw new SkillError("SKILL_FILE_TOO_LARGE", `Skill 中的文件过大：${rel}`);
        files += 1;
        bytes += size;
        if (files > MAX_FILES) throw new SkillError("SKILL_TOO_MANY_FILES", "Skill 文件数量超过 1000 个");
        if (bytes > MAX_TOTAL_BYTES) throw new SkillError("SKILL_TOO_LARGE", "Skill 总大小超过 25 MB");
        const target = join(destination, ...rel.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(sourceFile, target);
        hash.update(rel).update("\0").update(readFileSync(sourceFile)).update("\0");
      }
    };
    visit(sourceRoot, "");
    return { files, bytes, contentHash: hash.digest("hex") };
  }

  private replaceDirectory(current: string, replacement: string, staging: string): void {
    const target = resolve(current);
    if (!isInside(this.root, target)) throw new SkillError("SKILL_PATH_UNSAFE", "Skill 目录不在受管目录内", 409);
    const backup = join(staging, `backup-${randomUUID().slice(0, 8)}`);
    const hadCurrent = existsSync(target);
    if (hadCurrent) renameSync(target, backup);
    try {
      renameSync(replacement, target);
    } catch (error) {
      if (hadCurrent && !existsSync(target)) renameSync(backup, target);
      throw error;
    }
    if (hadCurrent) rmSync(backup, { recursive: true, force: true });
  }

  private record(input: {
    id: string;
    document: SkillDocument;
    manifest: SkillManifest;
    path: string;
    contentHash: string;
    origin: SkillRecord["origin"];
    sourceUrl: string | null;
    sourceRef: string | null;
    createdAt: string;
    updatedAt: string;
    changeReport: string;
  }): SkillRecord {
    return {
      id: input.id,
      methodId: null,
      methodVersion: null,
      name: input.document.name,
      version: input.document.version,
      status: "adopted",
      pinned: false,
      path: input.path,
      contentHash: input.contentHash,
      manifest: input.manifest,
      origin: input.origin,
      sourceTaskIds: [],
      trialTaskIds: [],
      previousVersionId: null,
      changeReport: input.changeReport,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      adoptedAt: input.createdAt,
      lastUsedAt: null,
      archivedAt: null,
      archiveReason: null,
      previousStatus: null,
      sourceUrl: input.sourceUrl,
      sourceRef: input.sourceRef,
      readOnly: false,
      permissions: input.document.permissions,
      actions: [],
      lastCheckedAt: input.updatedAt
    };
  }

  private edit(record: SkillRecord, patch: Partial<SkillRecord>): SkillRecord {
    return { ...record, ...patch };
  }

  private recordVersion(record: SkillRecord, changeReport: string): void {
    const version: SkillVersion = {
      id: randomUUID(),
      skillId: record.id,
      version: record.version,
      manifest: record.manifest,
      contentHash: record.contentHash,
      path: record.path,
      methodId: record.methodId,
      methodVersion: record.methodVersion,
      changeReport,
      createdAt: new Date().toISOString()
    };
    this.store.appendEvent({ type: "skill.version.recorded", payload: version });
  }

  private persist(record: SkillRecord, action: string): void {
    this.store.appendEvent({
      type: "skill.updated",
      payload: { ...record, action }
    });
    this.library?.markDirty();
  }

  private refreshLibrary(record: SkillRecord): void {
    this.library?.tree.syncSkill(record);
    this.library?.markDirty();
  }

  private async localizeManifest(manifest: SkillManifest): Promise<SkillManifest> {
    const description = manifest.description.trim();
    const hash = createHash("sha256").update(description).digest("hex");
    const existing = manifest.metadata.hearth;
    if (existing.descriptionHash === hash && existing.descriptionZh) return manifest;
    if (containsCjk(description)) {
      return {
        ...manifest,
        metadata: { hearth: { ...existing, descriptionZh: description, descriptionHash: hash } }
      };
    }
    if (!this.describeZh || !description) return manifest;
    try {
      const translated = (await this.describeZh(description))?.trim();
      if (!translated) return manifest;
      return {
        ...manifest,
        metadata: {
          hearth: {
            ...existing,
            descriptionZh: translated.slice(0, 600),
            descriptionHash: hash
          }
        }
      };
    } catch {
      return manifest;
    }
  }

  private view(record: SkillRecord): SkillView {
    return { ...record, descriptionZh: chineseDescription(record) };
  }

  private uniqueId(base: string): string {
    let candidate = base;
    let suffix = 2;
    while (existsSync(join(this.root, candidate)) || this.store.getSkill(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private sourceUrlFor(source: ParsedSkillSource): string {
    return source.kind === "file" ? pathToFileURL(source.path).href : source.original;
  }

  private stagingDirectory(label: string): string {
    const path = join(this.root, `.staging-${label}-${randomUUID().slice(0, 8)}`);
    mkdirSync(path, { recursive: true });
    return path;
  }
}

function readSkillDocument(skillRoot: string, preferredName: string | null): SkillDocument {
  const file = join(skillRoot, "SKILL.md");
  if (!existsSync(file)) throw new SkillError("SKILL_DOCUMENT_REQUIRED", "这个目录里没有 SKILL.md", 404);
  const raw = readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  const parsed = parseFrontmatter(raw);
  const fallbackName = preferredName?.trim() || basename(skillRoot) || "未命名技能";
  const name = frontmatterString(parsed.values, "name") || fallbackName;
  const description = frontmatterString(parsed.values, "description") || firstParagraph(parsed.body) || "这个 Skill 没有填写说明。";
  const version = frontmatterString(parsed.values, "version") || "1.0.0";
  const category = frontmatterString(parsed.values, "category") || "通用";
  const platforms = parsePlatforms(parsed.values.platforms ?? parsed.values.platform);
  const tools = parseList(parsed.values.tools ?? parsed.values["allowed-tools"]);
  return {
    name: clip(name, 120),
    description: clip(description, 600),
    version: clip(version, 80),
    category: clip(category, 60),
    platforms,
    tools,
    permissions: parsePermissions(parsed.values.permissions),
    body: parsed.body
  };
}

function parseFrontmatter(raw: string): { values: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) return { values: {}, body: raw };
  const end = raw.indexOf("\n---", 4);
  if (end < 0) return { values: {}, body: raw };
  const header = raw.slice(4, end).split("\n");
  const values: Record<string, string> = {};
  for (const line of header) {
    if (!line.trim() || line.trimStart().startsWith("#") || /^\s/.test(line)) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]!.toLowerCase()] = unquote(match[2]!.trim());
  }
  return { values, body: raw.slice(end + 4).replace(/^\n+/, "") };
}

function frontmatterString(values: Record<string, string>, key: string): string | null {
  const value = values[key];
  return value && !value.startsWith("[") && !value.startsWith("{") ? value : null;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  const clean = value.trim().replace(/^\[|\]$/g, "");
  return clean.split(",").map((item) => unquote(item.trim())).filter(Boolean).slice(0, 40);
}

function parsePlatforms(value: string | undefined): SkillPlatform[] {
  const all: SkillPlatform[] = ["windows", "macos", "linux"];
  const parsed = parseList(value).filter((item): item is SkillPlatform => all.includes(item as SkillPlatform));
  return parsed.length > 0 ? parsed : all;
}

function parsePermissions(value: string | undefined): SkillPermissions {
  const empty = { readRoots: [], writeRoots: [], networkHosts: [] };
  if (!value) return empty;
  try {
    const parsed = JSON.parse(value) as Partial<SkillPermissions>;
    return {
      readRoots: Array.isArray(parsed.readRoots) ? parsed.readRoots.filter((item): item is string => typeof item === "string") : [],
      writeRoots: Array.isArray(parsed.writeRoots) ? parsed.writeRoots.filter((item): item is string => typeof item === "string") : [],
      networkHosts: Array.isArray(parsed.networkHosts) ? parsed.networkHosts.filter((item): item is string => typeof item === "string") : []
    };
  } catch {
    return empty;
  }
}

function manifestFor(document: SkillDocument, origin: SkillRecord["origin"], now: string, pinned: boolean): SkillManifest {
  return {
    name: document.name,
    description: document.description,
    version: document.version,
    platforms: document.platforms,
    tools: document.tools,
    permissions: document.permissions,
    metadata: {
      hearth: {
        category: document.category,
        originTaskId: null,
        originHash: null,
        adoptedAt: now,
        origin,
        pinned
      }
    }
  };
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

function chineseDescription(skill: SkillRecord): string | null {
  const description = skill.manifest.description.trim();
  const hearth = skill.manifest.metadata?.hearth;
  const cached = hearth?.descriptionZh?.trim();
  if (!cached) return null;
  const hash = createHash("sha256").update(description).digest("hex");
  if (hearth?.descriptionHash && hearth.descriptionHash !== hash) return null;
  return cached;
}

function renderSkillPrompt(skill: SkillRecord, raw: string): string {
  const body = raw.length > MAX_PROMPT_CHARS ? `${raw.slice(0, MAX_PROMPT_CHARS)}\n\n（Skill 内容过长，已截断。）` : raw;
  const compatibility = /AskUserQuestion|ask_user/i.test(body)
    ? "工具名兼容：Skill 文本中的 AskUserQuestion 在 Hearth 中对应 ask_user。需要提问时调用 ask_user，一次只问一个问题，并等待用户回答；如果 Skill 要求提供选项，把 2–4 个选项写进 question 文本。不要改成直接作答或自行假设。"
    : "";
  return [
    `请使用「${skill.name}」这个 Skill 来完成接下来的请求。`,
    `Skill 目录：${skill.path}`,
    "需要时可以直接读取目录里的资源文件；不要把 Skill 里的示例内容当作已经完成的工作。",
    "按 Skill 规定的流程执行；不要用一次性总结替代它要求的交互步骤。",
    ...(compatibility ? [compatibility] : []),
    "",
    "--- Skill 使用说明 ---",
    body
  ].join("\n");
}

function firstParagraph(body: string): string {
  return body.split(/\n\s*\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
}

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "").trim();
}

function slugify(name: string): string {
  const ascii = name.normalize("NFKD").toLowerCase()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  if (!ascii || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(ascii)) {
    return `skill-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
  }
  return ascii;
}

function bumpVersion(version: string, now: string): string {
  const base = version.split("+")[0] || "1.0.0";
  const stamp = now.replace(/\D/g, "").slice(0, 12);
  return `${base}+${stamp}`;
}

function shortHash(value: string): string {
  return value.slice(0, 10);
}

function safeJoin(root: string, candidate: string): string {
  const target = resolve(root, candidate);
  if (!isInside(root, target)) throw new SkillError("SKILL_PATH_UNSAFE", "Skill 路径超出了下载目录");
  return target;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export const __test = { parseFrontmatter, readSkillDocument, slugify, manifestFor };

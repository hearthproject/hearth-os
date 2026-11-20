import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { LocalProject, LocalProjectView } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";

export interface FolderBrowseEntry {
  name: string;
  path: string;
}

export interface FolderBrowseResult {
  path: string | null;
  parent: string | null;
  roots: FolderBrowseEntry[];
  entries: FolderBrowseEntry[];
  separator: string;
}

export class ProjectError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ProjectError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ProjectServiceOptions {
  clock?: () => Date;
}

export class ProjectService {
  private readonly store: HearthStore;
  private readonly clock: () => Date;

  constructor(store: HearthStore, options: ProjectServiceOptions = {}) {
    this.store = store;
    this.clock = options.clock ?? (() => new Date());
  }

  list(): LocalProjectView[] {
    return this.store.listLocalProjects().map((project) => this.inspect(project));
  }

  listFolders(input?: string | null): FolderBrowseResult {
    const roots = browseRoots();
    const trimmed = input?.trim() ?? "";
    if (!trimmed) {
      return { path: null, parent: null, roots, entries: [], separator: "\\" };
    }
    const expanded = trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
        ? resolve(homedir(), trimmed.slice(2))
        : trimmed;
    const absolute = resolve(expandEnvironment(expanded));
    if (!existsSync(absolute)) throw new ProjectError("FOLDER_NOT_FOUND", "文件夹不存在", 404);
    if (!statSync(absolute).isDirectory()) throw new ProjectError("FOLDER_NOT_DIRECTORY", "路径不是文件夹");
    const real = realpathSync.native(absolute);
    let entries: FolderBrowseEntry[] = [];
    try {
      entries = readdirSync(real, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, path: resolve(real, entry.name) }))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
        .slice(0, 500);
    } catch {
      throw new ProjectError("FOLDER_NOT_READABLE", "无法读取这个文件夹", 403);
    }
    const parent = dirname(real);
    return {
      path: real,
      parent: parent === real ? null : parent,
      roots,
      entries,
      separator: "\\"
    };
  }

  get(id: string): LocalProjectView {
    return this.inspect(this.require(id));
  }

  create(input: { name?: string | undefined; path: string; defaultBranch?: string | undefined }): LocalProjectView {
    const path = normalizeProjectPath(input.path);
    const root = gitRootOrNull(path);
    const isGit = root !== null && samePath(path, root);
    const duplicate = this.store.listLocalProjects().find((project) => samePath(project.path, path));
    if (duplicate) throw new ProjectError("PROJECT_ALREADY_EXISTS", "这个文件夹已经注册为项目", 409);
    const defaultBranch = isGit
      ? validateBranch(root, input.defaultBranch?.trim() || currentBranch(root))
      : "";
    const now = this.clock().toISOString();
    const project: LocalProject = {
      id: `project_${randomUUID()}`,
      name: cleanName(input.name, path),
      path: realpathSync.native(path),
      defaultBranch,
      createdAt: now,
      updatedAt: now
    };
    return this.inspect(this.store.upsertLocalProject(project));
  }

  update(id: string, input: { name?: string | undefined; defaultBranch?: string | undefined }): LocalProjectView {
    const project = this.require(id);
    const defaultBranch = input.defaultBranch !== undefined && project.defaultBranch
      ? validateBranch(project.path, input.defaultBranch)
      : project.defaultBranch;
    const next: LocalProject = {
      ...project,
      ...(input.name !== undefined ? { name: cleanName(input.name, project.path) } : {}),
      defaultBranch,
      updatedAt: this.clock().toISOString()
    };
    return this.inspect(this.store.upsertLocalProject(next));
  }

  delete(id: string): void {
    this.require(id);
    this.store.deleteLocalProject(id);
  }

  private require(id: string): LocalProject {
    const project = this.store.getLocalProject(id);
    if (!project) throw new ProjectError("PROJECT_NOT_FOUND", "项目不存在", 404);
    return project;
  }

  private inspect(project: LocalProject): LocalProjectView {
    const isGit = Boolean(project.defaultBranch);
    if (!existsSync(project.path) || !statSync(project.path).isDirectory()) {
      return {
        ...project, kind: isGit ? "git" : "folder", available: false,
        currentBranch: null, dirty: false, error: "项目目录不存在"
      };
    }
    if (!isGit) {
      return { ...project, kind: "folder", available: true, currentBranch: null, dirty: false, error: null };
    }
    const root = git(["-C", project.path, "rev-parse", "--show-toplevel"]);
    if (!root.ok) {
      return {
        ...project, kind: "git", available: false, currentBranch: null, dirty: false,
        error: "项目不再是 Git 仓库"
      };
    }
    const branch = git(["-C", project.path, "rev-parse", "--abbrev-ref", "HEAD"]);
    const status = git(["-C", project.path, "status", "--porcelain"]);
    return {
      ...project,
      kind: "git",
      available: status.ok,
      currentBranch: branch.ok && branch.stdout.trim() !== "HEAD" ? branch.stdout.trim() : null,
      dirty: status.ok && status.stdout.trim().length > 0,
      error: status.ok ? null : status.stderr.trim() || "无法读取 Git 状态"
    };
  }
}

function normalizeProjectPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new ProjectError("PROJECT_PATH_REQUIRED", "请填写项目路径");
  const expanded = trimmed === "~"
    ? homedir()
    : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? resolve(homedir(), trimmed.slice(2))
      : trimmed;
  const absolute = resolve(expanded);
  if (!existsSync(absolute)) throw new ProjectError("PROJECT_PATH_NOT_FOUND", "项目路径不存在", 404);
  if (!statSync(absolute).isDirectory()) throw new ProjectError("PROJECT_PATH_NOT_DIRECTORY", "项目路径必须是目录");
  return realpathSync.native(absolute);
}

function gitRootOrNull(path: string): string | null {
  const result = git(["-C", path, "rev-parse", "--show-toplevel"]);
  if (!result.ok || !result.stdout.trim()) return null;
  return realpathSync.native(resolve(result.stdout.trim()));
}

function currentBranch(root: string): string {
  const result = git(["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = result.stdout.trim();
  if (!result.ok || !branch) {
    throw new ProjectError("PROJECT_BRANCH_REQUIRED", "仓库没有可用分支，请先创建首个提交", 409);
  }
  return branch;
}

function validateBranch(root: string, branch: string): string {
  const normalized = branch.trim();
  if (!normalized) throw new ProjectError("PROJECT_BRANCH_REQUIRED", "请填写默认分支");
  const format = git(["check-ref-format", "--branch", normalized]);
  if (!format.ok) throw new ProjectError("PROJECT_BRANCH_INVALID", "默认分支名称无效");
  const exists = git(["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${normalized}`]);
  if (!exists.ok) throw new ProjectError("PROJECT_BRANCH_NOT_FOUND", `本地分支不存在：${normalized}`, 409);
  return normalized;
}

function cleanName(value: string | undefined, root: string): string {
  const name = value?.trim() || basename(root);
  if (!name) throw new ProjectError("PROJECT_NAME_REQUIRED", "请填写项目名称");
  if (name.length > 100) throw new ProjectError("PROJECT_NAME_TOO_LONG", "项目名称不能超过 100 个字符");
  return name;
}

function samePath(left: string, right: string): boolean {
  return resolve(left).replace(/\\/g, "/").toLowerCase() === resolve(right).replace(/\\/g, "/").toLowerCase();
}

function browseRoots(): FolderBrowseEntry[] {
  if (process.platform === "win32") {
    const drives: FolderBrowseEntry[] = [];
    for (let code = 65; code <= 90; code += 1) {
      const letter = String.fromCharCode(code);
      const path = `${letter}:\\`;
      if (existsSync(path)) drives.push({ name: `${letter}:`, path });
    }
    return drives;
  }
  return [{ name: "主目录", path: homedir() }];
}

function expandEnvironment(value: string): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match);
}

function git(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024
  });
  if (result.error) {
    return { ok: false, stdout: "", stderr: result.error.message };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

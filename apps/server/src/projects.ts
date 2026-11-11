import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { LocalProject, LocalProjectView } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";

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

  get(id: string): LocalProjectView {
    return this.inspect(this.require(id));
  }

  create(input: { name?: string | undefined; path: string; defaultBranch?: string | undefined }): LocalProjectView {
    const path = normalizeProjectPath(input.path);
    const root = gitRoot(path);
    if (!samePath(path, root)) {
      throw new ProjectError("PROJECT_PATH_NOT_ROOT", `请选择 Git 仓库根目录：${root}`, 409);
    }
    const duplicate = this.store.listLocalProjects().find((project) => samePath(project.path, root));
    if (duplicate) throw new ProjectError("PROJECT_ALREADY_EXISTS", "这个 Git 项目已经注册", 409);
    const defaultBranch = validateBranch(root, input.defaultBranch?.trim() || currentBranch(root));
    const now = this.clock().toISOString();
    const project: LocalProject = {
      id: `project_${randomUUID()}`,
      name: cleanName(input.name, root),
      path: realpathSync.native(root),
      defaultBranch,
      createdAt: now,
      updatedAt: now
    };
    return this.inspect(this.store.upsertLocalProject(project));
  }

  update(id: string, input: { name?: string | undefined; defaultBranch?: string | undefined }): LocalProjectView {
    const project = this.require(id);
    const defaultBranch = input.defaultBranch !== undefined
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
    if (!existsSync(project.path) || !statSync(project.path).isDirectory()) {
      return { ...project, available: false, currentBranch: null, dirty: false, error: "项目目录不存在" };
    }
    const root = git(["-C", project.path, "rev-parse", "--show-toplevel"]);
    if (!root.ok) {
      return { ...project, available: false, currentBranch: null, dirty: false, error: "项目不再是 Git 仓库" };
    }
    const branch = git(["-C", project.path, "rev-parse", "--abbrev-ref", "HEAD"]);
    const status = git(["-C", project.path, "status", "--porcelain"]);
    return {
      ...project,
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

function gitRoot(path: string): string {
  const result = git(["-C", path, "rev-parse", "--show-toplevel"]);
  if (!result.ok || !result.stdout.trim()) {
    throw new ProjectError("PROJECT_NOT_GIT", "项目路径不是 Git 仓库", 409);
  }
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

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { TaskRecord, TaskWorktree, TaskWorktreeView } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";

export class WorktreeError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface TaskWorktreeServiceOptions {
  workspaceRoot: string;
  clock?: () => Date;
}

export class TaskWorktreeService {
  private readonly store: HearthStore;
  private readonly workspaceRoot: string;
  private readonly clock: () => Date;

  constructor(store: HearthStore, options: TaskWorktreeServiceOptions) {
    this.store = store;
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.clock = options.clock ?? (() => new Date());
  }

  ensure(
    task: Pick<TaskRecord, "id" | "projectId">,
    options: { baseBranch?: string | undefined; baseSha?: string | undefined } = {}
  ): TaskWorktree {
    if (!task.projectId) throw new WorktreeError("PROJECT_REQUIRED", "任务没有关联本地项目", 400);
    validateTaskId(task.id);
    const project = this.store.getLocalProject(task.projectId);
    if (!project) throw new WorktreeError("PROJECT_NOT_FOUND", "项目不存在", 404);
    if (!existsSync(project.path) || !statSync(project.path).isDirectory()) {
      throw new WorktreeError("PROJECT_PATH_MISSING", "项目目录不存在", 409);
    }
    const root = git(["-C", project.path, "rev-parse", "--show-toplevel"]);
    if (!root.ok || !samePath(root.stdout.trim(), project.path)) {
      throw new WorktreeError("PROJECT_NOT_GIT", "项目不再是可用的 Git 仓库根目录", 409);
    }

    const branch = `hearth/${task.id}`;
    const branchFormat = git(["check-ref-format", "--branch", branch]);
    if (!branchFormat.ok) throw new WorktreeError("WORKTREE_BRANCH_INVALID", "任务分支名称无效", 400);
    const path = join(this.workspaceRoot, "worktrees", task.id);
    const now = this.clock().toISOString();
    const existing = this.store.getTaskWorktree(task.id);

    if (existing && existing.projectId === task.projectId && existsSync(path)) {
      this.assertUsable(existing, path, branch);
      return this.store.upsertTaskWorktree({ ...existing, updatedAt: now });
    }

    if (existing && existsSync(path)) {
      this.assertUsable(existing, path, branch);
      if (existing.projectId !== task.projectId) {
        throw new WorktreeError("WORKTREE_PROJECT_MISMATCH", "任务 Worktree 属于另一个项目", 409);
      }
      return this.store.upsertTaskWorktree({ ...existing, updatedAt: now });
    }

    if (existsSync(path)) {
      throw new WorktreeError("WORKTREE_PATH_EXISTS", "Worktree 路径已被占用", 409);
    }

    const baseBranch = existing?.baseBranch ?? options.baseBranch ?? project.defaultBranch;
    const baseSha = existing?.baseSha
      ?? options.baseSha
      ?? this.resolveCommit(project.path, baseBranch);
    const branchExists = git(["-C", project.path, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
    const args = branchExists
      ? ["-C", project.path, "worktree", "add", path, branch]
      : ["-C", project.path, "worktree", "add", "--no-track", "-b", branch, path, baseSha];
    const created = git(args);
    if (!created.ok) {
      throw new WorktreeError(
        "WORKTREE_CREATE_FAILED",
        created.stderr.trim() || "无法创建任务 Worktree",
        409
      );
    }

    return this.store.upsertTaskWorktree({
      taskId: task.id,
      projectId: task.projectId,
      path,
      branch,
      baseBranch,
      baseSha,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
  }

  view(taskId: string): TaskWorktreeView | null {
    const record = this.store.getTaskWorktree(taskId);
    if (!record) return null;
    if (!existsSync(record.path) || !statSync(record.path).isDirectory()) {
      return { ...record, available: false, dirty: false, error: "Worktree 目录不存在" };
    }
    const root = git(["-C", record.path, "rev-parse", "--show-toplevel"]);
    if (!root.ok || !samePath(root.stdout.trim(), record.path)) {
      return { ...record, available: false, dirty: false, error: "目录不是有效的 Git Worktree" };
    }
    if (!existsSync(join(record.path, ".git"))) {
      return { ...record, available: false, dirty: false, error: "目录缺少 Git 工作区标记" };
    }
    const branch = git(["-C", record.path, "branch", "--show-current"]).stdout.trim();
    if (branch !== record.branch) {
      return { ...record, available: false, dirty: false, error: `当前分支不是 ${record.branch}` };
    }
    const status = git(["-C", record.path, "status", "--porcelain"]);
    return {
      ...record,
      available: status.ok,
      dirty: status.ok && status.stdout.trim().length > 0,
      error: status.ok ? null : status.stderr.trim() || "无法读取 Worktree 状态"
    };
  }

  cleanup(taskId: string): { removed: boolean; branchKept: boolean } {
    const record = this.store.getTaskWorktree(taskId);
    if (!record) throw new WorktreeError("WORKTREE_NOT_FOUND", "任务没有 Worktree", 404);
    const project = this.store.getLocalProject(record.projectId);
    if (!project) throw new WorktreeError("PROJECT_NOT_FOUND", "项目不存在", 404);
    if (existsSync(record.path)) {
      const view = this.view(taskId);
      if (!view?.available) throw new WorktreeError("WORKTREE_UNAVAILABLE", view?.error ?? "Worktree 不可用", 409);
      if (view.dirty) {
        throw new WorktreeError("WORKTREE_DIRTY", "Worktree 有未提交改动，不能清理", 409);
      }
      const removed = git(["-C", project.path, "worktree", "remove", record.path]);
      if (!removed.ok) {
        throw new WorktreeError("WORKTREE_REMOVE_FAILED", removed.stderr.trim() || "无法移除 Worktree", 409);
      }
    } else {
      git(["-C", project.path, "worktree", "prune"]);
    }
    const deleted = git(["-C", project.path, "branch", "-d", record.branch]);
    this.store.deleteTaskWorktree(taskId);
    return { removed: true, branchKept: !deleted.ok };
  }

  private resolveCommit(projectPath: string, ref: string): string {
    const result = git(["-C", projectPath, "rev-parse", "--verify", `${ref}^{commit}`]);
    if (!result.ok || !result.stdout.trim()) {
      throw new WorktreeError("WORKTREE_BASE_NOT_FOUND", `无法解析项目基线：${ref}`, 409);
    }
    return result.stdout.trim();
  }

  private assertUsable(record: TaskWorktree, path: string, branch: string): void {
    if (!samePath(record.path, path)) {
      throw new WorktreeError("WORKTREE_PATH_MISMATCH", "Worktree 登记路径不一致", 409);
    }
    const root = git(["-C", path, "rev-parse", "--show-toplevel"]);
    if (!root.ok || !samePath(root.stdout.trim(), path)) {
      throw new WorktreeError("WORKTREE_UNAVAILABLE", "Worktree 目录不是有效的 Git 工作区", 409);
    }
    const current = git(["-C", path, "branch", "--show-current"]).stdout.trim();
    if (current !== branch) {
      throw new WorktreeError("WORKTREE_BRANCH_MISMATCH", `Worktree 当前分支不是 ${branch}`, 409);
    }
  }
}

function validateTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId) || taskId === "." || taskId === "..") {
    throw new WorktreeError("TASK_ID_INVALID", "任务标识不合法", 400);
  }
}

function samePath(left: string, right: string): boolean {
  return resolve(left).replace(/\\/g, "/").toLowerCase() === resolve(right).replace(/\\/g, "/").toLowerCase();
}

function git(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) return { ok: false, stdout: "", stderr: result.error.message };
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

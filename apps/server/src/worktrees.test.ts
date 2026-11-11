import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { HearthService } from "./service.ts";
import { ProjectService } from "./projects.ts";
import { TaskGitService } from "./task-git.ts";
import { TaskWorktreeService } from "./worktrees.ts";

describe("task worktrees", () => {
  let root: string;
  let repo: string;
  let workspace: string;
  let store: HearthStore;
  let projects: ProjectService;
  let projectId: string;
  let worktrees: TaskWorktreeService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-worktrees-"));
    repo = join(root, "repo");
    workspace = join(root, "workspaces");
    git(root, ["init", "-b", "main", repo]);
    git(repo, ["config", "user.name", "Hearth Test"]);
    git(repo, ["config", "user.email", "hearth@example.test"]);
    writeFileSync(join(repo, "README.md"), "base\n", "utf8");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    store = new HearthStore(":memory:");
    projects = new ProjectService(store);
    projectId = projects.create({ path: repo, name: "Repo" }).id;
    worktrees = new TaskWorktreeService(store, { workspaceRoot: workspace });
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates independent branches for concurrent tasks and reuses them on resume", () => {
    const first = worktrees.ensure({ id: "TASK-A", projectId });
    const second = worktrees.ensure({ id: "TASK-B", projectId });

    expect(first.path).not.toBe(second.path);
    expect(first.branch).toBe("hearth/TASK-A");
    expect(second.branch).toBe("hearth/TASK-B");
    expect(statSync(join(first.path, ".git")).isFile()).toBe(true);
    expect(worktrees.view("TASK-A")).toMatchObject({ available: true, dirty: false, error: null });

    const resumed = worktrees.ensure({ id: "TASK-A", projectId });
    expect(resumed.path).toBe(first.path);
    expect(resumed.baseSha).toBe(first.baseSha);
  });

  it("rejects dirty cleanup and keeps an unmerged task branch", () => {
    const worktree = worktrees.ensure({ id: "TASK-DIRTY", projectId });
    writeFileSync(join(worktree.path, "change.txt"), "dirty\n", "utf8");
    expect(worktrees.view("TASK-DIRTY")).toMatchObject({ available: true, dirty: true });
    expect(() => worktrees.cleanup("TASK-DIRTY"))
      .toThrowError(expect.objectContaining({ code: "WORKTREE_DIRTY" }));

    git(worktree.path, ["add", "change.txt"]);
    git(worktree.path, ["commit", "-m", "task change"]);
    const result = worktrees.cleanup("TASK-DIRTY");
    expect(result).toEqual({ removed: true, branchKept: true });
    expect(existsSync(worktree.path)).toBe(false);
    expect(store.getTaskWorktree("TASK-DIRTY")).toBeNull();
    expect(gitOutput(repo, ["branch", "--list", "hearth/TASK-DIRTY"]).trim()).not.toBe("");
  });

  it("rejects projects that are not Git roots", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    const now = new Date().toISOString();
    store.upsertLocalProject({
      id: "project-plain",
      name: "Plain",
      path: plain,
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now
    });
    expect(() => worktrees.ensure({ id: "TASK-PLAIN", projectId: "project-plain" }))
      .toThrowError(expect.objectContaining({ code: "PROJECT_NOT_GIT" }));
  });

  it("shows a worktree-backed repository with its recorded baseline", async () => {
    const worktree = worktrees.ensure({ id: "TASK-GIT", projectId });
    const taskGit = new TaskGitService({
      workspaceRoot: workspace,
      worktreeFor: (taskId) => store.getTaskWorktree(taskId)
    });
    const view = await taskGit.view("TASK-GIT");
    expect(view).toMatchObject({
      available: true,
      branch: "hearth/TASK-GIT",
      base: "main",
      baseSha: worktree.baseSha,
      clean: true
    });
  });

  it("defaults project tasks to native workspaces and rejects unsupported executors", () => {
    const service = new HearthService(store);
    const task = service.createTask({ title: "Project task", goal: "Change code", projectId });
    expect(task).toMatchObject({ projectId, executorId: "native", taskKind: "workspace" });
    expect(() => service.createTask({
      title: "Wrong executor",
      goal: "Change code",
      projectId,
      executorId: "codex"
    })).toThrowError(expect.objectContaining({ code: "PROJECT_EXECUTOR_UNSUPPORTED" }));
  });
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message || "unknown"}`);
  }
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(result.stderr || "git failed");
  return result.stdout;
}

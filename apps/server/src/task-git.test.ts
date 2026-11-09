import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "./github.ts";
import { GitViewError, TaskGitService } from "./task-git.ts";

describe("TaskGitService", () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("reports working changes, commits, and pull request checks", async () => {
    const paths = setup();
    writeFileSync(join(paths.repo, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(paths.repo, "notes.txt"), "one\ntwo\n");
    const run: CommandRunner = async (_command, args) => {
      const command = args.join(" ");
      if (command === "rev-parse HEAD") return out("a".repeat(40));
      if (command === "branch --show-current") return out("hearth/42\n");
      if (command === "remote get-url origin") return out("git@github.com:example/project.git\n");
      if (command === "symbolic-ref --short refs/remotes/origin/HEAD") return out("origin/main\n");
      if (command === "rev-parse --verify --quiet origin/main") return out("b".repeat(40));
      if (command.startsWith("status --porcelain=v1")) return out(` M src/a.ts\0?? notes.txt\0`);
      if (command.startsWith("diff --numstat HEAD")) return out("2\t0\tsrc/a.ts\n");
      if (command === `diff --name-status --find-renames ${"b".repeat(40)}...${"a".repeat(40)}`) return out("M\tsrc/b.ts\n");
      if (command === `diff --numstat ${"b".repeat(40)}...${"a".repeat(40)} --`) return out("3\t1\tsrc/b.ts\n");
      if (command === `rev-list --count ${"b".repeat(40)}..${"a".repeat(40)}`) return out("1\n");
      if (command.startsWith("log ")) return out(`${["aaaaaaa", "aaaaaaa", "Fix workbench", "Alice", "2026-11-08T10:00:00Z"].join("\x1f")}\n`);
      if (command.startsWith("pr list")) return out(JSON.stringify([{
        number: 42,
        url: "https://github.com/example/project/pull/42",
        title: "Fix workbench",
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        headRefOid: "a".repeat(40),
        updatedAt: "2026-11-08T10:05:00Z",
        statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci.example/test" }]
      }]));
      throw new Error(`unexpected command: ${command}`);
    };
    const service = new TaskGitService({ workspaceRoot: paths.workspace, run });

    const view = await service.view("TASK-1");
    expect(view.available).toBe(true);
    expect(view.repo).toBe("example/project");
    expect(view.branch).toBe("hearth/42");
    expect(view.filesScope).toBe("working");
    expect(view.files).toEqual([
      expect.objectContaining({ path: "src/a.ts", status: "modified", additions: 2, deletions: 0 }),
      expect.objectContaining({ path: "notes.txt", status: "untracked", additions: 2, deletions: 0 })
    ]);
    expect(view.branchFiles).toEqual([
      expect.objectContaining({ path: "src/b.ts", status: "modified", additions: 3, deletions: 1 })
    ]);
    expect(view.branchAdditions).toBe(3);
    expect(view.branchDeletions).toBe(1);
    expect(view.commitsAhead).toBe(1);
    expect(view.commits[0]?.subject).toBe("Fix workbench");
    expect(view.pullRequest?.number).toBe(42);
    expect(view.pullRequest?.checks[0]?.conclusion).toBe("SUCCESS");
  });

  it("reads files inside the task repository and rejects traversal", async () => {
    const paths = setup();
    writeFileSync(join(paths.repo, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(paths.workspace, "tasks", "TASK-1", "secret.txt"), "secret\n");
    const run: CommandRunner = async (_command, args) => {
      if (args.join(" ") === "show HEAD:src/a.ts") return out("export const a = 2;\n");
      throw new Error("unexpected command");
    };
    const service = new TaskGitService({ workspaceRoot: paths.workspace, run });

    const file = await service.file("TASK-1", "src/a.ts");
    expect(file.exists).toBe(true);
    expect(file.content).toContain("export const a = 1");
    const head = await service.file("TASK-1", "src/a.ts", true);
    expect(head.content).toContain("export const a = 2");
    await expect(service.file("TASK-1", "../secret.txt")).rejects.toBeInstanceOf(GitViewError);
  });

  it("rejects a file reached through a directory symlink outside the repository", async () => {
    const paths = setup();
    const outside = join(paths.workspace, "tasks", "TASK-1", "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "outside secret\n");
    symlinkSync(outside, join(paths.repo, "escape"), process.platform === "win32" ? "junction" : "dir");
    const run: CommandRunner = async () => {
      throw new Error("unexpected command");
    };
    const service = new TaskGitService({ workspaceRoot: paths.workspace, run });

    await expect(service.file("TASK-1", "escape/secret.txt")).rejects.toBeInstanceOf(GitViewError);
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "hearth-task-git-"));
    const workspace = join(root, "workspaces");
    const repo = join(workspace, "tasks", "TASK-1", "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    return { workspace, repo };
  }
});

function out(stdout: string) {
  return { stdout, stderr: "" };
}

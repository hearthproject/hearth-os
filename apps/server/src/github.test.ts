import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectRecord } from "@hearth/core";
import { describe, expect, it } from "vitest";
import {
  executeGitHubEffect,
  extractProposedComment,
  prepareGitHubWorkspace,
  validatePullRequestPreview,
  type CommandRunner,
  type RepositoryContext
} from "./github.ts";

const REPOSITORY: RepositoryContext = {
  path: "C:/tmp/repo",
  repo: "JasonBuildAI/GoldMind",
  branch: "hearth/t07-test",
  base: "main",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  issue: 16,
  pull: null,
  detached: false
};

describe("GitHub execution boundaries", () => {
  it("retries a transient clone failure before preparing the task", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "hearth-github-retry-"));
    try {
      let cloneCalls = 0;
      const run: CommandRunner = async (command, args) => {
        if (command === "git" && args[2] === "clone") {
          cloneCalls += 1;
          if (cloneCalls === 1) throw new Error("Connection was reset");
          mkdirSync(args[6] ?? "", { recursive: true });
          return { stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "config") return { stdout: "", stderr: "" };
        if (command === "git" && args[0] === "remote") return { stdout: "https://github.com/JasonBuildAI/GoldMind.git", stderr: "" };
        if (command === "gh" && args[0] === "repo" && args[1] === "view") {
          return { stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }), stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse") return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
        if (command === "gh" && args[0] === "issue" && args[1] === "view") {
          return {
            stdout: JSON.stringify({ number: 16, title: "Issue", body: "Body", state: "OPEN", url: "https://github.com/JasonBuildAI/GoldMind/issues/16", labels: [], comments: [] }),
            stderr: ""
          };
        }
        return { stdout: "", stderr: "" };
      };

      await prepareGitHubWorkspace({
        spec: { repo: "JasonBuildAI/GoldMind", issue: 16, branch: "test/health-secret-guard" },
        taskId: "T07-test",
        workspaceRoot,
        run
      });

      expect(cloneCalls).toBe(2);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("uses the explicit implementation branch from the task template", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "hearth-github-branch-"));
    try {
      const headSha = "a".repeat(40);
      const run: CommandRunner = async (command, args) => {
        if (command === "git" && args[2] === "clone") {
          mkdirSync(args[6] ?? "", { recursive: true });
          return { stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "config") return { stdout: "", stderr: "" };
        if (command === "git" && args[0] === "remote") return { stdout: "git@github.com:JasonBuildAI/GoldMind.git", stderr: "" };
        if (command === "gh" && args[0] === "repo" && args[1] === "view") {
          return { stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }), stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse") return { stdout: `${headSha}\n`, stderr: "" };
        if (command === "gh" && args[0] === "issue" && args[1] === "view") {
          return {
            stdout: JSON.stringify({ number: 16, title: "Issue", body: "Body", state: "OPEN", url: "https://github.com/JasonBuildAI/GoldMind/issues/16", labels: [], comments: [] }),
            stderr: ""
          };
        }
        return { stdout: "", stderr: "" };
      };

      const prepared = await prepareGitHubWorkspace({
        spec: { repo: "JasonBuildAI/GoldMind", issue: 16, branch: "test/health-secret-guard" },
        taskId: "T07-test",
        workspaceRoot,
        run
      });
      expect(prepared.repository.branch).toBe("test/health-secret-guard");
      expect(prepared.context.checks).toEqual([]);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("clones from the local cache without contacting GitHub", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-github-cache-"));
    const cacheRoot = join(root, "git-cache");
    const cachePath = join(cacheRoot, "JasonBuildAI__GoldMind.git");
    mkdirSync(cachePath, { recursive: true });
    const calls: string[] = [];
    try {
      const run: CommandRunner = async (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === "git" && args[0] === "clone") {
          mkdirSync(args[3] ?? "", { recursive: true });
          return { stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "remote") return { stdout: "", stderr: "" };
        if (command === "git" && args[0] === "config") return { stdout: "", stderr: "" };
        if (command === "gh" && args[0] === "repo" && args[1] === "view") {
          return { stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }), stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse" && args[1] === "--verify") {
          return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse") return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
        if (command === "gh" && args[0] === "issue" && args[1] === "view") {
          return {
            stdout: JSON.stringify({ number: 16, title: "Issue", body: "Body", state: "OPEN", url: "https://github.com/JasonBuildAI/GoldMind/issues/16", labels: [], comments: [] }),
            stderr: ""
          };
        }
        return { stdout: "", stderr: "" };
      };

      await prepareGitHubWorkspace({
        spec: { repo: "JasonBuildAI/GoldMind", issue: 16, branch: "test/health-secret-guard" },
        taskId: "T07-test",
        workspaceRoot: join(root, "workspace"),
        cacheRoot,
        run
      });

      expect(calls.some((call) => call.includes("credential.helper=!gh auth git-credential"))).toBe(false);
      expect(calls.some((call) => call.startsWith("git clone --no-tags"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a stale cached PR head instead of silently using it", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-github-stale-cache-"));
    const cacheRoot = join(root, "git-cache");
    const cachePath = join(cacheRoot, "JasonBuildAI__GoldMind.git");
    mkdirSync(cachePath, { recursive: true });
    const staleSha = "b".repeat(40);
    const expectedSha = "c".repeat(40);
    try {
      const run: CommandRunner = async (command, args) => {
        if (command === "git" && args[0] === "clone") {
          mkdirSync(args[3] ?? "", { recursive: true });
          return { stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "remote") return { stdout: "", stderr: "" };
        if (command === "git" && args[0] === "config") return { stdout: "", stderr: "" };
        if (command === "gh" && args[0] === "repo" && args[1] === "view") {
          return { stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }), stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse" && args[1] === "--verify") {
          return { stdout: `${staleSha}\n`, stderr: "" };
        }
        if (command === "git" && args[0] === "fetch") throw new Error("network unavailable");
        return { stdout: "", stderr: "" };
      };

      await expect(prepareGitHubWorkspace({
        spec: { repo: "JasonBuildAI/GoldMind", pull: 15, headSha: expectedSha },
        taskId: "T08-test",
        workspaceRoot: join(root, "workspace"),
        cacheRoot,
        run
      })).rejects.toThrow(/缓存.*已过期/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates a PR preview that is bound to the prepared branch and issue", () => {
    const preview = validatePullRequestPreview({
      title: "test: add health secret regression",
      body: "Closes #16\n\nAdds a regression test.",
      branch: REPOSITORY.branch,
      base: REPOSITORY.base
    }, REPOSITORY);
    expect(preview.title).toContain("health");
  });

  it("extracts only the proposed review comment from marked output", () => {
    const markdown = [
      "# Internal report",
      "",
      "<!-- HEARTH_COMMENT_START -->",
      "## Review",
      "",
      "Blocking issue.",
      "<!-- HEARTH_COMMENT_END -->",
      "",
      "Internal verification notes."
    ].join("\n");

    expect(extractProposedComment(markdown)).toBe("## Review\n\nBlocking issue.");
  });

  it("accepts the legacy proposed-comment markers", () => {
    const markdown = "Internal notes\nPROPOSED_COMMENT_START\nReview body\nPROPOSED_COMMENT_END\nMore notes";
    expect(extractProposedComment(markdown)).toBe("Review body");
  });

  it("rejects review output without explicit comment boundaries", () => {
    expect(() => extractProposedComment("# Review\n\nLooks fine.")).toThrow(/缺少评论正文标记/);
  });

  it("rejects a PR preview that changes the prepared branch", () => {
    expect(() => validatePullRequestPreview({
      title: "bad",
      body: "Closes #16",
      branch: "main",
      base: "main"
    }, REPOSITORY)).toThrow(/分支必须固定/);
  });

  it("returns an existing open PR without creating a duplicate", async () => {
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "branch") return { stdout: REPOSITORY.branch, stderr: "" };
      if (args[0] === "rev-parse") return { stdout: REPOSITORY.headSha, stderr: "" };
      if (args[0] === "status") return { stdout: "", stderr: "" };
      if (command === "git" && args[0] === "push") return { stdout: "", stderr: "" };
      if (command === "gh" && args[1] === "list") {
        return { stdout: JSON.stringify([{ number: 17, url: "https://github.com/JasonBuildAI/GoldMind/pull/17", headRefOid: REPOSITORY.headSha }]), stderr: "" };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    const result = await executeGitHubEffect(makeEffect("github.publish-pr", {
      repo: REPOSITORY.repo,
      workspace: REPOSITORY.path,
      branch: REPOSITORY.branch,
      base: REPOSITORY.base,
      expectedCommit: REPOSITORY.headSha,
      title: "test: safe PR",
      body: "Closes #16"
    }), run);

    expect(result.number).toBe(17);
    expect(result.idempotent).toBe(true);
    expect(calls.some((call) => call.startsWith("gh pr create"))).toBe(false);
  });

  it("never posts a comment when the PR head changed", async () => {
    let commentsPosted = 0;
    const run: CommandRunner = async (command, args) => {
      if (command === "gh" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            headRefOid: "c".repeat(40),
            url: "https://github.com/JasonBuildAI/GoldMind/pull/15",
            state: "OPEN",
            comments: []
          }),
          stderr: ""
        };
      }
      if (command === "gh" && args[1] === "comment") commentsPosted += 1;
      return { stdout: "", stderr: "" };
    };

    await expect(executeGitHubEffect(makeEffect("github.comment", {
      repo: REPOSITORY.repo,
      pull: 15,
      headSha: "d".repeat(40),
      body: "review"
    }), run)).rejects.toThrow(/head 已变化/);
    expect(commentsPosted).toBe(0);
  });

  it("recognizes a previously published comment by its idempotency marker", async () => {
    const effect = makeEffect("github.comment", {
      repo: REPOSITORY.repo,
      pull: 15,
      headSha: "d".repeat(40),
      body: "review"
    });
    const run: CommandRunner = async (command, args) => {
      if (command === "gh" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            headRefOid: "d".repeat(40),
            url: "https://github.com/JasonBuildAI/GoldMind/pull/15",
            state: "OPEN",
            comments: [{ body: `review\n<!-- hearth-effect:${effect.idempotencyKey} -->`, url: "https://github.com/comment/1" }]
          }),
          stderr: ""
        };
      }
      throw new Error("comment should not be posted twice");
    };
    const result = await executeGitHubEffect(effect, run);
    expect(result.idempotent).toBe(true);
    expect(result.commentUrl).toBe("https://github.com/comment/1");
  });
});

function makeEffect(kind: string, target: Record<string, unknown>): EffectRecord {
  return {
    id: "effect-test",
    taskId: "T07-test",
    approvalId: "approval-test",
    kind,
    idempotencyKey: "approval:approval-test:hash",
    status: "executing",
    target,
    receipt: null,
    error: null,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z"
  };
}

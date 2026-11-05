import type { EffectRecord } from "@hearth/core";
import { describe, expect, it } from "vitest";
import {
  executeGitHubEffect,
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
  it("validates a PR preview that is bound to the prepared branch and issue", () => {
    const preview = validatePullRequestPreview({
      title: "test: add health secret regression",
      body: "Closes #16\n\nAdds a regression test.",
      branch: REPOSITORY.branch,
      base: REPOSITORY.base
    }, REPOSITORY);
    expect(preview.title).toContain("health");
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

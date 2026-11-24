import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GoalContract, GoalCriterion } from "@hearth/core";
import { verifyGoalCompletion } from "./goal-verifier.ts";
import type { GoalCommandResult } from "./goal-command.ts";

describe("verifyGoalCompletion", () => {
  let root: string;
  let outDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-verifier-"));
    outDir = join(root, "out");
    mkdirSync(outDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes a file criterion only when the file exists in the workspace", async () => {
    writeFileSync(join(root, "done.txt"), "ok", "utf8");
    const report = await verify({ criteria: [criterion({ validator: "file", check: "done.txt" })] });
    expect(report.verdict).toBe("pass");
    expect(report.criteria[0]?.status).toBe("passed");
  });

  it("rejects absolute paths and traversal outside the workspace", async () => {
    const report = await verify({
      criteria: [criterion({ validator: "file", check: "../secret.txt" })]
    });
    expect(report.verdict).toBe("fail");
    expect(report.criteria[0]?.detail).toContain("越出");
  });

  it("fails closed when the model proposes a forbidden action", async () => {
    const report = await verify({
      criteria: [criterion({ validator: "file", check: "missing.txt" })],
      forbiddenActions: ["push"],
      actions: [{ kind: "git.push", summary: "push to origin main" }]
    });
    expect(report.verdict).toBe("fail");
    expect(report.forbiddenActions[0]).toContain("push");
  });

  it("never auto-passes a manual criterion", async () => {
    const report = await verify({ criteria: [criterion({ validator: "manual", check: "look at it" })] });
    expect(report.verdict).toBe("needs_human");
    expect(report.criteria[0]?.status).toBe("not_run");
  });

  it("requires explicit approval before a command criterion can pass", async () => {
    const unapproved = await verify({ criteria: [criterion({ validator: "command", check: "[\"npm\",\"test\"]" })] });
    expect(unapproved.verdict).toBe("needs_human");

    const approved = await verify({
      criteria: [criterion({ validator: "command", check: "[\"npm\",\"test\"]" })],
      commandsApprovedAt: new Date().toISOString(),
      runCommand: async () => okCommand()
    });
    expect(approved.verdict).toBe("pass");
  });

  it("uses an implicit review criterion when no explicit criteria exist", async () => {
    const noReview = await verify({ criteria: [] });
    expect(noReview.verdict).toBe("needs_human");
    expect(noReview.criteria[0]?.criterionId).toBe("objective");

    const pass = await verify({
      criteria: [],
      review: async () => '{"verdict":"pass","reason":"objective is met"}'
    });
    expect(pass.verdict).toBe("pass");

    const fail = await verify({
      criteria: [],
      review: async () => "FAIL: objective still open"
    });
    expect(fail.verdict).toBe("fail");
  });

  it("validates a JSON schema and reports field errors", async () => {
    writeFileSync(join(root, "result.json"), JSON.stringify({ count: 2 }), "utf8");
    const check = JSON.stringify({
      file: "result.json",
      schema: { type: "object", required: ["count", "name"], properties: { count: { type: "number" }, name: { type: "string" } } }
    });
    const missingField = await verify({ criteria: [criterion({ validator: "schema", check })] });
    expect(missingField.verdict).toBe("fail");
    expect(missingField.summary).toContain("name");

    writeFileSync(join(root, "result.json"), JSON.stringify({ count: 2, name: "ok" }), "utf8");
    const valid = await verify({ criteria: [criterion({ validator: "schema", check })] });
    expect(valid.verdict).toBe("pass");
  });

  it("requires declared evidence before passing", async () => {
    writeFileSync(join(root, "done.txt"), "ok", "utf8");
    const report = await verify({
      criteria: [criterion({ validator: "file", check: "done.txt" })],
      evidenceRequirements: ["evidence/report.md"]
    });
    expect(report.verdict).toBe("needs_human");
    expect(report.missingEvidence).toEqual(["evidence/report.md"]);
  });

  it("reads git state through the injected argv runner", async () => {
    const report = await verify({
      criteria: [criterion({ validator: "git", check: JSON.stringify({ branch: "main", clean: true }) })],
      runCommand: async (argv) => argv[1] === "branch"
        ? okCommand("main\n")
        : okCommand("")
    });
    expect(report.verdict).toBe("pass");
  });

  async function verify(input: {
    criteria: GoalCriterion[];
    forbiddenActions?: string[];
    evidenceRequirements?: string[];
    actions?: Array<{ kind: string; summary: string }>;
    commandsApprovedAt?: string;
    review?: ((prompt: string) => Promise<string | null>) | null;
    runCommand?: (argv: string[], cwd: string) => Promise<GoalCommandResult>;
  }) {
    const goal = goalOf(input.criteria, input.forbiddenActions, input.evidenceRequirements, input.commandsApprovedAt);
    return verifyGoalCompletion({
      goal,
      taskId: "task-1",
      roundRunId: "run-1",
      workspaceRoot: root,
      outDir,
      artifacts: [],
      actions: input.actions ?? [],
      review: input.review ?? null,
      ...(input.runCommand ? { runCommand: input.runCommand } : {})
    });
  }
});

function criterion(overrides: Partial<GoalCriterion>): GoalCriterion {
  return {
    id: "c1",
    description: "a check",
    validator: "file",
    check: "done.txt",
    required: true,
    ...overrides
  };
}

function goalOf(criteria: GoalCriterion[], forbiddenActions: string[] = [], evidenceRequirements: string[] = [], commandsApprovedAt?: string): GoalContract {
  const now = new Date().toISOString();
  return {
    goalId: "goal-1",
    title: "test",
    objective: "finish",
    constraints: [],
    forbiddenActions,
    authoritySources: [{ kind: "user", ref: "test" }],
    successCriteria: criteria,
    evidenceRequirements,
    budget: {},
    stopConditions: [],
    reviewPolicy: "human_on_risk",
    currentState: "active",
    createdAt: now,
    updatedAt: now,
    ...(commandsApprovedAt ? { commandsApprovedAt } : {})
  };
}

function okCommand(stdout = ""): GoalCommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", error: null };
}

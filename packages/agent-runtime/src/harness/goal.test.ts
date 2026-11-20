import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentToolContext } from "../types.ts";
import { createGoalTools, goalContinuationPrompt, goalFinishIssue, readGoalByRoot, recordGoalTurns } from "./goal.ts";

describe("persisted goal lifecycle", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function contextFor(root: string, out: string): AgentToolContext {
    mkdirSync(out, { recursive: true });
    return {
      workspaceRoot: root,
      outDir: out,
      permissions: { readRoots: [root], writeRoots: [root, out], networkHosts: [], tools: ["create_goal", "get_goal", "update_goal"] },
      signal: new AbortController().signal
    };
  }

  it("blocks finish while active and injects a continuation prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-goal-"));
    roots.push(root);
    const context = contextFor(root, join(root, "out"));
    const tools = createGoalTools();
    await tools.find((tool) => tool.definition.name === "create_goal")!.execute({
      title: "Ship P2",
      objective: "Finish long-horizon state",
      successCriteria: ["tests pass"],
      maxTurns: 6,
      planPath: ".hearth/plans/p2.md"
    }, context);

    expect(goalFinishIssue(root)).toContain("update_goal");
    const prompt = goalContinuationPrompt(root);
    expect(prompt).toContain("Ship P2");
    expect(prompt).toContain("0/6 turns");
    expect(prompt).toContain(".hearth/plans/p2.md");

    await tools.find((tool) => tool.definition.name === "update_goal")!.execute({ status: "completed", note: "verified" }, context);
    expect(goalFinishIssue(root)).toBeNull();
  });

  it("counts turns across runs without pausing on an advisory limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-goal-limit-"));
    roots.push(root);
    const context = contextFor(root, join(root, "out"));
    const create = createGoalTools().find((tool) => tool.definition.name === "create_goal")!;
    await create.execute({ title: "Long task", objective: "Keep going", maxTurns: 2 }, context);

    expect(recordGoalTurns(root, 1)).toMatchObject({ status: "active", turnsUsed: 1 });
    const continued = recordGoalTurns(root, 1);
    expect(continued).toMatchObject({ status: "active", turnsUsed: 2 });
    expect(readGoalByRoot(root)?.status).toBe("active");
    expect(goalFinishIssue(root)).toContain("update_goal");
    expect(goalContinuationPrompt(root)).toContain("Long task");
  });
});

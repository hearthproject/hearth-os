import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskRecord } from "@hearth/core";
import { getTemplate } from "@hearth/templates";
import { buildTaskPrompt, prepareWorkspace } from "./workspace.ts";

describe("task workspace prompt", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("includes the template acceptance criteria in the Codex prompt", () => {
    tempDir = mkdtempSync(join(tmpdir(), "hearth-prompt-"));
    const repoRoot = join(tempDir, "repo");
    const template = getTemplate("T01");
    if (!template) throw new Error("Missing T01 template");
    const task: TaskRecord = {
      id: "T01-test",
      templateId: "T01",
      title: template.title,
      goal: template.goal,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deadline: null,
      inputs: [{ kind: "text", label: "测试", value: "测试输入" }],
      networkHosts: [],
      outputDir: template.outputDir,
      currentRunId: null,
      nextAction: null,
      error: null
    };
    const prepared = prepareWorkspace({ repoRoot, workspaceDir: join(tempDir, "workspace"), task });
    const prompt = buildTaskPrompt(task, prepared, template.expectedOutputs, template.acceptance);
    expect(prompt).toContain("专项验收标准");
    expect(prompt).toContain("口头约定，需确认");
    expect(prompt).toContain("2026-11-11");
  });
});

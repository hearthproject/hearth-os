import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  it("includes the template acceptance criteria in the Codex prompt", async () => {
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
    const prepared = await prepareWorkspace({ repoRoot, workspaceDir: join(tempDir, "workspace"), task });
    const prompt = buildTaskPrompt(task, prepared, template.expectedOutputs, template.acceptance);
    expect(prompt).toContain("专项验收标准");
    expect(prompt).toContain("口头约定，需确认");
    expect(prompt).toContain("2026-11-11");
  });

  it("fetches URL inputs into a local Markdown snapshot before Codex runs", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "hearth-web-input-"));
    const task: TaskRecord = {
      id: "T04-test",
      templateId: "T04",
      title: "网页归档",
      goal: "归档网页",
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deadline: null,
      inputs: [{ kind: "url", label: "示例页面", value: "https://example.com/page" }],
      networkHosts: ["example.com"],
      outputDir: "eval/runs/T04",
      currentRunId: null,
      nextAction: null,
      error: null
    };
    const prepared = await prepareWorkspace({
      repoRoot: join(tempDir, "repo"),
      workspaceDir: join(tempDir, "workspace"),
      task,
      webFetch: async () => ({
        requestedUrl: "https://example.com/page",
        finalUrl: "https://example.com/page",
        fetchedAt: "2026-11-05T00:00:00.000Z",
        status: 200,
        contentType: "text/html",
        title: "示例",
        markdown: "# 示例\n\n正文",
        bytes: 42,
        sha256: "0".repeat(64)
      })
    });

    expect(prepared.inputs[0]?.kind).toBe("url");
    expect(readFileSync(prepared.inputs[0]?.localPath ?? "", "utf8")).toContain("正文");
    const source = JSON.parse(readFileSync(join(tempDir, "workspace", "inputs", "01-示例页面", "source.json"), "utf8"));
    expect(source.finalUrl).toBe("https://example.com/page");
    expect(source.fetchedAt).toBe("2026-11-05T00:00:00.000Z");
  });
});

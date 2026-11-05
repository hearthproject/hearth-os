import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskRecord } from "@hearth/core";
import { getTemplate } from "@hearth/templates";
import { WebInputError } from "./web-fetch.ts";
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

  it("permits minimal implementation changes without inviting unrelated repository edits", () => {
    const task: TaskRecord = {
      id: "T07-test",
      templateId: "T07",
      title: "按 Issue 实现并提交 PR",
      goal: "完成 Issue",
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deadline: null,
      inputs: [],
      networkHosts: [],
      outputDir: "eval/runs/T07",
      currentRunId: null,
      nextAction: null,
      error: null
    };
    const prompt = buildTaskPrompt(task, {
      root: "C:/workspace",
      outDir: "C:/workspace/out",
      inputs: [],
      repository: {
        path: "C:/workspace/repo",
        repo: "JasonBuildAI/GoldMind",
        branch: "test/health-secret-guard",
        base: "main",
        baseSha: "a".repeat(40),
        headSha: "a".repeat(40),
        pull: null,
        issue: 16,
        detached: false
      }
    }, ["report.md"], []);

    expect(prompt).toContain("实现任务");
    expect(prompt).toContain("只允许修改隔离仓库内完成 Issue 所必需的文件");
    expect(prompt).not.toContain("不要修改输入快照或仓库中的其他文件");
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
    expect(source.ok).toBe(true);
  });

  it("keeps a failed page as evidence instead of failing the whole task", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "hearth-web-failure-"));
    const task = webTask();
    const prepared = await prepareWorkspace({
      repoRoot: join(tempDir, "repo"),
      workspaceDir: join(tempDir, "workspace"),
      task,
      webFetch: async () => {
        throw new WebInputError("access_challenge", "网页要求登录、验证码或浏览器验证：https://example.com/page", {
          status: 403,
          finalUrl: "https://example.com/page"
        });
      }
    });

    expect(prepared.inputs[0]?.metadata?.ok).toBe(false);
    expect(readFileSync(prepared.inputs[0]?.localPath ?? "", "utf8")).toContain("网页抓取失败");
    const source = JSON.parse(readFileSync(join(tempDir, "workspace", "inputs", "01-示例页面", "source.json"), "utf8"));
    expect(source).toMatchObject({
      ok: false,
      errorCode: "access_challenge",
      status: 403,
      finalUrl: "https://example.com/page"
    });
  });

  it("still fails hard when a URL violates the task allowlist", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "hearth-web-blocked-"));
    await expect(prepareWorkspace({
      repoRoot: join(tempDir, "repo"),
      workspaceDir: join(tempDir, "workspace"),
      task: webTask(),
      webFetch: async () => {
        throw new WebInputError("host_not_allowed", "网页主机不在任务白名单中：example.org");
      }
    })).rejects.toThrow("白名单");
  });

  function webTask(): TaskRecord {
    return {
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
  }
});

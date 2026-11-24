import { describe, expect, it } from "vitest";
import { planExecution } from "./chat.ts";
import { resolveExecutorFromEnabled, resolveExecutorLocked } from "./executors.ts";
import { needsGithubRepository, wantsCodeExecution, wantsDirectFileRead, wantsGithubAccess, wantsPublicWebResearch, wantsScreenshot } from "./task-intent.ts";

describe("task intent", () => {
  it("does not require a report for a direct file read", () => {
    expect(planExecution("读取 E:/data/missing.txt")).toMatchObject({ executorId: "native", expectedOutputs: [] });
    expect(planExecution("读取文件并保存报告").expectedOutputs).toEqual([]);
    expect(wantsDirectFileRead("读取 E:/data/missing.txt")).toBe(true);
    expect(wantsDirectFileRead("看看这个文件")).toBe(true);
  });

  it("does not narrow a directory listing to the single-file reader", () => {
    expect(wantsDirectFileRead("看看我桌面有哪些文件")).toBe(false);
    expect(wantsDirectFileRead("列出桌面文件清单")).toBe(false);
    expect(wantsDirectFileRead("看看这个文件夹里有什么")).toBe(false);
    expect(planExecution("看看我桌面有哪些文件")).toMatchObject({ executorId: "native", expectedOutputs: [] });
  });

  it("recognizes desktop screenshot requests", () => {
    expect(wantsScreenshot("截一张我电脑桌面的图发给我")).toBe(true);
    expect(planExecution("截一张我电脑桌面的图发给我")).toMatchObject({
      executorId: "native",
      taskKind: "general",
      expectedOutputs: ["desktop.png"],
      capability: "desktop-capture"
    });
  });

  it("recognizes public web research without granting it to ordinary tasks", () => {
    expect(wantsPublicWebResearch("调研 2026 年本地优先 Agent 的最新进展")).toBe(true);
    expect(wantsPublicWebResearch("搜索公开资料并整理引用")).toBe(true);
    expect(wantsPublicWebResearch("给我整理出一份今天的每日新闻简报")).toBe(true);
    expect(wantsPublicWebResearch("整理今天的科技资讯并列出热点")).toBe(true);
    expect(wantsPublicWebResearch("把这份会议记录整理成周报")).toBe(false);
  });

  it("recognizes tasks that need a code workspace and test execution", () => {
    expect(wantsCodeExecution("定位根因、修改最小代码并留下测试结果")).toBe(true);
    expect(wantsCodeExecution("根据 CI 日志定位回归")).toBe(true);
    expect(wantsCodeExecution("补全 API 契约测试")).toBe(true);
    expect(wantsCodeExecution("把这份会议记录整理成周报")).toBe(false);
  });

  it("requires a github-capable executor for PR work", () => {
    expect(wantsGithubAccess("帮我审核并列出待处理的 PR")).toBe(true);
    expect(planExecution("帮我审核并列出待处理的 PR")).toMatchObject({
      executorId: "codex",
      taskKind: "workspace",
      capability: "github",
      networkHosts: ["github.com", "api.github.com"]
    });
    const resolution = resolveExecutorFromEnabled(
      "codex",
      { native: true, codex: false, "deepseek-harness": false },
      { native: true, codex: true, "deepseek-harness": true },
      "github"
    );
    expect(resolution).toMatchObject({ executorId: "native", reroutedFrom: "codex" });
    expect(needsGithubRepository("帮我审核并列出待处理的 PR")).toBe(true);
    expect(needsGithubRepository("介绍一下 https://github.com/acme/demo 的用途")).toBe(false);
  });

  it("still reroutes ordinary work when codex is off", () => {
    const resolution = resolveExecutorFromEnabled(
      "codex",
      { native: true, codex: false, "deepseek-harness": false },
      { native: true, codex: true, "deepseek-harness": true }
    );
    expect(resolution).toMatchObject({ executorId: "native", reroutedFrom: "codex" });
  });

  it("does not reroute a locked executor that lacks capability", () => {
    const resolution = resolveExecutorLocked(
      "codex",
      { native: true, codex: true, "deepseek-harness": false },
      { native: true, codex: true, "deepseek-harness": true },
      "desktop-capture"
    );
    expect(resolution.executorId).toBeNull();
    expect(resolution.reason).toContain("不支持");
  });
});


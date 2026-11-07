import { describe, expect, it } from "vitest";
import { planExecution } from "./chat.ts";
import { resolveExecutorFromEnabled } from "./executors.ts";
import { needsGithubRepository, wantsGithubAccess, wantsScreenshot } from "./task-intent.ts";

describe("task intent", () => {
  it("recognizes desktop screenshot requests", () => {
    expect(wantsScreenshot("截一张我电脑桌面的图发给我")).toBe(true);
    expect(planExecution("截一张我电脑桌面的图发给我")).toMatchObject({
      executorId: "native",
      taskKind: "general",
      expectedOutputs: ["desktop.png"],
      capability: "desktop-capture"
    });
  });

  it("requires a github-capable executor for PR work", () => {
    expect(wantsGithubAccess("帮我审核并列出待处理的 PR")).toBe(true);
    expect(planExecution("帮我审核并列出待处理的 PR")).toMatchObject({
      executorId: "codex",
      taskKind: "workspace",
      capability: "github"
    });
    const resolution = resolveExecutorFromEnabled(
      "codex",
      { native: true, codex: false, hermes: false, qoder: false, workbuddy: false, zcode: false, kimi: false },
      { native: true, codex: true, hermes: true, qoder: false, workbuddy: false, zcode: false, kimi: false },
      "github"
    );
    expect(resolution.executorId).toBeNull();
    expect(resolution.reason).toContain("GitHub");
    expect(needsGithubRepository("帮我审核并列出待处理的 PR")).toBe(true);
    expect(needsGithubRepository("介绍一下 https://github.com/acme/demo 的用途")).toBe(false);
  });

  it("still reroutes ordinary work when codex is off", () => {
    const resolution = resolveExecutorFromEnabled(
      "codex",
      { native: true, codex: false, hermes: false, qoder: false, workbuddy: false, zcode: false, kimi: false },
      { native: true, codex: true, hermes: true, qoder: false, workbuddy: false, zcode: false, kimi: false }
    );
    expect(resolution).toMatchObject({ executorId: "native", reroutedFrom: "codex" });
  });
});

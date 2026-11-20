import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelSettings } from "./model-settings.ts";
import { verifyFirstTask } from "./onboarding-verify.ts";

const settings = { protocol: "openai-chat" } as ModelSettings;

describe("first task verification", () => {
  it("passes only when the model writes the answer and the run completes", async () => {
    let root = "";
    const result = await verifyFirstTask(settings, undefined, async (options) => {
      root = options.prepared.root;
      writeFileSync(join(root, "answer.txt"), "hearth\n", "utf8");
      return { status: "completed", turns: 2, finalResponse: "done" };
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.filesChanged).toContain("answer.txt");
    expect(existsSync(root)).toBe(false);
  });

  it("reports an actionable failure when the run does not complete", async () => {
    const result = await verifyFirstTask(settings, undefined, async () => ({
      status: "failed",
      turns: 1,
      finalResponse: "模型没有调用工具"
    }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("没有调用工具");
  });

  it("rejects an answer that does not match", async () => {
    const result = await verifyFirstTask(settings, undefined, async (options) => {
      writeFileSync(join(options.prepared.root, "answer.txt"), "wrong\n", "utf8");
      return { status: "completed", turns: 1, finalResponse: "done" };
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name.includes("answer.txt"))?.passed).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildDshPatch,
  dshPermissionMode,
  ordinaryQuestionMarkdown,
  planReviewMarkdown,
  promptForRun,
  runDeepSeekHarness,
  type DeepSeekHarnessRunOptions
} from "./index.ts";

function options(overrides: Partial<DeepSeekHarnessRunOptions["settings"]> = {}): DeepSeekHarnessRunOptions {
  return {
    settings: {
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:1",
      model: "test-model",
      apiKey: "test-key",
      ...overrides
    },
    dshHome: ".test-dsh",
    workingDirectory: ".",
    outDir: ".",
    prompt: "test",
    mode: "necessary",
    maxTurns: 1,
    runBudgetSeconds: 30
  };
}

describe("runDeepSeekHarness runtime loading", () => {
  it("loads the optional SDK lazily and validates settings", async () => {
    await expect(runDeepSeekHarness(options({ model: "" }))).rejects.toMatchObject({
      code: "DSH_MODEL_INCOMPLETE"
    });
  });
});

describe("buildDshPatch", () => {
  it("loads Hearth library tools through the standard MCP client", () => {
    const patch = buildDshPatch({
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:1",
      model: "test-model",
      apiKey: "test-key"
    }, {
      hearth: { command: "node.exe", args: ["library-mcp.mjs"], env: { HEARTH_BASE_URL: "http://127.0.0.1:4317" } }
    });
    expect(patch).toContain("id: mcp-hearth");
    expect(patch).toContain("serverName: \"hearth\"");
    expect(patch).toContain("command: \"node.exe\"");
    expect(patch).toContain("HEARTH_BASE_URL: \"http://127.0.0.1:4317\"");
  });
});

describe("DSH plan mode", () => {
  it("enters /plan with a hard read-only permission that cannot be widened", () => {
    const planOptions = {
      ...options(),
      planMode: true,
      mode: "full" as const,
      permissionMode: "danger-full-access" as const,
      prompt: "inspect the repository"
    };
    expect(dshPermissionMode(planOptions)).toBe("read-only");
    expect(promptForRun(planOptions)).toBe("/plan inspect the repository");
  });

  it("captures only the full plan-review detail and ignores ordinary questions", () => {
    expect(planReviewMarkdown([
      { intent: { kind: "clarify" }, detail: "Which branch?" },
      { intent: { kind: "plan-review" }, detail: "## 调查结论\n\n- inspected" },
      { intent: { kind: "plan-review" }, detail: "## 执行步骤\n\n1. implement" }
    ])).toBe("## 调查结论\n\n- inspected\n\n## 执行步骤\n\n1. implement");
  });

  it("captures ordinary clarification text without treating it as a plan", () => {
    expect(ordinaryQuestionMarkdown([
      { intent: { kind: "plan-review" }, question: "Review plan", detail: "## 执行步骤" },
      { question: "Which branch should I use?", detail: "Choose the target branch." }
    ])).toBe("Which branch should I use?\n\nChoose the target branch.");
  });
});

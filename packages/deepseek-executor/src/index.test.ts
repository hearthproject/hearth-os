import { describe, expect, it } from "vitest";
import { buildDshPatch, runDeepSeekHarness, type DeepSeekHarnessRunOptions } from "./index.ts";

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

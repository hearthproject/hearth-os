import { describe, expect, it } from "vitest";
import { runDeepSeekHarness, type DeepSeekHarnessRunOptions } from "./index.ts";

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

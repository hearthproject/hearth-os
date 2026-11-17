import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskRecord } from "@hearth/core";
import { runNativeTask } from "./native-executor.ts";
import type { ModelSettings } from "./model-settings.ts";

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function options() {
  const root = mkdtempSync(join(tmpdir(), "hearth-draft-")); roots.push(root);
  const outDir = join(root, "out", "new-run"); mkdirSync(outDir, { recursive: true });
  return {
    task: { id: "draft", title: "请假信", goal: "帮我拟一封请假信并保存为 result.md", inputs: [], networkHosts: [], executionMode: "quick", expectedOutputs: ["result.md"] } as unknown as TaskRecord,
    prepared: { root, outDir, inputs: [] },
    settings: { model: "test", apiKey: "key", baseUrl: "https://example.com/v1", protocol: "openai-chat" } as ModelSettings,
    prompt: "已有草稿：老师您好，我感冒了，明天返校。用户补充：我叫小兰。", expectedOutputs: ["result.md"], signal: new AbortController().signal
  };
}
it("generates once and saves once to the current run with normal authorization", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "老师您好，我是小兰。今天感冒不适，申请请假，明天返校。" } }], usage: { prompt_tokens: 100, completion_tokens: 30 } }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const input = options();
  const authorize = vi.fn(async () => ({ allowed: true as const }));
  const result = await runNativeTask({ ...input, onAuthorizeTool: authorize });
  expect(result.status).toBe("completed");
  expect(result.turns).toBe(1);
  expect(result.toolCalls).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(input.prepared.outDir, "result.md"), "utf8")).toContain("我是小兰");
  expect(result.usage.inputTokens).toBe(100);
});
it("does not generate again or switch tools when a draft write is denied", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "请假信正文" } }], usage: { prompt_tokens: 100, completion_tokens: 30 } }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const authorize = vi.fn(async () => ({ allowed: false as const, reason: "denied" }));
  const result = await runNativeTask({ ...options(), onAuthorizeTool: authorize });
  expect(result.status).toBe("failed");
  expect(result.finalResponse).toContain("denied");
  expect(result.usage.inputTokens).toBe(100);
  expect(result.toolCalls).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(authorize).toHaveBeenCalledTimes(1);
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent, zeroUsage } from "./runtime.ts";
import { createBuiltinTools } from "./tools.ts";
import { createFakeModel, fakeToolCall, fakeUsage, type FakeModelStep } from "./test-support/fake-model.ts";
import type { AgentCheckpoint, AgentTool, RuntimeEvent } from "./types.ts";

describe("agent runtime long-run fixtures", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("runs a long tool loop deterministically without a budget", async () => {
    const root = workspace(roots);
    const steps: FakeModelStep[] = [];
    for (let i = 0; i < 40; i++) {
      steps.push({
        content: `step ${i}`,
        toolCalls: [fakeToolCall("echo", { value: `v${i}` })],
        usage: fakeUsage(1_000 + i, 20),
        finishReason: "tool_calls"
      });
    }
    steps.push({ content: "done", toolCalls: [fakeToolCall("finish_task", { summary: "完成" })], usage: fakeUsage(2_000, 10), finishReason: "tool_calls" });

    const fake = createFakeModel(steps);
    const checkpoints: AgentCheckpoint[] = [];
    const result = await runAgent({
      model: fake.model,
      tools: [echoTool(), ...createBuiltinTools()],
      goal: "long run",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["echo", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); }
    });

    expect(result.status).toBe("completed");
    expect(result.turns).toBe(41);
    expect(result.toolCalls).toBe(41);
    expect(fake.state.calls).toBe(41);
    expect(result.usage.inputTokens).toBe(1_000 * 40 + 39 * 20 + 2_000);
    expect(result.usage.outputTokens).toBe(40 * 20 + 10);
    expect(checkpoints.some((checkpoint) => checkpoint.kind === "final")).toBe(true);
    expect(checkpoints.length).toBeGreaterThanOrEqual(42);
    expect(fake.state.requests.at(-1)?.tools.some((tool) => tool.name === "echo")).toBe(true);
  });

  it("records checkpoint failures without losing the run", async () => {
    const root = workspace(roots);
    const fake = createFakeModel([
      { content: "", toolCalls: [fakeToolCall("echo", { value: "a" })], finishReason: "tool_calls" },
      { content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
    ]);
    const events: RuntimeEvent[] = [];
    let checkpointCalls = 0;
    const result = await runAgent({
      model: fake.model,
      tools: [echoTool(), ...createBuiltinTools()],
      goal: "checkpoint failure",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["echo", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      onEvent: (event) => { events.push(event); },
      onCheckpoint: () => {
        checkpointCalls += 1;
        if (checkpointCalls === 2) throw new Error("disk full");
      }
    });

    expect(events.filter((event) => event.type === "checkpoint.failed").length).toBe(1);
    expect(fake.state.calls).toBe(2);
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("keeps the full request history available to fixtures", async () => {
    const root = workspace(roots);
    const fake = createFakeModel([
      { content: "", toolCalls: [fakeToolCall("echo", { value: "a" })], usage: fakeUsage(100, 5), finishReason: "tool_calls" },
      { content: "", toolCalls: [fakeToolCall("echo", { value: "b" })], usage: fakeUsage(120, 6), finishReason: "tool_calls" },
      { content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], usage: fakeUsage(140, 7), finishReason: "tool_calls" }
    ]);
    const result = await runAgent({
      model: fake.model,
      tools: [echoTool(), ...createBuiltinTools()],
      goal: "history",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["echo", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {}
    });

    expect(result.status).toBe("completed");
    expect(fake.state.requests).toHaveLength(3);
    expect(fake.state.requests[0]?.messages.length).toBeLessThan(fake.state.requests[2]?.messages.length ?? 0);
    expect(fake.state.requests[2]?.messages.some((message) => message.role === "tool")).toBe(true);
  });
});

function echoTool(): AgentTool {
  return {
    definition: { name: "echo", description: "echo a value", parameters: { type: "object", properties: { value: { type: "string" } } }, executionMode: "parallel" },
    async execute(input) {
      return { content: String((input as { value?: unknown }).value ?? "") };
    }
  };
}

function workspace(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-longrun-"));
  roots.push(root);
  return root;
}

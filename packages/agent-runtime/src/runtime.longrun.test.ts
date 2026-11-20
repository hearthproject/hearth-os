import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent, zeroUsage } from "./runtime.ts";
import { createAgentState } from "./harness/file-state.ts";
import { finishActiveWork } from "./harness/active-work.ts";
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

  it("stops the run when a checkpoint cannot be persisted", async () => {
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

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("检查点保存失败");
    expect(events.filter((event) => event.type === "checkpoint.failed").length).toBe(1);
    expect(fake.state.calls).toBe(1);
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("continues after checkpoint failure when the policy is warn", async () => {
    const root = workspace(roots);
    const fake = createFakeModel([
      { content: "", toolCalls: [fakeToolCall("echo", { value: "a" })], finishReason: "tool_calls" },
      { content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
    ]);
    let checkpointCalls = 0;
    const result = await runAgent({
      model: fake.model,
      tools: [echoTool(), ...createBuiltinTools()],
      goal: "checkpoint warn",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["echo", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      checkpointFailurePolicy: "warn",
      onCheckpoint: () => {
        checkpointCalls += 1;
        if (checkpointCalls === 2) throw new Error("disk full");
      }
    });

    expect(result.status).toBe("completed");
    expect(fake.state.calls).toBe(2);
  });

  it("keeps the full request history available to fixtures", async () => {
    const root = workspace(roots);
    const events: RuntimeEvent[] = [];
    const fake = createFakeModel([
      { content: "", toolCalls: [fakeToolCall("echo", { value: "a" })], usage: fakeUsage(100, 5), finishReason: "tool_calls" },
      { content: "", toolCalls: [fakeToolCall("echo", { value: "b" })], usage: fakeUsage(120, 6), finishReason: "tool_calls" },
      { content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], usage: fakeUsage(140, 7), finishReason: "tool_calls" }
    ]);
    const result = await runAgent({
      model: fake.model,
      modelId: "fake-model",
      tools: [echoTool(), ...createBuiltinTools()],
      goal: "history",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["echo", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      onEvent: (event) => { events.push(event); }
    });

    expect(result.status).toBe("completed");
    expect(fake.state.requests).toHaveLength(3);
    expect(fake.state.requests[0]?.messages.length).toBeLessThan(fake.state.requests[2]?.messages.length ?? 0);
    expect(fake.state.requests[2]?.messages.some((message) => message.role === "tool")).toBe(true);
    const snapshots = events.filter((event) => event.type === "context.snapshot");
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toMatchObject({ turn: 1, modelId: "fake-model", source: "estimate", providerInputTokens: null, toolCount: 2 });
    expect(snapshots[1]).toMatchObject({ turn: 2, source: "provider", providerInputTokens: 100, providerOutputTokens: 5 });
    expect(result.metrics).toMatchObject({ contextSource: "provider", compactions: 0, modelId: "fake-model" });
    expect(result.metrics?.contextPeaks).toHaveLength(3);
  });

  it("journals in-flight tool execution and clears it after checkpoint", async () => {
    const root = workspace(roots);
    const outDir = join(root, "out");
    const marker = join(outDir, ".hearth", "executing.json");
    mkdirSync(join(outDir, ".hearth"), { recursive: true });
    let sawMarker = false;
    const slowTool: AgentTool = {
      definition: { name: "slow", description: "slow", parameters: { type: "object", properties: {} }, executionMode: "sequential" },
      async execute() {
        sawMarker = existsSync(marker);
        return { content: "ok" };
      }
    };
    const fake = createFakeModel([
      { content: "", toolCalls: [fakeToolCall("slow", {})], finishReason: "tool_calls" },
      { content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
    ]);
    const result = await runAgent({
      model: fake.model,
      tools: [slowTool, ...createBuiltinTools()],
      goal: "journal",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir,
      permissions: { tools: ["slow", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {}
    });

    expect(result.status).toBe("completed");
    expect(sawMarker).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses to finish while background work is running", async () => {
    const root = workspace(roots);
    const outDir = join(root, "out");
    const state = createAgentState(root);
    state.activeWork = [{ id: "sh_test", kind: "shell", status: "running", label: "npm run dev", startedAt: Date.now() }];
    const releaseTool: AgentTool = {
      definition: { name: "release", description: "release", parameters: { type: "object", properties: {} } },
      async execute(_input, context) {
        finishActiveWork(context.state, "sh_test", "completed", 0);
        return { content: "released" };
      }
    };
    const fake = createFakeModel([
      { content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" },
      { content: "", toolCalls: [fakeToolCall("release", {})], finishReason: "tool_calls" },
      { content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
    ]);
    const result = await runAgent({
      model: fake.model,
      tools: [releaseTool, ...createBuiltinTools()],
      goal: "active work",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir,
      permissions: { tools: ["release", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      state
    });

    expect(result.status).toBe("completed");
    expect(result.messages.some((message) => message.role === "tool" && message.content.includes("后台工作未结束"))).toBe(true);
    expect(state.activeWork?.[0]?.status).toBe("completed");
  });

  it("marks background work lost on resume and tells the model", async () => {
    const root = workspace(roots);
    const state = createAgentState(root);
    state.activeWork = [{ id: "sh_test", kind: "shell", status: "running", label: "npm run dev", startedAt: Date.now() }];
    const fake = createFakeModel([
      { content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
    ]);
    const events: RuntimeEvent[] = [];
    const result = await runAgent({
      model: fake.model,
      tools: createBuiltinTools(),
      goal: "resume",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      resume: {
        messages: [{ role: "system", content: "system" }, { role: "user", content: "goal" }],
        usage: zeroUsage(),
        turns: 0,
        toolCalls: 0,
        state
      },
      onEvent: (event) => { events.push(event); }
    });

    expect(result.status).toBe("completed");
    expect(state.activeWork?.[0]?.status).toBe("lost");
    expect(events.some((event) => event.type === "notice" && event.message.includes("标记为 lost"))).toBe(true);
  });

  it("pauses auto compaction after three compactions in three turns", async () => {
    const root = workspace(roots);
    const steps: FakeModelStep[] = [];
    for (let i = 0; i < 4; i++) {
      steps.push({ content: "", toolCalls: [fakeToolCall("echo", { value: `v${i}` })], finishReason: "tool_calls" });
    }
    steps.push({ content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" });
    const fake = createFakeModel(steps);
    const events: RuntimeEvent[] = [];
    const result = await runAgent({
      model: fake.model,
      tools: [echoTool(), ...createBuiltinTools()],
      goal: "breaker",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["echo", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      contextWindowTokens: 1,
      contextReserveTokens: 0,
      onEvent: (event) => { events.push(event); }
    });

    expect(result.status).toBe("completed");
    expect(result.metrics?.compactions).toBeLessThanOrEqual(3);
    expect(events.some((event) => event.type === "notice" && event.message.includes("暂停 5 轮"))).toBe(true);
  });

  it("records prompt snapshots and warns when a resume prompt changed", async () => {
    const root = workspace(roots);
    const fake = createFakeModel([
      { content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
    ]);
    const checkpoints: AgentCheckpoint[] = [];
    await runAgent({
      model: fake.model,
      tools: createBuiltinTools(),
      goal: "prompt",
      systemPrompt: "version-a",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); }
    });
    expect(checkpoints.at(-1)?.promptHash).toBeTruthy();

    const events: RuntimeEvent[] = [];
    await runAgent({
      model: createFakeModel([
        { content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
      ]).model,
      tools: createBuiltinTools(),
      goal: "prompt",
      systemPrompt: "version-b",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      resume: {
        messages: [{ role: "system", content: "version-a" }, { role: "user", content: "goal" }],
        usage: zeroUsage(),
        turns: 0,
        toolCalls: 0,
        promptHash: "different"
      },
      onEvent: (event) => { events.push(event); }
    });

    expect(events.some((event) => event.type === "notice" && event.message.includes("系统提示或工具定义"))).toBe(true);
  });

  it("continues an active goal when the model stops without tools", async () => {
    const root = workspace(roots);
    writeGoal(root, { maxTurns: 0 });
    const fake = createFakeModel([
      { content: "阶段一完成", toolCalls: [], finishReason: "stop" },
      { content: "阶段二完成", toolCalls: [], finishReason: "stop" },
      { content: "阶段三完成", toolCalls: [], finishReason: "stop" },
      { content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
    ]);
    const result = await runAgent({
      model: fake.model,
      tools: createBuiltinTools(),
      goal: "goal",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {}
    });

    expect(result.status).toBe("completed");
    expect(fake.state.calls).toBe(4);
    expect(result.messages.some((message) => message.role === "user" && message.content.includes("Persisted goal"))).toBe(true);
  });

  it("returns waiting_input when an active goal reaches maxTurns", async () => {
    const root = workspace(roots);
    writeGoal(root, { maxTurns: 1 });
    const fake = createFakeModel([
      { content: "one", toolCalls: [], finishReason: "stop" },
      { content: "two", toolCalls: [], finishReason: "stop" }
    ]);
    const result = await runAgent({
      model: fake.model,
      tools: createBuiltinTools(),
      goal: "goal",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {}
    });

    expect(result.status).toBe("waiting_input");
    expect(result.summary).toContain("轮上限");
    expect(fake.state.calls).toBe(1);
  });

  it("reports and clears a stale execution marker before starting", async () => {
    const root = workspace(roots);
    const outDir = join(root, "out");
    const marker = join(outDir, ".hearth", "executing.json");
    mkdirSync(join(outDir, ".hearth"), { recursive: true });
    writeFileSync(marker, JSON.stringify({ tool: "write_file", callId: "stale", startedAt: "2026-01-01T00:00:00.000Z" }), "utf8");
    const fake = createFakeModel([
      { content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
    ]);
    const events: RuntimeEvent[] = [];
    const result = await runAgent({
      model: fake.model,
      tools: createBuiltinTools(),
      goal: "stale marker",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir,
      permissions: { tools: ["finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      onEvent: (event) => { events.push(event); }
    });

    expect(result.status).toBe("completed");
    expect(existsSync(marker)).toBe(false);
    expect(events.some((event) => event.type === "notice" && event.message.includes("上一轮工具执行未确认完成"))).toBe(true);
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

function writeGoal(root: string, options: { maxTurns: number }): void {
  mkdirSync(join(root, ".hearth"), { recursive: true });
  writeFileSync(join(root, ".hearth", "goal.json"), JSON.stringify({
    goalId: "goal_test",
    title: "Long goal",
    objective: "finish the work",
    constraints: [],
    successCriteria: ["done"],
    status: "active",
    note: null,
    maxTurns: options.maxTurns,
    turnsUsed: 0,
    planPath: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, null, 2), "utf8");
}

function workspace(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-longrun-"));
  roots.push(root);
  return root;
}

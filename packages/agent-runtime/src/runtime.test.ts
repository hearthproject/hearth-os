import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compactAgentMessages, compactAgentMessagesWithSummary } from "./compaction.ts";
import { runAgent, zeroUsage } from "./runtime.ts";
import { createBuiltinTools, defaultTaskPermissions } from "./tools.ts";
import type { AgentCheckpoint, AgentModel, AgentModelTurn, AgentTool, AgentToolCall, RuntimeEvent } from "./types.ts";

describe("agent runtime", () => {
  it("cancels promptly even when a model ignores the abort signal", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let complete!: (value: AgentModelTurn) => void;
    const running = runAgent({
      model: async () => { started(); return new Promise<AgentModelTurn>((resolve) => { complete = resolve; }); },
      tools: [], goal: "read a file", systemPrompt: "system", workspaceRoot: ".", outDir: ".",
      permissions: { tools: [], readRoots: [], writeRoots: [], networkHosts: [] },
      signal: controller.signal, budget: {}
    });
    await ready;
    controller.abort();
    try {
      expect((await running).status).toBe("cancelled");
    } finally {
      complete(turn("late answer", []));
    }
  }, 2000);
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.each([undefined, 128_000])("trims tool results before the next model call with window %s", async (contextWindowTokens) => {
    let calls = 0;
    const measured: RuntimeEvent[] = [];
    const result = await runAgent({
      model: async (messages) => {
        calls++;
        if (calls === 1) return turn("", [call("large", {})]);
        const output = messages.find((message) => message.role === "tool");
        expect(output?.content.startsWith("x".repeat(4_800))).toBe(true);
        expect(output?.content).toContain("chars omitted from older tool output");
        expect(output?.content.length).toBeLessThan(9_000);
        return { ...turn("done", []), usage: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 10, cacheWriteInputTokens: 2, reasoningOutputTokens: 3 } };
      },
      tools: [{ definition: { name: "large", description: "large output", parameters: {} }, execute: async () => ({ content: "x".repeat(30_000) }) }],
      goal: "test", systemPrompt: "system", workspaceRoot: ".", outDir: ".",
      permissions: { tools: ["large"], readRoots: [], writeRoots: [], networkHosts: [] },
      keepRecentToolOutputs: 0,
      budget: { maxTurns: 5, maxToolCalls: 5, maxTokens: 100_000, maxDurationMs: 30_000 },
      onEvent: (event) => measured.push(event),
      ...(contextWindowTokens ? { contextWindowTokens } : {})
    });
    expect(result.status).toBe("completed");
    expect(result.usage).toMatchObject({ cachedInputTokens: 10, cacheWriteInputTokens: 2, reasoningOutputTokens: 3 });
    const usageEvent = measured.find((event) => event.type === "context.usage");
    expect(usageEvent).toMatchObject({ inputTokens: 20, outputTokens: 5, cachedInputTokens: 10 });
    expect(usageEvent?.type === "context.usage" ? usageEvent.toolSchemaChars : 0).toBeGreaterThan(0);
  });

  it("registers and settles jobs in runtime events and the run journal", async () => {
    const root = workspace(roots);
    const journalPath = join(root, "run.jsonl");
    const events: RuntimeEvent[] = [];
    let calls = 0;
    const result = await runAgent({
      model: async () => {
        calls += 1;
        return calls === 1 ? turn("start job", [call("job_tool", {})]) : turn("done", []);
      },
      tools: [{
        definition: { name: "job_tool", description: "job", parameters: {} },
        execute: async () => ({ content: "job result", metadata: { jobId: "job-1", jobKind: "background_tool", jobStatus: "completed" } })
      }],
      goal: "test", systemPrompt: "system", workspaceRoot: root, outDir: root,
      permissions: { tools: ["job_tool"], readRoots: [root], writeRoots: [], networkHosts: [] },
      budget: { maxTurns: 5, maxToolCalls: 5, maxTokens: 100_000, maxDurationMs: 30_000 },
      journal: { path: journalPath },
      onEvent: (event) => events.push(event)
    });
    expect(result.status).toBe("completed");
    expect(events.filter((event) => event.type === "job.registered")).toHaveLength(1);
    expect(events.filter((event) => event.type === "job.settled")).toHaveLength(1);
    const journal = readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(journal.filter((entry) => entry.type === "job.registered")).toHaveLength(1);
    expect(journal.filter((entry) => entry.type === "job.settled")).toHaveLength(1);
  });

  it("charges summary usage and stops before another model call when it exhausts the budget", async () => {
    let modelCalls = 0;
    const checkpoints: AgentCheckpoint[] = [];
    const result = await runAgent({
      model: async () => { modelCalls++; return turn("done", []); },
      tools: [], goal: "test", systemPrompt: "system", workspaceRoot: ".", outDir: ".",
      permissions: { tools: [], readRoots: [], writeRoots: [], networkHosts: [] },
      budget: { maxTurns: 5, maxToolCalls: 5, maxTokens: 100, maxDurationMs: 30_000 },
      resume: { messages: [
        { role: "system", content: "system" }, { role: "user", content: "goal" },
        { role: "assistant", content: "old".repeat(5000), toolCalls: [] },
        { role: "user", content: "continue" }
      ], usage: zeroUsage(), turns: 0, toolCalls: 0 },
      contextWindowTokens: 2000, contextReserveTokens: 200, recentContextTokens: 1,
      summarizeContext: async () => ({ summary: "summary", usage: { inputTokens: 90, outputTokens: 10, cachedInputTokens: 40, reasoningOutputTokens: 2 } }),
      onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); }
    });
    expect(modelCalls).toBe(0);
    expect(result.status).toBe("budget_exceeded");
    expect(result.usage).toEqual({ ...zeroUsage(), inputTokens: 90, outputTokens: 10, cachedInputTokens: 40, reasoningOutputTokens: 2 });
    expect(checkpoints.at(-1)?.usage).toEqual(result.usage);
  });

  it("stops equivalent denied paths across different tools", async () => {
    let turns = 0;
    const root = workspace(roots);
    const options = {
      model: async () => turn("", [call(++turns === 1 ? "write" : "edit", {})]),
      tools: ["write", "edit"].map((name) => ({ definition: { name, description: name, parameters: {} }, execute: async () => ({ content: `工具执行失败：路径不在授权范围内：${name === "write" ? "out/old/result.md" : join(root, "out/old/result.md")}`, isError: true }) })),
      goal: "test", systemPrompt: "system", workspaceRoot: root, outDir: join(root, "out/new"),
      permissions: { tools: ["write", "edit"], readRoots: [], writeRoots: [], networkHosts: [] },
      budget: { maxTurns: 10, maxToolCalls: 10, maxTokens: 100000, maxDurationMs: 30000 }
    };
    const result = await runAgent(options);
    expect(result.status).toBe("failed");
    expect(turns).toBe(2);
    expect(result.messages.at(-1)?.content).toContain("当前产物输出目录");
  });

  it("completes when the model calls finish_task", async () => {
    const root = workspace(roots);
    const result = await runAgent({
      model: fakeModel([turn("", [call("finish_task", { summary: "已经完成" })])]),
      tools: createBuiltinTools(),
      goal: "完成一件事",
      systemPrompt: "system",
      budget: { maxTurns: 4, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] }),
      workspaceRoot: root,
      outDir: join(root, "out")
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toBe("已经完成");
    expect(result.toolCalls).toBe(1);
  });

  it("rejects finish_task until deliverable validation passes", async () => {
    const root = workspace(roots);
    let attempts = 0;
    const result = await runAgent({
      model: fakeModel([
        turn("", [call("finish_task", { summary: "第一次" })]),
        turn("", [call("finish_task", { summary: "第二次" })])
      ]),
      tools: createBuiltinTools(),
      goal: "完成一件事",
      systemPrompt: "system",
      budget: { maxTurns: 4, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] }),
      workspaceRoot: root,
      outDir: join(root, "out"),
      validateFinish: () => {
        attempts += 1;
        return attempts === 1 ? "缺少 facts" : null;
      }
    });

    expect(attempts).toBe(2);
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("第二次");
  });

  it("executes a file-writing tool before finishing", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    const checkpoints: AgentCheckpoint[] = [];
    const result = await runAgent({
      model: fakeModel([
        turn("", [call("write_file", { path: "out/result.md", content: "# 结果\n\n正文\n" })]),
        turn("", [call("finish_task", { summary: "生成了结果", outputs: ["out/result.md"] })])
      ]),
      tools: createBuiltinTools(),
      goal: "写一份结果",
      systemPrompt: "system",
      budget: { maxTurns: 4, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [] }),
      workspaceRoot: root,
      outDir: out,
      onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); }
    });

    expect(result.status).toBe("completed");
    expect(result.outputs).toEqual(["out/result.md"]);
    expect(readFileSync(join(out, "result.md"), "utf8")).toContain("正文");
    expect(checkpoints.some((checkpoint) => checkpoint.kind === "final")).toBe(true);
    expect(checkpoints.at(-1)?.usage).toEqual(zeroUsage());
  });

  it("executes a tool after the authorizer allows it", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    const authorized: string[] = [];
    const result = await runAgent({
      model: fakeModel([
        turn("", [call("write_file", { path: "out/approved.md", content: "approved" })]),
        turn("", [call("finish_task", { summary: "完成" })])
      ]),
      tools: createBuiltinTools(),
      goal: "写文件",
      systemPrompt: "system",
      budget: { maxTurns: 4, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [] }),
      workspaceRoot: root,
      outDir: out,
      authorizeTool: async ({ call }) => {
        authorized.push(call.name);
        return { allowed: true };
      }
    });

    expect(result.status).toBe("completed");
    expect(authorized).toEqual(["write_file", "finish_task"]);
    expect(readFileSync(join(out, "approved.md"), "utf8")).toBe("approved");
  });

  it("returns a tool error without executing when the authorizer denies", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    const result = await runAgent({
      model: fakeModel([
        turn("", [call("write_file", { path: "out/denied.md", content: "denied" })]),
        turn("", [call("finish_task", { summary: "完成" })])
      ]),
      tools: createBuiltinTools(),
      goal: "写文件",
      systemPrompt: "system",
      budget: { maxTurns: 4, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [] }),
      workspaceRoot: root,
      outDir: out,
      authorizeTool: async ({ call }) => call.name === "write_file"
        ? { allowed: false, reason: "用户没有批准" }
        : { allowed: true }
    });

    expect(result.status).toBe("completed");
    expect(() => readFileSync(join(out, "denied.md"), "utf8")).toThrow();
    expect(result.messages.some((message) =>
      message.role === "tool" && message.isError && message.content.includes("用户没有批准")
    )).toBe(true);
  });

  it("stops at the turn budget with an explicit status", async () => {
    const root = workspace(roots);
    const result = await runAgent({
      model: async () => turn("", [call("list_files", {})]),
      tools: createBuiltinTools(),
      goal: "一直循环",
      systemPrompt: "system",
      budget: { maxTurns: 2, maxToolCalls: 10, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] }),
      workspaceRoot: root,
      outDir: join(root, "out")
    });

    expect(result.status).toBe("budget_exceeded");
    expect(result.turns).toBe(2);
  });

  it("keeps running past the old default turn limit when no budget is set", async () => {
    const root = workspace(roots);
    const events: string[] = [];
    let turns = 0;
    const result = await runAgent({
      model: async () => {
        turns += 1;
        if (turns < 210) return turn("", [call("noop", { index: turns })]);
        return turn("", [call("finish_task", { summary: "完成" })]);
      },
      tools: [
        { definition: { name: "noop", description: "noop", parameters: {} }, execute: async (input) => ({ content: JSON.stringify(input) }) },
        { definition: { name: "finish_task", description: "finish", parameters: {} }, execute: async () => ({ content: "完成", action: "finish", summary: "完成" }) }
      ],
      goal: "持续执行",
      systemPrompt: "system",
      budget: {},
      requireFinishTool: true,
      permissions: { tools: ["noop", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      workspaceRoot: root,
      outDir: join(root, "out"),
      onEvent: (event) => { if (event.type === "budget.exceeded") events.push(event.budget); }
    });

    expect(result.status).toBe("completed");
    expect(result.turns).toBe(210);
    expect(events).toEqual([]);
  });

  it("pauses when the agent asks the user", async () => {
    const root = workspace(roots);
    const result = await runAgent({
      model: fakeModel([turn("", [call("ask_user", { question: "预算上限是多少？" })])]),
      tools: createBuiltinTools(),
      goal: "做预算",
      systemPrompt: "system",
      budget: { maxTurns: 4, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] }),
      workspaceRoot: root,
      outDir: join(root, "out")
    });

    expect(result.status).toBe("waiting_input");
    expect(result.question).toBe("预算上限是多少？");
    expect(result.planSubmitted).toBeUndefined();
  });

  it("marks submit_plan separately from an ordinary clarification", async () => {
    const root = workspace(roots);
    const plan = "## 调查结论\n\n- inspected\n\n## 执行步骤\n\n1. implement";
    const permissions = defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] });
    const result = await runAgent({
      model: fakeModel([turn("", [call("submit_plan", { plan, title: "Plan" })])]),
      tools: createBuiltinTools(),
      goal: "规划任务",
      systemPrompt: "system",
      budget: { maxTurns: 4, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: { ...permissions, tools: [...permissions.tools, "submit_plan"] },
      mode: "plan",
      workspaceRoot: root,
      outDir: join(root, "out")
    });

    expect(result.status).toBe("waiting_input");
    expect(result.question).toBe(plan);
    expect(result.planSubmitted).toBe(true);
  });

  it("still pauses for user input when ask_user runs in full permission", async () => {
    const root = workspace(roots);
    const result = await runAgent({
      model: fakeModel([
        turn("", [call("ask_user", { question: "要用哪个方案？" })]),
        turn("", [call("finish_task", { summary: "已自行选择方案并完成" })])
      ]),
      tools: createBuiltinTools(),
      goal: "自主完成任务",
      systemPrompt: "system",
      budget: { maxTurns: 4, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] }),
      workspaceRoot: root,
      outDir: join(root, "out"),
      isFullPermission: () => true
    });

    expect(result.status).toBe("waiting_input");
    expect(result.question).toBe("要用哪个方案？");
  });

  it("rejects tools that are not in the task permissions", async () => {
    const root = workspace(roots);
    const result = await runAgent({
      model: fakeModel([
        turn("", [call("write_file", { path: "out/x.md", content: "x" })]),
        turn("", [call("finish_task", { summary: "done" })])
      ]),
      tools: createBuiltinTools(),
      goal: "写文件",
      systemPrompt: "system",
      budget: { maxTurns: 4, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: { readRoots: [root], writeRoots: [], networkHosts: [], tools: ["finish_task"] },
      workspaceRoot: root,
      outDir: join(root, "out")
    });

    expect(result.status).toBe("completed");
    expect(result.messages.some((message) => message.role === "tool" && message.content.includes("未知或未授权工具"))).toBe(true);
  });

  it("completes a direct plain-text answer when no tool was needed", async () => {
    const root = workspace(roots);
    const notices: string[] = [];
    const result = await runAgent({
      model: fakeModel([turn("这是一个可以直接回答的问题。", [])]),
      tools: createBuiltinTools(),
      goal: "解释一个概念",
      systemPrompt: "system",
      budget: { maxTurns: 5, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] }),
      workspaceRoot: root,
      outDir: join(root, "out"),
      requireFinishTool: true,
      onEvent: (event) => { if (event.type === "notice") notices.push(event.message); }
    });
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("这是一个可以直接回答的问题。");
    expect(notices).toHaveLength(0);
    expect(result.messages.some((message) => message.role === "user" && message.content.includes("finish_task"))).toBe(false);
  });

  it("requires finish_task after the model has used a tool", async () => {
    const root = workspace(roots);
    const notices: string[] = [];
    const result = await runAgent({
      model: fakeModel([
        turn("", [call("inspect", {})]),
        turn("文件检查完了", []),
        turn("", [call("finish_task", { summary: "检查完成" })])
      ]),
      tools: [
        { definition: { name: "inspect", description: "inspect", parameters: {} }, execute: async () => ({ content: "ok" }) },
        ...createBuiltinTools().filter((tool) => tool.definition.name === "finish_task")
      ],
      goal: "检查状态",
      systemPrompt: "system",
      budget: { maxTurns: 6, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: { tools: ["inspect", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      workspaceRoot: root,
      outDir: join(root, "out"),
      requireFinishTool: true,
      onEvent: (event) => { if (event.type === "notice") notices.push(event.message); }
    });
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("检查完成");
    expect(notices).toHaveLength(1);
    expect(result.messages.some((message) => message.role === "user" && message.content.includes("finish_task"))).toBe(true);
  });

  it("fails when the model keeps claiming completion after tool use without finish_task", async () => {
    const root = workspace(roots);
    const result = await runAgent({
      model: fakeModel([
        turn("", [call("inspect", {})]),
        turn("完成了", []),
        turn("真的完成了", [])
      ]),
      tools: [
        { definition: { name: "inspect", description: "inspect", parameters: {} }, execute: async () => ({ content: "ok" }) },
        ...createBuiltinTools().filter((tool) => tool.definition.name === "finish_task")
      ],
      goal: "完成",
      systemPrompt: "system",
      budget: { maxTurns: 6, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: { tools: ["inspect", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      workspaceRoot: root,
      outDir: join(root, "out"),
      requireFinishTool: true
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("finish_task");
  });

  it("retries 429, 5xx and upstream_error model failures three times", async () => {
    const root = workspace(roots);
    let attempts = 0;
    const model: AgentModel = async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      if (attempts === 2) throw Object.assign(new Error("upstream failed"), { status: 503 });
      if (attempts === 3) throw Object.assign(new Error("[code=upstream_error] The request could not be completed."), { status: 400 });
      return turn("", [call("finish_task", { summary: "重试后完成" })]);
    };
    const result = await runAgent({
      model,
      tools: createBuiltinTools(),
      goal: "重试",
      systemPrompt: "system",
      budget: { maxTurns: 3, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] }),
      workspaceRoot: root,
      outDir: join(root, "out"),
      retryDelayMs: 0
    });
    expect(result.status).toBe("completed");
    expect(attempts).toBe(4);
  });

  it("returns failed instead of throwing after five transient retries", async () => {
    const root = workspace(roots);
    let attempts = 0;
    const model: AgentModel = async () => {
      attempts += 1;
      throw Object.assign(new Error("service unavailable"), { status: 503 });
    };
    const events: RuntimeEvent[] = [];
    const result = await runAgent({
      model,
      tools: [],
      goal: "retry exhaustion",
      systemPrompt: "system",
      budget: {},
      permissions: { tools: [], readRoots: [root], writeRoots: [root], networkHosts: [] },
      workspaceRoot: root,
      outDir: join(root, "out"),
      retryDelayMs: 0,
      onEvent: (event) => { events.push(event); }
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("暂时不可用");
    expect(attempts).toBe(6);
    expect(events.some((event) => event.type === "notice" && event.message.includes("连续 5 次"))).toBe(true);
  });

  it("does not retry ordinary 4xx model errors", async () => {
    const root = workspace(roots);
    let attempts = 0;
    const model: AgentModel = async () => {
      attempts += 1;
      throw Object.assign(new Error("bad request"), { status: 400 });
    };
    await expect(runAgent({
      model,
      tools: createBuiltinTools(),
      goal: "不要重试",
      systemPrompt: "system",
      budget: { maxTurns: 3, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] }),
      workspaceRoot: root,
      outDir: join(root, "out"),
      retryDelayMs: 0
    })).rejects.toThrow("bad request");
    expect(attempts).toBe(1);
  });

  it("force-compacts once after a context overflow before retrying", async () => {
    const root = workspace(roots);
    const summaries: number[] = [];
    const checkpoints: AgentCheckpoint[] = [];
    let attempts = 0;
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "goal" },
      ...Array.from({ length: 14 }, (_, index) => [
        { role: "assistant" as const, content: "", toolCalls: [{ id: `old-${index}`, name: "read_file", arguments: {}, rawArguments: "{}" }] },
        { role: "tool" as const, toolCallId: `old-${index}`, name: "read_file", content: "history ".repeat(1_500) }
      ]).flat()
    ];
    const model: AgentModel = async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("maximum context length exceeded"), { status: 400 });
      return turn("", [call("finish_task", { summary: "压缩后完成" })]);
    };
    const result = await runAgent({
      model,
      tools: createBuiltinTools(),
      goal: "overflow",
      systemPrompt: "system",
      budget: { maxTurns: 3, maxToolCalls: 4, maxTokens: 1_000_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] }),
      workspaceRoot: root,
      outDir: join(root, "out"),
      resume: { messages, usage: zeroUsage(), turns: 0, toolCalls: 0 },
      contextWindowTokens: 100_000,
      recentContextTokens: 300,
      summarizeContext: async (omitted) => { summaries.push(omitted.length); return { summary: "超限摘要", usage: { inputTokens: 40, outputTokens: 10, cachedInputTokens: 20 } }; },
      onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); },
      retryDelayMs: 0
    });
    expect(result.status).toBe("completed");
    expect(attempts).toBe(2);
    expect(result.usage.cachedInputTokens).toBe(20);
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(40);
    expect(summaries[0]).toBeGreaterThan(0);
    expect(checkpoints.some((checkpoint) => checkpoint.kind === "compaction" && checkpoint.summary === "超限摘要")).toBe(true);
  });

  it("runs parallel-safe tools in one batch and preserves result order", async () => {
    const root = workspace(roots);
    let active = 0;
    let maxActive = 0;
    const parallelTool = (name: string): AgentTool => ({
      definition: { name, description: name, parameters: {}, executionMode: "parallel", effect: "read" },
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
        active -= 1;
        return { content: name };
      }
    });
    const result = await runAgent({
      model: fakeModel([
        turn("", [call("read_a", {}), call("read_b", {})]),
        turn("", [call("finish_task", { summary: "done" })])
      ]),
      tools: [parallelTool("read_a"), parallelTool("read_b"), createBuiltinTools().find((tool) => tool.definition.name === "finish_task")!],
      goal: "parallel",
      systemPrompt: "system",
      budget: { maxTurns: 4, maxToolCalls: 10, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: { tools: ["read_a", "read_b", "finish_task"], readRoots: [], writeRoots: [], networkHosts: [] },
      workspaceRoot: root,
      outDir: join(root, "out"),
      maxParallelTools: 2
    });
    expect(result.status).toBe("completed");
    expect(maxActive).toBeGreaterThan(1);
    const outputs = result.messages.filter((message) => message.role === "tool").map((message) => message.content);
    expect(outputs.slice(0, 2)).toEqual(["read_a", "read_b"]);
  });

  it("parallelizes contiguous read tools and treats writes as barriers", async () => {
    const root = workspace(roots);
    const events: string[] = [];
    let activeReads = 0;
    let maxActiveReads = 0;
    let writeDone = false;
    const readTool = (name: string): AgentTool => ({
      definition: { name, description: name, parameters: {}, executionMode: "parallel", effect: "read" },
      execute: async () => {
        const startedAfterWrite = writeDone;
        events.push(`${name}:start:${startedAfterWrite}`);
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        activeReads -= 1;
        events.push(`${name}:end`);
        return { content: name };
      }
    });
    const writeTool: AgentTool = {
      definition: { name: "write_state", description: "write", parameters: {}, executionMode: "sequential" },
      execute: async () => {
        events.push("write:start");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        writeDone = true;
        events.push("write:end");
        return { content: "write" };
      }
    };
    const tools = [readTool("read_a"), readTool("read_b"), writeTool, readTool("read_c"), readTool("read_d")];
    const result = await runAgent({
      model: fakeModel([
        turn("", [call("read_a", {}), call("read_b", {}), call("write_state", {}), call("read_c", {}), call("read_d", {})]),
        turn("", [call("finish_task", { summary: "done" })])
      ]),
      tools: [...tools, createBuiltinTools().find((tool) => tool.definition.name === "finish_task")!],
      goal: "mixed batch",
      systemPrompt: "system",
      budget: { maxTurns: 4, maxToolCalls: 10, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: { tools: ["read_a", "read_b", "write_state", "read_c", "read_d", "finish_task"], readRoots: [], writeRoots: [], networkHosts: [] },
      workspaceRoot: root,
      outDir: join(root, "out"),
      maxParallelTools: 2
    });

    expect(result.status).toBe("completed");
    expect(maxActiveReads).toBe(2);
    expect(events).toContain("read_a:start:false");
    expect(events).toContain("read_b:start:false");
    expect(events.indexOf("read_b:end")).toBeLessThan(events.indexOf("write:start"));
    expect(events).toContain("read_c:start:true");
    expect(events).toContain("read_d:start:true");
    expect(events.indexOf("write:end")).toBeLessThan(events.indexOf("read_c:start:true"));
    const outputs = result.messages.filter((message) => message.role === "tool").map((message) => message.content);
    expect(outputs.slice(0, 5)).toEqual(["read_a", "read_b", "write", "read_c", "read_d"]);
  });

  it("stops after repeated identical tool calls and results", async () => {
    const root = workspace(roots);
    const repeated = call("read_file", { path: "missing.txt" });
    const model: AgentModel = async () => turn("", [{ ...repeated, id: `repeat-${Math.random()}` }]);
    const result = await runAgent({
      model,
      tools: createBuiltinTools(),
      goal: "不要重复",
      toolCircuitBreaker: { threshold: 10 },
      systemPrompt: "system",
      budget: { maxTurns: 10, maxToolCalls: 10, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] }),
      workspaceRoot: root,
      outDir: join(root, "out")
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("重复相同工具调用");
    expect(result.messages.filter((message) => message.role === "tool").length).toBeGreaterThanOrEqual(5);
  });
});

describe("context compaction", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("keeps the system prompt and recent tool results", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "goal" },
      ...Array.from({ length: 80 }, (_, index) => [
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: `call-${index}`, name: "read_file", arguments: {}, rawArguments: "{}" }]
        },
        {
          role: "tool" as const,
          toolCallId: `call-${index}`,
          name: "read_file",
          content: "x".repeat(2_000)
        }
      ]).flat()
    ];
    const compacted = compactAgentMessages(messages, { keepRecent: 10, maxChars: 20_000, maxToolChars: 2_000 });
    expect(compacted.compacted).toBe(true);
    expect(compacted.messages.length).toBeLessThan(messages.length);
    expect(compacted.messages[0]).toEqual({ role: "system", content: "system" });
    expect(compacted.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("summarizes complete earlier turns and keeps every tool call paired", async () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "goal" },
      ...Array.from({ length: 24 }, (_, index) => [
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: `call-${index}`, name: "read_file", arguments: { path: `file-${index}.txt` }, rawArguments: "{}" }]
        },
        {
          role: "tool" as const,
          toolCallId: `call-${index}`,
          name: "read_file",
          content: "evidence ".repeat(1_000)
        }
      ]).flat()
    ];
    let summarized = 0;
    const compacted = await compactAgentMessagesWithSummary(messages, {
      contextWindowTokens: 3_000,
      reserveTokens: 500,
      recentTokens: 400,
      maxToolChars: 4_000
    }, async (omitted) => {
      summarized = omitted.length;
      return "已经读取前 20 个文件，关键结论是 A。";
    });

    expect(compacted.compacted).toBe(true);
    expect(summarized).toBeGreaterThan(0);
    expect(compacted.messages[0]).toEqual({ role: "system", content: "system" });
    expect(compacted.messages.some((message) => message.role === "user" && message.content.includes("关键结论是 A"))).toBe(true);
    expect(compacted.afterTokens).toBeLessThan(compacted.beforeTokens);
    expect(toolPairsComplete(compacted.messages)).toBe(true);
  });

  it("falls back to safe truncation when the summary model fails", async () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "goal" },
      ...Array.from({ length: 20 }, (_, index) => [
        { role: "assistant" as const, content: "", toolCalls: [{ id: `call-${index}`, name: "grep", arguments: {}, rawArguments: "{}" }] },
        { role: "tool" as const, toolCallId: `call-${index}`, name: "grep", content: "match ".repeat(2_000) }
      ]).flat()
    ];
    const compacted = await compactAgentMessagesWithSummary(messages, {
      contextWindowTokens: 2_000,
      reserveTokens: 200,
      recentTokens: 300,
      maxToolChars: 3_000
    }, async () => { throw new Error("summary unavailable"); });
    expect(compacted.compacted).toBe(true);
    expect(compacted.summarized).toBe(false);
    expect(compacted.messages.some((message) => message.role === "user" && message.content.includes("摘要"))).toBe(false);
    expect(toolPairsComplete(compacted.messages)).toBe(true);
  });

  it("compacts a resumed large context and writes a checkpoint", async () => {
    const root = workspace(roots);
    const checkpoints: AgentCheckpoint[] = [];
    const events: string[] = [];
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "goal" },
      ...Array.from({ length: 16 }, (_, index) => [
        { role: "assistant" as const, content: "", toolCalls: [{ id: `old-${index}`, name: "read_file", arguments: {}, rawArguments: "{}" }] },
        { role: "tool" as const, toolCallId: `old-${index}`, name: "read_file", content: "history ".repeat(2_000) }
      ]).flat()
    ];
    const result = await runAgent({
      model: fakeModel([turn("", [call("finish_task", { summary: "恢复后完成" })])]),
      tools: createBuiltinTools(),
      goal: "resume",
      systemPrompt: "system",
      budget: { maxTurns: 4, maxToolCalls: 4, maxTokens: 1_000_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] }),
      workspaceRoot: root,
      outDir: join(root, "out"),
      resume: { messages, usage: zeroUsage(), turns: 0, toolCalls: 0 },
      contextWindowTokens: 3_000,
      contextReserveTokens: 500,
      recentContextTokens: 400,
      summarizeContext: async () => "恢复摘要",
      onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); },
      onEvent: (event) => { if (event.type === "compacted" && event.reason !== "microcompact") events.push("compacted"); }
    });
    expect(result.status).toBe("completed");
    expect(events).toEqual(["compacted"]);
    expect(checkpoints[0]?.kind).toBe("compaction");
    expect(checkpoints[0]?.summary).toBe("恢复摘要");
  });

  it("adds usage reported by a delegated tool to the parent run", async () => {
    const root = workspace(roots);
    const usageEvents: number[] = [];
    const result = await runAgent({
      model: fakeModel([
        turn("", [call("delegate_task", { objective: "调查", mode: "read-only" })]),
        turn("", [call("finish_task", { summary: "父任务完成" })])
      ]),
      tools: [
        {
          definition: { name: "delegate_task", description: "delegate", parameters: { type: "object" } },
          async execute() {
            return {
              content: "子代理完成",
              usage: { inputTokens: 31, cachedInputTokens: 2, cacheWriteInputTokens: 3, outputTokens: 12, reasoningOutputTokens: 1 }
            };
          }
        },
        ...createBuiltinTools()
      ],
      goal: "委派",
      systemPrompt: "system",
      budget: { maxTurns: 4, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: { readRoots: [root], writeRoots: [], networkHosts: [], tools: ["delegate_task", "finish_task"] },
      workspaceRoot: root,
      outDir: join(root, "out"),
      onEvent: (event) => {
        if (event.type === "usage") usageEvents.push(event.usage.inputTokens);
      }
    });

    expect(result.status).toBe("completed");
    expect(result.usage).toEqual({
      inputTokens: 31,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 3,
      outputTokens: 12,
      reasoningOutputTokens: 1
    });
    expect(usageEvents).toEqual([31]);
  });
  it("blocks workspace writes and non-read-only shell commands in plan mode", async () => {
    const root = workspace(roots);
    let wrote = false;
    const ran: string[] = [];
    const tools: AgentTool[] = [
      {
        definition: { name: "write_file", description: "write", parameters: { type: "object" } },
        async execute() {
          wrote = true;
          return { content: "written" };
        }
      },
      {
        definition: { name: "shell", description: "shell", parameters: { type: "object" } },
        async execute(input) {
          const args = input as Record<string, unknown>;
          ran.push(String(args.command));
          return { content: "ok" };
        }
      }
    ];
    const result = await runAgent({
      model: fakeModel([
        turn("", [
          call("write_file", { path: "src.ts", content: "next" }),
          call("shell", { command: "git status --short" }),
          call("shell", { command: "rm -rf build" })
        ])
      ]),
      tools,
      goal: "plan",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["write_file", "shell"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: { maxTurns: 1, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      mode: "plan"
    });
    expect(wrote).toBe(false);
    expect(ran).toEqual(["git status --short"]);
    expect(result.status).toBe("budget_exceeded");
  });

  it("runs the post-edit hook with changed files and ignores failed edits", async () => {
    const root = workspace(roots);
    const seen: Array<{ tool: string; files: string[]; turn: number }> = [];
    const edit: AgentTool = {
      definition: { name: "edit_file", description: "edit", parameters: { type: "object" } },
      async execute(input) {
        const fail = (input as { fail?: boolean }).fail === true;
        return fail
          ? { content: "cannot edit", isError: true }
          : { content: "edited", metadata: { filesChanged: ["src/a.ts"] } };
      }
    };
    const finish = createBuiltinTools().find((tool) => tool.definition.name === "finish_task")!;
    const result = await runAgent({
      model: fakeModel([
        turn("", [call("edit_file", { fail: true }), call("edit_file", {})]),
        turn("", [call("finish_task", { summary: "done" })])
      ]),
      tools: [edit, finish],
      goal: "post-edit hook",
      systemPrompt: "system",
      budget: { maxTurns: 3, maxToolCalls: 10, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: { tools: ["edit_file", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      workspaceRoot: root,
      outDir: join(root, "out"),
      afterEdit: (event) => { seen.push({ tool: event.tool, files: event.files, turn: event.turn }); }
    });
    expect(result.status).toBe("completed");
    expect(seen).toEqual([{ tool: "edit_file", files: ["src/a.ts"], turn: 1 }]);
  });
});

function toolPairsComplete(messages: Array<{ role: string; content: string; toolCalls?: Array<{ id: string }>; toolCallId?: string }>): boolean {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.toolCalls ?? []) callIds.add(call.id);
    if (message.role === "tool" && message.toolCallId) resultIds.add(message.toolCallId);
  }
  return [...callIds].every((id) => resultIds.has(id)) && [...resultIds].every((id) => callIds.has(id));
}

function workspace(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-runtime-"));
  roots.push(root);
  return root;
}

function call(name: string, args: Record<string, unknown>): AgentToolCall {
  return { id: `call-${name}-${Math.random()}`, name, arguments: args, rawArguments: JSON.stringify(args) };
}

function turn(content: string, toolCalls: AgentToolCall[], usage: AgentModelTurn["usage"] = null): AgentModelTurn {
  return { content, toolCalls, usage, finishReason: toolCalls.length > 0 ? "tool_calls" : "stop" };
}

function fakeModel(turns: AgentModelTurn[]): AgentModel {
  let index = 0;
  return async () => turns[Math.min(index++, turns.length - 1)] ?? { content: "", toolCalls: [], usage: null, finishReason: "stop" };
}

it("retries a tool that fails with TOOL_TIMEOUT before succeeding", async () => {
  let attempts = 0;
  const model = fakeModel([
    turn("", [call("flaky", {})]),
    turn("完成了", [])
  ]);
  const result = await runAgent({
    model,
    tools: [{
      definition: { name: "flaky", description: "flaky tool", parameters: {} },
      execute: async () => {
        attempts++;
        if (attempts < 2) {
          const err: any = new Error("tool timed out");
          err.code = "TOOL_TIMEOUT";
          err.retryable = true;
          throw err;
        }
        return { content: "ok" };
      }
    }],
    goal: "test", systemPrompt: "system", workspaceRoot: ".", outDir: ".",
    permissions: { tools: ["flaky"], readRoots: [], writeRoots: [], networkHosts: [] },
    budget: { maxTurns: 5, maxToolCalls: 5, maxTokens: 100_000, maxDurationMs: 30_000 },
  });
  expect(result.status).toBe("completed");
  expect(attempts).toBe(2);
});

it("stops retrying a tool after maxRetries and returns the failure", async () => {
  let attempts = 0;
  const model = fakeModel([
    turn("", [call("flaky", {})]),
    turn("done", [])
  ]);
  const result = await runAgent({
    model,
    tools: [{
      definition: { name: "flaky", description: "flaky tool", parameters: {} },
      execute: async () => {
        attempts++;
        const err: any = new Error("tool timed out");
        err.code = "TOOL_TIMEOUT";
        err.retryable = true;
        throw err;
      }
    }],
    goal: "test", systemPrompt: "system", workspaceRoot: ".", outDir: ".",
    permissions: { tools: ["flaky"], readRoots: [], writeRoots: [], networkHosts: [] },
    budget: { maxTurns: 5, maxToolCalls: 5, maxTokens: 100_000, maxDurationMs: 30_000 },
  });
  expect(result.status).toBe("completed");
  expect(attempts).toBe(2);
});

it("trips circuit breaker after 5 consecutive tool failures", async () => {
  let toolCallCount = 0;
  const model: AgentModel = async () => turn("", [call("flaky", {})]);
  const result = await runAgent({
    model,
    tools: [{
      definition: { name: "flaky", description: "flaky tool", parameters: {} },
      execute: async () => {
        toolCallCount++;
        return { content: "failed", isError: true, error: { code: "TOOL_TIMEOUT", retryable: true } };
      }
    }],
    goal: "test", systemPrompt: "system", workspaceRoot: ".", outDir: ".",
    permissions: { tools: ["flaky"], readRoots: [], writeRoots: [], networkHosts: [] },
    budget: { maxTurns: 20, maxToolCalls: 20, maxTokens: 100_000, maxDurationMs: 30_000 },
  });
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("熔断器");
});

it("does not trip circuit breaker when one turn contains several failed tool calls", async () => {
  let toolCallCount = 0;
  let modelCallCount = 0;
  const model: AgentModel = async () => {
    modelCallCount++;
    if (modelCallCount === 1) {
      return turn("", [0, 1, 2, 3, 4].map((n) => call("flaky", { n })));
    }
    return turn("done", []);
  };
  const result = await runAgent({
    model,
    tools: [{
      definition: { name: "flaky", description: "flaky tool", parameters: {} },
      execute: async () => {
        toolCallCount++;
        return { content: "failed", isError: true, error: { code: "TOOL_TIMEOUT", retryable: true } };
      }
    }],
    goal: "test", systemPrompt: "system", workspaceRoot: ".", outDir: ".",
    permissions: { tools: ["flaky"], readRoots: [], writeRoots: [], networkHosts: [] },
    budget: { maxTurns: 20, maxToolCalls: 20, maxTokens: 100_000, maxDurationMs: 30_000 },
  });
  expect(result.status).toBe("completed");
  expect(toolCallCount).toBe(5);
});

it("resets circuit breaker after a successful tool call", async () => {
  let modelCallCount = 0;
  let toolExecCount = 0;
  const model: AgentModel = async () => {
    modelCallCount++;
    if (modelCallCount <= 5) return turn("", [call("flaky", {})]);
    return turn("done", []);
  };
  const result = await runAgent({
    model,
    tools: [{
      definition: { name: "flaky", description: "flaky tool", parameters: {} },
      execute: async () => {
        toolExecCount++;
        if (toolExecCount <= 2 || toolExecCount === 4) {
          return { content: "failed", isError: true, error: { code: "TOOL_TIMEOUT", retryable: true } };
        }
        return { content: "ok" };
      }
    }],
    goal: "test", systemPrompt: "system", workspaceRoot: ".", outDir: ".",
    permissions: { tools: ["flaky"], readRoots: [], writeRoots: [], networkHosts: [] },
    budget: { maxTurns: 20, maxToolCalls: 20, maxTokens: 100_000, maxDurationMs: 30_000 },
  });
  expect(result.status).toBe("completed");
});

it("reports retries and total duration in tool.finished event", async () => {
  let attempts = 0;
  const events: RuntimeEvent[] = [];
  const result = await runAgent({
    model: fakeModel([turn("", [call("flaky", {})]), turn("done", [])]),
    tools: [{
      definition: { name: "flaky", description: "flaky tool", parameters: {} },
      execute: async () => {
        attempts++;
        if (attempts < 3) {
          const err: any = new Error("tool timed out");
          err.code = "TOOL_TIMEOUT";
          err.retryable = true;
          throw err;
        }
        return { content: "ok" };
      }
    }],
    goal: "test", systemPrompt: "system", workspaceRoot: ".", outDir: ".",
    permissions: { tools: ["flaky"], readRoots: [], writeRoots: [], networkHosts: [] },
    budget: { maxTurns: 5, maxToolCalls: 5, maxTokens: 100_000, maxDurationMs: 30_000 },
    onEvent: (event) => events.push(event)
  });
  expect(result.status).toBe("completed");
  const finished = events.filter((e): e is Extract<RuntimeEvent, { type: "tool.finished" }> => e.type === "tool.finished");
  expect(finished.length).toBeGreaterThan(0);
  expect(finished[0]!.retries).toBe(1);
  expect(typeof finished[0]!.totalDurationMs).toBe("number");
  expect(finished[0]!.totalDurationMs).toBeGreaterThan(0);
});

it("drops truncated tool calls instead of executing half-built arguments", async () => {
  const executed: string[] = [];
  const events: RuntimeEvent[] = [];
  const truncated: AgentModelTurn = { content: "partial plan", toolCalls: [call("record", { value: "x" })], usage: null, finishReason: "length" };
  const result = await runAgent({
    model: fakeModel([truncated, turn("done", [])]),
    tools: [{
      definition: { name: "record", description: "record", parameters: { type: "object", properties: { value: { type: "string" } } } },
      execute: async () => { executed.push("record"); return { content: "ok" }; }
    }],
    goal: "test", systemPrompt: "system", workspaceRoot: ".", outDir: ".",
    permissions: { tools: ["record"], readRoots: [], writeRoots: [], networkHosts: [] },
    budget: { maxTurns: 5, maxToolCalls: 5, maxTokens: 100_000, maxDurationMs: 30_000 },
    onEvent: (event) => events.push(event)
  });
  expect(result.status).toBe("completed");
  expect(executed).toEqual([]);
  expect(result.messages.some((message) => message.role === "assistant" && message.content === "partial plan" && message.toolCalls.length === 0)).toBe(true);
  const notices = events.filter((event): event is Extract<RuntimeEvent, { type: "notice" }> => event.type === "notice");
  expect(notices.some((notice) => notice.message.includes("未执行"))).toBe(true);
});

it("rejects tool arguments that violate the declared schema", async () => {
  let executed = 0;
  const events: RuntimeEvent[] = [];
  const result = await runAgent({
    model: fakeModel([turn("", [call("strict", {})]), turn("done", [])]),
    tools: [{
      definition: {
        name: "strict",
        description: "strict",
        parameters: {
          type: "object",
          required: ["path"],
          properties: { path: { type: "string" } },
          additionalProperties: false
        }
      },
      execute: async () => { executed += 1; return { content: "ok" }; }
    }],
    goal: "test", systemPrompt: "system", workspaceRoot: ".", outDir: ".",
    permissions: { tools: ["strict"], readRoots: [], writeRoots: [], networkHosts: [] },
    budget: { maxTurns: 5, maxToolCalls: 5, maxTokens: 100_000, maxDurationMs: 30_000 },
    onEvent: (event) => events.push(event)
  });
  expect(result.status).toBe("completed");
  expect(executed).toBe(0);
  const rejected = events.filter((event): event is Extract<RuntimeEvent, { type: "tool.rejected" }> => event.type === "tool.rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.issues.some((issue) => issue.message.includes("required"))).toBe(true);
  const toolMessage = result.messages.find((message) => message.role === "tool");
  expect(toolMessage?.content).toContain("参数不合法");
});

it("notices when resuming with different tool definitions", async () => {
  const events: RuntimeEvent[] = [];
  const result = await runAgent({
    model: async () => turn("done", []),
    tools: [],
    goal: "test", systemPrompt: "system", workspaceRoot: ".", outDir: ".",
    permissions: { tools: [], readRoots: [], writeRoots: [], networkHosts: [] },
    budget: { maxTurns: 5, maxToolCalls: 5, maxTokens: 100_000, maxDurationMs: 30_000 },
    resume: {
      messages: [{ role: "system", content: "system" }, { role: "user", content: "goal" }],
      usage: zeroUsage(),
      turns: 0,
      toolCalls: 0,
      toolsDigest: "0000000000000000"
    },
    onEvent: (event) => events.push(event)
  });
  expect(result.status).toBe("completed");
  const notices = events.filter((event): event is Extract<RuntimeEvent, { type: "notice" }> => event.type === "notice");
  expect(notices.some((notice) => notice.message.includes("工具定义"))).toBe(true);
});

it("emits a non-empty todos.updated event after todo_write", async () => {
  const root = mkdtempSync(join(tmpdir(), "hearth-runtime-todos-"));
  const events: RuntimeEvent[] = [];
  let modelCall = 0;
  const model: AgentModel = async () => {
    modelCall += 1;
    if (modelCall === 1) {
      const args = { todos: [
        { id: "t1", content: "读取输入", status: "completed" },
        { id: "t2", content: "清洗数据", status: "in_progress" }
      ] };
      const toolCall: AgentToolCall = { id: "todo-1", name: "todo_write", arguments: args, rawArguments: JSON.stringify(args) };
      return { content: "", toolCalls: [toolCall], usage: null, finishReason: "tool_calls" };
    }
    const args = { summary: "完成" };
    const toolCall: AgentToolCall = { id: "finish-1", name: "finish_task", arguments: args, rawArguments: JSON.stringify(args) };
    return { content: "", toolCalls: [toolCall], usage: null, finishReason: "tool_calls" };
  };
  const result = await runAgent({
    model,
    tools: createBuiltinTools(),
    goal: "清洗数据",
    systemPrompt: "system",
    budget: { maxTurns: 6, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
    permissions: { tools: ["todo_write", "todo_read", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
    workspaceRoot: root,
    outDir: join(root, "out"),
    onEvent: (event) => events.push(event)
  });
  expect(result.status).toBe("completed");
  const updates = events.filter((event): event is Extract<RuntimeEvent, { type: "todos.updated" }> => event.type === "todos.updated");
  expect(updates.length).toBeGreaterThan(0);
  const latest = updates.at(-1)!;
  expect(latest.todos).toEqual([
    { id: "t1", content: "读取输入", status: "completed" },
    { id: "t2", content: "清洗数据", status: "in_progress" }
  ]);
});

it("injects the structured plan with step states back into the model", async () => {
  const root = mkdtempSync(join(tmpdir(), "hearth-runtime-plan-inject-"));
  const snapshots: string[] = [];
  let callIndex = 0;
  const model: AgentModel = async (messages) => {
    callIndex += 1;
    snapshots.push(messages.map((message) => message.content).join("\n"));
    if (callIndex === 1) {
      const args = {
        plan: "迁移测试",
        title: "Plan",
        steps: [{ title: "重写 test_delete.py", detail: "去掉 JSON" }, { title: "运行 pytest" }]
      };
      const toolCall: AgentToolCall = { id: "plan-1", name: "submit_plan", arguments: args, rawArguments: JSON.stringify(args) };
      return { content: "", toolCalls: [toolCall], usage: null, finishReason: "tool_calls" };
    }
    const args = { summary: "完成" };
    const toolCall: AgentToolCall = { id: "finish-1", name: "finish_task", arguments: args, rawArguments: JSON.stringify(args) };
    return { content: "", toolCalls: [toolCall], usage: null, finishReason: "tool_calls" };
  };
  const result = await runAgent({
    model,
    tools: createBuiltinTools(),
    goal: "迁移测试",
    systemPrompt: "system",
    budget: { maxTurns: 6, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
    permissions: { tools: ["submit_plan", "todo_write", "todo_read", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
    workspaceRoot: root,
    outDir: join(root, "out")
  });
  expect(result.status).toBe("completed");
  expect(snapshots.length).toBeGreaterThanOrEqual(2);
  expect(snapshots[1]).toContain("<active_plan>");
  expect(snapshots[1]).toContain("p1. [pending] 重写 test_delete.py");
  expect(snapshots[1]).toContain("p2. [pending] 运行 pytest");
});

describe("requirePlanFirst gate", () => {
  function toolCall(id: string, name: string, args: Record<string, unknown>): AgentToolCall {
    return { id, name, arguments: args, rawArguments: JSON.stringify(args) };
  }

  function turnWith(call: AgentToolCall): AgentModelTurn {
    return { content: "", toolCalls: [call], usage: null, finishReason: "tool_calls" };
  }

  it("refuses non-plan tools on the first turn until a plan is submitted", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-plan-gate-"));
    const events: RuntimeEvent[] = [];
    let callIndex = 0;
    const model: AgentModel = async () => {
      callIndex += 1;
      if (callIndex === 1) return turnWith(toolCall("read-1", "read_file", { path: "missing.txt" }));
      if (callIndex === 2) {
        return turnWith(toolCall("plan-1", "submit_plan", {
          steps: [{ title: "读文件" }, { title: "写结果" }]
        }));
      }
      return turnWith(toolCall("finish-1", "finish_task", { summary: "完成" }));
    };
    const result = await runAgent({
      model,
      tools: createBuiltinTools(),
      goal: "读文件后写结果",
      systemPrompt: "system",
      budget: { maxTurns: 8, maxToolCalls: 6, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: { tools: ["read_file", "submit_plan", "todo_write", "todo_read", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      workspaceRoot: root,
      outDir: join(root, "out"),
      requirePlanFirst: true,
      onEvent: (event) => events.push(event)
    });
    expect(result.status).toBe("completed");
    const executed = events
      .filter((event): event is Extract<RuntimeEvent, { type: "tool.finished" }> => event.type === "tool.finished")
      .map((event) => event.call.name);
    expect(executed).not.toContain("read_file");
    const updates = events.filter((event): event is Extract<RuntimeEvent, { type: "todos.updated" }> => event.type === "todos.updated");
    expect(updates.at(-1)?.todos).toHaveLength(2);
  });

  it("falls back to a minimal plan when the model keeps ignoring the gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-plan-fallback-"));
    const events: RuntimeEvent[] = [];
    let callIndex = 0;
    const model: AgentModel = async () => {
      callIndex += 1;
      if (callIndex <= 3) return turnWith(toolCall(`read-${callIndex}`, "read_file", { path: "missing.txt" }));
      return turnWith(toolCall("finish-1", "finish_task", { summary: "完成" }));
    };
    const result = await runAgent({
      model,
      tools: createBuiltinTools(),
      goal: "读文件后写结果",
      systemPrompt: "system",
      budget: { maxTurns: 10, maxToolCalls: 8, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: { tools: ["read_file", "submit_plan", "todo_write", "todo_read", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      workspaceRoot: root,
      outDir: join(root, "out"),
      requirePlanFirst: true,
      onEvent: (event) => events.push(event)
    });
    expect(result.status).toBe("waiting_input");
    expect(result.planSubmitted).toBe(true);
    expect(result.summary).toContain("理解任务目标与输入");
    const updates = events.filter((event): event is Extract<RuntimeEvent, { type: "todos.updated" }> => event.type === "todos.updated");
    const latest = updates.at(-1);
    expect(latest).toBeDefined();
    expect(latest!.todos.length).toBeGreaterThan(0);
    expect(latest!.todos.some((todo) => todo.content === "理解任务目标与输入")).toBe(true);
  });
});

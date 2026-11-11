import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compactAgentMessages, compactAgentMessagesWithSummary } from "./compaction.ts";
import { runAgent, zeroUsage } from "./runtime.ts";
import { createBuiltinTools, defaultTaskPermissions } from "./tools.ts";
import type { AgentCheckpoint, AgentModel, AgentModelTurn, AgentToolCall } from "./types.ts";

describe("agent runtime", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
  });

  it("continues autonomously when ask_user runs after switching to full permission", async () => {
    const root = workspace(roots);
    const notices: string[] = [];
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
      isFullPermission: () => true,
      onEvent: (event) => {
        if (event.type === "notice") notices.push(event.message);
      }
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("自行选择");
    expect(notices.join(" ")).toContain("完全权限");
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

  it("prompts once before accepting plain-text completion in native mode", async () => {
    const root = workspace(roots);
    const notices: string[] = [];
    const result = await runAgent({
      model: fakeModel([
        turn("看起来已经完成了", []),
        turn("", [call("finish_task", { summary: "确认完成" })])
      ]),
      tools: createBuiltinTools(),
      goal: "完成",
      systemPrompt: "system",
      budget: { maxTurns: 5, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] }),
      workspaceRoot: root,
      outDir: join(root, "out"),
      requireFinishTool: true,
      onEvent: (event) => { if (event.type === "notice") notices.push(event.message); }
    });
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("确认完成");
    expect(notices).toHaveLength(1);
    expect(result.messages.some((message) => message.role === "user" && message.content.includes("finish_task"))).toBe(true);
  });

  it("fails when the model keeps claiming completion without finish_task", async () => {
    const root = workspace(roots);
    const result = await runAgent({
      model: fakeModel([turn("完成了", []), turn("真的完成了", [])]),
      tools: createBuiltinTools(),
      goal: "完成",
      systemPrompt: "system",
      budget: { maxTurns: 5, maxToolCalls: 4, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] }),
      workspaceRoot: root,
      outDir: join(root, "out"),
      requireFinishTool: true
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("finish_task");
  });

  it("retries 429 and 5xx model failures twice", async () => {
    const root = workspace(roots);
    let attempts = 0;
    const model: AgentModel = async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      if (attempts === 2) throw Object.assign(new Error("upstream failed"), { status: 503 });
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
    expect(attempts).toBe(3);
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
      summarizeContext: async (omitted) => { summaries.push(omitted.length); return "超限摘要"; },
      onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); },
      retryDelayMs: 0
    });
    expect(result.status).toBe("completed");
    expect(attempts).toBe(2);
    expect(summaries[0]).toBeGreaterThan(0);
    expect(checkpoints.some((checkpoint) => checkpoint.kind === "compaction" && checkpoint.summary === "超限摘要")).toBe(true);
  });

  it("skips repeated tool calls and fails before an infinite loop", async () => {
    const root = workspace(roots);
    const repeated = call("read_file", { path: "missing.txt" });
    const result = await runAgent({
      model: fakeModel([
        turn("", [repeated]),
        turn("", [{ ...repeated, id: "repeat-1" }]),
        turn("", [{ ...repeated, id: "repeat-2" }])
      ]),
      tools: createBuiltinTools(),
      goal: "不要重复",
      systemPrompt: "system",
      budget: { maxTurns: 5, maxToolCalls: 10, maxTokens: 10_000, maxDurationMs: 30_000 },
      permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: join(root, "out"), networkHosts: [] }),
      workspaceRoot: root,
      outDir: join(root, "out")
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("重复相同工具调用");
    expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(2);
    expect(result.messages.some((message) => message.role === "tool" && message.content.includes("已跳过"))).toBe(true);
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
      onEvent: (event) => { if (event.type === "compacted") events.push("compacted"); }
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

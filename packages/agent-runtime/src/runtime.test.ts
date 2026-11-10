import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compactAgentMessages } from "./compaction.ts";
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
});

describe("context compaction", () => {
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
});

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

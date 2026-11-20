import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_TOOL_NAMES, ToolCatalog } from "./harness/tool-catalog.ts";
import { deserializeAgentState } from "./harness/checkpoint-state.ts";
import { runAgent } from "./runtime.ts";
import { createBuiltinTools } from "./tools.ts";
import { createFakeModel, fakeToolCall } from "./test-support/fake-model.ts";
import type { AgentCheckpoint, AgentTool, AgentToolContext } from "./types.ts";

const fakeNames = [
  "jira_create_issue",
  "jira_search_issues",
  "jira_transition_issue",
  ...Array.from({ length: 97 }, (_, index) => `mcp_extra_${index + 1}`)
];

describe("tool catalog", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("direct-exposes only core tools when the catalog is large", () => {
    const tools = [fakeTool("finish_task"), ...fakeNames.map((name) => fakeTool(name))];
    const catalog = new ToolCatalog(tools);
    const definitions = catalog.definitions();
    const coreAvailable = CORE_TOOL_NAMES.filter((name) => tools.some((tool) => tool.definition.name === name));
    expect(catalog.deferred).toBe(true);
    expect(definitions.map((definition) => definition.name).sort()).toEqual(coreAvailable.sort());
    expect(definitions.length).toBeLessThanOrEqual(coreAvailable.length + 2);
    expect(catalog.resolve("jira_create_issue")).toBeUndefined();
  });

  it("returns matching schemas and makes them callable", () => {
    const catalog = new ToolCatalog(fakeNames.map((name) => fakeTool(name)));
    const matches = catalog.search("jira", 5);
    expect(matches.map((match) => match.name).sort()).toEqual(["jira_create_issue", "jira_search_issues", "jira_transition_issue"]);
    expect(matches[0]?.parameters).toEqual({ type: "object", properties: {} });
    expect(catalog.resolve("jira_create_issue")).toBeUndefined();
    catalog.expose(matches.map((match) => match.name));
    expect(catalog.resolve("jira_create_issue")?.definition.name).toBe("jira_create_issue");
    expect(catalog.definitions().some((definition) => definition.name === "jira_create_issue")).toBe(true);
  });

  it("hides tools from the model and executes deferred tools through tool_call", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-catalog-"));
    roots.push(root);
    const executed: string[] = [];
    const approved: string[] = [];
    const checkpoints: AgentCheckpoint[] = [];
    const tools = [
      ...createBuiltinTools().filter((tool) => tool.definition.name === "finish_task"),
      ...fakeNames.map((name) => fakeTool(name, executed))
    ];
    const fake = createFakeModel([
      { content: "", toolCalls: [fakeToolCall("mcp_extra_1")], finishReason: "tool_calls" },
      { content: "", toolCalls: [fakeToolCall("tool_search", { query: "jira" })], finishReason: "tool_calls" },
      { content: "", toolCalls: [fakeToolCall("tool_call", { name: "jira_create_issue", arguments: { title: "open" } })], finishReason: "tool_calls" },
      { content: "done", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
    ]);
    const result = await runAgent({
      model: fake.model,
      tools,
      goal: "catalog",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["finish_task", ...fakeNames], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      authorizeTool: async ({ call }) => {
        approved.push(call.name);
        return { allowed: true };
      },
      onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); }
    });

    expect(result.status).toBe("completed");
    expect(fake.state.requests[0]?.tools.length).toBe(3);
    expect(fake.state.requests[0]?.tools.map((tool) => tool.name)).toEqual(["finish_task", "tool_search", "tool_call"]);
    expect(fake.state.requests[2]?.tools.some((tool) => tool.name === "jira_create_issue")).toBe(true);
    expect(result.messages.some((message) => message.role === "tool" && message.content.includes("未知或未授权工具"))).toBe(true);
    expect(executed).toContain("jira_create_issue");
    expect(approved).toContain("jira_create_issue");
    expect(approved).not.toContain("tool_call");
    const persisted = deserializeAgentState(checkpoints.at(-1)?.state);
    expect(persisted?.exposedTools).toContain("jira_create_issue");
  });

  it("resumes with the tools discovered before the restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-catalog-"));
    roots.push(root);
    const executed: string[] = [];
    const first = createFakeModel([
      { content: "", toolCalls: [fakeToolCall("tool_search", { query: "jira" })], finishReason: "tool_calls" },
      { content: "done", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
    ]);
    const tools = [
      ...createBuiltinTools().filter((tool) => tool.definition.name === "finish_task"),
      ...fakeNames.map((name) => fakeTool(name, executed))
    ];
    const saved: AgentCheckpoint[] = [];
    await runAgent({
      model: first.model,
      tools,
      goal: "catalog",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["finish_task", ...fakeNames], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      onCheckpoint: (checkpoint) => { saved.push(checkpoint); }
    });
    const checkpoint = saved.at(-1)!;
    const state = deserializeAgentState(checkpoint.state);
    expect(state?.exposedTools).toContain("jira_create_issue");

    const resumed = createFakeModel([
      { content: "", toolCalls: [fakeToolCall("tool_call", { name: "jira_create_issue", arguments: {} })], finishReason: "tool_calls" },
      { content: "done", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
    ]);
    const result = await runAgent({
      model: resumed.model,
      tools,
      goal: "catalog",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["finish_task", ...fakeNames], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      resume: {
        messages: checkpoint.messages,
        usage: checkpoint.usage,
        turns: checkpoint.turns,
        toolCalls: checkpoint.toolCalls,
        ...(state ? { state } : {}),
        ...(checkpoint.promptHash ? { promptHash: checkpoint.promptHash } : {})
      }
    });
    expect(result.status).toBe("completed");
    expect(executed.filter((name) => name === "jira_create_issue")).toHaveLength(1);
  });
});

function fakeTool(name: string, executed?: string[]): AgentTool {
  return {
    definition: { name, description: `${name} performs a fake MCP operation`, parameters: { type: "object", properties: {} } },
    async execute(_input: unknown, _context: AgentToolContext) {
      executed?.push(name);
      return { content: `${name} ok` };
    }
  };
}

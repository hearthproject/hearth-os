import { describe, expect, it, vi } from "vitest";
import type { McpServerView } from "@hearth/core";
import { createMcpTools, McpToolBindingError, mcpToolName, parseMcpToolName, type McpToolProvider } from "./mcp-tools.ts";
import { requiresToolApproval, toolApprovalSummary } from "./tool-policy.ts";

const now = "2026-11-11T00:00:00.000Z";

describe("native MCP tools", () => {
  it("binds ready and enabled servers with stable names and schema", async () => {
    const provider = fakeProvider([
      server("mcp_one", "One", [
        { name: "search", description: "Search docs", inputSchema: { type: "object", properties: {}, additionalProperties: false } }
      ])
    ]);
    const tools = createMcpTools(provider);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.definition.name).toBe("mcp__mcp_one__search");
    expect(tools[0]?.definition.description).toContain("One / search");
    expect(tools[0]?.definition.parameters).toMatchObject({ type: "object" });

    const result = await tools[0]!.execute({ query: "x" }, {
      workspaceRoot: "C:\\workspace",
      outDir: "C:\\workspace\\out",
      permissions: { readRoots: [], writeRoots: [], networkHosts: [], tools: [] },
      signal: new AbortController().signal
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("MCP 工具 One/search");
    expect(provider.callTool).toHaveBeenCalledWith("mcp_one", "search", { query: "x" }, expect.any(Object));
  });

  it("omits disabled or unready servers and reports tool failures as tool results", async () => {
    const provider = fakeProvider([
      { ...server("mcp_off", "Off", []), enabled: false },
      { ...server("mcp_bad", "Bad", []), status: "error" },
      server("mcp_ok", "OK", [
        { name: "fail", description: "", inputSchema: { type: "object" } }
      ])
    ]);
    provider.callTool.mockRejectedValueOnce(new Error("server crashed"));
    const tools = createMcpTools(provider);
    expect(tools.map((tool) => tool.definition.name)).toEqual(["mcp__mcp_ok__fail"]);
    const result = await tools[0]!.execute({}, {
      workspaceRoot: "C:\\workspace",
      outDir: "C:\\workspace\\out",
      permissions: { readRoots: [], writeRoots: [], networkHosts: [], tools: [] },
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("server crashed");
  });

  it("fails closed on duplicate qualified names", () => {
    const duplicate = server("mcp_dup", "Dup", [
      { name: "echo", description: "", inputSchema: { type: "object" } }
    ]);
    expect(() => createMcpTools(fakeProvider([duplicate, duplicate]))).toThrow(McpToolBindingError);
    expect(() => createMcpTools(fakeProvider([duplicate, duplicate]))).toThrow(/名称冲突/);
  });

  it("parses names containing underscores and marks MCP calls for approval", () => {
    expect(mcpToolName("mcp_one", "read__thing")).toBe("mcp__mcp_one__read__thing");
    expect(parseMcpToolName("mcp__mcp_one__read__thing")).toEqual({ serverId: "mcp_one", toolName: "read__thing" });
    expect(parseMcpToolName("mcp__broken")).toBeNull();
    expect(requiresToolApproval("mcp__mcp_one__read__thing")).toBe(true);
    expect(toolApprovalSummary("mcp__mcp_one__read__thing", {})).toContain("mcp_one/read__thing");
  });
});

function server(id: string, name: string, tools: McpServerView["tools"]): McpServerView {
  return {
    id,
    name,
    transport: "stdio",
    command: "node",
    args: [],
    envKeys: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    status: "ready",
    tools,
    error: null,
    lastProbeAt: now
  };
}

function fakeProvider(servers: McpServerView[]): McpToolProvider & { callTool: ReturnType<typeof vi.fn> } {
  return {
    list: () => servers,
    callTool: vi.fn(async (serverId: string, toolName: string) => ({
      content: `${serverId}/${toolName}:ok`,
      isError: false
    }))
  } as McpToolProvider & { callTool: ReturnType<typeof vi.fn> };
}

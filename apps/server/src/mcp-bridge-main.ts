import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

interface SelectedMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
  serverName: string;
  sourceName: string;
}

interface McpServerView {
  id: string;
  name: string;
  enabled: boolean;
  status: "unchecked" | "ready" | "error";
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  error: string | null;
}

const baseUrl = (process.env.HEARTH_BASE_URL ?? "http://127.0.0.1:4317").replace(/\/+$/, "");
const serverIds = parseServerIds(process.env.HEARTH_MCP_SERVER_IDS);
const selected: SelectedMcpTool[] = [];
const toolNames = new Set<string>();

for (const id of serverIds) {
  const response = await requestJson<{ server: McpServerView }>(`/api/mcp/servers/${encodeURIComponent(id)}`);
  const server = response.server;
  if (!server.enabled || server.status !== "ready") {
    throw new Error(`MCP 服务器“${server.name}”当前不可用：${server.error ?? server.status}`);
  }
  for (const tool of server.tools) {
    const qualified = `${server.id}__${tool.name}`;
    if (toolNames.has(qualified)) throw new Error(`MCP 工具名称冲突：${qualified}`);
    toolNames.add(qualified);
    selected.push({
      name: qualified,
      description: `[MCP：${server.name} / ${tool.name}] ${tool.description || "MCP 工具"}`,
      inputSchema: tool.inputSchema,
      serverId: server.id,
      serverName: server.name,
      sourceName: tool.name
    });
  }
}

const mcp = new Server(
  { name: "hearth-selected-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: selected.map((tool) => ({
    name: tool.name,
    description: tool.description.slice(0, 2_200),
    inputSchema: tool.inputSchema
  }))
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = selected.find((candidate) => candidate.name === request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `MCP 工具不存在：${request.params.name}` }]
    };
  }
  try {
    const response = await requestJson<{ result: { content: string; isError: boolean } }>(
      `/api/mcp/servers/${encodeURIComponent(tool.serverId)}/tools/${encodeURIComponent(tool.sourceName)}/call`,
      {
        method: "POST",
        body: JSON.stringify({ arguments: request.params.arguments ?? {} })
      }
    );
    return {
      ...(response.result.isError ? { isError: true } : {}),
      content: [{ type: "text" as const, text: response.result.content }]
    };
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: `MCP 工具 ${tool.serverName}/${tool.sourceName} 调用失败：${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }
});

await mcp.connect(new StdioServerTransport());

function parseServerIds(value: string | undefined): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? "[]") as unknown;
  } catch {
    throw new Error("HEARTH_MCP_SERVER_IDS 不是合法 JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("HEARTH_MCP_SERVER_IDS 必须是数组");
  const ids = [...new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
  if (ids.length === 0) throw new Error("没有选择 MCP 服务器");
  if (ids.length > 8) throw new Error("一次最多选择 8 个 MCP 服务器");
  return ids;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "message" in payload
      ? String((payload as { message: unknown }).message)
      : `Hearth 返回 HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

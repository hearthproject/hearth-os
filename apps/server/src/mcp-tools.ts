import type { AgentTool, AgentToolResult } from "@hearth/agent-runtime";
import type { McpServerView } from "@hearth/core";
import type { McpToolCallOptions, McpToolCallResult, McpServerService } from "./mcp-servers.ts";

export const MCP_TOOL_PREFIX = "mcp__";

const MAX_QUALIFIED_NAME_CHARS = 220;
const BUILTIN_TOOL_NAMES = new Set([
  "read_file",
  "read_document",
  "list_files",
  "search_text",
  "glob",
  "grep",
  "write_file",
  "write_spreadsheet",
  "write_document",
  "edit_file",
  "apply_patch",
  "shell",
  "capture_screen",
  "fetch_url",
  "ask_user",
  "finish_task",
  "web_search",
  "load_skill",
  "read_skill_resource",
  "delegate_task"
]);

export interface McpToolProvider {
  list(): McpServerView[];
  callTool(serverId: string, toolName: string, args: unknown, options?: McpToolCallOptions): Promise<McpToolCallResult>;
}

export class McpToolBindingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpToolBindingError";
    this.code = code;
  }
}

export function mcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__${toolName}`;
}

export function parseMcpToolName(value: string): { serverId: string; toolName: string } | null {
  if (!value.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = value.slice(MCP_TOOL_PREFIX.length);
  const separator = rest.indexOf("__");
  if (separator <= 0 || separator >= rest.length - 2) return null;
  return {
    serverId: rest.slice(0, separator),
    toolName: rest.slice(separator + 2)
  };
}

export function createMcpTools(provider: McpToolProvider): AgentTool[] {
  const names = new Set(BUILTIN_TOOL_NAMES);
  const tools: AgentTool[] = [];
  for (const server of provider.list()) {
    if (!server.enabled || server.status !== "ready") continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(server.id)) {
      throw new McpToolBindingError("MCP_SERVER_ID_INVALID", `MCP 服务器 id 不合法：${server.id}`);
    }
    for (const descriptor of server.tools) {
      const name = mcpToolName(server.id, descriptor.name);
      if (name.length > MAX_QUALIFIED_NAME_CHARS) {
        throw new McpToolBindingError("MCP_TOOL_NAME_TOO_LONG", `MCP 工具名称过长：${name}`);
      }
      if (names.has(name)) {
        throw new McpToolBindingError("MCP_TOOL_NAME_CONFLICT", `MCP 工具名称冲突：${name}`);
      }
      names.add(name);
      tools.push({
        definition: {
          name,
          description: `[MCP：${clipInline(server.name, 120)} / ${descriptor.name}] ${descriptor.description || "MCP 服务器工具"}`.slice(0, 2_200),
          parameters: descriptor.inputSchema
        },
        async execute(input, context): Promise<AgentToolResult> {
          try {
            const result = await provider.callTool(server.id, descriptor.name, input, {
              signal: context.signal
            });
            return {
              content: `MCP 工具 ${server.name}/${descriptor.name}：\n${result.content}`,
              ...(result.isError ? { isError: true } : {})
            };
          } catch (error) {
            return {
              content: `MCP 工具 ${server.name}/${descriptor.name} 调用失败：${error instanceof Error ? error.message : String(error)}`,
              isError: true
            };
          }
        }
      });
    }
  }
  return tools;
}

function clipInline(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

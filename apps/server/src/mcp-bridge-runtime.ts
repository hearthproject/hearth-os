import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEARTH_ROOT, HOST, PORT } from "./config.ts";

export interface McpBridgeLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpBridgeLaunchOptions {
  serverIds: string[];
  root?: string;
  entry?: string;
  baseUrl?: string;
  nodePath?: string;
  exists?: (path: string) => boolean;
}

/** Launches the task-scoped stdio proxy used by Codex and DeepSeek Harness. */
export function mcpBridgeLaunch(options: McpBridgeLaunchOptions): McpBridgeLaunch {
  const ids = [...new Set(options.serverIds.map((id) => id.trim()).filter(Boolean))].slice(0, 8);
  if (ids.length === 0) throw new Error("没有选择 MCP 服务器");
  const root = options.root ?? HEARTH_ROOT;
  const exists = options.exists ?? existsSync;
  const node = options.nodePath ?? process.env.HEARTH_NODE_PATH ?? process.execPath;
  const baseUrl = (options.baseUrl ?? process.env.HEARTH_BASE_URL ?? `http://${HOST}:${PORT}`).replace(/\/+$/, "");
  const explicit = options.entry ?? process.env.HEARTH_MCP_BRIDGE_ENTRY;
  const bundled = fileURLToPath(new URL("./mcp-bridge.mjs", import.meta.url));
  const source = join(root, "apps", "server", "src", "mcp-bridge-main.ts");
  const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  let args: string[];
  if (explicit) {
    args = [explicit];
  } else if (exists(bundled)) {
    args = [bundled];
  } else {
    args = [tsx, source];
  }
  return {
    command: node,
    args,
    env: {
      HEARTH_BASE_URL: baseUrl,
      HEARTH_MCP_SERVER_IDS: JSON.stringify(ids)
    }
  };
}
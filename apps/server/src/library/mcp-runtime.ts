import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEARTH_ROOT, HOST, PORT } from "../config.ts";

export interface LibraryMcpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface LibraryMcpLaunchOptions {
  root?: string;
  entry?: string;
  baseUrl?: string;
  nodePath?: string;
  exists?: (path: string) => boolean;
}

export function libraryMcpLaunch(options: LibraryMcpLaunchOptions = {}): LibraryMcpLaunch {
  const root = options.root ?? HEARTH_ROOT;
  const exists = options.exists ?? existsSync;
  const node = options.nodePath ?? process.env.HEARTH_NODE_PATH ?? process.execPath;
  const baseUrl = (options.baseUrl ?? process.env.HEARTH_BASE_URL ?? `http://${HOST}:${PORT}`).replace(/\/+$/, "");
  const explicit = options.entry ?? process.env.HEARTH_LIBRARY_MCP_ENTRY;
  const bundled = fileURLToPath(new URL("./library-mcp.mjs", import.meta.url));
  const source = join(root, "apps", "server", "src", "library", "mcp-main.ts");
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
    env: { HEARTH_BASE_URL: baseUrl }
  };
}

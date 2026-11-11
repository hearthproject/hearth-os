import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig, McpServerView, McpToolDescriptor } from "@hearth/core";
import type { HearthStore, McpServerRecord } from "@hearth/eventlog";
import type { SecretBox } from "./secrets.ts";

const MAX_TOOLS = 100;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_PROBE_ERROR_CHARS = 1_000;

export class McpServerError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "McpServerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface McpServerInput {
  name: string;
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  enabled?: boolean | undefined;
}

export interface McpServerUpdateInput {
  name?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  enabled?: boolean | undefined;
}

export interface McpServerServiceOptions {
  store: HearthStore;
  secretBox: SecretBox;
  clock?: () => Date;
  timeoutMs?: number;
}

export class McpServerService {
  private readonly store: HearthStore;
  private readonly secretBox: SecretBox;
  private readonly clock: () => Date;
  private readonly timeoutMs: number;

  constructor(options: McpServerServiceOptions) {
    this.store = options.store;
    this.secretBox = options.secretBox;
    this.clock = options.clock ?? (() => new Date());
    this.timeoutMs = Math.max(1_000, Math.min(60_000, options.timeoutMs ?? 12_000));
  }

  list(): McpServerView[] {
    return this.store.listMcpServers().map(toView);
  }

  get(id: string): McpServerView {
    return toView(this.require(id));
  }

  async create(input: McpServerInput): Promise<McpServerView> {
    const normalized = normalizeInput(input);
    const now = this.clock().toISOString();
    const env = normalized.env ?? {};
    const config: McpServerConfig = {
      id: `mcp_${randomUUID().slice(0, 8)}`,
      name: normalized.name,
      transport: "stdio",
      command: normalized.command,
      args: normalized.args,
      envKeys: Object.keys(env).sort(),
      enabled: normalized.enabled,
      createdAt: now,
      updatedAt: now
    };
    const record = this.store.upsertMcpServer(config, this.encryptEnv(env));
    return record.enabled ? this.probe(record.id) : toView(record);
  }

  async update(id: string, input: McpServerUpdateInput): Promise<McpServerView> {
    const current = this.require(id);
    const normalized = normalizeInput({
      name: input.name ?? current.name,
      command: input.command ?? current.command,
      args: input.args ?? current.args,
      env: input.env,
      enabled: input.enabled ?? current.enabled
    });
    const now = this.clock().toISOString();
    const envCipher = normalized.env === undefined ? current.envCipher : this.encryptEnv(normalized.env);
    const envKeys = normalized.env === undefined ? current.envKeys : Object.keys(normalized.env ?? {}).sort();
    const config: McpServerConfig = {
      id: current.id,
      name: normalized.name,
      transport: "stdio",
      command: normalized.command,
      args: normalized.args,
      envKeys,
      enabled: normalized.enabled,
      createdAt: current.createdAt,
      updatedAt: now
    };
    const record = this.store.upsertMcpServer(config, envCipher);
    return record.enabled ? this.probe(record.id) : toView(record);
  }

  delete(id: string): void {
    this.require(id);
    this.store.deleteMcpServer(id);
  }

  async probe(id: string): Promise<McpServerView> {
    const record = this.require(id);
    const env = this.decryptEnv(record);
    const checkedAt = this.clock().toISOString();
    try {
      const tools = await this.discover(record, env);
      return toView(this.store.updateMcpServerProbe(id, {
        status: "ready",
        tools,
        error: null,
        lastProbeAt: checkedAt
      }));
    } catch (error) {
      const message = redactError(error, env).slice(0, MAX_PROBE_ERROR_CHARS);
      return toView(this.store.updateMcpServerProbe(id, {
        status: "error",
        tools: [],
        error: message,
        lastProbeAt: checkedAt
      }));
    }
  }

  environment(id: string): Record<string, string> {
    return this.decryptEnv(this.require(id));
  }

  private async discover(record: McpServerRecord, env: Record<string, string>): Promise<McpToolDescriptor[]> {
    const client = new Client({ name: "hearth", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: record.command,
      args: record.args,
      env,
      stderr: "pipe",
      maxBufferSize: 4 * 1024 * 1024
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_000);
    });
    try {
      await client.connect(transport, { timeout: this.timeoutMs });
      const result = await client.listTools(undefined, { timeout: this.timeoutMs });
      if (result.tools.length > MAX_TOOLS) {
        throw new McpServerError("MCP_TOO_MANY_TOOLS", `MCP 服务器暴露了超过 ${MAX_TOOLS} 个工具`, 409);
      }
      const seen = new Set<string>();
      return result.tools.map((tool) => {
        const name = String(tool.name ?? "").trim();
        if (!name || name.length > MAX_TOOL_NAME_CHARS || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
          throw new McpServerError("MCP_TOOL_NAME_INVALID", `MCP 工具名称不合法：${name || "(空)"}`, 409);
        }
        if (seen.has(name)) throw new McpServerError("MCP_TOOL_DUPLICATE", `MCP 工具名称重复：${name}`, 409);
        seen.add(name);
        return {
          name,
          description: String(tool.description ?? "").slice(0, MAX_DESCRIPTION_CHARS),
          inputSchema: normalizeSchema(tool.inputSchema)
        };
      });
    } catch (error) {
      if (stderr.trim() && error instanceof Error && !error.message.trim()) error.message = stderr.trim().slice(-MAX_PROBE_ERROR_CHARS);
      throw error;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private encryptEnv(env: Record<string, string>): string | null {
    return Object.keys(env).length > 0 ? this.secretBox.encrypt(JSON.stringify(env)) : null;
  }

  private decryptEnv(record: McpServerRecord): Record<string, string> {
    if (!record.envCipher) return {};
    try {
      const parsed = JSON.parse(this.secretBox.decrypt(record.envCipher)) as unknown;
      return normalizeEnv(parsed);
    } catch {
      throw new McpServerError("MCP_SECRET_INVALID", "MCP 服务器环境密钥无法解密，请重新保存", 409);
    }
  }

  private require(id: string): McpServerRecord {
    const record = this.store.getMcpServer(id);
    if (!record) throw new McpServerError("MCP_SERVER_NOT_FOUND", "MCP 服务器不存在", 404);
    return record;
  }
}

function toView(record: McpServerRecord): McpServerView {
  const { envCipher: _envCipher, ...view } = record;
  return view;
}

function normalizeInput(input: McpServerInput): {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string> | undefined;
  enabled: boolean;
} {
  const name = input.name?.trim() ?? "";
  if (!name) throw new McpServerError("MCP_NAME_REQUIRED", "请填写服务器名称");
  if (name.length > 100) throw new McpServerError("MCP_NAME_TOO_LONG", "服务器名称不能超过 100 个字符");
  const command = input.command?.trim() ?? "";
  if (!command) throw new McpServerError("MCP_COMMAND_REQUIRED", "请填写启动命令");
  if (command.length > 1_000 || command.includes("\0")) throw new McpServerError("MCP_COMMAND_INVALID", "启动命令不合法");
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > 64) throw new McpServerError("MCP_ARGS_INVALID", "启动参数最多 64 个");
  const cleanArgs = args.map((arg) => {
    if (typeof arg !== "string" || arg.length > 4_000 || arg.includes("\0")) {
      throw new McpServerError("MCP_ARGS_INVALID", "启动参数不合法");
    }
    return arg;
  });
  return {
    name,
    command,
    args: cleanArgs,
    env: input.env === undefined ? undefined : normalizeEnv(input.env),
    enabled: input.enabled ?? true
  };
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpServerError("MCP_ENV_INVALID", "环境变量必须是键值对象");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) throw new McpServerError("MCP_ENV_TOO_MANY", "环境变量最多 32 个");
  const env: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new McpServerError("MCP_ENV_KEY_INVALID", `环境变量名不合法：${key}`);
    if (typeof raw !== "string" || raw.length > 4_000 || raw.includes("\0")) {
      throw new McpServerError("MCP_ENV_VALUE_INVALID", `环境变量值不合法：${key}`);
    }
    env[key] = raw;
  }
  return env;
}

function normalizeSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "object", properties: {} };
  }
  return value as Record<string, unknown>;
}

function redactError(error: unknown, env: Record<string, string>): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of Object.values(env)) {
    if (value.length >= 4) message = message.split(value).join("***");
  }
  return message.trim() || "MCP 服务器探测失败";
}

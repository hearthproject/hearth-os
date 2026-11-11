import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Ajv, type ValidateFunction } from "ajv";
import type { McpServerConfig, McpServerView, McpToolDescriptor } from "@hearth/core";
import type { HearthStore, McpServerRecord } from "@hearth/eventlog";
import type { SecretBox } from "./secrets.ts";

const MAX_TOOLS = 100;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_PROBE_ERROR_CHARS = 1_000;
const MAX_SCHEMA_CHARS = 64_000;
const MAX_RESULT_CHARS = 100_000;

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

export interface McpToolCallOptions {
  signal?: AbortSignal | undefined;
}

export interface McpToolCallResult {
  content: string;
  isError: boolean;
}

export class McpServerService {
  private readonly store: HearthStore;
  private readonly secretBox: SecretBox;
  private readonly clock: () => Date;
  private readonly timeoutMs: number;
  private readonly ajv: Ajv;

  constructor(options: McpServerServiceOptions) {
    this.store = options.store;
    this.secretBox = options.secretBox;
    this.clock = options.clock ?? (() => new Date());
    this.timeoutMs = Math.max(1_000, Math.min(60_000, options.timeoutMs ?? 12_000));
    this.ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
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

  async callTool(
    serverId: string,
    toolName: string,
    args: unknown,
    options: McpToolCallOptions = {}
  ): Promise<McpToolCallResult> {
    const record = this.require(serverId);
    if (!record.enabled) throw new McpServerError("MCP_SERVER_DISABLED", "MCP 服务器已停用", 409);
    if (record.status !== "ready") throw new McpServerError("MCP_SERVER_NOT_READY", "MCP 服务器尚未通过探测", 409);
    const tool = record.tools.find((item) => item.name === toolName);
    if (!tool) throw new McpServerError("MCP_TOOL_NOT_FOUND", "MCP 工具不存在或已被移除", 404);
    const env = this.decryptEnv(record);
    const argumentsValue = args === undefined ? {} : args;
    this.validateArguments(tool, argumentsValue, env);
    return this.executeTool(record, tool, argumentsValue as Record<string, unknown>, env, options.signal);
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
        const inputSchema = normalizeSchema(tool.inputSchema);
        const schemaText = JSON.stringify(inputSchema);
        if (schemaText.length > MAX_SCHEMA_CHARS) {
          throw new McpServerError("MCP_SCHEMA_TOO_LARGE", `MCP 工具 ${name} 的输入 Schema 过大`, 409);
        }
        try {
          this.ajv.compile(inputSchema);
        } catch (error) {
          throw new McpServerError("MCP_SCHEMA_INVALID", `MCP 工具 ${name} 的输入 Schema 不合法：${redactError(error, env || {})}`, 409);
        }
        return {
          name,
          description: String(tool.description ?? "").slice(0, MAX_DESCRIPTION_CHARS),
          inputSchema
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

  private validateArguments(tool: McpToolDescriptor, args: unknown, env: Record<string, string>): void {
    let validate: ValidateFunction;
    try {
      validate = this.ajv.compile(tool.inputSchema);
    } catch (error) {
      throw new McpServerError("MCP_SCHEMA_INVALID", `MCP 工具 ${tool.name} 的输入 Schema 不合法：${redactError(error, env)}`, 409);
    }
    if (!validate(args)) {
      const details = (validate.errors ?? [])
        .slice(0, 5)
        .map((error) => `${error.instancePath || "/"} ${error.message ?? "不合法"}`)
        .join("；");
      throw new McpServerError("MCP_ARGUMENTS_INVALID", `MCP 工具参数不合法：${redactText(details, env).slice(0, 1_000)}`);
    }
  }

  private async executeTool(
    record: McpServerRecord,
    tool: McpToolDescriptor,
    args: Record<string, unknown>,
    env: Record<string, string>,
    signal: AbortSignal | undefined
  ): Promise<McpToolCallResult> {
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
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const callSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      await client.connect(transport, { timeout: this.timeoutMs, signal: callSignal });
      const result = await client.callTool(
        { name: tool.name, arguments: args },
        undefined,
        { timeout: this.timeoutMs, signal: callSignal }
      );
      return normalizeCallResult(result as CallToolResult, env);
    } catch (error) {
      if (signal?.aborted) throw new McpServerError("MCP_TOOL_CANCELLED", "MCP 工具调用已取消", 499);
      if (timeoutSignal.aborted) {
        throw new McpServerError("MCP_TOOL_TIMEOUT", `MCP 工具调用超时（${this.timeoutMs}ms）`, 504);
      }
      const message = redactError(error, env);
      const stderrMessage = stderr.trim() ? `；服务器输出：${redactText(stderr.trim(), env)}` : "";
      throw new McpServerError("MCP_TOOL_CALL_FAILED", `${message}${stderrMessage}`.slice(0, MAX_PROBE_ERROR_CHARS), 502);
    } finally {
      await client.close().catch(() => undefined);
    }
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
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message, env).trim() || "MCP 服务器探测失败";
}

function redactText(message: string, env: Record<string, string>): string {
  let redacted = message;
  for (const value of Object.values(env)) {
    if (value) redacted = redacted.split(value).join("***");
  }
  return redacted;
}

function normalizeCallResult(result: CallToolResult, env: Record<string, string>): McpToolCallResult {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "resource") {
      const resource = block.resource;
      parts.push("text" in resource
        ? `[资源 ${resource.uri}]\n${resource.text}`
        : `[资源 ${resource.uri}，二进制内容已省略]`);
    } else if (block.type === "resource_link") {
      parts.push(`[资源链接 ${block.name}]\n${block.uri}`);
    } else {
      parts.push(`[${block.type} 内容已省略]`);
    }
  }
  if (result.structuredContent !== undefined) {
    parts.push(`结构化结果：\n${JSON.stringify(result.structuredContent, null, 2)}`);
  }
  const text = redactText(parts.filter(Boolean).join("\n\n"), env) || "（MCP 工具没有返回内容）";
  return {
    content: text.length <= MAX_RESULT_CHARS
      ? text
      : `${text.slice(0, MAX_RESULT_CHARS)}\n\n... MCP 工具结果已截断（原始 ${text.length} 字符）`,
    isError: result.isError === true
  };
}

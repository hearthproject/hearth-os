import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Ajv, type ValidateFunction } from "ajv";
import type {
  McpRegistryCandidate,
  McpServerConfig,
  McpServerView,
  McpToolDescriptor,
  McpTransport
} from "@hearth/core";
import type { HearthStore, McpServerRecord } from "@hearth/eventlog";
import type { LibraryService } from "./library/service.ts";
import type { McpRegistryClient } from "./mcp-registry.ts";
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
  transport?: McpTransport | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  url?: string | null | undefined;
  env?: Record<string, string> | undefined;
  headers?: Record<string, string> | undefined;
  enabled?: boolean | undefined;
}

export interface McpServerUpdateInput {
  name?: string | undefined;
  transport?: McpTransport | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  url?: string | null | undefined;
  env?: Record<string, string> | undefined;
  headers?: Record<string, string> | undefined;
  enabled?: boolean | undefined;
}

export interface InstallRegistryMcpInput {
  serverName: string;
  env?: Record<string, string> | undefined;
  headers?: Record<string, string> | undefined;
  enabled?: boolean | undefined;
}

export interface McpServerServiceOptions {
  store: HearthStore;
  secretBox: SecretBox;
  registry?: McpRegistryClient | undefined;
  library?: LibraryService | undefined;
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

interface Secrets {
  env: Record<string, string>;
  headers: Record<string, string>;
}

interface NormalizedMcpInput {
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string | null;
  env: Record<string, string> | undefined;
  headers: Record<string, string> | undefined;
  enabled: boolean;
}

export class McpServerService {
  private readonly store: HearthStore;
  private readonly secretBox: SecretBox;
  private readonly registry: McpRegistryClient | null;
  private readonly library: LibraryService | null;
  private readonly clock: () => Date;
  private readonly timeoutMs: number;
  private readonly ajv: Ajv;

  constructor(options: McpServerServiceOptions) {
    this.store = options.store;
    this.secretBox = options.secretBox;
    this.registry = options.registry ?? null;
    this.library = options.library ?? null;
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
    const config: McpServerConfig = {
      id: `mcp_${randomUUID().slice(0, 8)}`,
      name: normalized.name,
      transport: normalized.transport,
      command: normalized.command,
      args: normalized.args,
      url: normalized.url,
      envKeys: Object.keys(normalized.env ?? {}).sort(),
      headerKeys: Object.keys(normalized.headers ?? {}).sort(),
      authMode: Object.keys(normalized.headers ?? {}).length > 0 ? "headers" : "none",
      registryServerId: null,
      registryName: null,
      packageName: null,
      packageVersion: null,
      runtime: normalized.transport === "stdio" ? "manual" : "remote",
      manifest: {},
      enabled: normalized.enabled,
      createdAt: now,
      updatedAt: now
    };
    const record = this.store.upsertMcpServer(config, this.encryptSecrets(normalized));
    const saved = record.enabled ? await this.probe(record.id) : toView(record);
    this.refreshLibrary(this.require(record.id));
    return saved;
  }

  async update(id: string, input: McpServerUpdateInput): Promise<McpServerView> {
    const current = this.require(id);
    const normalized = normalizeInput({
      name: input.name ?? current.name,
      transport: input.transport ?? current.transport,
      command: input.command ?? current.command,
      args: input.args ?? current.args,
      url: input.url === undefined ? current.url : input.url,
      env: input.env,
      headers: input.headers,
      enabled: input.enabled ?? current.enabled
    });
    const now = this.clock().toISOString();
    const previousSecrets = { envCipher: current.envCipher, headersCipher: current.headersCipher };
    const secrets = {
      envCipher: normalized.env === undefined ? current.envCipher : this.encryptJson(normalized.env),
      headersCipher: normalized.headers === undefined ? current.headersCipher : this.encryptJson(normalized.headers)
    };
    const config: McpServerConfig = {
      ...configFromRecord(current),
      name: normalized.name,
      transport: normalized.transport,
      command: normalized.command,
      args: normalized.args,
      url: normalized.url,
      envKeys: normalized.env === undefined ? current.envKeys : Object.keys(normalized.env).sort(),
      headerKeys: normalized.headers === undefined ? current.headerKeys : Object.keys(normalized.headers).sort(),
      authMode: normalized.headers === undefined
        ? current.authMode
        : Object.keys(normalized.headers).length > 0 ? "headers" : "none",
      enabled: normalized.enabled,
      updatedAt: now
    };
    const record = this.store.upsertMcpServer(config, secrets);
    this.refreshLibrary(record);
    try {
      return record.enabled ? await this.probe(record.id) : toView(record);
    } catch (error) {
      this.store.upsertMcpServer(configFromRecord(current), previousSecrets);
      this.store.updateMcpServerProbe(id, {
        status: current.status,
        tools: current.tools,
        error: current.error,
        lastProbeAt: current.lastProbeAt
      });
      this.refreshLibrary(this.require(id));
      throw error;
    }
  }

  delete(id: string): McpServerView {
    const record = this.require(id);
    this.store.deleteMcpServer(id);
    this.library?.tree.removeMcpServer(id);
    this.library?.markDirty();
    return toView(record);
  }

  async probe(id: string): Promise<McpServerView> {
    const record = this.require(id);
    const secrets = this.decryptSecrets(record);
    const checkedAt = this.clock().toISOString();
    try {
      const tools = await this.discover(record, secrets);
      const updated = this.store.updateMcpServerProbe(id, {
        status: "ready",
        tools,
        error: null,
        lastProbeAt: checkedAt
      });
      this.refreshLibrary(updated);
      return toView(updated);
    } catch (error) {
      const message = redactError(error, secrets).slice(0, MAX_PROBE_ERROR_CHARS);
      const updated = this.store.updateMcpServerProbe(id, {
        status: "error",
        tools: [],
        error: message,
        lastProbeAt: checkedAt
      });
      this.refreshLibrary(updated);
      return toView(updated);
    }
  }

  async installRegistry(input: InstallRegistryMcpInput): Promise<McpServerView> {
    if (!this.registry) throw new McpServerError("MCP_REGISTRY_UNAVAILABLE", "MCP Registry 客户端没有启动", 503);
    const candidate = await this.registry.find(input.serverName);
    if (!candidate.installable) {
      throw new McpServerError("MCP_REGISTRY_UNSUPPORTED", candidate.unsupportedReason ?? "这个 MCP 服务器暂时不能安装", 409);
    }
    const env = mergeRegistryValues(candidate.envVariables, input.env ?? {}, "env");
    const headers = mergeRegistryValues(candidate.headerVariables, input.headers ?? {}, "headers");
    const missing = [
      ...candidate.requiredEnv.filter((key) => !env[key]?.trim()),
      ...candidate.requiredHeaders.filter((key) => !headers[key]?.trim())
    ];
    if (missing.length > 0) {
      throw new McpServerError("MCP_REGISTRY_VALUES_REQUIRED", `安装前还需要填写：${missing.join("、")}`);
    }
    const existing = this.store.listMcpServers().find((record) => record.registryServerId === candidate.serverName) ?? null;
    const previous = existing;
    const previousSecrets = existing
      ? { envCipher: existing.envCipher, headersCipher: existing.headersCipher }
      : null;
    const now = this.clock().toISOString();
    const normalized = normalizeInput({
      name: existing?.name ?? uniqueName(this.store.listMcpServers(), candidate.title || candidate.serverName),
      transport: candidate.transport,
      command: candidate.command,
      args: candidate.args,
      url: candidate.url,
      env,
      headers,
      enabled: input.enabled ?? true
    });
    const target: McpServerConfig = {
      id: existing?.id ?? `mcp_${randomUUID().slice(0, 8)}`,
      name: normalized.name,
      transport: normalized.transport,
      command: normalized.command,
      args: normalized.args,
      url: normalized.url,
      envKeys: Object.keys(env).sort(),
      headerKeys: Object.keys(headers).sort(),
      authMode: Object.keys(headers).length > 0 ? "headers" : "none",
      registryServerId: candidate.serverName,
      registryName: candidate.serverName,
      packageName: candidate.packageName,
      packageVersion: candidate.packageVersion,
      runtime: candidate.runtime,
      manifest: registryManifest(candidate),
      enabled: false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const saved = this.store.upsertMcpServer(target, this.encryptSecrets(normalized));
    this.refreshLibrary(saved);
    try {
      const tools = await this.discover(saved, { env, headers });
      const ready = this.store.updateMcpServerProbe(saved.id, {
        status: "ready",
        tools,
        error: null,
        lastProbeAt: now
      });
      const enabled = this.store.upsertMcpServer(
        { ...configFromRecord(ready), enabled: input.enabled ?? true, updatedAt: now },
        this.encryptSecrets(normalized)
      );
      this.refreshLibrary(enabled);
      return toView(enabled);
    } catch (error) {
      if (previous && previousSecrets) {
        this.store.upsertMcpServer(configFromRecord(previous), previousSecrets);
        this.store.updateMcpServerProbe(previous.id, {
          status: previous.status,
          tools: previous.tools,
          error: previous.error,
          lastProbeAt: previous.lastProbeAt
        });
        this.refreshLibrary(this.require(previous.id));
      } else {
        this.store.deleteMcpServer(saved.id);
        this.library?.tree.removeMcpServer(saved.id);
        this.library?.markDirty();
      }
      throw new McpServerError(
        "MCP_REGISTRY_INSTALL_FAILED",
        `安装失败，已恢复原有配置：${redactError(error, { env, headers }).slice(0, MAX_PROBE_ERROR_CHARS)}`,
        502
      );
    }
  }

  environment(id: string): Record<string, string> {
    return this.decryptSecrets(this.require(id)).env;
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
    const secrets = this.decryptSecrets(record);
    const argumentsValue = args === undefined ? {} : args;
    this.validateArguments(tool, argumentsValue, secrets);
    return this.executeTool(record, tool, argumentsValue as Record<string, unknown>, secrets, options.signal);
  }

  private async discover(record: McpServerRecord, secrets: Secrets): Promise<McpToolDescriptor[]> {
    const client = new Client({ name: "hearth", version: "0.1.0" });
    const connection = createTransport(record, secrets);
    try {
      await client.connect(connection.transport, { timeout: this.timeoutMs });
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
          throw new McpServerError("MCP_SCHEMA_INVALID", `MCP 工具 ${name} 的输入 Schema 不合法：${redactError(error, secrets)}`, 409);
        }
        return {
          name,
          description: String(tool.description ?? "").slice(0, MAX_DESCRIPTION_CHARS),
          inputSchema
        };
      });
    } catch (error) {
      const stderr = connection.stderr();
      if (stderr.trim() && error instanceof Error && !error.message.trim()) {
        error.message = stderr.trim().slice(-MAX_PROBE_ERROR_CHARS);
      }
      throw error;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private encryptSecrets(secrets: { env?: Record<string, string> | undefined; headers?: Record<string, string> | undefined }): {
    envCipher: string | null;
    headersCipher: string | null;
  } {
    return {
      envCipher: this.encryptJson(secrets.env ?? {}),
      headersCipher: this.encryptJson(secrets.headers ?? {})
    };
  }

  private encryptJson(value: Record<string, string>): string | null {
    return Object.keys(value).length > 0 ? this.secretBox.encrypt(JSON.stringify(value)) : null;
  }

  private decryptSecrets(record: McpServerRecord): Secrets {
    return {
      env: this.decryptMap(record.envCipher, "环境变量"),
      headers: this.decryptMap(record.headersCipher, "HTTP Header")
    };
  }

  private decryptMap(cipher: string | null, label: string): Record<string, string> {
    if (!cipher) return {};
    try {
      const parsed = JSON.parse(this.secretBox.decrypt(cipher)) as unknown;
      return normalizeMap(parsed, label === "HTTP Header" ? normalizeHeaders : normalizeEnv);
    } catch {
      throw new McpServerError("MCP_SECRET_INVALID", `MCP 服务器的${label}密钥无法解密，请重新保存`, 409);
    }
  }

  private require(id: string): McpServerRecord {
    const record = this.store.getMcpServer(id);
    if (!record) throw new McpServerError("MCP_SERVER_NOT_FOUND", "MCP 服务器不存在", 404);
    return record;
  }

  private validateArguments(tool: McpToolDescriptor, args: unknown, secrets: Secrets): void {
    let validate: ValidateFunction;
    try {
      validate = this.ajv.compile(tool.inputSchema);
    } catch (error) {
      throw new McpServerError("MCP_SCHEMA_INVALID", `MCP 工具 ${tool.name} 的输入 Schema 不合法：${redactError(error, secrets)}`, 409);
    }
    if (!validate(args)) {
      const details = (validate.errors ?? [])
        .slice(0, 5)
        .map((error) => `${error.instancePath || "/"} ${error.message ?? "不合法"}`)
        .join("；");
      throw new McpServerError("MCP_ARGUMENTS_INVALID", `MCP 工具参数不合法：${redactText(details, secrets).slice(0, 1_000)}`);
    }
  }

  private async executeTool(
    record: McpServerRecord,
    tool: McpToolDescriptor,
    args: Record<string, unknown>,
    secrets: Secrets,
    signal: AbortSignal | undefined
  ): Promise<McpToolCallResult> {
    const client = new Client({ name: "hearth", version: "0.1.0" });
    const connection = createTransport(record, secrets);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const callSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      await client.connect(connection.transport, { timeout: this.timeoutMs, signal: callSignal });
      const result = await client.callTool(
        { name: tool.name, arguments: args },
        undefined,
        { timeout: this.timeoutMs, signal: callSignal }
      );
      return normalizeCallResult(result as CallToolResult, secrets);
    } catch (error) {
      if (signal?.aborted) throw new McpServerError("MCP_TOOL_CANCELLED", "MCP 工具调用已取消", 499);
      if (timeoutSignal.aborted) {
        throw new McpServerError("MCP_TOOL_TIMEOUT", `MCP 工具调用超时（${this.timeoutMs}ms）`, 504);
      }
      const message = redactError(error, secrets);
      const stderrMessage = connection.stderr().trim() ? `；服务器输出：${redactText(connection.stderr().trim(), secrets)}` : "";
      throw new McpServerError("MCP_TOOL_CALL_FAILED", `${message}${stderrMessage}`.slice(0, MAX_PROBE_ERROR_CHARS), 502);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private refreshLibrary(record: McpServerRecord): void {
    this.library?.tree.syncMcpServer(record);
    this.library?.markDirty();
  }
}

function toView(record: McpServerRecord): McpServerView {
  const { envCipher: _envCipher, headersCipher: _headersCipher, ...view } = record;
  return view;
}

function configFromRecord(record: McpServerRecord): McpServerConfig {
  return {
    id: record.id,
    name: record.name,
    transport: record.transport,
    command: record.command,
    args: record.args,
    url: record.url,
    envKeys: record.envKeys,
    headerKeys: record.headerKeys,
    authMode: record.authMode,
    registryServerId: record.registryServerId,
    registryName: record.registryName,
    packageName: record.packageName,
    packageVersion: record.packageVersion,
    runtime: record.runtime,
    manifest: record.manifest,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function createTransport(record: McpServerRecord, secrets: Secrets): {
  transport: Transport;
  stderr: () => string;
} {
  if (record.transport === "streamable-http") {
    if (!record.url) throw new McpServerError("MCP_URL_REQUIRED", "远程 MCP 服务器缺少 URL");
    const url = normalizeRemoteUrl(record.url);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          accept: "application/json, text/event-stream",
          "user-agent": "Hearth/0.6 MCP client",
          ...secrets.headers
        },
        redirect: "error"
      },
      redirectPolicy: "same-origin"
    });
    return { transport, stderr: () => "" };
  }
  if (!record.command.trim()) throw new McpServerError("MCP_COMMAND_REQUIRED", "请填写启动命令");
  let stderr = "";
  const transport = new StdioClientTransport({
    command: record.command,
    args: record.args,
    env: { ...getDefaultEnvironment(), ...secrets.env },
    stderr: "pipe",
    maxBufferSize: 4 * 1024 * 1024
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = `${stderr}${String(chunk)}`.slice(-4_000);
  });
  return { transport, stderr: () => stderr };
}

function normalizeInput(input: McpServerInput): NormalizedMcpInput {
  const name = input.name?.trim() ?? "";
  if (!name) throw new McpServerError("MCP_NAME_REQUIRED", "请填写服务器名称");
  if (name.length > 100) throw new McpServerError("MCP_NAME_TOO_LONG", "服务器名称不能超过 100 个字符");
  const transport = input.transport ?? "stdio";
  if (transport !== "stdio" && transport !== "streamable-http") {
    throw new McpServerError("MCP_TRANSPORT_INVALID", "MCP 传输方式不合法");
  }
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > 64) throw new McpServerError("MCP_ARGS_INVALID", "启动参数最多 64 个");
  const cleanArgs = args.map((arg) => {
    if (typeof arg !== "string" || arg.length > 4_000 || arg.includes("\0")) {
      throw new McpServerError("MCP_ARGS_INVALID", "启动参数不合法");
    }
    return arg;
  });
  const env = input.env === undefined ? undefined : normalizeMap(input.env, normalizeEnv);
  const headers = input.headers === undefined ? undefined : normalizeMap(input.headers, normalizeHeaders);
  if (transport === "stdio") {
    const command = input.command?.trim() ?? "";
    if (!command) throw new McpServerError("MCP_COMMAND_REQUIRED", "请填写启动命令");
    if (command.length > 1_000 || command.includes("\0")) throw new McpServerError("MCP_COMMAND_INVALID", "启动命令不合法");
    return {
      name,
      transport,
      command,
      args: cleanArgs,
      url: null,
      env,
      headers: headers ?? {},
      enabled: input.enabled ?? true
    };
  }
  const url = normalizeRemoteUrl(input.url ?? "").href;
  return {
    name,
    transport,
    command: "",
    args: [],
    url,
    env: env ?? {},
    headers,
    enabled: input.enabled ?? true
  };
}

function normalizeRemoteUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpServerError("MCP_URL_INVALID", "远程 MCP 地址不合法");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new McpServerError("MCP_URL_INVALID", "远程 MCP 必须使用 HTTPS，本机调试地址除外");
  }
  if (url.username || url.password) throw new McpServerError("MCP_URL_INVALID", "远程 MCP 地址不能包含凭据");
  url.hash = "";
  return url;
}

function normalizeMap(
  value: unknown,
  normalizeEntry: (key: string, raw: unknown) => [string, string]
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpServerError("MCP_SECRETS_INVALID", "密钥必须是键值对象");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) throw new McpServerError("MCP_SECRETS_TOO_MANY", "密钥最多 32 个");
  return Object.fromEntries(entries.map(([key, raw]) => normalizeEntry(key, raw)));
}

function normalizeEnv(key: string, raw: unknown): [string, string] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new McpServerError("MCP_ENV_KEY_INVALID", `环境变量名不合法：${key}`);
  if (typeof raw !== "string" || raw.length > 4_000 || raw.includes("\0")) {
    throw new McpServerError("MCP_ENV_VALUE_INVALID", `环境变量值不合法：${key}`);
  }
  return [key, raw];
}

function normalizeHeaders(key: string, raw: unknown): [string, string] {
  const clean = key.trim();
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(clean)) throw new McpServerError("MCP_HEADER_KEY_INVALID", `HTTP Header 名不合法：${key}`);
  if (["host", "content-length", "connection", "transfer-encoding"].includes(clean.toLocaleLowerCase())) {
    throw new McpServerError("MCP_HEADER_RESERVED", `HTTP Header 不能覆盖：${clean}`);
  }
  if (typeof raw !== "string" || raw.length > 8_000 || /[\r\n\0]/.test(raw)) {
    throw new McpServerError("MCP_HEADER_VALUE_INVALID", `HTTP Header 值不合法：${clean}`);
  }
  return [clean, raw];
}

function normalizeSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "object", properties: {} };
  }
  return value as Record<string, unknown>;
}

function redactError(error: unknown, secrets: Secrets): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message, secrets).trim() || "MCP 服务器探测失败";
}

function redactText(message: string, secrets: Secrets): string {
  let redacted = message;
  for (const value of [...Object.values(secrets.env), ...Object.values(secrets.headers)]) {
    if (value) redacted = redacted.split(value).join("***");
  }
  return redacted;
}

function normalizeCallResult(result: CallToolResult, secrets: Secrets): McpToolCallResult {
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
  const text = redactText(parts.filter(Boolean).join("\n\n"), secrets) || "（MCP 工具没有返回内容）";
  return {
    content: text.length <= MAX_RESULT_CHARS
      ? text
      : `${text.slice(0, MAX_RESULT_CHARS)}\n\n... MCP 工具结果已截断（原始 ${text.length} 字符）`,
    isError: result.isError === true
  };
}

function mergeRegistryValues(
  definitions: McpRegistryCandidate["envVariables"],
  supplied: Record<string, string>,
  kind: "env" | "headers"
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const definition of definitions) {
    const value = supplied[definition.name] ?? definition.defaultValue ?? "";
    if (value) values[definition.name] = value;
  }
  return normalizeMap(values, kind === "headers" ? normalizeHeaders : normalizeEnv);
}

function registryManifest(candidate: McpRegistryCandidate): Record<string, unknown> {
  return {
    registryServerId: candidate.serverName,
    title: candidate.title,
    description: candidate.description,
    homepage: candidate.homepage,
    repositoryUrl: candidate.repositoryUrl,
    transport: candidate.transport,
    runtime: candidate.runtime,
    packageName: candidate.packageName,
    packageVersion: candidate.packageVersion,
    envVariables: candidate.envVariables,
    headerVariables: candidate.headerVariables
  };
}

function uniqueName(records: McpServerRecord[], base: string): string {
  const existing = new Set(records.map((record) => record.name.toLocaleLowerCase()));
  const clean = base.trim().slice(0, 100) || "MCP 服务";
  if (!existing.has(clean.toLocaleLowerCase())) return clean;
  let index = 2;
  while (existing.has(`${clean} ${index}`.toLocaleLowerCase())) index += 1;
  return `${clean} ${index}`;
}

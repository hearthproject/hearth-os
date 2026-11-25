import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpRegistryCandidate } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import type { McpRegistryClient } from "./mcp-registry.ts";
import { McpServerService } from "./mcp-servers.ts";
import { SecretBox } from "./secrets.ts";

const mockServer = fileURLToPath(new URL("./test-fixtures/mock-mcp-server.mjs", import.meta.url));

describe("local MCP server management", () => {
  let store: HearthStore;
  let secretBox: SecretBox;
  let service: McpServerService;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    secretBox = new SecretBox(randomBytes(32));
    service = new McpServerService({ store, secretBox, timeoutMs: 3_000 });
  });

  afterEach(() => {
    store.close();
  });

  it("probes a stdio server, discovers tools and never exposes encrypted env values", async () => {
    const server = await service.create({
      name: "Mock",
      command: process.execPath,
      args: [mockServer],
      env: { MOCK_MCP_SECRET: "super-secret-value" }
    });

    expect(server).toMatchObject({
      transport: "stdio",
      enabled: true,
      status: "ready",
      error: null,
      envKeys: ["MOCK_MCP_SECRET"]
    });
    expect(server.tools.map((tool) => tool.name)).toEqual(["echo", "slow", "crash", "leak", "large"]);
    expect(server.tools[0]?.inputSchema).toMatchObject({ type: "object", required: ["text"] });
    expect(JSON.stringify(service.list())).not.toContain("super-secret-value");
    const stored = store.getMcpServer(server.id);
    expect(stored?.envCipher).toBeTruthy();
    expect(stored?.envCipher).not.toContain("super-secret-value");
    expect(service.environment(server.id)).toEqual({ MOCK_MCP_SECRET: "super-secret-value" });
  });

  it("isolates a crashing server and records a bounded probe failure", async () => {
    const crashed = await service.create({
      name: "Crash",
      command: process.execPath,
      args: [mockServer],
      env: { MOCK_MCP_CRASH: "1" }
    });
    expect(crashed.status).toBe("error");
    expect(crashed.tools).toEqual([]);
    expect(crashed.error?.length).toBeLessThanOrEqual(1_000);

    const healthy = await service.create({ name: "Healthy", command: process.execPath, args: [mockServer] });
    expect(healthy.status).toBe("ready");
    expect(service.list()).toHaveLength(2);
  });

  it("times out a hanging discovery and keeps the server manageable", async () => {
    const hanging = new McpServerService({ store, secretBox, timeoutMs: 1_000 });
    const server = await hanging.create({
      name: "Hang",
      command: process.execPath,
      args: [mockServer],
      env: { MOCK_MCP_LIST_HANG: "1" }
    });
    expect(server.status).toBe("error");
    expect(server.error).toBeTruthy();
    expect(hanging.get(server.id).status).toBe("error");
  }, 15_000);

  it("calls a discovered tool with schema validation and bounds the result", async () => {
    const server = await service.create({
      name: "Callable",
      command: process.execPath,
      args: [mockServer],
      env: { MOCK_MCP_SECRET: "call-secret-value" }
    });

    const echoed = await service.callTool(server.id, "echo", { text: "hello" });
    expect(echoed).toMatchObject({ isError: false });
    expect(echoed.content).toContain("echo:hello");
    expect(echoed.content).toContain('"echoed": "hello"');

    const leaked = await service.callTool(server.id, "leak", {});
    expect(leaked.content).not.toContain("call-secret-value");
    expect(leaked.content).toContain("***");

    const large = await service.callTool(server.id, "large", {});
    expect(large.content.length).toBeLessThan(101_000);
    expect(large.content).toContain("MCP 工具结果已截断");

    await expect(service.callTool(server.id, "echo", { text: 42 })).rejects.toMatchObject({
      code: "MCP_ARGUMENTS_INVALID"
    });
    expect(JSON.stringify(await service.callTool(server.id, "echo", { text: "safe" }))).not.toContain("call-secret-value");
  }, 15_000);

  it("isolates a call timeout and a crash during tool execution", async () => {
    const server = await service.create({ name: "Fragile", command: process.execPath, args: [mockServer] });
    await expect(service.callTool(server.id, "slow", {})).rejects.toMatchObject({ code: "MCP_TOOL_TIMEOUT" });
    expect(service.get(server.id).status).toBe("ready");
    await expect(service.callTool(server.id, "crash", {})).rejects.toMatchObject({ code: "MCP_TOOL_CALL_FAILED" });
    expect(service.get(server.id).status).toBe("ready");
  }, 15_000);

  it("exposes create, list, probe and delete over the local API", async () => {
    const app = await buildServer({ store, secretBox, serveWeb: false });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/mcp/servers",
        payload: { name: "API Mock", command: process.execPath, args: [mockServer], env: { MOCK_MCP_SECRET: "api-secret" } }
      });
      expect(created.statusCode).toBe(201);
      const body = created.json() as { server: { id: string; status: string; envKeys: string[] } };
      expect(body.server.status).toBe("ready");
      expect(body.server.envKeys).toEqual(["MOCK_MCP_SECRET"]);
      expect(created.body).not.toContain("api-secret");

      const listed = await app.inject({ method: "GET", url: "/api/mcp/servers" });
      expect(listed.statusCode).toBe(200);
      expect((listed.json() as { servers: unknown[] }).servers).toHaveLength(1);

      const probed = await app.inject({ method: "POST", url: `/api/mcp/servers/${body.server.id}/probe` });
      expect(probed.statusCode).toBe(200);
      expect((probed.json() as { server: { status: string } }).server.status).toBe("ready");

      const deleted = await app.inject({ method: "DELETE", url: `/api/mcp/servers/${body.server.id}` });
      expect(deleted.statusCode).toBe(204);
      expect(service.list()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("connects to a Streamable HTTP server with encrypted headers", async () => {
    let authorization: string | undefined;
    const createProtocolServer = () => {
      const protocol = new McpProtocolServer(
        { name: "remote-test", version: "1.0.0" },
        { capabilities: { tools: {} } }
      );
      protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{
          name: "remote_echo",
          description: "Echo through Streamable HTTP",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false
          }
        }]
      }));
      protocol.setRequestHandler(CallToolRequestSchema, async (request) => ({
        content: [{ type: "text", text: `remote:${String(request.params.arguments?.text ?? "")}` }]
      }));
      return protocol;
    };
    const httpServer = createServer(async (request, response) => {
      authorization = request.headers.authorization;
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const protocol = createProtocolServer();
      const transport = new StreamableHTTPServerTransport();
      await protocol.connect(transport);
      try {
        await transport.handleRequest(request, response);
      } finally {
        await transport.close().catch(() => undefined);
        await protocol.close().catch(() => undefined);
      }
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address() as AddressInfo;

    try {
      const remote = await service.create({
        name: "Remote HTTP",
        transport: "streamable-http",
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { Authorization: "Bearer remote-secret" }
      });
      if (remote.status !== "ready") throw new Error(`Remote probe failed: ${remote.error}`);

      expect(remote).toMatchObject({
        transport: "streamable-http",
        status: "ready",
        headerKeys: ["Authorization"]
      });
      expect(remote.tools.map((tool) => tool.name)).toEqual(["remote_echo"]);
      expect(JSON.stringify(service.list())).not.toContain("remote-secret");

      const result = await service.callTool(remote.id, "remote_echo", { text: "hello" });
      expect(result.content).toBe("remote:hello");
      expect(authorization).toBe("Bearer remote-secret");
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }, 15_000);

  it("installs a Registry candidate transactionally and probes it before enabling", async () => {
    const candidate = registryCandidate({
      serverName: "io.example/mock",
      title: "Registry Mock",
      command: process.execPath,
      args: [mockServer]
    });
    const registry = { find: vi.fn(async () => candidate) } as unknown as McpRegistryClient;
    const registryService = new McpServerService({ store, secretBox, registry, timeoutMs: 3_000 });

    const installed = await registryService.installRegistry({ serverName: candidate.serverName });

    expect(installed).toMatchObject({
      name: "Registry Mock",
      registryServerId: candidate.serverName,
      packageName: candidate.packageName,
      runtime: candidate.runtime,
      status: "ready",
      enabled: true
    });
    expect(installed.tools.map((tool) => tool.name)).toContain("echo");
    expect(registry.find).toHaveBeenCalledWith(candidate.serverName);
  }, 15_000);

  it("requires declared Registry secrets and removes a failed new draft", async () => {
    const candidate = registryCandidate({
      serverName: "io.example/failing",
      title: "Failing Registry",
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      requiredEnv: ["EXAMPLE_TOKEN"],
      envVariables: [{
        name: "EXAMPLE_TOKEN",
        description: "Token",
        required: true,
        secret: true,
        placeholder: null,
        defaultValue: null
      }]
    });
    const registry = { find: vi.fn(async () => candidate) } as unknown as McpRegistryClient;
    const registryService = new McpServerService({ store, secretBox, registry, timeoutMs: 3_000 });

    await expect(registryService.installRegistry({ serverName: candidate.serverName })).rejects.toMatchObject({
      code: "MCP_REGISTRY_VALUES_REQUIRED"
    });
    expect(store.listMcpServers()).toHaveLength(0);

    await expect(registryService.installRegistry({
      serverName: candidate.serverName,
      env: { EXAMPLE_TOKEN: "top-secret" }
    })).rejects.toMatchObject({ code: "MCP_REGISTRY_INSTALL_FAILED" });
    expect(store.listMcpServers()).toHaveLength(0);
  }, 15_000);
});

function registryCandidate(overrides: Partial<McpRegistryCandidate> = {}): McpRegistryCandidate {
  return {
    serverName: "io.example/test",
    title: "Registry Test",
    description: "Test server",
    version: "1.0.0",
    transport: "stdio",
    runtime: "npx",
    packageName: "@example/test",
    packageVersion: "1.0.0",
    command: process.execPath,
    args: [mockServer],
    url: null,
    requiredEnv: [],
    requiredHeaders: [],
    envVariables: [],
    headerVariables: [],
    homepage: null,
    repositoryUrl: null,
    installable: true,
    unsupportedReason: null,
    ...overrides
  };
}

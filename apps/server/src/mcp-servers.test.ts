import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
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
    expect(server.tools.map((tool) => tool.name)).toEqual(["echo", "slow"]);
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

  it("exposes create, list, probe and delete over the local API", async () => {
    const app = await buildServer({ store, syncSecretBox: secretBox, serveWeb: false });
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
});

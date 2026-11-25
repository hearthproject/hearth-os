import { describe, expect, it, vi } from "vitest";
import { McpRegistryClient, McpRegistryError, normalizeRegistryResponse } from "./mcp-registry.ts";

describe("MCP Registry normalization", () => {
  it("normalizes an npm package into an npx launch without arbitrary shell syntax", () => {
    const [candidate] = normalizeRegistryResponse({
      servers: [{
        server: {
          name: "io.example/docs",
          title: "Example Docs",
          description: "Search the Example documentation",
          version: "1.2.3",
          packages: [{
            registryType: "npm",
            identifier: "@example/mcp-docs",
            version: "1.2.3",
            runtimeHint: "npx",
            runtimeArguments: [{ type: "named", name: "yes" }],
            packageArguments: [{ type: "named", name: "stdio" }]
          }]
        }
      }]
    });

    expect(candidate).toMatchObject({
      serverName: "io.example/docs",
      title: "Example Docs",
      transport: "stdio",
      runtime: "npx",
      command: "npx",
      packageName: "@example/mcp-docs",
      packageVersion: "1.2.3",
      installable: true,
      unsupportedReason: null
    });
    expect(candidate?.args).toEqual(["--yes", "@example/mcp-docs@1.2.3", "--stdio"]);
  });

  it("normalizes a uvx Python package and Registry environment declarations", () => {
    const [candidate] = normalizeRegistryResponse([{
      name: "io.example/python",
      version: "2.0.0",
      packages: [{
        registryType: "pypi",
        identifier: "example-mcp",
        version: "2.0.0",
        runtimeHint: "uvx",
        environmentVariables: [
          { name: "EXAMPLE_TOKEN", description: "API token", isRequired: true, isSecret: true },
          { name: "EXAMPLE_REGION", default: "us", isRequired: false }
        ]
      }]
    }]);

    expect(candidate).toMatchObject({
      runtime: "uvx",
      command: "uvx",
      packageName: "example-mcp",
      requiredEnv: ["EXAMPLE_TOKEN"],
      envVariables: [
        { name: "EXAMPLE_TOKEN", required: true, secret: true },
        { name: "EXAMPLE_REGION", required: false, defaultValue: "us" }
      ]
    });
    expect(candidate?.args).toEqual(["example-mcp==2.0.0"]);
  });

  it("prefers Streamable HTTP and keeps header declarations for the installer", () => {
    const [candidate] = normalizeRegistryResponse({
      servers: [{
        server: {
          name: "io.example/remote",
          version: "1.0.0",
          remotes: [{
            type: "streamable-http",
            url: "https://mcp.example.com/mcp",
            headers: [{ name: "Authorization", description: "Bearer token", isRequired: true, isSecret: true }]
          }]
        }
      }]
    });

    expect(candidate).toMatchObject({
      transport: "streamable-http",
      runtime: "remote",
      command: "",
      url: "https://mcp.example.com/mcp",
      requiredHeaders: ["Authorization"],
      installable: true
    });
  });

  it("marks SSE-only and package-less entries as unsupported", () => {
    const candidates = normalizeRegistryResponse([
      { name: "io.example/sse", version: "1", remotes: [{ type: "sse", url: "https://example.com/sse" }] },
      { name: "io.example/empty", version: "1" },
      { name: "io.example/bad-python", version: "1", packages: [{ registryType: "pypi", identifier: "pkg", runtimeHint: "python" }] }
    ]);

    expect(candidates).toHaveLength(3);
    expect(candidates.every((candidate) => !candidate.installable)).toBe(true);
    expect(candidates[0]?.unsupportedReason).toContain("SSE");
    expect(candidates[1]?.unsupportedReason).toContain("没有可用");
    expect(candidates[2]?.unsupportedReason).toContain("uvx");
  });

  it("ignores malformed entries and prevents duplicate versions", () => {
    const valid = { name: "io.example/duplicate", version: "1", remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }] };
    const candidates = normalizeRegistryResponse({ servers: [null, "broken", { server: { name: 42 } }, { server: valid }, { server: valid }] });
    expect(candidates.map((candidate) => candidate.serverName)).toEqual(["io.example/duplicate"]);
  });
});

describe("MCP Registry client", () => {
  it("uses the official query shape, validates HTTPS, and caches identical searches", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ servers: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
    const client = new McpRegistryClient({ fetchImpl, registryUrl: "https://registry.example.test/v0/servers" });

    await client.search("github", { limit: 5 });
    await client.search("github", { limit: 5 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.get("search")).toBe("github");
    expect(requestUrl.searchParams.get("limit")).toBe("5");
    expect(requestUrl.searchParams.get("version")).toBe("latest");
    expect(() => new McpRegistryClient({ registryUrl: "http://registry.example.test" })).toThrow(McpRegistryError);
  });

  it("reports unavailable registries without leaking response internals", async () => {
    const fetchImpl = vi.fn(async () => new Response("upstream secret", { status: 500 })) as unknown as typeof fetch;
    const client = new McpRegistryClient({ fetchImpl, registryUrl: "https://registry.example.test/v0/servers" });
    await expect(client.search("anything")).rejects.toMatchObject({
      code: "MCP_REGISTRY_HTTP_ERROR",
      statusCode: 502
    });
  });

  it("rejects malformed Registry payloads with a stable error", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
    const client = new McpRegistryClient({ fetchImpl, registryUrl: "https://registry.example.test/v0/servers" });
    await expect(client.search("anything")).rejects.toMatchObject({
      code: "MCP_REGISTRY_INVALID_RESPONSE",
      statusCode: 502
    });
  });
});

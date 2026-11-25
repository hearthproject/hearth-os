import { describe, expect, it } from "vitest";
import { mcpBridgeLaunch } from "./mcp-bridge-runtime.ts";

describe("task-scoped MCP bridge launch", () => {
  it("prefers the bundled bridge and passes de-duplicated server IDs in the environment", () => {
    const launch = mcpBridgeLaunch({
      serverIds: ["mcp_one", " mcp_two ", "mcp_one", ""],
      root: "D:\\repo",
      baseUrl: "http://127.0.0.1:4317/",
      nodePath: "node",
      exists: (path) => path.endsWith("mcp-bridge.mjs")
    });

    expect(launch).toMatchObject({
      command: "node",
      env: {
        HEARTH_BASE_URL: "http://127.0.0.1:4317",
        HEARTH_MCP_SERVER_IDS: '["mcp_one","mcp_two"]'
      }
    });
    expect(launch.args[0]).toMatch(/mcp-bridge\.mjs$/);
  });

  it("falls back to the TypeScript source through the repository tsx runtime", () => {
    const launch = mcpBridgeLaunch({
      serverIds: ["mcp_one"],
      root: "D:\\repo",
      nodePath: "node",
      exists: () => false
    });

    expect(launch.args).toEqual([
      "D:\\repo\\node_modules\\tsx\\dist\\cli.mjs",
      "D:\\repo\\apps\\server\\src\\mcp-bridge-main.ts"
    ]);
  });

  it("honors an explicit entry and rejects empty selections", () => {
    const launch = mcpBridgeLaunch({ serverIds: ["mcp_one"], entry: "C:\\bridge.mjs", nodePath: "node" });
    expect(launch.args).toEqual(["C:\\bridge.mjs"]);
    expect(() => mcpBridgeLaunch({ serverIds: ["  "] })).toThrow(/没有选择 MCP/);
  });
});

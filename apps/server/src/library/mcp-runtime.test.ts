import { describe, expect, it } from "vitest";
import { libraryMcpLaunch } from "./mcp-runtime.ts";

describe("library MCP launch", () => {
  it("prefers an explicit bundled entry and passes the live Hearth endpoint", () => {
    const launch = libraryMcpLaunch({
      entry: "C:\\Hearth\\library-mcp.mjs",
      baseUrl: "http://127.0.0.1:5000/",
      nodePath: "C:\\Hearth\\node.exe"
    });
    expect(launch).toEqual({
      command: "C:\\Hearth\\node.exe",
      args: ["C:\\Hearth\\library-mcp.mjs"],
      env: { HEARTH_BASE_URL: "http://127.0.0.1:5000" }
    });
  });

  it("falls back to the TypeScript entry through tsx in development", () => {
    const launch = libraryMcpLaunch({ root: "D:\\repo", exists: () => false, nodePath: "node" });
    expect(launch.args[0]).toContain("node_modules");
    expect(launch.args[0]).toContain("tsx");
    expect(launch.args[1]).toContain("mcp-main.ts");
  });
});

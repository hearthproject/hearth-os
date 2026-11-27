import { describe, expect, it } from "vitest";
import { codexMcpConfig, codexRuntimeConfig, describeItem, runCodex } from "./executor.ts";
import type { CodexProfile } from "./profile.ts";

describe("describeItem", () => {
  it("turns test commands into a high-level check step", () => {
    const item = { id: "1", type: "command_execution" as const, command: "npm test", aggregated_output: "", status: "completed" as const };
    expect(describeItem(item).message).toBe("运行检查");
    expect(describeItem(item).detail).toMatchObject({ command: "npm test", status: "completed", executorId: "codex" });
  });

  it("lists changed files", () => {
    const item = { id: "2", type: "file_change" as const, changes: [{ path: "result.md", kind: "update" as const }], status: "completed" as const };
    expect(describeItem(item).message).toBe("修改文件：result.md");
    expect(describeItem(item).detail).toMatchObject({ paths: ["update:result.md"], status: "completed" });
  });

  it("does not expose raw terminal commands", () => {
    const item = { id: "3", type: "command_execution" as const, command: "x".repeat(200), aggregated_output: "", status: "completed" as const };
    expect(describeItem(item).message).toBe("执行操作");
    expect(describeItem(item).detail).toMatchObject({ command: "x".repeat(200) });
  });

  it("summarizes file reads without the pwsh wrapper", () => {
    const item = { id: "4", type: "command_execution" as const, command: "\"C:\\pwsh.exe\" -Command \"Get-Content a.txt\"", aggregated_output: "", status: "completed" as const };
    expect(describeItem(item).message).toBe("查看项目文件");
    expect(describeItem(item).detail).toMatchObject({ command: "Get-Content a.txt" });
  });

  it("summarizes directory listings without the cmd wrapper", () => {
    const item = { id: "5", type: "command_execution" as const, command: "\"C:\\Windows\\System32\\cmd.exe\" /c \"dir /a\"", aggregated_output: "", status: "completed" as const };
    expect(describeItem(item).message).toBe("查看项目文件");
    expect(describeItem(item).detail).toMatchObject({ command: "dir /a" });
  });

  it("drops model metadata warnings", () => {
    const item = { id: "6", type: "error" as const, message: "Model metadata for `gpt-5.1-codex` not found. Defaulting to fallback metadata; this may impact performance." };
    expect(describeItem(item).message).toBe("");
  });

  it("refuses a missing codexPathOverride before constructing the SDK", async () => {
    const profile: CodexProfile = {
      codexHome: "C:\\codex",
      configPath: "C:\\codex\\config.toml",
      model: null,
      providerId: "openai",
      providerName: "OpenAI",
      baseUrl: null,
      wireApi: null,
      envKey: null,
      envKeyPresent: false,
      envKeySource: "none",
      authSource: "openai-login",
      canRun: true,
      issues: []
    };
    await expect(runCodex({
      profile,
      workingDirectory: process.cwd(),
      prompt: "HEARTH_OK",
      codexPathOverride: "C:\\missing\\codex.exe"
    })).rejects.toThrow("Codex 可执行文件不存在");
  });

  it("passes the planning sandbox and no session identity into the SDK thread", async () => {
    const profile: CodexProfile = {
      codexHome: "C:\\codex",
      configPath: "C:\\codex\\config.toml",
      model: "test-model",
      providerId: "openai",
      providerName: "OpenAI",
      baseUrl: null,
      wireApi: null,
      envKey: null,
      envKeyPresent: false,
      envKeySource: "none",
      authSource: "openai-login",
      canRun: true,
      issues: []
    };
    let threadOptions: Record<string, unknown> | null = null;
    const codex = {
      startThread(options: Record<string, unknown>) {
        threadOptions = options;
        return {
          id: "plan-thread",
          runStreamed() {
            return { events: (async function* () {})() };
          }
        };
      },
      resumeThread() {
        throw new Error("planning must not resume an old thread");
      }
    };
    await runCodex({
      profile,
      codex: codex as never,
      workingDirectory: "C:\\repo",
      prompt: "inspect",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false
    });
    expect(threadOptions).toMatchObject({
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled"
    });
  });
});

describe("codexMcpConfig", () => {
  it("publishes the Hearth library as a standard stdio MCP server", () => {
    expect(codexMcpConfig({
      hearth: { command: "node", args: ["library-mcp.mjs"], env: { HEARTH_BASE_URL: "http://127.0.0.1:4317" } }
    })).toEqual({
      hearth: {
        command: "node",
        args: ["library-mcp.mjs"],
        env: { HEARTH_BASE_URL: "http://127.0.0.1:4317" },
        startup_timeout_sec: 20,
        tool_timeout_sec: 120
      }
    });
  });
});

describe("codexRuntimeConfig", () => {
  it("turns native multi-agent on with clamped thread limits", () => {
    expect(codexRuntimeConfig({ enabled: true, maxThreads: 4, maxDepth: 1 })).toEqual({
      features: { multi_agent: true },
      agents: { max_threads: 4, max_depth: 1 }
    });
  });

  it("only disables the feature in single mode and leaves no thread config behind", () => {
    expect(codexRuntimeConfig({ enabled: false })).toEqual({
      features: { multi_agent: false }
    });
  });

  it("merges MCP servers with the team flags into one config object", () => {
    expect(codexRuntimeConfig(
      { enabled: true, maxThreads: 2, maxDepth: 2 },
      { hearth: { command: "node", args: ["library-mcp.mjs"] } }
    )).toMatchObject({
      features: { multi_agent: true },
      agents: { max_threads: 2, max_depth: 2 },
      mcp_servers: { hearth: { command: "node", args: ["library-mcp.mjs"] } }
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  checkEnvironment,
  chooseCodexPath,
  defaultCodexPath,
  formatEnvironmentReport,
  type EnvironmentOptions
} from "./environment";

describe("chooseCodexPath", () => {
  it("prefers HEARTH_CODEX_PATH when it exists", () => {
    const chosen = chooseCodexPath("C:\\tools\\codex.exe", "", (path) => path === "C:\\tools\\codex.exe");
    expect(chosen).toBe("C:\\tools\\codex.exe");
  });

  it("ignores PowerShell shims and picks the first real exe", () => {
    const output = ["C:\\npm\\codex.ps1", "C:\\npm\\codex.cmd", "C:\\bin\\codex.exe"].join("\r\n");
    const chosen = chooseCodexPath(undefined, output, (path) => path === "C:\\bin\\codex.exe");
    expect(chosen).toBe("C:\\bin\\codex.exe");
  });

  it("falls back to the known npm global location", () => {
    const chosen = chooseCodexPath(undefined, "", (path) => path === defaultCodexPath());
    expect(chosen).toBe(defaultCodexPath());
  });

  it("returns null when nothing exists", () => {
    expect(chooseCodexPath(undefined, "codex.ps1", () => false)).toBeNull();
  });
});

function options(overrides: Partial<EnvironmentOptions> = {}): EnvironmentOptions {
  return {
    baseUrl: "http://127.0.0.1:4317",
    resourcesPath: "C:\\Hearth\\resources",
    port: 4317,
    run: (command) => {
      if (command === "where.exe") return { ok: true, output: "C:\\tools\\codex.exe" };
      if (command === "git.exe") return { ok: true, output: "git version 2.49.0" };
      if (command === "gh.exe") return { ok: true, output: "gh version 2.70.0" };
      return { ok: true, output: "10.9.8" };
    },
    exists: (path) => path === "C:\\tools\\codex.exe",
    fetchImpl: async () =>
      new Response(JSON.stringify({ chatModel: { configured: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
    ...overrides
  };
}

describe("checkEnvironment", () => {
  it("reports seven checks and healthy when everything is present", async () => {
    const report = await checkEnvironment(
      options({
        helperPath: "C:\\Hearth\\resources\\helper\\helper.mjs",
        exists: (path) =>
          path === "C:\\tools\\codex.exe" || path === "C:\\Hearth\\resources\\helper\\helper.mjs"
      })
    );
    expect(report.items).toHaveLength(7);
    expect(report.items.map((item) => item.id)).toEqual([
      "model",
      "git",
      "gh",
      "codex",
      "npm",
      "helper",
      "port"
    ]);
    expect(report.healthy).toBe(true);
    expect(report.missing).toBe(0);
  });

  it("marks missing model and absent helper without breaking the service", async () => {
    const report = await checkEnvironment(
      options({
        helperPath: "C:\\missing\\helper.mjs",
        exists: () => false,
        fetchImpl: async () =>
          new Response(JSON.stringify({ chatModel: { configured: false } }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      })
    );
    const model = report.items.find((item) => item.id === "model");
    expect(model?.status).toBe("missing");
    const port = report.items.find((item) => item.id === "port");
    expect(port?.status).toBe("ok");
    expect(report.items.find((item) => item.id === "codex")?.status).toBe("warn");
  });

  it("does not turn a missing chat model into a port failure", async () => {
    const report = await checkEnvironment(options());
    expect(report.items.find((item) => item.id === "port")?.status).toBe("ok");
  });

  it("formats status markers and actions", async () => {
    const report = await checkEnvironment(options({ exists: () => false, helperPath: "C:\\missing\\helper.mjs" }));
    const text = formatEnvironmentReport(report);
    expect(text).toContain("✓ 聊天模型");
    expect(text).toContain("! Codex 执行器");
    expect(text).toContain("→ 安装 Codex CLI");
  });
});

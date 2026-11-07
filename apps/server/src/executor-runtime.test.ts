import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearExecutorHealthCache, executorHealth, probeExecutor, resolveExecutorLaunch } from "./executor-runtime.ts";
import { defaultExecutorSettings } from "./executor-settings.ts";

const roots: string[] = [];
const previousDetect = process.env.HEARTH_EXECUTOR_DETECT;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-executor-"));
  roots.push(root);
  return root;
}

function writeScript(path: string, version: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      `if (process.argv.includes("--version")) { console.log(${JSON.stringify(version)}); process.exit(0); }`,
      "console.log(JSON.stringify({ argv: process.argv.slice(2) }));"
    ].join("\n"),
    "utf8"
  );
}

describe("executor runtime", () => {
  beforeEach(() => {
    process.env.HEARTH_EXECUTOR_DETECT = "off";
    clearExecutorHealthCache();
  });

  afterEach(() => {
    clearExecutorHealthCache();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
    if (previousDetect === undefined) delete process.env.HEARTH_EXECUTOR_DETECT;
    else process.env.HEARTH_EXECUTOR_DETECT = previousDetect;
  });

  it("resolves and probes a managed node cli", () => {
    const root = tempRoot();
    const settingsPath = join(root, "executor-settings.json");
    const script = join(root, "executors", "workbuddy", "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
    writeScript(script, "9.9.9");

    const settings = defaultExecutorSettings();
    const launch = resolveExecutorLaunch("workbuddy", settings, settingsPath);
    expect(launch?.source).toBe("managed");
    expect(launch?.kind).toBe("node-script");

    const health = executorHealth("workbuddy", settings, settingsPath, 0);
    expect(health.canRun).toBe(true);
    expect(health.version).toBe("9.9.9");
    expect(health.installState).toBe("available");
  });

  it("uses a configured executable path and reports a missing executor", () => {
    const root = tempRoot();
    const settingsPath = join(root, "executor-settings.json");
    const script = join(root, "fake-kimi.mjs");
    writeScript(script, "2.5.2");

    const settings = defaultExecutorSettings();
    settings.executors.kimi = { executablePath: script };
    const health = executorHealth("kimi", settings, settingsPath, 0);
    expect(health.canRun).toBe(true);
    expect(health.version).toBe("2.5.2");

    const missing = executorHealth("workbuddy", settings, settingsPath, 0);
    expect(missing.canRun).toBe(false);
    expect(missing.installState).toBe("missing");
  });

  it("probes asynchronously without throwing for missing executors", async () => {
    const root = tempRoot();
    const settingsPath = join(root, "executor-settings.json");
    const result = await probeExecutor("kimi", defaultExecutorSettings(), settingsPath);
    expect(result.id).toBe("kimi");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.health.installState).toBe("missing");
  });
});

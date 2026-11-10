import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyExecutorProbeFailure, clearExecutorHealthCache, executorHealth, probeExecutor, resolveExecutorLaunch } from "./executor-runtime.ts";
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
      "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'probe-session' }));",
      "console.log(JSON.stringify({ role: 'assistant', content: 'HEARTH_OK' }));",
      "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'HEARTH_OK' }] } }));",
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'HEARTH_OK', session_id: 'probe-session' }));"
    ].join("\n"),
    "utf8"
  );
}

function writeQuotaScript(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) { console.log('9.9.9'); process.exit(0); }",
      "console.error('Error: HTTP 429 Too Many Requests');",
      "process.exit(1);"
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

  it("resolves a managed node cli and only marks it ready after a real probe", async () => {
    const root = tempRoot();
    const settingsPath = join(root, "executor-settings.json");
    const script = join(root, "executors", "workbuddy", "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
    writeScript(script, "9.9.9");

    const settings = defaultExecutorSettings();
    const launch = resolveExecutorLaunch("workbuddy", settings, settingsPath);
    expect(launch?.source).toBe("managed");
    expect(launch?.kind).toBe("node-script");

    const health = executorHealth("workbuddy", settings, settingsPath, 0);
    expect(health.canRun).toBe(false);
    expect(health.state).toBe("unverified");
    expect(health.version).toBe("9.9.9");
    expect(health.installState).toBe("available");

    const probed = await probeExecutor("workbuddy", settings, settingsPath, 10_000);
    expect(probed.ok).toBe(true);
    expect(probed.health.state).toBe("ready");
    expect(probed.health.verifiedAt).toBeTruthy();
    expect(executorHealth("workbuddy", settings, settingsPath, 0).canRun).toBe(true);
  });

  it("uses a configured executable path and reports a missing executor", async () => {
    const root = tempRoot();
    const settingsPath = join(root, "executor-settings.json");
    const script = join(root, "fake-kimi.mjs");
    writeScript(script, "2.5.2");

    const settings = defaultExecutorSettings();
    settings.executors.kimi = { executablePath: script };
    const health = executorHealth("kimi", settings, settingsPath, 0);
    expect(health.canRun).toBe(false);
    expect(health.state).toBe("unverified");
    expect(health.version).toBe("2.5.2");

    const probed = await probeExecutor("kimi", settings, settingsPath, 10_000);
    expect(probed.ok).toBe(true);

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

  it("keeps a real probe that hits a quota limit unavailable", async () => {
    const root = tempRoot();
    const settingsPath = join(root, "executor-settings.json");
    const script = join(root, "executors", "workbuddy", "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
    writeQuotaScript(script);

    const probed = await probeExecutor("workbuddy", defaultExecutorSettings(), settingsPath, 10_000);
    expect(probed.ok).toBe(false);
    expect(probed.health.state).toBe("quota_exceeded");
    expect(probed.health.canRun).toBe(false);
    expect(probed.health.verifiedAt).toBeNull();
    expect(probed.error).toContain("429");
  });

  it("classifies 429 and quota failures as quota_exceeded", () => {
    expect(classifyExecutorProbeFailure("429 Too Many Requests", "HTTP_429").state).toBe("quota_exceeded");
    expect(classifyExecutorProbeFailure("当前账户额度已用尽", null).state).toBe("quota_exceeded");
    expect(classifyExecutorProbeFailure("connection refused", null).state).toBe("failed");
  });
});

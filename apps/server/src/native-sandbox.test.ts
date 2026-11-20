import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { resolveSandboxPolicy, runShellSession, sandboxTempBase } from "@hearth/agent-runtime";
import { WindowsAclSandboxProvider } from "./native-sandbox.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // ACL grants can outlive the test; leave the temp tree for OS cleanup.
    }
  }
});

describe.runIf(process.platform === "win32")("Windows ACL sandbox provider", () => {
  it("confines shell writes to the workspace and keeps an outside write denied", async () => {
    const parent = mkdtempSync(join(sandboxTempBase(), "hearth-native-sandbox-"));
    roots.push(parent);
    const workspace = join(parent, "ws");
    const out = join(parent, "out");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(out, { recursive: true });

    const provider = new WindowsAclSandboxProvider({ probe: false });
    await provider.probe();
    const selection = resolveSandboxPolicy({
      permissions: {
        readRoots: [workspace],
        writeRoots: [workspace],
        networkHosts: [],
        sandboxMode: "workspace-write"
      },
      workspaceRoot: workspace,
      outDir: out,
      sessionId: "native-provider-test"
    });
    expect(selection.policy).toBeTruthy();

    const insidePath = join(workspace, "inside.txt");
    const outsidePath = join(parent, "outside.txt");
    const inside = await runShellSession({
      command: `cmd /c echo inside>"${insidePath}"`,
      cwd: workspace,
      outDir: out,
      timeoutMs: 10_000,
      sandbox: { provider, policy: selection.policy! }
    });
    expect(inside.exitCode, inside.output).toBe(0);
    expect(existsSync(insidePath)).toBe(true);
    expect(inside.sandbox?.backend).toBe("windows-acl");

    const outside = await runShellSession({
      command: `cmd /c echo outside>"${outsidePath}"`,
      cwd: workspace,
      outDir: out,
      timeoutMs: 10_000,
      sandbox: { provider, policy: selection.policy! }
    });
    await delay(100);
    expect(outside.exitCode).not.toBe(0);
    expect(existsSync(outsidePath)).toBe(false);
  }, 30_000);
});

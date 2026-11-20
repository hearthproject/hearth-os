import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildChildEnv,
  canonicalPath,
  pathWithin,
  resolveSandboxPolicy,
  runnerFailed
} from "./sandbox.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-sandbox-test-"));
  roots.push(root);
  return root;
}

describe("sandbox policy", () => {
  it("resolves a workspace-write policy inside the workspace", () => {
    const root = workspace();
    const outDir = join(root, "out");
    mkdirSync(outDir);
    const selection = resolveSandboxPolicy({
      permissions: {
        readRoots: [root],
        writeRoots: [root, outDir],
        networkHosts: ["example.com"],
        sandboxMode: "workspace-write"
      },
      workspaceRoot: root,
      outDir,
      sessionId: "task-1"
    });

    expect(selection.mode).toBe("workspace-write");
    expect(selection.policy?.workspaceRoot).toBe(canonicalPath(root));
    expect(selection.policy?.writableRoots).toContain(canonicalPath(outDir));
    expect(selection.policy?.networkHosts).toEqual(["example.com"]);
    expect(selection.policy?.tempRoot).toContain("hearth-sandbox");
    expect(selection.policy?.tempRoot.toLowerCase().startsWith(canonicalPath(root).toLowerCase())).toBe(false);
  });

  it("keeps writable roots outside the sandbox root out of the shell policy", () => {
    const root = workspace();
    const outside = workspace();
    const selection = resolveSandboxPolicy({
      permissions: {
        readRoots: [root],
        writeRoots: [outside],
        networkHosts: [],
        sandboxMode: "workspace-write"
      },
      workspaceRoot: root,
      outDir: join(root, "out"),
      sessionId: "task-2"
    });
    expect(selection.policy?.writableRoots).not.toContain(canonicalPath(outside));
    expect(selection.warnings.join(" ")).toContain("不会暴露给 shell");
  });

  it("returns no policy for danger-full-access", () => {
    const root = workspace();
    const selection = resolveSandboxPolicy({
      permissions: {
        readRoots: [root],
        writeRoots: [],
        networkHosts: [],
        sandboxMode: "danger-full-access"
      },
      workspaceRoot: root,
      outDir: join(root, "out"),
      sessionId: "task-3"
    });
    expect(selection.policy).toBeNull();
    expect(selection.warnings.join(" ")).toContain("未隔离");
  });

  it("treats paths inside the root consistently on Windows", () => {
    const root = workspace();
    expect(pathWithin(root, join(root, "nested", "file.txt"))).toBe(true);
    expect(pathWithin(root, join(root, "..", "outside.txt"))).toBe(false);
  });

  it("filters credentials, loader variables, and Hearth internals from child env", () => {
    const root = workspace();
    const env = buildChildEnv({
      base: {
        PATH: "C:\\Windows\\System32",
        OPENAI_API_KEY: "secret-key",
        GITHUB_TOKEN: "ghp_secret",
        HEARTH_INTERNAL: "internal",
        NODE_OPTIONS: "--require=evil",
        PYTHONPATH: "evil",
        TEMP: "C:\\outside"
      },
      extra: {
        SAFE_VALUE: "ok",
        PATH: "C:\\evil",
        TEMP: "C:\\outside",
        ANTHROPIC_API_KEY: "another-secret"
      },
      tempRoot: join(root, "temp"),
      workspaceRoot: root
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.HEARTH_INTERNAL).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SAFE_VALUE).toBe("ok");
    expect(env.PATH).not.toContain("C:\\evil");
    expect(env.TEMP).toBe(join(root, "temp"));
    expect(env.TMP).toBe(join(root, "temp"));
    expect(env.npm_config_cache).toContain(".hearth");
  });

  it("classifies runner failure separately from command failure", () => {
    expect(runnerFailed("windows-acl-run: SetNamedSecurityInfoW failed", 127, [{ allowedExitCodes: [127], fatalSignatures: ["windows-acl-run: "] }])).toBe(true);
    expect(runnerFailed("Access is denied.", 1, [{ allowedExitCodes: [127], fatalSignatures: ["windows-acl-run: "] }])).toBe(false);
  });
});

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildChildEnv, type SandboxPolicy } from "@hearth/agent-runtime";
import { WindowsNativeSandboxProvider } from "./windows-native-sandbox.ts";

const helperPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "bin", "hearth-native.exe");
const isWindows = process.platform === "win32";
const hasHelper = isWindows && existsSync(helperPath);

function policyFor(workspaceRoot: string, tempRoot: string, mode: SandboxPolicy["mode"] = "workspace-write"): SandboxPolicy {
  return {
    mode,
    workspaceRoot,
    writableRoots: [workspaceRoot],
    readRoots: [],
    networkHosts: [],
    tempRoot,
    sessionId: "native-sandbox-test",
    env: buildChildEnv({ base: process.env, tempRoot, workspaceRoot })
  };
}

async function run(provider: WindowsNativeSandboxProvider, policy: SandboxPolicy, argv: readonly string[]): Promise<{ code: number | null; stderr: string }> {
  const confined = await provider.confine({ argv, cwd: policy.workspaceRoot, policy });
  return await new Promise((resolvePromise) => {
    const child = spawn(confined.argv[0]!, confined.argv.slice(1), {
      cwd: confined.cwd,
      env: confined.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => resolvePromise({ code, stderr }));
  });
}

describe("WindowsNativeSandboxProvider", () => {
  it("builds a native helper argv with workspace, temp and write roots", async () => {
    const provider = new WindowsNativeSandboxProvider({ helperPath: process.execPath, probe: false });
    const workspace = "C:\\work";
    const temp = "C:\\temp";
    const out = join(workspace, "out");
    const policy = {
      ...policyFor(workspace, temp),
      writableRoots: [workspace, out]
    };
    const confined = await provider.confine({ argv: ["C:\\Windows\\System32\\cmd.exe", "/c", "exit 0"], cwd: workspace, policy });
    expect(confined.argv[0]).toBe(process.execPath);
    expect(confined.argv).toContain("sandbox");
    expect(confined.argv).toContain("--workspace");
    expect(confined.argv).toContain("--parent-pid");
    expect(confined.argv).toContain("--write");
    expect(confined.argv.at(-1)).toBe("exit 0");
    expect(confined.enforcement).toBe("full");
    expect(confined.networkEnforcement).toBe("full");
  });

  it("builds a pty helper argv with console dimensions", async () => {
    const provider = new WindowsNativeSandboxProvider({ helperPath: process.execPath, probe: false });
    const workspace = "C:\\work";
    const temp = "C:\\temp";
    const policy = policyFor(workspace, temp);
    const confined = await provider.confine({
      argv: ["C:\\Windows\\System32\\cmd.exe"],
      cwd: workspace,
      policy,
      pty: { cols: 100, rows: 40 }
    });
    expect(confined.argv).toContain("pty");
    expect(confined.argv).toContain("--cols");
    expect(confined.argv).toContain("100");
    expect(confined.argv).toContain("--rows");
    expect(confined.argv).toContain("40");
    expect(confined.argv).not.toContain("sandbox");
  });

  it.runIf(hasHelper)("runs an interactive command through ConPTY", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-native-test-"));
    const workspace = join(root, "ws");
    const temp = join(root, "tmp");
    mkdirSync(workspace);
    mkdirSync(temp);
    try {
      const provider = new WindowsNativeSandboxProvider({ helperPath, probe: false });
      const policy = policyFor(workspace, temp);
      const confined = await provider.confine({
        argv: [process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"],
        cwd: workspace,
        policy,
        pty: { cols: 100, rows: 40 }
      });
      const output = await new Promise<string>((resolvePromise, reject) => {
        const child = spawn(confined.argv[0]!, confined.argv.slice(1), {
          cwd: confined.cwd,
          env: confined.env,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"]
        });
        let text = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`PTY output timeout: ${text.slice(-500)}`));
        }, 12_000);
        child.stdout.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
          if (text.includes("pty-ok")) {
            child.stdin.write("exit\r\n");
          }
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error(`PTY exit ${code}: ${text.slice(-500)}`));
          else resolvePromise(text);
        });
        child.stdin.write("echo pty-ok\r\n");
      });
      expect(output).toContain("pty-ok");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 20_000);

  it("refuses net-allowlist instead of silently removing network access", async () => {
    const provider = new WindowsNativeSandboxProvider({ helperPath: process.execPath, probe: false });
    const policy = {
      ...policyFor("C:\\work", "C:\\temp"),
      networkHosts: ["example.com"]
    };
    await expect(provider.confine({ argv: ["C:\\Windows\\System32\\cmd.exe", "/c", "exit 0"], cwd: policy.workspaceRoot, policy }))
      .rejects.toThrow(/net-allowlist/);
  });

  it.runIf(hasHelper)("allows a workspace write in workspace-write mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-native-test-"));
    const workspace = join(root, "ws");
    const temp = join(root, "tmp");
    mkdirSync(workspace);
    mkdirSync(temp);
    try {
      const provider = new WindowsNativeSandboxProvider({ helperPath, probe: false });
      const result = await run(provider, policyFor(workspace, temp), [process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", "/c", "echo ok> ok.txt"]);
      expect(result.code).toBe(0);
      expect(readFileSync(join(workspace, "ok.txt"), "utf8").trim()).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it.runIf(hasHelper)("denies workspace writes in read-only mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-native-test-"));
    const workspace = join(root, "ws");
    const temp = join(root, "tmp");
    mkdirSync(workspace);
    mkdirSync(temp);
    try {
      const provider = new WindowsNativeSandboxProvider({ helperPath, probe: false });
      const result = await run(provider, policyFor(workspace, temp, "read-only"), [process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", "/c", "echo no> blocked.txt"]);
      expect(result.code).not.toBe(0);
      expect(existsSync(join(workspace, "blocked.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it.runIf(hasHelper)("denies writes outside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-native-test-"));
    const workspace = join(root, "ws");
    const temp = join(root, "tmp");
    mkdirSync(workspace);
    mkdirSync(temp);
    const outside = join(root, "outside.txt");
    try {
      const provider = new WindowsNativeSandboxProvider({ helperPath, probe: false });
      const result = await run(provider, policyFor(workspace, temp), [process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", "/c", `echo no> "${outside}"`]);
      expect(result.code).not.toBe(0);
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it.runIf(hasHelper)("filters secret environment variables", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-native-test-"));
    const workspace = join(root, "ws");
    const temp = join(root, "tmp");
    mkdirSync(workspace);
    mkdirSync(temp);
    try {
      const provider = new WindowsNativeSandboxProvider({ helperPath, probe: false });
      const previous = process.env.TEST_API_KEY;
      process.env.TEST_API_KEY = "super-secret";
      try {
        const result = await run(provider, policyFor(workspace, temp), [process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", "/c", "set TEST_API_KEY"]);
        expect(result.code).not.toBe(0);
        expect(result.stderr.toLowerCase()).not.toContain("super-secret");
      } finally {
        if (previous === undefined) delete process.env.TEST_API_KEY;
        else process.env.TEST_API_KEY = previous;
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it.runIf(hasHelper)("denies network access by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-native-test-"));
    const workspace = join(root, "ws");
    const temp = join(root, "tmp");
    mkdirSync(workspace);
    mkdirSync(temp);
    try {
      const provider = new WindowsNativeSandboxProvider({ helperPath, probe: false });
      const result = await run(provider, policyFor(workspace, temp), ["C:\\Windows\\System32\\ping.exe", "-n", "1", "8.8.8.8"]);
      expect(result.code).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 15_000);

  it.runIf(hasHelper)("does not follow a junction out of the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-native-test-"));
    const workspace = join(root, "ws");
    const temp = join(root, "tmp");
    const outside = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(temp);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "outside-secret", "utf8");
    try {
      const provider = new WindowsNativeSandboxProvider({ helperPath, probe: false });
      const link = join(workspace, "escape");
      symlinkSync(outside, link, "junction");
      const result = await run(provider, policyFor(workspace, temp), [process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", "/c", `type "${join(link, "secret.txt")}"`]);
      expect(result.code).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it.runIf(hasHelper)("kills the child when the helper process closes", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-native-test-"));
    const workspace = join(root, "ws");
    const temp = join(root, "tmp");
    mkdirSync(workspace);
    mkdirSync(temp);
    try {
      const provider = new WindowsNativeSandboxProvider({ helperPath, probe: false });
      const confined = await provider.confine({
        argv: [process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", "/c", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -Command Start-Sleep -Seconds 20"],
        cwd: workspace,
        policy: policyFor(workspace, temp)
      });
      const helper = spawn(confined.argv[0]!, confined.argv.slice(1), { cwd: confined.cwd, env: confined.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const query = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${helper.pid}").ProcessId`
      ], { encoding: "utf8", windowsHide: true });
      const childPid = Number.parseInt(query.stdout.trim(), 10);
      expect(Number.isFinite(childPid)).toBe(true);
      process.kill(helper.pid!, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 15_000);
});

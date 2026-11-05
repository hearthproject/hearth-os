import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "./github.ts";
import { prepareTaskRuntime } from "./runtime.ts";

describe("task runtime preparation", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("prepares a pinned Python environment and records the exact interpreter", async () => {
    const root = makeTemp("hearth-runtime-python-");
    const repoPath = join(root, "repo");
    const backend = join(repoPath, "backend");
    mkdirSync(backend, { recursive: true });
    writeFileSync(join(backend, "requirements.txt"), "fastapi\n");
    writeFileSync(join(backend, "requirements-dev.txt"), "pytest\n");
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "uv" && args[0] === "venv") {
        const venv = args[3] ?? "";
        const interpreter = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
        mkdirSync(join(interpreter, ".."), { recursive: true });
        writeFileSync(interpreter, "fake interpreter");
        return { stdout: "", stderr: "" };
      }
      if (command === "uv" && args[0] === "pip") return { stdout: "installed", stderr: "" };
      if (args[0] === "--version") return { stdout: "Python 3.11.14\n", stderr: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    const result = await prepareTaskRuntime({
      spec: {
        python: {
          version: "3.11",
          workingDirectory: "backend",
          requirements: ["backend/requirements.txt", "backend/requirements-dev.txt"]
        }
      },
      repoPath,
      workspaceRoot: join(root, "workspace"),
      run
    });

    expect(result.ok).toBe(true);
    expect(result.python?.version).toBe("Python 3.11.14");
    expect(result.python?.interpreter).toContain(".runtime");
    expect(existsSync(result.python?.interpreter ?? "")).toBe(true);
    expect(calls.some((call) => call.startsWith("uv pip install"))).toBe(true);
    const record = JSON.parse(readFileSync(result.recordPath, "utf8"));
    expect(record.ok).toBe(true);
    expect(record.python.version).toBe("Python 3.11.14");
  });

  it("records an optional dependency failure instead of silently claiming readiness", async () => {
    const root = makeTemp("hearth-runtime-node-");
    const repoPath = join(root, "repo");
    const app = join(repoPath, "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), "{}\n");
    const run: CommandRunner = async () => {
      throw new Error("registry unavailable");
    };

    const result = await prepareTaskRuntime({
      spec: { node: { workingDirectory: "app", install: "ci" }, optional: true },
      repoPath,
      workspaceRoot: join(root, "workspace"),
      run
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("registry unavailable");
    expect(existsSync(result.logPath)).toBe(true);
    const record = JSON.parse(readFileSync(result.recordPath, "utf8"));
    expect(record.ok).toBe(false);
    expect(record.errors).toHaveLength(1);
  });

  it("rejects dependency paths that escape the cloned repository", async () => {
    const root = makeTemp("hearth-runtime-escape-");
    const repoPath = join(root, "repo");
    mkdirSync(repoPath, { recursive: true });

    const result = await prepareTaskRuntime({
      spec: { node: { workingDirectory: "app/../../outside", install: "ci" }, optional: true },
      repoPath,
      workspaceRoot: join(root, "workspace")
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("必须位于仓库内");
  });

  function makeTemp(prefix: string): string {
    tempDir = mkdtempSync(join(tmpdir(), prefix));
    return tempDir;
  }
});

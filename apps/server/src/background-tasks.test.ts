import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import type { BackgroundTaskRecord } from "@hearth/agent-runtime";
import { SqliteBackgroundTaskRegistry } from "./background-tasks.ts";

const helperPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "bin", "hearth-native.exe");
const hasHelper = process.platform === "win32" && existsSync(helperPath);

function record(overrides: Partial<BackgroundTaskRecord>): BackgroundTaskRecord {
  const now = new Date().toISOString();
  return {
    sessionId: "sh_test",
    taskId: "task-1",
    runId: "run-1",
    pid: null,
    startTime: now,
    command: "node -e \"setTimeout(() => {}, 30000)\"",
    outputPath: "C:\\temp\\sh_test.log",
    pty: false,
    status: "running",
    exitCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function withRegistry(fn: (registry: SqliteBackgroundTaskRegistry) => void): void {
  const root = mkdtempSync(join(tmpdir(), "hearth-background-test-"));
  const store = new HearthStore(join(root, "hearth.db"));
  try {
    fn(new SqliteBackgroundTaskRegistry(store));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe("SqliteBackgroundTaskRegistry", () => {
  it("persists a running session and settles it", () => {
    withRegistry((registry) => {
      registry.start(record({ sessionId: "sh_one" }));
      expect(registry.get("sh_one")?.status).toBe("running");
      expect(registry.list("running")).toHaveLength(1);
      registry.finish("sh_one", 0, "exited");
      expect(registry.get("sh_one")?.status).toBe("exited");
      expect(registry.get("sh_one")?.exitCode).toBe(0);
      expect(registry.list("running")).toHaveLength(0);
    });
  });

  it("marks a dead PID lost without killing a reused PID", () => {
    withRegistry((registry) => {
      registry.start(record({ sessionId: "sh_dead", pid: 999_999 }));
      expect(registry.recoverLost()).toBe(1);
      expect(registry.get("sh_dead")?.status).toBe("lost");
    });
  });

  it.runIf(hasHelper)("kills a matching live process and marks it lost", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore", windowsHide: true });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const root = mkdtempSync(join(tmpdir(), "hearth-background-test-"));
      const store = new HearthStore(join(root, "hearth.db"));
      try {
        const registry = new SqliteBackgroundTaskRegistry(store);
        registry.start(record({ sessionId: "sh_live", pid: child.pid ?? null }));
        const saved = registry.get("sh_live");
        expect(saved?.startTime).toBeTruthy();
        expect(saved?.startTime).not.toBe(saved?.createdAt);
        expect(registry.recoverLost()).toBe(1);
        expect(registry.get("sh_live")?.status).toBe("lost");
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            process.kill(child.pid!, 0);
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch {
            break;
          }
        }
        expect(() => process.kill(child.pid!, 0)).toThrow();
      } finally {
        store.close();
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    } finally {
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
      } catch {
        // Already killed by recoverLost.
      }
    }
  }, 20_000);
});

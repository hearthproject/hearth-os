import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DataDirLockError } from "./data-lock.ts";
import { HostKernel } from "./host-kernel.ts";

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-host-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("HostKernel", () => {
  it("holds one root lease and releases it on stop", () => {
    const dir = makeDir();
    const first = new HostKernel({ dataDir: dir, port: 4317 });
    const second = new HostKernel({ dataDir: dir, port: 4318 });
    first.start();
    expect(first.snapshot()).toMatchObject({ phase: "recovering", step: "store", lease: { kind: "file-lock" } });
    expect(() => second.start()).toThrow(DataDirLockError);
    first.ready();
    expect(first.canAcceptWrites()).toBe(true);
    first.beginDrain();
    expect(first.canAcceptWrites()).toBe(false);
    first.stop();
    expect(first.snapshot().lease).toBeNull();
    second.start();
    expect(second.snapshot().phase).toBe("recovering");
    second.stop();
  });

  it("records recovery steps and failure details", () => {
    const dir = makeDir();
    const host = new HostKernel({ dataDir: dir, port: 4317 });
    host.recovering();
    host.advance("operations");
    host.advance("runs");
    expect(host.snapshot().step).toBe("runs");
    host.fail(new Error("sqlite damaged"));
    expect(host.snapshot()).toMatchObject({ phase: "failed", error: "sqlite damaged" });
    host.stop();
    expect(host.snapshot().phase).toBe("stopped");
  });
});

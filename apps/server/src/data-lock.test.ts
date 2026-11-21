import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDataDirLock,
  DataDirLockError,
  dataDirLockExists,
  readDataDirLock,
  releaseDataDirLock,
  sameProcessIdentity
} from "./data-lock.ts";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("data directory lock", () => {
  it("acquires and releases a lock", () => {
    const dir = makeDir();
    expect(dataDirLockExists(dir)).toBe(false);

    const lock = acquireDataDirLock(dir, 4317);
    expect(dataDirLockExists(dir)).toBe(true);
    expect(readDataDirLock(dir)?.pid).toBe(process.pid);
    expect(readDataDirLock(dir)?.port).toBe(4317);

    lock.release();
    expect(dataDirLockExists(dir)).toBe(false);
  });

  it("rejects a second live holder", () => {
    const dir = makeDir();
    const lock = acquireDataDirLock(dir, 4317);
    try {
      expect(() => acquireDataDirLock(dir, 4318)).toThrow(DataDirLockError);
    } finally {
      lock.release();
    }
  });

  it("cleans a stale lock whose PID is gone", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "hearth.lock"), JSON.stringify({
      pid: 999_999,
      startedAt: new Date().toISOString(),
      port: 4317
    }));

    const lock = acquireDataDirLock(dir, 4317);
    expect(readDataDirLock(dir)?.pid).toBe(process.pid);
    lock.release();
  });

  it("cleans an unreadable lock", () => {
    const dir = makeDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hearth.lock"), "not-json");

    const lock = acquireDataDirLock(dir, 4317);
    expect(readDataDirLock(dir)?.pid).toBe(process.pid);
    lock.release();
  });

  it("does not remove another process's lock when releasing", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "hearth.lock"), JSON.stringify({
      pid: 999_999,
      startedAt: new Date().toISOString(),
      port: 4317
    }));

    releaseDataDirLock(join(dir, "hearth.lock"));
    expect(readDataDirLock(dir)?.pid).toBe(999_999);
  });

  it("rejects a recycled PID whose creation time differs", () => {
    expect(sameProcessIdentity(
      { pid: process.pid, processStartedAt: "2026-11-21T09:00:00.000Z" },
      "2026-11-21T10:00:00.000Z"
    )).toBe(false);
    expect(sameProcessIdentity(
      { pid: process.pid, processStartedAt: "2026-11-21T10:00:00.000Z" },
      "2026-11-21T10:00:01.000Z"
    )).toBe(true);
    expect(sameProcessIdentity({ pid: process.pid }, null)).toBe(true);
  });

  it("supports a custom lock file for the host lease", () => {
    const dir = makeDir();
    const lock = acquireDataDirLock(dir, 4317, { name: "hearth.host.lock" });
    expect(readDataDirLock(dir)).toBeNull();
    expect(() => acquireDataDirLock(dir, 4318, { name: "hearth.host.lock" })).toThrow(DataDirLockError);
    lock.release();
  });
});

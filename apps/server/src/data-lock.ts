import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DataDirLockInfo {
  pid: number;
  startedAt: string;
  port: number;
  /** Process creation time, used to reject a recycled PID. */
  processStartedAt?: string;
}

export interface DataDirLock {
  path: string;
  release: () => void;
}

export class DataDirLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataDirLockError";
  }
}

import { spawnSync } from "node:child_process";

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function processStartedAt(pid: number): string | null {
  if (pid === process.pid) {
    return new Date(Date.now() - process.uptime() * 1000).toISOString();
  }
  if (process.platform !== "win32") return null;
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
    { encoding: "utf8", timeout: 5000, windowsHide: true }
  );
  if (result.status !== 0) return null;
  const value = String(result.stdout ?? "").trim();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function sameProcessIdentity(info: Pick<DataDirLockInfo, "pid" | "processStartedAt">, actualStartedAt: string | null): boolean {
  if (!info.processStartedAt || !actualStartedAt) return true;
  const recorded = Date.parse(info.processStartedAt);
  const actual = Date.parse(actualStartedAt);
  if (!Number.isFinite(recorded) || !Number.isFinite(actual)) return true;
  return Math.abs(recorded - actual) < 2_000;
}

function readLock(path: string): DataDirLockInfo | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object") return null;
    const info = value as Partial<DataDirLockInfo>;
    if (!Number.isInteger(info.pid) || typeof info.startedAt !== "string" || typeof info.port !== "number") {
      return null;
    }
    return info as DataDirLockInfo;
  } catch {
    return null;
  }
}

export function acquireDataDirLock(dataDir: string, port: number, options: { name?: string; info?: Partial<DataDirLockInfo> } = {}): DataDirLock {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, options.name ?? "hearth.lock");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      const ownStartedAt = processStartedAt(process.pid);
      const info: DataDirLockInfo = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        port,
        ...(ownStartedAt ? { processStartedAt: ownStartedAt } : {}),
        ...options.info
      };
      writeFileSync(fd, `${JSON.stringify(info, null, 2)}\n`, "utf8");
      closeSync(fd);
      return { path, release: () => releaseDataDirLock(path) };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;

      const existing = readLock(path);
      if (existing && isProcessAlive(existing.pid) && sameProcessIdentity(existing, processStartedAt(existing.pid))) {
        throw new DataDirLockError(
          `数据目录已被另一个 Hearth 实例占用（PID ${existing.pid}，端口 ${existing.port}）。` +
          "请先关闭那个实例，避免两个进程同时写 SQLite。"
        );
      }

      try {
        unlinkSync(path);
      } catch {
        // Another process may have removed it first; retry the exclusive create.
      }
    }
  }

  throw new DataDirLockError(`无法获取数据目录锁：${path}`);
}

export function releaseDataDirLock(path: string): void {
  try {
    const info = readLock(path);
    if (!info || info.pid !== process.pid) return;
    unlinkSync(path);
  } catch {
    // The lock may already be gone; releasing is best-effort.
  }
}

export function readDataDirLock(dataDir: string): DataDirLockInfo | null {
  return readLock(join(dataDir, "hearth.lock"));
}

export function dataDirLockExists(dataDir: string): boolean {
  return existsSync(join(dataDir, "hearth.lock"));
}

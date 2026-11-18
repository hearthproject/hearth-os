import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DataDirLockInfo {
  pid: number;
  startedAt: string;
  port: number;
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

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
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

export function acquireDataDirLock(dataDir: string, port: number): DataDirLock {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "hearth.lock");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      const info: DataDirLockInfo = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        port
      };
      writeFileSync(fd, `${JSON.stringify(info, null, 2)}\n`, "utf8");
      closeSync(fd);
      return { path, release: () => releaseDataDirLock(path) };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;

      const existing = readLock(path);
      if (existing && isProcessAlive(existing.pid)) {
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

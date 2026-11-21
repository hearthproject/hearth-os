import { acquireDataDirLock } from "./data-lock.ts";

export interface HostLease {
  /** `named-mutex` once the native helper is present; file lock is the portable fallback. */
  kind: "named-mutex" | "file-lock";
  path: string;
  release: () => void;
}

/**
 * One writer per data directory. The lock records both PID and process
 * creation time, so a recycled PID cannot inherit a stale lease. The native
 * helper will replace this with a Windows named mutex in the sandbox milestone.
 */
export function acquireHostLease(dataDir: string, port: number): HostLease {
  const lock = acquireDataDirLock(dataDir, port, { name: "hearth.host.lock" });
  return { kind: "file-lock", path: lock.path, release: lock.release };
}

import { spawnSync } from "node:child_process";
import type { HearthStore } from "@hearth/eventlog";
import {
  killWindowsProcessTree,
  type BackgroundTaskRecord,
  type BackgroundTaskRegistry,
  type BackgroundTaskStatus
} from "@hearth/agent-runtime";
import { resolveNativeHelperPath } from "./windows-native-sandbox.ts";

/**
 * SQLite-backed registry for shell processes. Lives on the same HearthStore
 * connection as every other write, so there is still one SQLite writer.
 */
export class SqliteBackgroundTaskRegistry implements BackgroundTaskRegistry {
  constructor(private readonly store: HearthStore) {}

  start(record: BackgroundTaskRecord): void {
    const actualStart = record.pid ? windowsProcessStartTime(record.pid) : null;
    const startTime = actualStart ?? record.startTime;
    this.store.db.prepare(
      `INSERT INTO background_processes
       (session_id, task_id, run_id, pid, start_time, command, output_path, pty, status, exit_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         pid = excluded.pid, start_time = excluded.start_time, command = excluded.command,
         output_path = excluded.output_path, pty = excluded.pty, status = 'running',
         exit_code = NULL, updated_at = excluded.updated_at`
    ).run(
      record.sessionId,
      record.taskId,
      record.runId,
      record.pid,
      startTime,
      record.command,
      record.outputPath,
      record.pty ? 1 : 0,
      record.createdAt,
      record.updatedAt
    );
  }

  finish(sessionId: string, exitCode: number | null, status: Exclude<BackgroundTaskStatus, "running">): void {
    this.store.db.prepare(
      `UPDATE background_processes SET status = ?, exit_code = ?, updated_at = ? WHERE session_id = ? AND status = 'running'`
    ).run(status, exitCode, new Date().toISOString(), sessionId);
  }

  get(sessionId: string): BackgroundTaskRecord | null {
    const row = this.store.db.prepare("SELECT * FROM background_processes WHERE session_id = ?").get(sessionId) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(status?: BackgroundTaskStatus): BackgroundTaskRecord[] {
    const rows = status
      ? this.store.db.prepare("SELECT * FROM background_processes WHERE status = ? ORDER BY created_at").all(status)
      : this.store.db.prepare("SELECT * FROM background_processes ORDER BY created_at").all();
    return (rows as Record<string, unknown>[]).map(rowToRecord);
  }

  /**
   * Called before the host becomes ready. A session whose PID + creation time
   * still matches is the same process; it cannot be adopted by a new runtime,
   * so kill its tree and mark it lost instead of leaving a ghost shell.
   */
  recoverLost(): number {
    let recovered = 0;
    for (const record of this.list("running")) {
      if (record.pid) {
        const actualStart = windowsProcessStartTime(record.pid);
        if (actualStart && record.startTime && actualStart === record.startTime) {
          try {
            killWindowsProcessTree(record.pid);
          } catch {
            // Best effort; the record is still marked lost.
          }
        }
      }
      this.finish(record.sessionId, null, "lost");
      recovered += 1;
    }
    return recovered;
  }
}

let installedRegistry: SqliteBackgroundTaskRegistry | null = null;

export function installBackgroundTaskRegistry(store: HearthStore): SqliteBackgroundTaskRegistry {
  const registry = new SqliteBackgroundTaskRegistry(store);
  installedRegistry = registry;
  return registry;
}

export function getBackgroundTaskRegistry(): SqliteBackgroundTaskRegistry | null {
  return installedRegistry;
}

export function resetBackgroundTaskRegistry(): void {
  installedRegistry = null;
}

function rowToRecord(row: Record<string, unknown>): BackgroundTaskRecord {
  return {
    sessionId: String(row.session_id),
    taskId: typeof row.task_id === "string" ? row.task_id : null,
    runId: typeof row.run_id === "string" ? row.run_id : null,
    pid: typeof row.pid === "number" ? row.pid : null,
    startTime: typeof row.start_time === "string" ? row.start_time : null,
    command: String(row.command),
    outputPath: String(row.output_path),
    pty: Number(row.pty) === 1,
    status: String(row.status) as BackgroundTaskStatus,
    exitCode: typeof row.exit_code === "number" ? row.exit_code : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function windowsProcessStartTime(pid: number): string | null {
  if (process.platform !== "win32") return null;
  try {
    const helper = resolveNativeHelperPath();
    const result = spawnSync(helper, ["process-info", "--pid", String(pid)], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000
    });
    if (result.status !== 0 || !result.stdout) return null;
    const parsed = JSON.parse(result.stdout.trim()) as { startedAt?: unknown };
    return typeof parsed.startedAt === "string" ? parsed.startedAt : null;
  } catch {
    return null;
  }
}

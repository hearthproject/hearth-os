export type BackgroundTaskStatus = "running" | "exited" | "killed" | "lost";

/** One shell process recorded in the durable background registry. */
export interface BackgroundTaskRecord {
  sessionId: string;
  taskId: string | null;
  runId: string | null;
  pid: number | null;
  /** OS process creation time, used to reject PID reuse after a host restart. */
  startTime: string | null;
  command: string;
  outputPath: string;
  pty: boolean;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Durable record of shell processes. The live session map owns output streams;
 * this registry is the restart-facing truth for "did this process exist".
 */
export interface BackgroundTaskRegistry {
  start(record: BackgroundTaskRecord): void;
  finish(sessionId: string, exitCode: number | null, status: Exclude<BackgroundTaskStatus, "running">): void;
  get(sessionId: string): BackgroundTaskRecord | null;
  list(status?: BackgroundTaskStatus): BackgroundTaskRecord[];
}

/** In-memory reference implementation for standalone runs and tests. */
export class MemoryBackgroundTaskRegistry implements BackgroundTaskRegistry {
  private readonly records = new Map<string, BackgroundTaskRecord>();

  start(record: BackgroundTaskRecord): void {
    this.records.set(record.sessionId, { ...record });
  }

  finish(sessionId: string, exitCode: number | null, status: Exclude<BackgroundTaskStatus, "running">): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    record.status = status;
    record.exitCode = exitCode;
    record.updatedAt = new Date().toISOString();
  }

  get(sessionId: string): BackgroundTaskRecord | null {
    const record = this.records.get(sessionId);
    return record ? { ...record } : null;
  }

  list(status?: BackgroundTaskStatus): BackgroundTaskRecord[] {
    return [...this.records.values()]
      .filter((record) => status === undefined || record.status === status)
      .map((record) => ({ ...record }));
  }
}

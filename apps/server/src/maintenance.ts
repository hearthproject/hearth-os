import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { MaintenanceRun } from "@hearth/core";
import type { ApprovalManager } from "./approvals.ts";
import type { ContextService } from "./context.ts";
import type { HearthService } from "./service.ts";

const DEFAULT_CLAIMED_COMMAND_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TEMP_FILE_TTL_MS = 24 * 60 * 60 * 1000;
const KEEP_MAINTENANCE_RUNS = 100;

export interface MaintenanceServiceOptions {
  service: HearthService;
  approvals: ApprovalManager;
  backupRoot: string;
  deviceFrameRoot: string;
  context?: ContextService;
  clock?: () => Date;
}

export interface MaintenanceSnapshot {
  latest: MaintenanceRun | null;
  runs: MaintenanceRun[];
  running: boolean;
  policy: {
    claimedCommandTtlMinutes: number;
    temporaryFileTtlHours: number;
    keptRuns: number;
  };
}

export class MaintenanceError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly run: MaintenanceRun;

  constructor(code: string, message: string, statusCode: number, run: MaintenanceRun) {
    super(message);
    this.name = "MaintenanceError";
    this.code = code;
    this.statusCode = statusCode;
    this.run = run;
  }
}

export class MaintenanceService {
  private readonly service: HearthService;
  private readonly approvals: ApprovalManager;
  private readonly backupRoot: string;
  private readonly deviceFrameRoot: string;
  private readonly context: ContextService | null;
  private readonly clock: () => Date;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: MaintenanceServiceOptions) {
    this.service = options.service;
    this.approvals = options.approvals;
    this.backupRoot = resolve(options.backupRoot);
    this.deviceFrameRoot = resolve(options.deviceFrameRoot);
    this.context = options.context ?? null;
    this.clock = options.clock ?? (() => new Date());
  }

  snapshot(limit = 20): MaintenanceSnapshot {
    return {
      latest: this.service.store.latestMaintenanceRun(),
      runs: this.service.store.listMaintenanceRuns(limit),
      running: this.running,
      policy: {
        claimedCommandTtlMinutes: DEFAULT_CLAIMED_COMMAND_TTL_MS / 60_000,
        temporaryFileTtlHours: DEFAULT_TEMP_FILE_TTL_MS / 3_600_000,
        keptRuns: KEEP_MAINTENANCE_RUNS
      }
    };
  }

  run(): MaintenanceRun {
    if (this.running) {
      throw new MaintenanceError("MAINTENANCE_IN_PROGRESS", "已有维护任务在执行", 409, {
        id: "not-started",
        startedAt: this.clock().toISOString(),
        endedAt: null,
        status: "running",
        actions: {},
        error: null
      });
    }
    this.running = true;
    const startedAt = this.clock().toISOString();
    const run: MaintenanceRun = {
      id: randomUUID(),
      startedAt,
      endedAt: null,
      status: "running",
      actions: {
        approvalsExpired: 0,
        tasksRecovered: 0,
        leasesExpired: 0,
        commandsExpired: 0,
        framesExpired: 0,
        frameFilesRemoved: 0,
        frameFileErrors: 0,
        pairingsExpired: 0,
        temporaryFilesRemoved: 0,
        maintenanceRunsPruned: 0,
        contextTasksPruned: 0,
        contextItemsPruned: 0,
        contextBlobsPruned: 0,
        contextHandoffsPruned: 0
      },
      error: null
    };
    this.service.store.createMaintenanceRun(run);
    try {
      const approvals = this.approvals.expirePastDue();
      run.actions.approvalsExpired = approvals.approvals;
      run.actions.tasksRecovered = approvals.tasks;

      const now = this.clock().toISOString();
      const nowMs = Date.parse(now);
      const db = this.service.store.db;
      run.actions.leasesExpired = Number(
        db.prepare("DELETE FROM task_leases WHERE expires_at <= ?").run(now).changes
      );
      run.actions.commandsExpired = Number(
        db.prepare(
          "UPDATE desktop_commands SET status = 'expired', error = ?, updated_at = ?, completed_at = ? WHERE status = 'claimed' AND updated_at <= ?"
        ).run("桌面助手没有在维护时限内完成命令", now, now, new Date(nowMs - DEFAULT_CLAIMED_COMMAND_TTL_MS).toISOString()).changes
      );
      run.actions.pairingsExpired = Number(
        db.prepare(
          "UPDATE pairing_requests SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?"
        ).run(now, now).changes
      );

      const frames = db.prepare("SELECT id, storage_path FROM desktop_frames WHERE expires_at <= ?").all(now) as Array<{
        id: string;
        storage_path: string;
      }>;
      for (const frame of frames) {
        const storagePath = resolve(String(frame.storage_path));
        const relativePath = relative(this.deviceFrameRoot, storagePath);
        if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
          run.actions.frameFileErrors = (run.actions.frameFileErrors ?? 0) + 1;
          continue;
        }
        if (existsSync(storagePath)) {
          try {
            unlinkSync(storagePath);
            run.actions.frameFilesRemoved = (run.actions.frameFilesRemoved ?? 0) + 1;
          } catch {
            run.actions.frameFileErrors = (run.actions.frameFileErrors ?? 0) + 1;
            continue;
          }
        }
        db.prepare("UPDATE desktop_sessions SET current_frame_id = NULL WHERE current_frame_id = ?").run(frame.id);
        db.prepare("DELETE FROM desktop_frames WHERE id = ?").run(frame.id);
        run.actions.framesExpired = (run.actions.framesExpired ?? 0) + 1;
      }

      run.actions.temporaryFilesRemoved = this.removeTemporaryFiles(nowMs);
      if (this.context) {
        const retention = this.context.pruneExpired({ now: new Date(now) });
        run.actions.contextTasksPruned = retention.tasksPruned;
        run.actions.contextItemsPruned = retention.deletedItems;
        run.actions.contextBlobsPruned = retention.deletedBlobs;
        run.actions.contextHandoffsPruned = retention.deletedHandoffs;
      }
      run.actions.maintenanceRunsPruned = Number(
        db.prepare(
          "DELETE FROM maintenance_runs WHERE id NOT IN (SELECT id FROM maintenance_runs ORDER BY started_at DESC LIMIT ?)"
        ).run(KEEP_MAINTENANCE_RUNS).changes
      );

      run.status = "completed";
      run.endedAt = this.clock().toISOString();
      this.service.store.finishMaintenanceRun(run);
      return run;
    } catch (error) {
      run.status = "failed";
      run.endedAt = this.clock().toISOString();
      run.error = safeError(error);
      this.service.store.finishMaintenanceRun(run);
      throw new MaintenanceError("MAINTENANCE_FAILED", "维护任务失败；未执行高风险动作", 500, run);
    } finally {
      this.running = false;
    }
  }

  start(intervalMs = 6 * 60 * 60 * 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.run();
      } catch {
        // The failed run is persisted; health surfaces it without weakening safety gates.
      }
    }, Math.max(60_000, intervalMs));
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private removeTemporaryFiles(nowMs: number): number {
    if (!existsSync(this.backupRoot)) return 0;
    let removed = 0;
    for (const name of readdirSync(this.backupRoot)) {
      if (!name.startsWith(".") || !name.endsWith(".tmp")) continue;
      const path = join(this.backupRoot, name);
      try {
        const age = nowMs - statSync(path).mtimeMs;
        if (age < DEFAULT_TEMP_FILE_TTL_MS) continue;
        unlinkSync(path);
        removed += 1;
      } catch {
        continue;
      }
    }
    return removed;
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z]:\\[^\s]+/g, "<local-path>").slice(0, 500);
}


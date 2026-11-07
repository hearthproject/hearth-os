import { statfsSync, statSync } from "node:fs";
import type { HealthSnapshot } from "@hearth/core";
import type { ExecutorSettings } from "@hearth/core";
import { CURRENT_SCHEMA_VERSION } from "@hearth/eventlog";
import { loadCodexProfile, type CodexProfile } from "@hearth/codex-executor";
import { loadExecutorSettings } from "./executor-settings.ts";
import { hermesHealth } from "./hermes-health.ts";
import type { HearthService } from "./service.ts";

const LOW_DISK_BYTES = 256 * 1024 * 1024;

export interface HealthServiceOptions {
  service: HearthService;
  startedAt: string;
  dataDir: string;
  dbPath: string;
  schedulerEnabled: boolean;
  schedulerRunning: () => boolean;
  executorSettingsPath: string;
  executorSettingsProvider?: (() => ExecutorSettings) | undefined;
  codexProfile?: (() => CodexProfile) | undefined;
  clock?: () => Date;
}

export class HealthService {
  private readonly service: HearthService;
  private readonly startedAt: string;
  private readonly dataDir: string;
  private readonly dbPath: string;
  private readonly schedulerEnabled: boolean;
  private readonly schedulerRunning: () => boolean;
  private readonly executorSettingsPath: string;
  private readonly executorSettingsProvider: (() => ExecutorSettings) | null;
  private readonly codexProfile: (() => CodexProfile) | null;
  private readonly clock: () => Date;

  constructor(options: HealthServiceOptions) {
    this.service = options.service;
    this.startedAt = options.startedAt;
    this.dataDir = options.dataDir;
    this.dbPath = options.dbPath;
    this.schedulerEnabled = options.schedulerEnabled;
    this.schedulerRunning = options.schedulerRunning;
    this.executorSettingsPath = options.executorSettingsPath;
    this.executorSettingsProvider = options.executorSettingsProvider ?? null;
    this.codexProfile = options.codexProfile ?? null;
    this.clock = options.clock ?? (() => new Date());
  }

  snapshot(): HealthSnapshot {
    const now = this.clock();
    const profile = this.codexProfile?.() ?? loadCodexProfile();
    const executorSettings = this.executorSettingsProvider?.() ?? loadExecutorSettings(this.executorSettingsPath);
    const hermes = hermesHealth(executorSettings.hermesCommand);
    const memory = process.memoryUsage();
    const taskCounts = this.service.store.countTasksByStatus();
    const latestMaintenance = this.service.store.latestMaintenanceRun();
    const schemaVersion = this.service.store.getAppMeta().schemaVersion;
    const freeBytes = diskFreeBytes(this.dataDir);
    const issues: string[] = [];
    if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
      issues.push(`数据库 schema ${schemaVersion} 与运行时 ${CURRENT_SCHEMA_VERSION} 不一致`);
    }
    if (latestMaintenance?.status === "failed") {
      issues.push(latestMaintenance.error ?? "最近一次维护失败");
    }
    if (freeBytes !== null && freeBytes < LOW_DISK_BYTES) {
      issues.push("本机可用磁盘空间低于 256 MB");
    }
    return {
      status: issues.length > 0 ? "degraded" : "ok",
      name: "Hearth",
      now: now.toISOString(),
      startedAt: this.startedAt,
      uptimeSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(this.startedAt)) / 1000)),
      schemaVersion,
      instanceId: this.service.store.instanceId,
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal
      },
      disk: {
        freeBytes,
        dataBytes: fileBytes(this.dbPath),
        walBytes: fileBytes(`${this.dbPath}-wal`)
      },
      tasks: {
        total: Object.values(taskCounts).reduce((sum, count) => sum + count, 0),
        queued: taskCounts.queued,
        running: taskCounts.running,
        recoverable: taskCounts.recoverable,
        waitingApproval: taskCounts.waiting_approval
      },
      maintenance: {
        lastRunAt: latestMaintenance?.endedAt ?? latestMaintenance?.startedAt ?? null,
        lastStatus: latestMaintenance?.status ?? null,
        lastError: latestMaintenance?.error ?? null
      },
      scheduler: {
        enabled: this.schedulerEnabled,
        running: this.schedulerRunning()
      },
      security: {
        killSwitch: this.service.store.getMeta("security.killSwitch")?.includes('"killSwitch":true') ?? false
      },
      issues,
      codex: {
        canRun: profile.canRun,
        providerId: profile.providerId,
        providerName: profile.providerName,
        model: profile.model,
        authSource: profile.authSource,
        envKeySource: profile.envKeySource,
        issues: profile.issues
      },
      hermes
    };
  }
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function diskFreeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}


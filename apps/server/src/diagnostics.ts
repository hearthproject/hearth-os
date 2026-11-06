import { existsSync } from "node:fs";
import type { HealthService } from "./health.ts";
import type { MaintenanceService } from "./maintenance.ts";
import type { HearthService } from "./service.ts";

export interface DiagnosticsServiceOptions {
  service: HearthService;
  health: HealthService;
  maintenance: MaintenanceService;
  webDist: string;
  clock?: () => Date;
}

export interface DiagnosticsSnapshot {
  format: "hearth-diagnostics";
  version: 1;
  generatedAt: string;
  health: ReturnType<HealthService["snapshot"]>;
  maintenance: ReturnType<MaintenanceService["snapshot"]>;
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
    pid: number;
  };
  counts: {
    events: number;
    tasks: number;
    runs: number;
    approvals: number;
    artifacts: number;
    memories: number;
    methods: number;
  };
  eventTypes: Array<{ type: string; total: number }>;
  checks: {
    webBuildPresent: boolean;
    localOnlyHost: boolean;
    encryptedBackupOnly: boolean;
  };
}

export class DiagnosticsService {
  private readonly service: HearthService;
  private readonly health: HealthService;
  private readonly maintenance: MaintenanceService;
  private readonly webDist: string;
  private readonly clock: () => Date;

  constructor(options: DiagnosticsServiceOptions) {
    this.service = options.service;
    this.health = options.health;
    this.maintenance = options.maintenance;
    this.webDist = options.webDist;
    this.clock = options.clock ?? (() => new Date());
  }

  snapshot(): DiagnosticsSnapshot {
    const db = this.service.store.db;
    const count = (table: string) => Number(
      (db.prepare(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)}`).get() as { total?: number }).total ?? 0
    );
    const eventTypes = (db.prepare(
      "SELECT type, COUNT(*) AS total FROM events GROUP BY type ORDER BY total DESC, type ASC LIMIT 30"
    ).all() as Array<{ type: string; total: number }>).map((row) => ({
      type: String(row.type),
      total: Number(row.total)
    }));
    return {
      format: "hearth-diagnostics",
      version: 1,
      generatedAt: this.clock().toISOString(),
      health: this.health.snapshot(),
      maintenance: this.maintenance.snapshot(10),
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid
      },
      counts: {
        events: count("events"),
        tasks: count("tasks"),
        runs: count("runs"),
        approvals: count("approvals"),
        artifacts: count("artifacts"),
        memories: count("memories"),
        methods: count("method_candidates")
      },
      eventTypes,
      checks: {
        webBuildPresent: existsSync(this.webDist),
        localOnlyHost: true,
        encryptedBackupOnly: true
      }
    };
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}


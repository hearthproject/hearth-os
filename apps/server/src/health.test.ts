import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HearthStore } from "@hearth/eventlog";
import { HealthService } from "./health.ts";
import { HearthService } from "./service.ts";

describe("health snapshot", () => {
  let root: string;
  let store: HearthStore;
  let service: HearthService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-health-"));
    store = new HearthStore(":memory:");
    service = new HearthService(store);
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reports runtime, storage, task and scheduler state without secrets", () => {
    service.createTask({ title: "health-task", goal: "check" });
    const health = new HealthService({
      service,
      startedAt: new Date(Date.now() - 90_000).toISOString(),
      dataDir: root,
      dbPath: join(root, "hearth.sqlite"),
      schedulerEnabled: true,
      schedulerRunning: () => true
    }).snapshot();

    expect(health).toMatchObject({
      status: "ok",
      name: "Hearth",
      schemaVersion: 3,
      instanceId: store.instanceId,
      tasks: { total: 1, queued: 1, running: 0, recoverable: 0, waitingApproval: 0 },
      scheduler: { enabled: true, running: true },
      security: { killSwitch: false }
    });
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(89);
    expect(health.memory.rssBytes).toBeGreaterThan(0);
    expect(health.disk.freeBytes).not.toBeNull();
    expect(JSON.stringify(health)).not.toContain("OPENAI_API_KEY");
  });

  it("degrades when the latest maintenance run failed", () => {
    store.createMaintenanceRun({
      id: "failed-run",
      startedAt: "2026-11-06T00:00:00.000Z",
      endedAt: "2026-11-06T00:00:01.000Z",
      status: "failed",
      actions: {},
      error: "cleanup failed"
    });
    const health = new HealthService({
      service,
      startedAt: new Date().toISOString(),
      dataDir: root,
      dbPath: join(root, "hearth.sqlite"),
      schedulerEnabled: false,
      schedulerRunning: () => false
    }).snapshot();
    expect(health.status).toBe("degraded");
    expect(health.issues).toContain("cleanup failed");
    expect(health.maintenance.lastStatus).toBe("failed");
  });
});


import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";

describe("operations API", () => {
  let root: string;
  let store: HearthStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-operations-"));
    store = new HearthStore(":memory:");
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("exposes health, maintenance and redacted diagnostics", async () => {
    process.env.HEARTH_DIAGNOSTICS_TEST_SECRET = "must-never-appear";
    const app = await buildServer({
      store,
      serveWeb: false,
      backupRoot: join(root, "backups"),
      masterKeyPath: join(root, "master.key"),
      dataDir: root,
      dbPath: join(root, "hearth.sqlite")
    });
    try {
      await app.inject({ method: "POST", url: "/api/tasks", payload: { title: "health-api" } });
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({
        status: "ok",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        tasks: { total: 1 },
        scheduler: { enabled: false, running: false }
      });
      expect(health.json().uptimeSeconds).toBeGreaterThanOrEqual(0);

      const maintenance = await app.inject({ method: "POST", url: "/api/maintenance/run" });
      expect(maintenance.statusCode).toBe(200);
      expect(maintenance.json()).toMatchObject({ status: "completed", error: null });
      expect(maintenance.json().actions.tasksRecovered).toBe(0);

      const snapshot = await app.inject({ method: "GET", url: "/api/maintenance" });
      expect(snapshot.json().latest.status).toBe("completed");
      expect(snapshot.json().runs).toHaveLength(1);

      const healthAfter = await app.inject({ method: "GET", url: "/api/health" });
      expect(healthAfter.json().maintenance.lastStatus).toBe("completed");

      const diagnostics = await app.inject({ method: "GET", url: "/api/diagnostics" });
      expect(diagnostics.statusCode).toBe(200);
      expect(diagnostics.headers["content-disposition"]).toContain("hearth-diagnostics-");
      expect(diagnostics.json()).toMatchObject({
        format: "hearth-diagnostics",
        version: 1,
        counts: { tasks: 1 },
        checks: { encryptedBackupOnly: true }
      });
      expect(diagnostics.body).not.toContain(process.env.HEARTH_DIAGNOSTICS_TEST_SECRET);
      expect(diagnostics.body).not.toContain(root);
    } finally {
      delete process.env.HEARTH_DIAGNOSTICS_TEST_SECRET;
      await app.close();
    }
  });
});


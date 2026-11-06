import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";

const PASSPHRASE = "local encryption passphrase";

describe("backup API", () => {
  let root: string;
  let store: HearthStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-backup-api-"));
    store = new HearthStore(":memory:");
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates, downloads and restores an encrypted archive", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      backupRoot: join(root, "backups"),
      masterKeyPath: join(root, "master.key")
    });
    try {
      const first = await app.inject({ method: "POST", url: "/api/tasks", payload: { title: "backup-before", goal: "keep" } });
      expect(first.statusCode).toBe(201);
      const created = await app.inject({ method: "POST", url: "/api/backups", payload: { passphrase: PASSPHRASE } });
      expect(created.statusCode).toBe(201);
      const record = created.json();
      expect(record.kind).toBe("encrypted-database");

      const list = await app.inject({ method: "GET", url: "/api/backups" });
      expect(list.statusCode).toBe(200);
      expect(list.json().records).toHaveLength(1);
      expect(list.json().scope.excludes.length).toBeGreaterThan(0);
      expect(JSON.stringify(list.json())).not.toContain(root);

      const download = await app.inject({ method: "GET", url: `/api/backups/${record.id}/download` });
      expect(download.statusCode).toBe(200);
      expect(download.headers["content-type"]).toContain("application/vnd.hearth.backup+json");
      expect(download.body).not.toContain("backup-before");
      const envelope = download.body;

      const second = await app.inject({ method: "POST", url: "/api/tasks", payload: { title: "backup-after", goal: "remove" } });
      expect(second.statusCode).toBe(201);

      const restored = await app.inject({
        method: "POST",
        url: `/api/backups/${record.id}/restore`,
        payload: { passphrase: PASSPHRASE }
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().counts.tasks).toBe(1);
      expect(restored.json().warnings).toEqual(expect.arrayContaining([expect.stringContaining("产物正文")]));

      const tasks = await app.inject({ method: "GET", url: "/api/tasks" });
      expect(tasks.json().tasks.map((task: { title: string }) => task.title)).toEqual(["backup-before"]);

      const upload = await app.inject({
        method: "POST",
        url: "/api/backups/restore",
        payload: { passphrase: PASSPHRASE, envelope }
      });
      expect(upload.statusCode).toBe(200);

      const legacy = await app.inject({ method: "GET", url: "/api/backup" });
      expect(legacy.statusCode).toBe(410);
      expect(legacy.json().error).toBe("ENCRYPTED_BACKUP_REQUIRED");
    } finally {
      await app.close();
    }
  });

  it("does not mutate data when the restore passphrase is wrong", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      backupRoot: join(root, "backups"),
      masterKeyPath: join(root, "master.key")
    });
    try {
      await app.inject({ method: "POST", url: "/api/tasks", payload: { title: "kept" } });
      const record = (await app.inject({ method: "POST", url: "/api/backups", payload: { passphrase: PASSPHRASE } })).json();
      const failed = await app.inject({
        method: "POST",
        url: `/api/backups/${record.id}/restore`,
        payload: { passphrase: "this passphrase is incorrect" }
      });
      expect(failed.statusCode).toBe(401);
      expect(failed.json().error).toBe("BACKUP_DECRYPT_FAILED");
      const tasks = await app.inject({ method: "GET", url: "/api/tasks" });
      expect(tasks.json().tasks).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});


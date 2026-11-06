import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { BackupService } from "./backups.ts";
import { HearthService } from "./service.ts";

const PASSPHRASE = "correct horse battery staple";

describe("encrypted backups", () => {
  let root: string;
  let store: HearthStore;
  let service: HearthService;
  let backups: BackupService;
  let keyPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-backup-test-"));
    keyPath = join(root, "master.key");
    writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    backups = new BackupService({ service, backupRoot: join(root, "backups"), masterKeyPath: keyPath });
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("encrypts the database and restores it with rollback-safe validation", () => {
    const before = service.createTask({ title: "before-backup", goal: "keep this task" });
    const record = backups.create(PASSPHRASE);
    const serialized = readFileSync(record.path, "utf8");
    expect(JSON.parse(serialized)).toMatchObject({ format: "hearth-backup", version: 1, cipher: "aes-256-gcm" });
    expect(serialized).not.toContain("before-backup");
    expect(serialized).not.toContain(Buffer.alloc(32, 7).toString("base64"));

    const after = service.createTask({ title: "after-backup", goal: "must disappear on restore" });
    expect(() => backups.restoreRecord(record.id, "not-the-right-passphrase")).toThrow("口令不正确");
    expect(store.getTask(after.id)).not.toBeNull();

    writeFileSync(keyPath, randomBytes(32));
    const result = backups.restoreRecord(record.id, PASSPHRASE);
    expect(result.counts.tasks).toBe(1);
    expect(result.masterKeyRestored).toBe(true);
    expect(store.listTasks().map((task) => task.id)).toEqual([before.id]);
    expect(store.getTask(after.id)).toBeNull();
    expect(readFileSync(keyPath)).toEqual(Buffer.alloc(32, 7));
  });

  it("rejects short passphrases and keeps backups out of the event stream", () => {
    expect(() => backups.create("short")).toThrow("至少需要 12 个字符");
    const record = backups.create(PASSPHRASE);
    expect(backups.snapshot().records).toHaveLength(1);
    expect(record.kind).toBe("encrypted-database");
    expect(store.countEvents(undefined, "backup.created")).toBe(0);
  });
});


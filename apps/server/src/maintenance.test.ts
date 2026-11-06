import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRecord } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { ApprovalManager } from "./approvals.ts";
import { MaintenanceService } from "./maintenance.ts";
import { HearthService } from "./service.ts";

describe("maintenance", () => {
  let root: string;
  let frameRoot: string;
  let backupRoot: string;
  let store: HearthStore;
  let service: HearthService;
  let maintenance: MaintenanceService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-maintenance-"));
    frameRoot = join(root, "frames");
    backupRoot = join(root, "backups");
    mkdirSync(frameRoot, { recursive: true });
    mkdirSync(backupRoot, { recursive: true });
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    const approvals = new ApprovalManager(service, async () => ({}));
    maintenance = new MaintenanceService({ service, approvals, backupRoot, deviceFrameRoot: frameRoot });
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("cleans only expired operational state and records every action", () => {
    const task = service.createTask({ title: "keep-me", goal: "must survive maintenance" });
    service.updateTask(task.id, { status: "running" });
    service.updateTask(task.id, { status: "waiting_approval" });
    const approval: ApprovalRecord = {
      id: "approval-expired",
      taskId: task.id,
      runId: "run-expired",
      kind: "outbox.local-write",
      summary: "expired",
      target: {},
      preview: {},
      parameterHash: "a".repeat(64),
      status: "pending",
      expiresAt: "2026-01-01T00:00:00.000Z",
      decidedAt: null,
      effectId: null,
      createdAt: "2025-12-01T00:00:00.000Z"
    };
    service.createApproval(approval);

    const db = store.db;
    db.prepare(
      "INSERT INTO task_leases (task_id, owner_instance_id, owner_device_id, epoch, expires_at, heartbeat_at, created_at, updated_at) VALUES (?, ?, NULL, 1, ?, ?, ?, ?)"
    ).run(task.id, "old-instance", "2026-01-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO pairing_requests (id, code, secret_hash, device_token_hash, name, platform, version, requested_apps_json, requested_capabilities_json, status, device_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)"
    ).run("pair-old", "123456", "secret", "token", "old", "windows", "1", "[]", "[]", "2026-01-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO desktop_sessions (id, device_id, status, control_epoch, current_frame_id, last_error, created_at, updated_at, terminated_at) VALUES ('session-1', 'device-1', 'active', 1, 'frame-1', NULL, ?, ?, NULL)"
    ).run("2025-12-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z");
    const framePath = join(frameRoot, "old.png");
    writeFileSync(framePath, "old screenshot");
    db.prepare(
      "INSERT INTO desktop_frames (id, device_id, session_id, mime_type, width, height, sha256, bytes, storage_path, active_app, window_title, captured_at, expires_at) VALUES ('frame-1', 'device-1', 'session-1', 'image/png', 1, 1, ?, 13, ?, 'app', 'title', ?, ?)"
    ).run("b".repeat(64), framePath, "2025-12-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO desktop_commands (id, device_id, session_id, kind, status, frame_id, control_epoch, payload_json, result_json, error, created_at, updated_at, completed_at) VALUES ('command-1', 'device-1', 'session-1', 'click', 'claimed', 'frame-1', 1, '{}', NULL, NULL, ?, ?, NULL)"
    ).run("2025-12-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z");
    const temporaryPath = join(backupRoot, ".stale.tmp");
    writeFileSync(temporaryPath, "stale");
    const old = new Date("2025-12-01T00:00:00.000Z");
    utimesSync(temporaryPath, old, old);

    const run = maintenance.run();
    expect(run.status).toBe("completed");
    expect(run.actions).toMatchObject({
      approvalsExpired: 1,
      tasksRecovered: 1,
      leasesExpired: 1,
      commandsExpired: 1,
      framesExpired: 1,
      frameFilesRemoved: 1,
      pairingsExpired: 1,
      temporaryFilesRemoved: 1
    });
    expect(store.getTask(task.id)?.status).toBe("recoverable");
    expect(store.getTask(task.id)?.title).toBe("keep-me");
    expect(store.getApproval(approval.id)?.status).toBe("expired");
    expect(db.prepare("SELECT COUNT(*) AS total FROM task_leases").get()).toMatchObject({ total: 0 });
    expect(db.prepare("SELECT COUNT(*) AS total FROM desktop_frames").get()).toMatchObject({ total: 0 });
    expect(db.prepare("SELECT status FROM desktop_commands WHERE id = 'command-1'").get()).toMatchObject({ status: "expired" });
    expect(db.prepare("SELECT status FROM pairing_requests WHERE id = 'pair-old'").get()).toMatchObject({ status: "expired" });
    expect(db.prepare("SELECT current_frame_id FROM desktop_sessions WHERE id = 'session-1'").get()).toMatchObject({ current_frame_id: null });
    expect(existsSync(framePath)).toBe(false);
    expect(existsSync(temporaryPath)).toBe(false);
    expect(maintenance.snapshot().latest?.id).toBe(run.id);
  });
});


import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeviceCapability, DeviceRecord } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { ConnectionError, ConnectionService } from "./connections.ts";
import { HearthService } from "./service.ts";

describe("connection runtime", () => {
  let store: HearthStore;
  let service: HearthService;
  let connections: ConnectionService;
  let now: Date;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    now = new Date("2026-11-10T02:00:00.000Z");
    connections = new ConnectionService({
      service,
      now: () => now,
      heartbeatTimeoutMs: 5_000,
      sessionTtlMs: 60_000,
      cacheTtlMs: 60_000
    });
  });

  afterEach(() => store.close());

  it("keeps transport, subscription, and freshness separate and never calls cache live", () => {
    const connected = connections.connect({ deviceId: "local:test", userId: "u1", scopes: ["tasks"] });
    expect(connected).toMatchObject({
      generation: 1,
      transport: "connected",
      subscription: "live",
      dataFreshness: "current",
      sourceCursor: 0,
      latestCursor: 0
    });

    service.createTask({ title: "离线前任务", goal: "验证缓存不会冒充实时" });
    const stale = connections.status(connected.connectionId);
    expect(stale.transport).toBe("connected");
    expect(stale.subscription).toBe("catching_up");
    expect(stale.dataFreshness).toBe("cached");
    expect(stale.latestCursor).toBeGreaterThan(stale.sourceCursor);

    const projection = connections.projection<Array<{ id: string }>>(connected.connectionId, "tasks", 1);
    expect(projection.cached).toBe(true);
    expect(projection.dataFreshness).toBe("cached");
    expect(projection.asOf).toBeTruthy();
    expect(projection.sourceCursor).toBe(0);
    expect(projection.data).toHaveLength(1);
    expect(() => connections.projection(connected.connectionId, "tasks", 99)).toThrowError(
      expect.objectContaining({ code: "CONNECTION_GENERATION_STALE" })
    );

    now = new Date(now.getTime() + 6_000);
    const failed = connections.status(connected.connectionId);
    expect(failed.transport).toBe("failed");
    expect(failed.subscription).toBe("failed");
    expect(failed.dataFreshness).toBe("cached");
    expect(failed.lastError).toContain("心跳");

    now = new Date("2026-11-10T02:00:00.000Z");
    const plan = connections.reconnect(connected.connectionId, { generation: 1 });
    expect(plan).toMatchObject({ generation: 2, pulledEvents: 1, staleItems: 0 });
    expect(plan.sourceCursor).toBe(plan.latestCursor);
    const live = connections.status(connected.connectionId);
    expect(live).toMatchObject({ transport: "connected", subscription: "live", dataFreshness: "current" });
    expect(connections.projection(connected.connectionId, "tasks", 2).cached).toBe(false);
  });

  it("writes offline operations to outbox only, rejects stale generations, and commits after an explicit replay decision", () => {
    const task = service.createTask({ title: "跟进任务", goal: "验证离线 outbox" });
    const connected = connections.connect({ deviceId: "local:test", userId: "u1" });
    const offline = connections.disconnect(connected.connectionId, 1, "offline");
    expect(offline).toMatchObject({ transport: "disconnected", subscription: "stale", lastError: null });
    expect(offline.session.disconnectReason).toBe("offline");
    const item = connections.enqueue(connected.connectionId, {
      generation: 1,
      scope: "tasks",
      kind: "task.follow-up",
      idempotencyKey: "offline-follow-up-1",
      payload: { taskId: task.id, content: "离线补充要求", mode: "queue" }
    });
    expect(item.status).toBe("queued");
    expect(store.listTaskFollowUps(task.id)).toHaveLength(0);

    const plan = connections.reconnect(connected.connectionId, { generation: 1, scopes: [] });
    expect(plan).toMatchObject({ generation: 2, staleItems: 1 });
    expect(plan.items).toHaveLength(0);
    expect(store.listTaskFollowUps(task.id)).toHaveLength(0);
    expect(store.getConnectionOutboxItem(item.id)?.status).toBe("conflict");
    expect(() => connections.submit(connected.connectionId, item.id, 1)).toThrowError(
      expect.objectContaining({ code: "CONNECTION_GENERATION_STALE" })
    );
    expect(() => connections.submit(connected.connectionId, item.id, 2)).toThrowError(
      expect.objectContaining({ code: "CONNECTION_GENERATION_STALE" })
    );

    const queued = connections.enqueue(connected.connectionId, {
      generation: 2,
      scope: "tasks",
      kind: "task.follow-up",
      idempotencyKey: "online-follow-up-2",
      payload: { taskId: task.id, content: "重新确认后的要求", mode: "steer" }
    });
    const duplicate = connections.enqueue(connected.connectionId, {
      generation: 2,
      scope: "tasks",
      kind: "task.follow-up",
      idempotencyKey: "online-follow-up-2",
      payload: { taskId: task.id, content: "不应重复写入", mode: "queue" }
    });
    expect(duplicate.id).toBe(queued.id);
    const submitted = connections.submit(connected.connectionId, queued.id, 2);
    expect(submitted).toMatchObject({ status: "committed" });
    expect(submitted.result).toHaveProperty("followUpId");
    expect(store.listTaskFollowUps(task.id)).toHaveLength(1);
    expect(connections.submit(connected.connectionId, queued.id, 2).committedAt).toBe(submitted.committedAt);
  });

  it("marks remote actions uncertain after disconnect and reconciles them explicitly", () => {
    const connected = connections.connect({ deviceId: "local:remote", userId: "u1" });
    connections.disconnect(connected.connectionId, 1, "network lost");
    const item = connections.enqueue(connected.connectionId, {
      generation: 1,
      scope: "remote.execution",
      kind: "remote.action",
      idempotencyKey: "remote-action-0001",
      payload: { command: "restart-worker" }
    });
    expect(item.status).toBe("uncertain");
    expect(item.error).toContain("回执");
    const resolved = connections.resolveOutbox(connected.connectionId, item.id, {
      generation: 1,
      status: "committed",
      result: { receipt: "worker-restarted" }
    });
    expect(resolved.status).toBe("committed");
    expect(resolved.result).toEqual({ receipt: "worker-restarted" });
  });

  it("requires a new approval for device scope escalation and stops a revoked device immediately", () => {
    const device = makeDevice("approved");
    service.createDevice(device);
    const connected = connections.connect({
      deviceId: device.id,
      userId: "u1",
      scopes: ["observe", "desktop.control"]
    });
    expect(connected.session.scopes).toEqual(["observe"]);
    expect(connected.pendingScopes).toEqual(["desktop.control"]);
    expect(connected.scopeApprovalRequired).toBe(true);

    expect(() => connections.approveScopes(connected.connectionId, ["desktop.control"])).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_APPROVAL_REQUIRED" })
    );
    const approvedDevice = service.updateDevice({
      ...device,
      capabilities: device.capabilities.map((capability) =>
        capability.kind === "desktop.control" ? { ...capability, status: "approved", approvedAt: now.toISOString() } : capability
      ),
      updatedAt: now.toISOString()
    });
    const approved = connections.approveScopes(connected.connectionId, ["desktop.control"]);
    expect(approved.session.scopes).toEqual(["observe", "desktop.control"]);
    expect(approved.pendingScopes).toEqual([]);

    service.updateDevice({
      ...approvedDevice,
      status: "revoked",
      capabilities: approvedDevice.capabilities.map((capability) => ({ ...capability, status: "revoked", revokedAt: now.toISOString() })),
      updatedAt: now.toISOString()
    });
    expect(() => connections.enqueue(connected.connectionId, {
      generation: approved.generation,
      scope: "observe",
      kind: "client.note",
      idempotencyKey: "revoked-device-1",
      payload: {}
    })).toThrowError(expect.objectContaining({ code: "DEVICE_REVOKED" }));
    expect(() => connections.projection(connected.connectionId, "tasks", approved.generation)).toThrowError(
      expect.objectContaining({ code: "DEVICE_REVOKED" })
    );
    expect(connections.status(connected.connectionId)).toMatchObject({ transport: "failed", subscription: "failed" });
  });
});

function makeDevice(capabilityStatus: DeviceCapability["status"]): DeviceRecord {
  const now = "2026-11-10T02:00:00.000Z";
  const capabilities: DeviceCapability[] = [
    {
      kind: "observe", status: capabilityStatus, apps: ["notepad"], requestedAt: now,
      approvedAt: capabilityStatus === "approved" ? now : null, revokedAt: null
    },
    {
      kind: "desktop.control", status: "pending", apps: ["notepad"], requestedAt: now,
      approvedAt: null, revokedAt: null
    }
  ];
  return {
    id: "DEVICE-1",
    pairingRequestId: "PAIR-1",
    name: "Workstation",
    platform: "windows",
    version: "1.0.0",
    status: "online",
    tokenHash: "hash",
    capabilities,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now
  };
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";

describe("connection runtime API", () => {
  let store: HearthStore;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    store = new HearthStore(":memory:");
    app = await buildServer({ store, serveWeb: false });
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  it("exposes status, heartbeat, cached projections, and an explicit offline outbox", async () => {
    const connected = await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { deviceId: "local:api", userId: "user-1" }
    });
    expect(connected.statusCode).toBe(201);
    const session = connected.json();
    const connectionId = session.connectionId as string;
    expect(session).toMatchObject({
      generation: 1,
      transport: "connected",
      subscription: "live",
      dataFreshness: "current"
    });

    const taskResponse = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "连接测试任务", goal: "验证连接 API 和离线投影" }
    });
    expect(taskResponse.statusCode).toBe(201);
    const task = taskResponse.json() as { id: string };

    const status = await app.inject({ method: "GET", url: `/api/connections/${connectionId}/status` });
    expect(status.statusCode).toBe(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.json()).toMatchObject({ transport: "connected", subscription: "catching_up", dataFreshness: "cached" });

    const heartbeat = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/heartbeat`,
      payload: { generation: 1 }
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json().transport).toBe("connected");

    const projection = await app.inject({
      method: "GET",
      url: `/api/connections/${connectionId}/projection?scope=tasks&generation=1`
    });
    expect(projection.statusCode).toBe(200);
    expect(projection.json()).toMatchObject({ cached: true, dataFreshness: "cached", sourceCursor: 0 });
    expect(projection.json().data).toHaveLength(1);

    const disconnected = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/disconnect`,
      payload: { generation: 1, reason: "offline" }
    });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json()).toMatchObject({
      transport: "disconnected",
      subscription: "stale",
      lastError: null,
      session: { disconnectReason: "offline" }
    });

    const queued = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/outbox`,
      payload: {
        generation: 1,
        scope: "tasks",
        kind: "task.follow-up",
        idempotencyKey: "api-offline-0001",
        payload: { taskId: task.id, content: "离线补充要求", mode: "queue" }
      }
    });
    expect(queued.statusCode).toBe(201);
    expect(queued.json().status).toBe("queued");

    const replay = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/reconnect`,
      payload: { generation: 1, scopes: [] }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ generation: 2, staleItems: 1, items: [] });
    expect(replay.json().sourceCursor).toBe(replay.json().latestCursor);

    const liveProjection = await app.inject({
      method: "GET",
      url: `/api/connections/${connectionId}/projection?scope=tasks&generation=2`
    });
    expect(liveProjection.statusCode).toBe(200);
    expect(liveProjection.json()).toMatchObject({ cached: false, dataFreshness: "current" });

    const stale = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/outbox/${queued.json().id}/submit`,
      payload: { generation: 1 }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("CONNECTION_GENERATION_STALE");

    const staleHeartbeat = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/heartbeat`,
      payload: { generation: 1 }
    });
    expect(staleHeartbeat.statusCode).toBe(409);
    expect(staleHeartbeat.json().error).toBe("CONNECTION_GENERATION_STALE");

    const replacement = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/outbox`,
      payload: {
        generation: 2,
        scope: "tasks",
        kind: "task.follow-up",
        idempotencyKey: "api-replacement-0002",
        payload: { taskId: task.id, content: "重新确认后的要求", mode: "steer" }
      }
    });
    expect(replacement.statusCode).toBe(201);
    const replacementId = replacement.json().id as string;

    const submitted = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/outbox/${replacementId}/submit`,
      payload: { generation: 2 }
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({ status: "committed" });
    expect(submitted.json().result).toHaveProperty("followUpId");

    const outbox = await app.inject({ method: "GET", url: `/api/connections/${connectionId}/outbox` });
    expect(outbox.statusCode).toBe(200);
    expect(outbox.json().items.map((item: { status: string }) => item.status)).toEqual(["conflict", "committed"]);

    const afterCommit = await app.inject({
      method: "GET",
      url: `/api/connections/${connectionId}/projection?scope=tasks&generation=2`
    });
    expect(afterCommit.statusCode).toBe(200);
    expect(afterCommit.json()).toMatchObject({ cached: true, dataFreshness: "cached" });

    const remoteOffline = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/disconnect`,
      payload: { generation: 2, reason: "network lost" }
    });
    expect(remoteOffline.statusCode).toBe(200);
    expect(remoteOffline.json().transport).toBe("disconnected");

    const remoteAction = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/outbox`,
      payload: {
        generation: 2,
        scope: "remote.execution",
        kind: "remote.action",
        idempotencyKey: "api-remote-action-0003",
        payload: { command: "restart-worker" }
      }
    });
    expect(remoteAction.statusCode).toBe(201);
    expect(remoteAction.json()).toMatchObject({ status: "uncertain" });

    const resolved = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/outbox/${remoteAction.json().id}/resolve`,
      payload: { generation: 2, status: "committed", result: { receipt: "worker-restarted" } }
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ status: "committed", result: { receipt: "worker-restarted" } });

    const missing = await app.inject({ method: "GET", url: "/api/connections/CONN-missing/status" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("CONNECTION_NOT_FOUND");
  });

  it("requires capability approval before scope escalation and fails closed after revocation", async () => {
    const pairingResponse = await app.inject({
      method: "POST",
      url: "/api/device-pairings",
      payload: {
        name: "Connection API workstation",
        version: "1.0.0",
        deviceToken: "c".repeat(43),
        apps: ["notepad"],
        capabilities: ["observe", "desktop.control"]
      }
    });
    expect(pairingResponse.statusCode).toBe(201);
    const pairing = pairingResponse.json();
    const approvedPairing = await app.inject({
      method: "POST",
      url: `/api/devices/pairing-requests/${pairing.request.id}/approve`
    });
    expect(approvedPairing.statusCode).toBe(200);
    const deviceId = approvedPairing.json().id as string;

    const observe = await app.inject({
      method: "POST",
      url: `/api/devices/${deviceId}/capabilities/observe/approve`,
      payload: { apps: ["notepad"] }
    });
    expect(observe.statusCode).toBe(200);

    const connected = await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { deviceId, userId: "user-1", scopes: ["observe", "desktop.control"] }
    });
    expect(connected.statusCode).toBe(201);
    const connectionId = connected.json().connectionId as string;
    expect(connected.json()).toMatchObject({
      pendingScopes: ["desktop.control"],
      scopeApprovalRequired: true,
      session: { scopes: ["observe"] }
    });

    const blocked = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/scopes`,
      payload: { scopes: ["desktop.control"] }
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("CAPABILITY_APPROVAL_REQUIRED");

    const control = await app.inject({
      method: "POST",
      url: `/api/devices/${deviceId}/capabilities/desktop.control/approve`,
      payload: { apps: ["notepad"] }
    });
    expect(control.statusCode).toBe(200);

    const approved = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/scopes`,
      payload: { scopes: ["desktop.control"] }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      pendingScopes: [],
      session: { scopes: ["observe", "desktop.control"] }
    });

    const revoked = await app.inject({ method: "POST", url: `/api/devices/${deviceId}/revoke` });
    expect(revoked.statusCode).toBe(200);
    const failed = await app.inject({ method: "GET", url: `/api/connections/${connectionId}/status` });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ transport: "failed", subscription: "failed" });

    const denied = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/outbox`,
      payload: {
        generation: 1,
        scope: "observe",
        kind: "client.note",
        idempotencyKey: "api-revoked-device-0004",
        payload: {}
      }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("DEVICE_REVOKED");
  });
});

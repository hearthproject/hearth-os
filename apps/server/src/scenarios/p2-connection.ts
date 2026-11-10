import { ConnectionService } from "../connections.ts";
import { errorCode } from "./support.ts";
import { result, withHarness } from "./common.ts";
import type { ScenarioHandler } from "./types.ts";

export const p2ConnectionScenarios: Record<string, ScenarioHandler> = {
  "connection-offline-consistency": async (context) => withHarness(async (service, store) => {
    context.clock.set("2026-11-10T02:00:00.000Z");
    const connections = new ConnectionService({
      service,
      now: context.clock.now,
      heartbeatTimeoutMs: 5_000,
      sessionTtlMs: 60_000,
      cacheTtlMs: 60_000
    });
    const task = service.createTask({ title: "离线跟进任务", goal: "验证离线一致性" });
    const connected = connections.connect({
      deviceId: "local:scenario",
      userId: context.fakeUser.id,
      scopes: ["tasks", "remote.execution"]
    });
    const status = connections.status(connected.connectionId);
    const projection = connections.projection<Array<{ id: string }>>(connected.connectionId, "tasks", connected.generation);
    let staleGeneration = false;
    try {
      connections.projection(connected.connectionId, "tasks", connected.generation + 99);
    } catch (error) {
      staleGeneration = errorCode(error) === "CONNECTION_GENERATION_STALE";
    }
    connections.disconnect(connected.connectionId, connected.generation, "offline");
    const offlineItem = connections.enqueue(connected.connectionId, {
      generation: connected.generation,
      scope: "tasks",
      kind: "task.follow-up",
      idempotencyKey: "scenario-offline-follow-up",
      payload: { taskId: task.id, content: "离线补充", mode: "queue" }
    });
    const offlineFollowUpCount = store.listTaskFollowUps(task.id).length;
    const remote = connections.enqueue(connected.connectionId, {
      generation: connected.generation,
      scope: "remote.execution",
      kind: "remote.action",
      idempotencyKey: "scenario-remote-action",
      payload: { command: "restart-worker" }
    });
    const resolvedRemote = connections.resolveOutbox(connected.connectionId, remote.id, {
      generation: connected.generation,
      status: "committed",
      result: { receipt: "worker-restarted" }
    });
    const replay = connections.reconnect(connected.connectionId, { generation: connected.generation });
    const refreshed = connections.projection<Array<{ id: string }>>(connected.connectionId, "tasks", replay.generation);
    const isolated = store.getConnectionOutboxItem(offlineItem.id);
    let oldGenerationRejected = false;
    try {
      connections.submit(connected.connectionId, offlineItem.id, replay.generation);
    } catch (error) {
      oldGenerationRejected = errorCode(error) === "CONNECTION_GENERATION_STALE";
    }
    const queued = connections.enqueue(connected.connectionId, {
      generation: replay.generation,
      scope: "tasks",
      kind: "task.follow-up",
      idempotencyKey: "scenario-online-follow-up",
      payload: { taskId: task.id, content: "重新确认后补充", mode: "steer" }
    });
    const duplicate = connections.enqueue(connected.connectionId, {
      generation: replay.generation,
      scope: "tasks",
      kind: "task.follow-up",
      idempotencyKey: "scenario-online-follow-up",
      payload: { taskId: task.id, content: "不应重复", mode: "queue" }
    });
    const submitted = connections.submit(connected.connectionId, queued.id, replay.generation);
    context.check("cache-not-live", status.dataFreshness === "cached" && projection.cached === true && Boolean(projection.asOf), "缓存投影必须标记 cached/asOf");
    context.check("stale-generation-rejected", staleGeneration, "旧 generation 读取必须拒绝");
    context.check("offline-outbox-only", offlineItem.status === "queued" && offlineFollowUpCount === 0, `outbox 状态=${offlineItem.status}, 离线阶段 follow-up=${offlineFollowUpCount}`);
    context.check("remote-action-uncertain", remote.status === "uncertain" && resolvedRemote.status === "committed", `${remote.status}->${resolvedRemote.status}`);
    context.check("reconnect-isolates-stale", replay.generation === 2 && isolated?.status === "conflict", `generation=${replay.generation}, item=${isolated?.status}`);
    context.check("old-generation-submit-rejected", oldGenerationRejected, "重连后旧 generation 不得提交");
    context.check("duplicate-idempotent", duplicate.id === queued.id && submitted.status === "committed", `duplicate=${duplicate.id}, submitted=${submitted.status}`);
    context.check("single-follow-up", store.listTaskFollowUps(task.id).length === 1, `follow-up 数量=${store.listTaskFollowUps(task.id).length}`);
    context.check("reconnected-live", refreshed.cached === false && refreshed.dataFreshness === "current", `freshness=${refreshed.dataFreshness}`);
    context.record("status", status);
    context.record("projection", projection);
    context.record("replay", replay);
    context.record("offlineItem", offlineItem);
    context.record("remote", resolvedRemote);
    context.record("submitted", submitted);
    context.record("postSubmitFreshness", connections.status(connected.connectionId).dataFreshness);
    return result(context);
  })
};

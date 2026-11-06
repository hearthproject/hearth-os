import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { HearthService } from "./service.ts";
import { MemoryService } from "./memory.ts";
import { SecretBox } from "./secrets.ts";
import { SyncService } from "./sync.ts";

describe("SyncService", () => {
  let remoteStore: HearthStore;
  let localStore: HearthStore;
  let remoteService: HearthService;
  let localService: HearthService;
  let remoteSync: SyncService;
  let localSync: SyncService;

  beforeEach(() => {
    remoteStore = new HearthStore(":memory:");
    localStore = new HearthStore(":memory:");
    remoteService = new HearthService(remoteStore);
    localService = new HearthService(localStore);
    const secretBox = new SecretBox(Buffer.alloc(32, 7));
    remoteSync = new SyncService(remoteService, { secretBox });
    localSync = new SyncService(localService, { secretBox });
  });

  afterEach(() => {
    remoteStore.close();
    localStore.close();
  });

  it("imports event pages incrementally and survives projection rebuild", () => {
    const task = remoteService.createTask({ title: "同步任务", goal: "验证只读副本" });
    remoteService.updateTask(task.id, { status: "running", nextAction: "执行中" });
    remoteService.updateTask(task.id, { status: "completed", nextAction: "完成" });

    const first = remoteSync.exportEvents(0, 2);
    const firstResult = localSync.applyPage(first);
    expect(firstResult.imported).toBe(2);
    expect(first.hasMore).toBe(true);

    const second = remoteSync.exportEvents(first.nextCursor, 10);
    const secondResult = localSync.applyPage(second);
    expect(secondResult.imported).toBeGreaterThan(0);
    expect(localStore.getTask(task.id)?.status).toBe("completed");

    const duplicate = localSync.applyPage(second);
    expect(duplicate.imported).toBe(0);
    expect(duplicate.skipped).toBe(second.events.length);

    localStore.rebuildProjections();
    expect(localStore.getTask(task.id)?.title).toBe("同步任务");
    expect(localStore.getTask(task.id)?.status).toBe("completed");
  });

  it("filters sensitive and secret memory events from the replica", () => {
    const memory = new MemoryService(remoteService);
    for (const [content, sensitivity] of [
      ["普通项目背景", "normal"],
      ["敏感预算信息", "sensitive"],
      ["机密访问令牌", "secret"]
    ] as const) {
      const created = memory.create({
        kind: "project",
        content,
        subjectKey: "project." + sensitivity,
        source: { type: "user", id: null, label: "用户", excerpt: null },
        sensitivity,
        allowRecall: true
      });
      memory.confirm(created.id);
    }

    const page = remoteSync.exportEvents(0, 500);
    const text = JSON.stringify(page);
    expect(text).toContain("普通项目背景");
    expect(text).not.toContain("敏感预算信息");
    expect(text).not.toContain("机密访问令牌");
  });

  it("records a conflict instead of overwriting newer local state", () => {
    const task = remoteService.createTask({ title: "冲突任务", goal: "保留双方来源" });
    localSync.applyPage(remoteSync.exportEvents());
    localService.updateTask(task.id, { nextAction: "本地较新的状态" });
    const remoteUpdate = remoteStore.appendEvent({
      type: "task.updated",
      taskId: task.id,
      payload: { nextAction: "远端较旧的状态" },
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    const page = remoteSync.exportEvents(remoteUpdate.seq - 1, 10);
    const result = localSync.applyPage(page);
    expect(result.conflicts).toBe(1);
    expect(localStore.getTask(task.id)?.nextAction).toBe("本地较新的状态");
    const conflict = localStore.listSyncConflicts("pending")[0];
    expect(conflict?.entityType).toBe("task");

    localSync.resolveConflict(conflict!.id, "remote");
    expect(localStore.getTask(task.id)?.nextAction).toBe("远端较旧的状态");
  });

  it("pulls from an authenticated peer and advances its cursor", async () => {
    const remotePeer = remoteSync.createPeer({ name: "local", baseUrl: "http://127.0.0.1:4318" });
    const localPeer = localSync.createPeer({ name: "remote", baseUrl: "http://127.0.0.1:4318", token: remotePeer.token });
    remoteService.createTask({ title: "从远端拉取", goal: "验证同步" });
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      remoteSync.authenticateInbound(authorization.slice("Bearer ".length));
      const page = remoteSync.exportEvents(Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("limit") ?? 200));
      return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
    };
    localSync = new SyncService(localService, { secretBox: new SecretBox(Buffer.alloc(32, 7)), fetchImpl });

    const remoteTask = remoteService.store.listTasks()[0];
    await localSync.pull(localPeer.peer.id);
    expect(localStore.getTask(remoteTask!.id)?.title).toBe("从远端拉取");
    expect(localStore.getSyncPeer(localPeer.peer.id)?.lastPullSeq).toBeGreaterThan(0);
  });
});

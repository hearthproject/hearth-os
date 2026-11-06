import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { TaskLeaseService } from "./leases.ts";
import { SecretBox } from "./secrets.ts";
import { HearthService } from "./service.ts";
import { SyncService } from "./sync.ts";

describe("task leases", () => {
  let stores: HearthStore[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores = [];
  });

  it("fences an expired owner and requires a new epoch after takeover", () => {
    const store = makeStore();
    const service = new HearthService(store);
    let now = new Date("2026-01-01T00:00:00.000Z");
    const ownerA = new TaskLeaseService(service, { ownerInstanceId: "instance-a", ttlMs: 1_000, clock: () => now });
    const ownerB = new TaskLeaseService(service, { ownerInstanceId: "instance-b", ttlMs: 1_000, clock: () => now });
    const task = service.createTask({ title: "租约任务", goal: "验证 fencing" });

    const first = ownerA.acquire(task.id);
    expect(first.epoch).toBe(1);
    expectLeaseError(() => ownerB.acquire(task.id), "LEASE_HELD");

    now = new Date("2026-01-01T00:00:02.000Z");
    expectLeaseError(() => ownerA.assertHeld(task.id, first.epoch), "LEASE_EXPIRED");
    const second = ownerB.acquire(task.id);
    expect(second.epoch).toBe(2);
    expectLeaseError(() => ownerA.assertHeld(task.id, first.epoch), "LEASE_FENCED");
    expect(ownerA.release(task.id, first.epoch)).toBeNull();
  });

  it("observes another instance through synced lease events", () => {
    const storeA = makeStore();
    const storeB = makeStore();
    const serviceA = new HearthService(storeA);
    const serviceB = new HearthService(storeB);
    const secretBox = new SecretBox(Buffer.alloc(32, 3));
    const syncA = new SyncService(serviceA, { secretBox });
    const syncB = new SyncService(serviceB, { secretBox });
    const ownerA = new TaskLeaseService(serviceA, { ownerInstanceId: "instance-a" });
    const ownerB = new TaskLeaseService(serviceB, { ownerInstanceId: "instance-b" });
    const task = serviceA.createTask({ title: "跨实例租约", goal: "只允许一个执行者" });

    const taskPage = syncA.exportEvents(0, 500);
    syncB.applyPage(taskPage);
    const lease = ownerA.acquire(task.id);
    const leasePage = syncA.exportEvents(taskPage.nextCursor, 500);
    syncB.applyPage(leasePage);

    expect(ownerB.isHeldByOther(task.id)).toBe(true);
    expectLeaseError(() => ownerB.acquire(task.id), "LEASE_HELD");
    expect(storeB.getTaskLease(task.id)?.epoch).toBe(lease.epoch);
    expect(storeB.getTaskLease(task.id)?.ownerInstanceId).toBe("instance-a");
  });

  function makeStore(): HearthStore {
    const store = new HearthStore(":memory:");
    stores.push(store);
    return store;
  }
});

function expectLeaseError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected lease error ${code}`);
}

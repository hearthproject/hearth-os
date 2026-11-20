import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { TaskLeaseService } from "./leases.ts";
import { HearthService } from "./service.ts";

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

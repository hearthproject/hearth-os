import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";

describe("proactive API", () => {
  let store: HearthStore;

  beforeEach(() => {
    store = new HearthStore(":memory:");
  });

  afterEach(() => store.close());

  it("exposes settings, scanning, snooze, accept, and pause endpoints", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "准备发布说明", goal: "完成发布准备" }
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().id as string;
    store.appendEvent({
      type: "task.updated",
      taskId,
      payload: { deadline: new Date(Date.now() + 3_600_000).toISOString() }
    });

    const settings = await app.inject({
      method: "PATCH",
      url: "/api/proactive/settings",
      payload: { dailyLimit: 3, quietStart: "00:00", quietEnd: "00:00", cooldownMinutes: 0 }
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().dailyLimit).toBe(3);

    const scan = await app.inject({ method: "POST", url: "/api/proactive/scan" });
    expect(scan.statusCode).toBe(200);
    expect(scan.json().created).toBeGreaterThanOrEqual(1);
    const suggestion = scan.json().suggestions[0];
    expect(suggestion.source.kind).toBe("task");

    const snoozed = await app.inject({
      method: "POST",
      url: "/api/suggestions/" + suggestion.id + "/snooze",
      payload: { minutes: 10 }
    });
    expect(snoozed.statusCode).toBe(200);
    expect(snoozed.json().status).toBe("snoozed");

    const accepted = await app.inject({
      method: "POST",
      url: "/api/suggestions/" + suggestion.id + "/accept",
      payload: { title: "跟进发布" }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().taskId).toBeTypeOf("string");

    const paused = await app.inject({ method: "POST", url: "/api/proactive/pause", payload: { minutes: 30 } });
    expect(paused.statusCode).toBe(200);
    const snapshot = await app.inject({ method: "GET", url: "/api/proactive" });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().budget.paused).toBe(true);
    expect(snapshot.json().metrics.accepted).toBe(1);

    await app.close();
  });

  it("rejects invalid settings and missing suggestions", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/proactive/settings",
      payload: { dailyLimit: 999 }
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await app.inject({ method: "POST", url: "/api/suggestions/missing/ignore" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("SUGGESTION_NOT_FOUND");
    await app.close();
  });
});

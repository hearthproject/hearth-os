import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";

describe("standing intents and attention API", () => {
  let store: HearthStore;

  beforeEach(() => {
    store = new HearthStore(":memory:");
  });

  afterEach(() => store.close());

  it("creates intents, matches text, exposes attention actions, and records NO_REPLY", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const created = await app.inject({
      method: "POST",
      url: "/api/intents",
      payload: {
        description: "发布前检查回滚负责人",
        triggerEntries: [{ terms: ["发布", "rollback"], mode: "all" }],
        scope: { anywhere: true },
        action: "ask",
        cooldownSeconds: 0
      }
    });
    expect(created.statusCode).toBe(201);
    const intentId = created.json().id as string;
    expect(created.json().state).toBe("armed");

    const matched = await app.inject({
      method: "POST",
      url: "/api/intents/match",
      payload: { text: "准备发布，请确认 rollback 负责人" }
    });
    expect(matched.statusCode).toBe(200);
    expect(matched.json().matches).toHaveLength(1);
    expect(matched.json().attention[0].kind).toBe("decision");

    const queue = await app.inject({ method: "GET", url: "/api/attention" });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().items).toHaveLength(1);
    const attentionId = queue.json().items[0].id as string;

    const ignored = await app.inject({ method: "POST", url: `/api/attention/${attentionId}/ignore` });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json().status).toBe("ignored");
    expect((await app.inject({ method: "GET", url: "/api/attention" })).json().items).toHaveLength(0);

    const budget = await app.inject({
      method: "PATCH",
      url: "/api/attention/settings",
      payload: { dailyLimit: 2, cooldownSeconds: 0 }
    });
    expect(budget.statusCode).toBe(200);
    expect(budget.json().dailyLimit).toBe(2);

    const heartbeat = await app.inject({ method: "POST", url: "/api/heartbeat/run", payload: {} });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json().decision).toBe("NO_REPLY");
    const history = await app.inject({ method: "GET", url: "/api/heartbeat" });
    expect(history.statusCode).toBe(200);
    expect(history.json().last.decision).toBe("NO_REPLY");

    const cancelled = await app.inject({ method: "POST", url: `/api/intents/${intentId}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().state).toBe("cancelled");
    await app.close();
  });

  it("validates payloads and returns a stable not-found error", async () => {
    const app = await buildServer({ store, serveWeb: false });
    expect((await app.inject({ method: "POST", url: "/api/intents", payload: { description: "missing triggers" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/intents/missing/arm" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/attention/missing/resolve" })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: "/api/attention/settings", payload: { dailyLimit: 999 } })).statusCode).toBe(400);
    await app.close();
  });
});

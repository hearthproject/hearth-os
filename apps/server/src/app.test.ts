import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";

describe("Hearth server", () => {
  let store: HearthStore;

  beforeEach(() => {
    store = new HearthStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("exposes health without leaking the provider key", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.name).toBe("Hearth");
    expect(body.codex).toBeTypeOf("object");
    expect(JSON.stringify(body)).not.toContain("CODEX_OPEN_DESIGN_API_KEY=");
    await app.close();
  });

  it("lists the fifteen evaluation templates", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const response = await app.inject({ method: "GET", url: "/api/templates" });
    expect(response.statusCode).toBe(200);
    expect(response.json().templates).toHaveLength(15);
    await app.close();
  });

  it("stops and resumes the scheduler from the local control plane", async () => {
    const app = await buildServer({ store, serveWeb: false, startScheduler: true });
    const initial = await app.inject({ method: "GET", url: "/api/system" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ running: true, schedulerEnabled: true });

    const stopped = await app.inject({ method: "POST", url: "/api/system/stop" });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().running).toBe(false);

    const resumed = await app.inject({ method: "POST", url: "/api/system/start" });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().running).toBe(true);
    await app.close();
  });

  it("creates a task and projects its event", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { templateId: "T01" }
    });
    expect(response.statusCode).toBe(201);
    const task = response.json();
    expect(task.templateId).toBe("T01");
    expect(task.status).toBe("queued");
    expect(task.outputDir).toBe("eval/runs/T01");

    const detail = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(detail.statusCode).toBe(200);
    const view = detail.json();
    expect(view.task.id).toBe(task.id);
    expect(view.events[0].type).toBe("task.created");

    const list = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(list.json().tasks).toHaveLength(1);
    await app.close();
  });

  it("rejects unknown templates and cross-site writes", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { templateId: "T99" }
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe("UNKNOWN_TEMPLATE");

    const crossSite = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { origin: "https://example.com", "sec-fetch-site": "cross-site" },
      payload: { templateId: "T01" }
    });
    expect(crossSite.statusCode).toBe(403);
    await app.close();
  });

  it("streams newly created events over SSE", async () => {
    const app = await buildServer({ store, serveWeb: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing response stream");

      const created = await fetch(`http://127.0.0.1:${address.port}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId: "T04" }),
        signal: controller.signal
      });
      expect(created.status).toBe(201);

      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("task.created")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toContain("event: task.created");
      expect(received).toContain('"templateId":"T04"');
      await reader.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await app.close();
    }
  });
});

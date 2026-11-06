import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import { HearthService } from "./service.ts";

describe("methods API", () => {
  let store: HearthStore;
  let service: HearthService;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
  });

  afterEach(() => store.close());

  function terminalTask(status: "completed" | "failed") {
    const task = service.createTask({ templateId: "T01" });
    service.updateTask(task.id, { status: "running", nextAction: "执行中" });
    service.updateTask(task.id, { status, nextAction: status });
    return task;
  }

  it("generates, evaluates, promotes, and rolls back a candidate", async () => {
    const source = terminalTask("completed");
    const baseline = terminalTask("failed");
    const trial = terminalTask("completed");
    const app = await buildServer({ store, serveWeb: false });

    const generated = await app.inject({ method: "POST", url: "/api/methods/generate", payload: { taskId: source.id } });
    expect(generated.statusCode).toBe(201);
    const methodId = generated.json().id as string;
    expect(generated.json().status).toBe("candidate");

    const recorded = await app.inject({ method: "POST", url: "/api/methods/" + methodId + "/trials", payload: { taskId: trial.id } });
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json().status).toBe("trial");

    const evaluated = await app.inject({
      method: "POST",
      url: "/api/methods/" + methodId + "/evaluate",
      payload: { baselineTaskIds: [baseline.id], trialTaskIds: [trial.id], notes: "API 评估" }
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json().verdict).toBe("improved");

    const promoted = await app.inject({ method: "POST", url: "/api/methods/" + methodId + "/promote" });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().status).toBe("adopted");

    const rolledBack = await app.inject({
      method: "POST",
      url: "/api/methods/" + methodId + "/rollback",
      payload: { reason: "演练回退" }
    });
    expect(rolledBack.statusCode).toBe(200);
    expect(rolledBack.json().status).toBe("reverted");

    const snapshot = await app.inject({ method: "GET", url: "/api/methods" });
    expect(snapshot.json().methods).toHaveLength(1);
    expect(snapshot.json().evaluations).toHaveLength(1);
    expect(snapshot.json().trials).toHaveLength(1);
    await app.close();
  });

  it("validates method input and exposes permission errors", async () => {
    const source = terminalTask("completed");
    const app = await buildServer({ store, serveWeb: false });

    const invalid = await app.inject({ method: "POST", url: "/api/methods", payload: { name: "缺少字段" } });
    expect(invalid.statusCode).toBe(400);

    const expanded = await app.inject({
      method: "POST",
      url: "/api/methods",
      payload: {
        name: "越权方法",
        summary: "尝试扩大权限",
        applicability: "测试",
        steps: ["执行"],
        sourceTaskIds: [source.id],
        allowedCapabilities: ["network:evil.example"]
      }
    });
    expect(expanded.statusCode).toBe(409);
    expect(expanded.json().error).toBe("METHOD_PERMISSION_EXPANSION");
    await app.close();
  });
});

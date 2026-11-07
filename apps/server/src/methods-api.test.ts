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

  function injectMethod(taskId: string, methodId: string, methodVersion: number) {
    const now = new Date().toISOString();
    const runId = "run-" + taskId;
    service.createRun({
      id: runId, taskId, attempt: 1, status: "completed", threadId: null, workspace: "workspace",
      startedAt: now, endedAt: now, failure: null, usage: null, leaseEpoch: null, createdAt: now,
      executorId: "native"
    });
    return store.insertMethodApplication({
      id: "application-" + taskId, taskId, runId, methodId, methodVersion,
      selection: "pinned", promptSha256: "a".repeat(64), createdAt: now
    });
  }

  it("generates, evaluates, promotes, and rolls back a candidate", async () => {
    const source = terminalTask("completed");
    const baselines = [terminalTask("failed"), terminalTask("failed")];
    const trials = [terminalTask("completed"), terminalTask("completed")];
    const app = await buildServer({ store, serveWeb: false });

    const generated = await app.inject({ method: "POST", url: "/api/methods/generate", payload: { taskId: source.id } });
    expect(generated.statusCode).toBe(201);
    const methodId = generated.json().id as string;
    const methodVersion = generated.json().version as number;
    expect(generated.json().status).toBe("candidate");
    for (const trial of trials) {
      injectMethod(trial.id, methodId, methodVersion);
    }

    const uninjected = terminalTask("completed");
    const missingEvidence = await app.inject({ method: "POST", url: "/api/methods/" + methodId + "/trials", payload: { taskId: uninjected.id } });
    expect(missingEvidence.statusCode).toBe(409);
    expect(missingEvidence.json().error).toBe("METHOD_TRIAL_NOT_INJECTED");

    for (const trial of trials) {
      const recorded = await app.inject({ method: "POST", url: "/api/methods/" + methodId + "/trials", payload: { taskId: trial.id } });
      expect(recorded.statusCode).toBe(200);
      expect(recorded.json().status).toBe("trial");
    }

    const pairing = await app.inject({ method: "GET", url: "/api/methods/" + methodId + "/pairing" });
    expect(pairing.statusCode).toBe(200);
    expect(pairing.json().trialTaskIds).toHaveLength(2);

    const evaluated = await app.inject({
      method: "POST",
      url: "/api/methods/" + methodId + "/evaluate",
      payload: {
        baselineTaskIds: baselines.map((task) => task.id),
        trialTaskIds: trials.map((task) => task.id),
        notes: "API 评估"
      }
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
    expect(snapshot.json().trials).toHaveLength(2);
    await app.close();
  });

  it("creates and patches tasks with explicit method assignments", async () => {
    const source = terminalTask("completed");
    const app = await buildServer({ store, serveWeb: false });

    const generated = await app.inject({ method: "POST", url: "/api/methods/generate", payload: { taskId: source.id } });
    const methodId = generated.json().id as string;
    const methodVersion = generated.json().version as number;

    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { templateId: "T01", methodId }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().methodId).toBe(methodId);
    expect(created.json().methodVersion).toBe(methodVersion);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.json().id}/method`,
      payload: { methodId: null }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().methodId).toBeNull();

    const mismatch = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { templateId: "T02", methodId }
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error).toBe("METHOD_TEMPLATE_MISMATCH");
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

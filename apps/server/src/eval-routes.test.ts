import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HearthStore } from "@hearth/eventlog";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerEvalRoutes } from "./eval-routes.ts";
import type { ModelSettings } from "./model-settings.ts";
import { HearthService } from "./service.ts";

const stores: HearthStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("eval routes", () => {
  it("creates an idempotent offline task and rejects a changed request", async () => {
    const fixture = await createFixture();
    const body = taskBody();
    const first = await fixture.app.inject({ method: "POST", url: "/api/eval/tasks", payload: body });
    expect(first.statusCode).toBe(201);
    const created = first.json<{ task: { id: string; externalRef: string; networkHosts: string[]; outputDir: string; requestHash: string }; created: boolean }>();
    expect(created.created).toBe(true);
    expect(created.task.externalRef).toBe("exp-1:E01:codex:r1");
    expect(created.task.networkHosts).toEqual([]);
    expect(created.task.outputDir).toBe(".hearth/eval-artifacts/exp-1/E01/r1");
    expect(created.task.requestHash).toMatch(/^[a-f0-9]{64}$/);

    const repeated = await fixture.app.inject({ method: "POST", url: "/api/eval/tasks", payload: body });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json<{ task: { id: string } }>().task.id).toBe(created.task.id);

    const conflict = await fixture.app.inject({
      method: "POST",
      url: "/api/eval/tasks",
      payload: { ...body, goal: "不同的目标" }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe("EVAL_REQUEST_CONFLICT");
  });

  it("rejects paths outside eval and URLs in offline mode", async () => {
    const fixture = await createFixture();
    const outside = await fixture.app.inject({
      method: "POST",
      url: "/api/eval/tasks",
      payload: { ...taskBody(), inputs: [{ kind: "file", label: "bad", value: "package.json" }] }
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.json().error).toBe("UNSAFE_EVAL_PATH");

    const url = await fixture.app.inject({
      method: "POST",
      url: "/api/eval/tasks",
      payload: { ...taskBody(), externalRef: "exp-1:E01:codex:r2", inputs: [{ kind: "url", label: "page", value: "https://example.com" }] }
    });
    expect(url.statusCode).toBe(400);
    expect(url.json().error).toBe("OFFLINE_NETWORK_FORBIDDEN");
  });

  it("returns a normalized judge result from the configured model", async () => {
    const fixture = await createFixture();
    const created = await fixture.app.inject({ method: "POST", url: "/api/eval/tasks", payload: taskBody() });
    const task = created.json<{ task: { id: string } }>().task;
    const artifactPath = join(fixture.root, ".hearth", "eval-artifacts", "exp-1", "E01", "r1", "result.md");
    mkdirSync(join(artifactPath, ".."), { recursive: true });
    writeFileSync(artifactPath, "已回复并说明原因", "utf8");
    fixture.service.publishArtifact({
      id: "artifact-1",
      taskId: task.id,
      runId: "run-1",
      relativePath: "result.md",
      absolutePath: artifactPath,
      mimeType: "text/markdown",
      sha256: "a".repeat(64),
      bytes: 24,
      createdAt: new Date().toISOString()
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/eval/judge",
      payload: {
        taskId: task.id,
        criteria: [{ id: "quality", label: "质量", rubric: "回复清晰", points: 30 }],
        deterministic: [{ criterionId: "exists", passed: true, reason: "文件存在" }]
      }
    });
    expect(response.statusCode).toBe(200);
    const judged = response.json();
    expect(judged.model).toBe("judge-model");
    expect(judged.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(judged.criteria).toEqual([
      { id: "quality", passed: true, confidence: 0.91, reason: "清晰", evidence: ["已回复"] }
    ]);
    expect(judged.overallConfidence).toBe(0.91);
  });

  it("uses an unavailable response when no chat model is configured", async () => {
    const fixture = await createFixture(false);
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/eval/judge",
      payload: { taskId: "missing", criteria: [{ id: "quality", label: "质量", rubric: "清晰", points: 30 }], deterministic: [] }
    });
    expect(response.statusCode).toBe(404);
  });
});

async function createFixture(withModel = true) {
  const root = mkdtempSync(join(tmpdir(), "hearth-eval-routes-"));
  mkdirSync(join(root, "eval", "inputs"), { recursive: true });
  writeFileSync(join(root, "eval", "inputs", "mail.txt"), "incoming mail", "utf8");
  const store = new HearthStore(":memory:");
  stores.push(store);
  const service = new HearthService(store);
  const app = Fastify();
  registerEvalRoutes(app, {
    service,
    store,
    repoRoot: root,
    settings: () => withModel ? judgeSettings : null,
    complete: async () => ({
      content: '{"criteria":[{"id":"quality","passed":true,"confidence":0.91,"reason":"清晰","evidence":["已回复"]}],"overallConfidence":0.91}',
      usage: { inputTokens: 100, outputTokens: 20 }
    })
  });
  await app.ready();
  return { root, app, service, store };
}

function taskBody() {
  return {
    externalRef: "exp-1:E01:codex:r1",
    title: "E01 邮件回复",
    goal: "根据输入文件写一封回复",
    inputs: [{ kind: "file", label: "邮件", value: "eval/inputs/mail.txt" }],
    expectedOutputs: ["result.md"],
    executorId: "codex",
    runMode: "offline",
    networkHosts: [],
    outputDir: ".hearth/eval-artifacts/exp-1/E01/r1",
    timeoutMs: 60_000
  };
}

const judgeSettings: ModelSettings = {
  providerId: "test",
  providerName: "Test",
  protocol: "openai-chat",
  baseUrl: "http://127.0.0.1:9999/v1",
  model: "judge-model",
  apiKey: "test-key",
  updatedAt: null
};

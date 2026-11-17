import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HearthStore } from "@hearth/eventlog";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { completeChat } from "./model-client.ts";
import { registerEvalRoutes } from "./eval-routes.ts";
import type { ModelSettings } from "./model-settings.ts";
import { HearthService } from "./service.ts";
import { ApprovalManager } from "./approvals.ts";
import { OutboxService } from "./outbox.ts";
import { ReconcileService } from "./reconcile.ts";
import { MemoryService } from "./memory.ts";
import { MethodService } from "./methods.ts";
import { ScheduleService } from "./schedules.ts";
import { SkillPackageService } from "./skills.ts";

const stores: HearthStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed by a restart test
    }
  }
});

describe("eval routes", () => {
  it("creates an idempotent offline task and rejects a changed request", async () => {
    const fixture = await createFixture();
    const body = taskBody();
    const first = await fixture.app.inject({ method: "POST", url: "/api/eval/tasks", payload: body });
    expect(first.statusCode).toBe(201);
    const created = first.json<{ task: { id: string; externalRef: string; networkHosts: string[]; outputDir: string; requestHash: string; permissions: { tools: string[]; readRoots: string[]; writeRoots: string[]; approvalMode?: string } }; created: boolean }>();
    expect(created.created).toBe(true);
    expect(created.task.externalRef).toBe("exp-1:E01:codex:r1");
    expect(created.task.networkHosts).toEqual([]);
    expect(created.task.outputDir).toBe(".hearth/eval-artifacts/exp-1/E01/r1");
    expect(created.task.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.task.permissions.readRoots).toEqual([fixture.evalInputRoot]);
    expect(created.task.permissions.writeRoots).toEqual([join(fixture.root, ".hearth", "eval-artifacts", "exp-1", "E01", "r1")]);
    expect(created.task.permissions.approvalMode).toBe("full");
    expect(created.task.permissions.tools).toEqual(expect.arrayContaining([
      "read_file",
      "write_file",
      "finish_task"
    ]));

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

  it("accepts absolute inputs from the configured external evaluation repository", async () => {
    const externalRoot = mkdtempSync(join(tmpdir(), "hearth-eval-inputs-"));
    const inputPath = join(externalRoot, "mail.txt");
    writeFileSync(inputPath, "external evaluation input", "utf8");
    const fixture = await createFixture(true, externalRoot);

    const created = await fixture.app.inject({
      method: "POST",
      url: "/api/eval/tasks",
      payload: { ...taskBody(), inputs: [{ kind: "file", label: "邮件", value: inputPath }] }
    });
    expect(created.statusCode).toBe(201);
    const task = fixture.store.getTask(created.json().task.id);
    expect(task?.inputs[0]?.value).toBe(inputPath);
    expect(task?.permissions?.readRoots).toEqual([externalRoot]);
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
    expect(judged.diagnostics).toMatchObject({
      maxTokens: 8000, responseFormat: "json_object", reasoningEffort: null,
      usage: { inputTokens: 100, outputTokens: 20 }
    });
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

  it.each(["length", "stop"])("reports judge response diagnostics for %s failures", async (finishReason) => {
    const complete = vi.fn<typeof completeChat>().mockResolvedValue({
      content: "", usage: { inputTokens: 2438, outputTokens: 8000 },
      diagnostics: { requestId: "judge-request", finishReason, reasoningCharacters: 12000 }
    });
    const fixture = await createFixture(true, undefined, complete, { ...judgeSettings, model: "glm-5.3-flash" });
    const created = await fixture.app.inject({ method: "POST", url: "/api/eval/tasks", payload: taskBody() });
    const response = await fixture.app.inject({
      method: "POST", url: "/api/eval/judge", payload: {
        taskId: created.json().task.id,
        criteria: [{ id: "quality", label: "质量", rubric: "清晰", points: 30 }], deterministic: []
      }
    });
    expect(complete.mock.calls[0]?.[2]).toMatchObject({
      maxTokens: 8000, responseFormat: { type: "json_object" }, reasoningEffort: "low", temperature: 1
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().message).toContain(finishReason === "length" ? "结果被截断" : "没有返回 JSON");
    expect(response.json().diagnostics).toMatchObject({
      finishReason, requestId: "judge-request", reasoningCharacters: 12000, contentCharacters: 0,
      usage: { inputTokens: 2438, outputTokens: 8000 }
    });
  });

  it("serves a paged trace with monotonic sequence numbers", async () => {
    const fixture = await createFixture();
    const created = await fixture.app.inject({ method: "POST", url: "/api/eval/tasks", payload: taskBody() });
    const task = created.json<{ task: { id: string } }>().task;
    for (let index = 0; index < 3; index += 1) {
      fixture.store.appendEvent({
        type: "task.updated",
        taskId: task.id,
        runId: "run-1",
        payload: {}
      });
    }

    const first = await fixture.app.inject({ method: "GET", url: `/api/eval/tasks/${task.id}/trace?limit=2` });
    expect(first.statusCode).toBe(200);
    const page = first.json<{
      taskId: string; nextSeq: number; hasMore: boolean; total: number;
      counts: { window: number; byType: Record<string, number> };
      events: Array<{ seq: number; type: string }>;
    }>();
    expect(page.taskId).toBe(task.id);
    expect(page.events).toHaveLength(2);
    expect(page.nextSeq).toBe(page.events[1]?.seq);
    expect(page.hasMore).toBe(true);
    expect(page.counts.window).toBe(2);
    expect(page.counts.byType["task.updated"]).toBe(3);

    const second = await fixture.app.inject({
      method: "GET",
      url: `/api/eval/tasks/${task.id}/trace?afterSeq=${page.nextSeq}&limit=500`
    });
    expect(second.statusCode).toBe(200);
    const rest = second.json<typeof page>();
    expect(rest.events[0]!.seq).toBeGreaterThan(page.nextSeq);
    expect(rest.total).toBe(page.total);
    const seqs = [...page.events, ...rest.events].map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));

    const missing = await fixture.app.inject({ method: "GET", url: "/api/eval/tasks/missing/trace" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("TASK_NOT_FOUND");

    const oversized = await fixture.app.inject({ method: "GET", url: `/api/eval/tasks/${task.id}/trace?limit=501` });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().error).toBe("INVALID_TRACE_QUERY");
  });

  it("runs operator actions idempotently and records the effect on the eval task", async () => {
    const fixture = await createFixture();
    const created = await fixture.app.inject({
      method: "POST",
      url: "/api/eval/tasks",
      payload: { ...taskBody(), externalRef: "eval:ops:1", allowExternalEffects: true }
    });
    expect(created.statusCode).toBe(201);
    const task = created.json<{ task: { id: string; taskKind: string; permissions: { approvalMode?: string } } }>().task;
    expect(task.taskKind).toBe("delivery");
    const runId = "run-op-1";
    fixture.service.updateTask(task.id, { status: "running", currentRunId: runId }, runId);
    fixture.service.updateTask(task.id, { status: "waiting_approval", currentRunId: runId }, runId);
    const approval = fixture.service.createApproval({
      id: "approval-op-1",
      taskId: task.id,
      runId,
      kind: "email.smtp-send",
      summary: "发送评测邮件",
      target: { to: ["reviewer@example.test"] },
      preview: {},
      parameterHash: "hash-1",
      status: "pending",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      decidedAt: null,
      effectId: null,
      createdAt: new Date().toISOString()
    });

    const decide = await fixture.app.inject({
      method: "POST",
      url: `/api/eval/tasks/${task.id}/operator`,
      payload: { operationId: "op-decide-1", action: "approval.decide", targetId: approval.id, decision: "approve", parameterHash: "hash-1" }
    });
    expect(decide.statusCode).toBe(200);
    const decided = decide.json<{ replayed: boolean; effect: { id: string; status: string; taskId: string } }>();
    expect(decided.replayed).toBe(false);
    expect(decided.effect.taskId).toBe(task.id);
    expect(decided.effect.status).toBe("succeeded");

    const replay = await fixture.app.inject({
      method: "POST",
      url: `/api/eval/tasks/${task.id}/operator`,
      payload: { operationId: "op-decide-1", action: "approval.decide", targetId: approval.id, decision: "approve", parameterHash: "hash-1" }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(fixture.store.listEffects(task.id)).toHaveLength(1);

    const conflict = await fixture.app.inject({
      method: "POST",
      url: `/api/eval/tasks/${task.id}/operator`,
      payload: { operationId: "op-decide-1", action: "approval.decide", targetId: "other", decision: "approve", parameterHash: "hash-1" }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe("OPERATION_ID_CONFLICT");

    const asserted = await fixture.app.inject({
      method: "POST",
      url: `/api/eval/tasks/${task.id}/operator`,
      payload: { operationId: "op-assert-1", action: "effect.assert", expectedStatus: "succeeded" }
    });
    expect(asserted.statusCode).toBe(200);
    expect(asserted.json().satisfied).toBe(true);

    const uncertain = await fixture.app.inject({
      method: "POST",
      url: `/api/eval/tasks/${task.id}/operator`,
      payload: { operationId: "op-uncertain-1", action: "reconcile.mark_uncertain", targetId: decided.effect.id, note: "回执丢失" }
    });
    expect(uncertain.statusCode).toBe(200);
    const item = uncertain.json<{ reconcileItem: { id: string; status: string } }>().reconcileItem;
    expect(item.status).toBe("open");

    const resolved = await fixture.app.inject({
      method: "POST",
      url: `/api/eval/tasks/${task.id}/operator`,
      payload: { operationId: "op-resolve-1", action: "reconcile.resolve", targetId: item.id, resolution: "committed", note: "上游已确认" }
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().reconcileItem.status).toBe("resolved_committed");
    expect(fixture.store.getEffect(decided.effect.id)?.status).toBe("reconciled_committed");
  });

  it("refuses operator access when disabled or when the task is not an eval task", async () => {
    const disabled = await createFixture(true, undefined, undefined, judgeSettings, { operatorEnabled: false });
    const created = await disabled.app.inject({
      method: "POST", url: "/api/eval/tasks", payload: { ...taskBody(), externalRef: "eval:ops:2" }
    });
    const disabledResponse = await disabled.app.inject({
      method: "POST",
      url: `/api/eval/tasks/${created.json().task.id}/operator`,
      payload: { operationId: "op-1", action: "effect.assert" }
    });
    expect(disabledResponse.statusCode).toBe(403);
    expect(disabledResponse.json().error).toBe("EVAL_OPERATOR_DISABLED");

    const fixture = await createFixture();
    const plain = fixture.service.createTask({ title: "普通任务", goal: "不经过评测入口" });
    const rejected = await fixture.app.inject({
      method: "POST",
      url: `/api/eval/tasks/${plain.id}/operator`,
      payload: { operationId: "op-2", action: "effect.assert" }
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error).toBe("NOT_EVAL_TASK");
  });

  it("drives memory lifecycle and skill promotion through the operator", async () => {
    const fixture = await createFixture();
    const created = await fixture.app.inject({
      method: "POST", url: "/api/eval/tasks", payload: { ...taskBody(), externalRef: "eval:mem:1" }
    });
    const taskId = created.json().task.id as string;
    const operate = (payload: Record<string, unknown>) => fixture.app.inject({
      method: "POST", url: `/api/eval/tasks/${taskId}/operator`, payload
    });

    const made = await operate({
      operationId: "mem-create-1",
      action: "memory.create",
      payload: { kind: "preference", content: "咖啡只喝无糖燕麦拿铁", subjectKey: "user.drink" }
    });
    expect(made.statusCode).toBe(200);
    const memoryId = made.json<{ memory: { id: string; status: string } }>().memory.id;
    expect(made.json().memory.status).toBe("candidate");

    const confirmed = await operate({ operationId: "mem-confirm-1", action: "memory.confirm", targetId: memoryId });
    expect(confirmed.json().memory.status).toBe("active");

    const recalled = await operate({
      operationId: "mem-recall-1", action: "memory.recall", payload: { text: "咖啡" }
    });
    expect(recalled.json().recall.memories.map((item: { id: string }) => item.id)).toContain(memoryId);

    const corrected = await operate({
      operationId: "mem-correct-1", action: "memory.correct", targetId: memoryId,
      payload: { content: "咖啡只喝无糖燕麦拿铁，不加浓缩", reason: "用户补充偏好" }
    });
    expect(corrected.json().memory.content).toContain("不加浓缩");

    const forgotten = await operate({ operationId: "mem-forget-1", action: "memory.forget", targetId: memoryId });
    expect(forgotten.json().memory.status).toBe("forgotten");
    const afterForget = await operate({
      operationId: "mem-recall-2", action: "memory.recall", payload: { text: "咖啡" }
    });
    expect(afterForget.json().recall.memories.map((item: { id: string }) => item.id)).not.toContain(memoryId);

    const methodTask = fixture.service.createTask({ title: "整理周报", goal: "每周整理周报" });
    fixture.service.updateTask(methodTask.id, { status: "running" });
    fixture.service.updateTask(methodTask.id, { status: "completed" });
    const method = fixture.methods.autoLearnFromTask(methodTask.id);
    if (!method) throw new Error("method missing");
    const exported = fixture.skills.exportMethod(method.id);

    const checked = await operate({
      operationId: "skill-check-1", action: "skill.execution_check", targetId: exported.id,
      payload: { toolName: "read_file" }
    });
    expect(checked.statusCode).toBe(200);
    expect(typeof checked.json().decision.allowed).toBe("boolean");

    const transitioned = await operate({
      operationId: "skill-transition-1", action: "skill.transition", targetId: exported.id,
      payload: { status: "archived", reason: "评测归档" }
    });
    expect(transitioned.json().skill.status).toBe("archived");
  });

  it("triggers a scheduled task through the operator", async () => {
    const fixture = await createFixture();
    const created = await fixture.app.inject({
      method: "POST", url: "/api/eval/tasks", payload: { ...taskBody(), externalRef: "eval:sched:1" }
    });
    const taskId = created.json().task.id as string;
    const schedule = fixture.schedules.create({
      name: "每日邮件摘要",
      prompt: "汇总过去 24 小时的重要邮件",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai"
    });
    const triggered = await fixture.app.inject({
      method: "POST",
      url: `/api/eval/tasks/${taskId}/operator`,
      payload: { operationId: "schedule-run-1", action: "schedule.run", targetId: schedule.id }
    });
    expect(triggered.statusCode).toBe(200);
    const run = triggered.json<{ run: { scheduleId: string; taskId: string } }>().run;
    expect(run.scheduleId).toBe(schedule.id);
    expect(fixture.service.store.getTask(run.taskId)).toBeTruthy();
  });

  it("rejects a concurrent duplicate operation while the first is running", async () => {
    const fixture = await createFixture(true, undefined, undefined, judgeSettings, { effectDelayMs: 300 });
    const created = await fixture.app.inject({
      method: "POST", url: "/api/eval/tasks", payload: { ...taskBody(), externalRef: "eval:conc:1", allowExternalEffects: true }
    });
    const taskId = created.json().task.id as string;
    const runId = "run-conc-1";
    fixture.service.updateTask(taskId, { status: "running", currentRunId: runId }, runId);
    fixture.service.updateTask(taskId, { status: "waiting_approval", currentRunId: runId }, runId);
    const approval = fixture.service.createApproval({
      id: "approval-conc-1",
      taskId,
      runId,
      kind: "email.smtp-send",
      summary: "并发评测",
      target: {},
      preview: {},
      parameterHash: "hash-conc",
      status: "pending",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      decidedAt: null,
      effectId: null,
      createdAt: new Date().toISOString()
    });
    const payload = {
      operationId: "op-conc-1",
      action: "approval.decide",
      targetId: approval.id,
      decision: "approve",
      parameterHash: "hash-conc"
    };
    const [first, second] = await Promise.all([
      fixture.app.inject({ method: "POST", url: `/api/eval/tasks/${taskId}/operator`, payload }),
      fixture.app.inject({ method: "POST", url: `/api/eval/tasks/${taskId}/operator`, payload })
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const rejected = first.statusCode === 409 ? first : second;
    expect(rejected.json().error).toBe("OPERATION_IN_PROGRESS");
    expect(fixture.store.listEffects(taskId)).toHaveLength(1);
  });

  it("keeps operator idempotency and trace across a store restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-eval-restart-"));
    mkdirSync(join(root, "eval", "inputs"), { recursive: true });
    writeFileSync(join(root, "eval", "inputs", "mail.txt"), "incoming mail", "utf8");
    const evalInputRoot = join(root, "eval");
    const databasePath = join(root, "eval.sqlite");

    const first = await buildEvalApp({
      root, evalInputRoot, store: new HearthStore(databasePath), withModel: true, settings: judgeSettings, options: {}
    });
    const created = await first.app.inject({
      method: "POST", url: "/api/eval/tasks", payload: { ...taskBody(), externalRef: "eval:restart:1", allowExternalEffects: true }
    });
    const taskId = created.json().task.id as string;
    const runId = "run-restart-1";
    first.service.updateTask(taskId, { status: "running", currentRunId: runId }, runId);
    first.service.updateTask(taskId, { status: "waiting_approval", currentRunId: runId }, runId);
    const approval = first.service.createApproval({
      id: "approval-restart-1",
      taskId,
      runId,
      kind: "email.smtp-send",
      summary: "重启评测",
      target: {},
      preview: {},
      parameterHash: "hash-restart",
      status: "pending",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      decidedAt: null,
      effectId: null,
      createdAt: new Date().toISOString()
    });
    const payload = {
      operationId: "op-restart-1",
      action: "approval.decide",
      targetId: approval.id,
      decision: "approve",
      parameterHash: "hash-restart"
    };
    expect((await first.app.inject({ method: "POST", url: `/api/eval/tasks/${taskId}/operator`, payload })).statusCode).toBe(200);
    await first.app.close();
    first.store.close();

    const second = await buildEvalApp({
      root, evalInputRoot, store: new HearthStore(databasePath), withModel: true, settings: judgeSettings, options: {}
    });
    try {
      const replayed = await second.app.inject({ method: "POST", url: `/api/eval/tasks/${taskId}/operator`, payload });
      expect(replayed.statusCode).toBe(200);
      expect(replayed.json().replayed).toBe(true);
      expect(second.store.listEffects(taskId)).toHaveLength(1);

      const trace = await second.app.inject({ method: "GET", url: `/api/eval/tasks/${taskId}/trace` });
      expect(trace.statusCode).toBe(200);
      expect(trace.json().events.some((event: { type: string }) => event.type === "eval.operator")).toBe(true);
    } finally {
      await second.app.close();
      second.store.close();
    }
  });
});

interface EvalFixtureOptions {
  operatorEnabled?: boolean;
  databasePath?: string;
  effectDelayMs?: number;
}

async function createFixture(
  withModel = true,
  externalInputRoot?: string,
  complete?: typeof completeChat,
  settings = judgeSettings,
  options: EvalFixtureOptions = {}
) {
  const root = mkdtempSync(join(tmpdir(), "hearth-eval-routes-"));
  const evalInputRoot = externalInputRoot ?? join(root, "eval");
  if (!externalInputRoot) {
    mkdirSync(join(root, "eval", "inputs"), { recursive: true });
    writeFileSync(join(root, "eval", "inputs", "mail.txt"), "incoming mail", "utf8");
  }
  const store = new HearthStore(options.databasePath ?? ":memory:");
  stores.push(store);
  return buildEvalApp({ root, evalInputRoot, store, withModel, complete, settings, options });
}

async function buildEvalApp(input: {
  root: string;
  evalInputRoot: string;
  store: HearthStore;
  withModel: boolean;
  complete?: typeof completeChat | undefined;
  settings: ModelSettings;
  options: EvalFixtureOptions;
}) {
  const { root, evalInputRoot, store, withModel, settings, options } = input;
  const service = new HearthService(store);
  const approvals = new ApprovalManager(service, async () => {
    if (options.effectDelayMs) await new Promise((resolve) => setTimeout(resolve, options.effectDelayMs));
    return { delivered: true };
  });
  const outbox = new OutboxService(service, approvals, join(root, "workspace"));
  const reconcile = new ReconcileService(service);
  const memory = new MemoryService(service);
  const methods = new MethodService(service);
  const skills = new SkillPackageService(service, methods, { rootDir: join(root, "skills") });
  const schedules = new ScheduleService({ service, executorAvailable: () => ({ canRun: true, issues: [] }) });
  const app = Fastify();
  registerEvalRoutes(app, {
    service,
    store,
    repoRoot: root,
    evalInputRoot,
    operator: { approvals, outbox, reconcile, memory, skills, schedules },
    ...(options.operatorEnabled === false ? { operatorEnabled: false } : { operatorEnabled: true }),
    settings: () => withModel ? settings : null,
    complete: input.complete ?? (async () => ({
      content: '{"criteria":[{"id":"quality","passed":true,"confidence":0.91,"reason":"清晰","evidence":["已回复"]}],"overallConfidence":0.91}',
      usage: { inputTokens: 100, outputTokens: 20 }
    }))
  });
  await app.ready();
  return { root, evalInputRoot, app, service, store, memory, methods, skills, schedules };
}

function taskBody() {
  return {
    externalRef: "exp-1:E01:codex:r1",
    title: "E01 邮件回复",
    goal: "根据输入文件写一封回复",
    inputs: [{ kind: "file", label: "邮件", value: "inputs/mail.txt" }],
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
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_000,
  apiKey: "test-key",
  updatedAt: null
};

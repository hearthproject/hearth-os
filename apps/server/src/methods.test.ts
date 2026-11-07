import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { HearthService } from "./service.ts";
import { MethodError, MethodService } from "./methods.ts";

describe("MethodService", () => {
  let store: HearthStore;
  let service: HearthService;
  let methods: MethodService;
  let now: Date;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    now = new Date("2026-11-06T10:00:00.000Z");
    methods = new MethodService(service, () => now);
  });

  afterEach(() => store.close());

  function terminalTask(status: "completed" | "failed" = "completed") {
    const task = service.createTask({ templateId: "T01" });
    service.updateTask(task.id, { status: "running", nextAction: "执行中" });
    service.updateTask(task.id, { status, nextAction: status === "completed" ? "完成" : "失败" });
    return service.requireTask(task.id);
  }

  function promoteCandidate(methodId: string) {
    const baselines = [terminalTask("failed"), terminalTask("failed")];
    const trials = [terminalTask("completed"), terminalTask("completed")];
    const candidate = store.getMethodCandidate(methodId);
    if (!candidate) throw new Error("candidate missing");
    for (const trial of trials) {
      injectMethod(trial.id, methodId, candidate.version);
      methods.recordTrial(methodId, trial.id);
    }
    methods.evaluate(methodId, {
      baselineTaskIds: baselines.map((task) => task.id),
      trialTaskIds: trials.map((task) => task.id)
    });
    return methods.promote(methodId);
  }

  function injectMethod(taskId: string, methodId: string, methodVersion: number) {
    const runId = "run-" + taskId;
    service.createRun({
      id: runId, taskId, attempt: 1, status: "completed", threadId: null, workspace: "workspace",
      startedAt: now.toISOString(), endedAt: now.toISOString(), failure: null, usage: null,
      leaseEpoch: null, createdAt: now.toISOString(), executorId: "native"
    });
    return methods.recordApplication({
      taskId, runId, methodId, methodVersion, selection: "pinned", promptSha256: "a".repeat(64)
    });
  }

  it("generates a candidate from terminal task trajectories", () => {
    const task = terminalTask("completed");
    const candidate = methods.generateFromTask(task.id);

    expect(candidate.status).toBe("candidate");
    expect(candidate.templateId).toBe("T01");
    expect(candidate.sourceTaskIds).toContain(task.id);
    expect(candidate.allowedCapabilities).toContain("input:file");
    expect(candidate.baseline.tasks).toBeGreaterThanOrEqual(1);
    expect(candidate.guardrails.some((guardrail) => guardrail.includes("审批"))).toBe(true);
    expect(store.getMethodCandidate(candidate.id)?.name).toBe(candidate.name);
  });

  it("resolves pinned and adopted methods and records applications", () => {
    const source = terminalTask("completed");
    const candidate = methods.generateFromTask(source.id);
    const queued = service.createTask({ templateId: "T01" });
    methods.assignToTask(queued.id, candidate.id);
    expect(methods.resolveForTask(service.requireTask(queued.id))).toMatchObject({
      method: { id: candidate.id },
      selection: "pinned"
    });

    store.appendEvent({
      type: "method.candidate.updated",
      payload: { ...candidate, status: "adopted", generation: 1, adoptedAt: now.toISOString(), updatedAt: now.toISOString() }
    });
    const automatic = service.createTask({ templateId: "T01" });
    expect(methods.resolveForTask(automatic)?.selection).toBe("auto_template");
    expect(methods.resolveForTask(service.createTask({ templateId: "T02" }))).toBeNull();

    const application = methods.recordApplication({
      taskId: automatic.id,
      runId: "run-1",
      methodId: candidate.id,
      methodVersion: candidate.version,
      selection: "auto_template",
      promptSha256: "a".repeat(64)
    });
    expect(methods.listApplications({ taskId: automatic.id })).toEqual([application]);
    expect(methods.snapshot().applications).toContainEqual(application);
  });

  it("assigns and clears a method on a queued task", () => {
    const source = terminalTask("completed");
    const candidate = methods.generateFromTask(source.id);
    const queued = service.createTask({ templateId: "T01" });

    const assigned = methods.assignToTask(queued.id, candidate.id);
    expect(assigned.methodId).toBe(candidate.id);
    expect(assigned.methodVersion).toBe(candidate.version);

    const cleared = methods.assignToTask(queued.id, null);
    expect(cleared.methodId).toBeNull();
    expect(cleared.methodVersion).toBeNull();

    const otherTemplate = service.createTask({ templateId: "T02" });
    expect(() => methods.assignToTask(otherTemplate.id, candidate.id)).toThrowError(MethodError);
  });

  it("extracts trajectory evidence and deduplicates candidates by fingerprint", () => {
    const task = terminalTask("completed");
    store.appendContextItem({
      seq: 0, id: "context-tool", conversationId: null, taskId: task.id, runId: "run-1",
      executorId: "native", kind: "tool_call", role: "assistant", content: "read_file\n{\"path\":\"input.md\"}",
      contentRef: null, sha256: null, tokens: 5, sensitivity: "normal", provenance: {},
      parentId: null, executorEventId: "tool:1", createdAt: now.toISOString()
    });
    store.appendContextItem({
      seq: 0, id: "context-decision", conversationId: null, taskId: task.id, runId: "run-1",
      executorId: "native", kind: "decision", role: "system", content: "先核对输入，再生成产物",
      contentRef: null, sha256: null, tokens: 5, sensitivity: "normal", provenance: {},
      parentId: null, executorEventId: "decision:1", createdAt: now.toISOString()
    });

    const first = methods.generateFromTask(task.id);
    const second = methods.generateFromTask(task.id);
    expect(second.id).toBe(first.id);
    expect(first.sourceTaskIds).toEqual([task.id]);
    expect(first.steps.some((step) => step.includes("read_file"))).toBe(true);
    expect(first.steps.some((step) => step.includes("先核对输入"))).toBe(true);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects capability expansion at candidate creation", () => {
    const task = terminalTask();
    expect(() => methods.create({
      name: "越权方法",
      summary: "尝试访问来源中没有的网络能力",
      applicability: "测试",
      steps: ["执行"],
      sourceTaskIds: [task.id],
      allowedCapabilities: ["input:file", "network:evil.example"],
      templateId: "T01"
    })).toThrowError(MethodError);
  });

  it("evaluates 2+2 samples, promotes, and rolls back with an audit trail", () => {
    const source = terminalTask("completed");
    const baseline = [terminalTask("failed"), terminalTask("failed")];
    const trials = [terminalTask("completed"), terminalTask("completed")];
    const candidate = methods.generateFromTask(source.id);
    for (const trial of trials) {
      injectMethod(trial.id, candidate.id, candidate.version);
      methods.recordTrial(candidate.id, trial.id);
    }

    const trialled = store.getMethodCandidate(candidate.id);
    expect(trialled?.status).toBe("trial");
    expect(trialled?.trial.completed).toBe(2);

    const evaluation = methods.evaluate(candidate.id, {
      baselineTaskIds: baseline.map((task) => task.id),
      trialTaskIds: trials.map((task) => task.id),
      notes: "同一模板，2 个失败基线与 2 个完成试跑"
    });
    expect(evaluation.verdict).toBe("improved");
    expect(store.listMethodEvaluations(candidate.id)).toHaveLength(1);

    const adopted = methods.promote(candidate.id);
    expect(adopted.status).toBe("adopted");
    expect(adopted.adoptedAt).not.toBeNull();

    const reverted = methods.rollback(candidate.id, "试跑后出现回归");
    expect(reverted.status).toBe("reverted");
    expect(reverted.retiredAt).not.toBeNull();
    expect(reverted.guardrails.some((guardrail) => guardrail.includes("试跑后出现回归"))).toBe(true);
  });

  it("increments adoption generations and restores the previous one on rollback", () => {
    const first = methods.generateFromTask(terminalTask("completed").id);
    const adoptedFirst = promoteCandidate(first.id);
    expect(adoptedFirst.generation).toBe(1);

    const secondSource = terminalTask("completed");
    store.appendContextItem({
      seq: 0, id: "context-second", conversationId: null, taskId: secondSource.id, runId: "run-second",
      executorId: "native", kind: "decision", role: "system", content: "第二代方法多一步交叉验证",
      contentRef: null, sha256: null, tokens: 5, sensitivity: "normal", provenance: {},
      parentId: null, executorEventId: "decision:second", createdAt: now.toISOString()
    });
    const second = methods.generateFromTask(secondSource.id);
    const adoptedSecond = promoteCandidate(second.id);
    expect(adoptedSecond.generation).toBe(2);
    expect(adoptedSecond.previousVersionId).toBe(first.id);
    expect(store.getMethodCandidate(first.id)?.status).toBe("superseded");
    expect(store.listMethodCandidates("adopted")).toHaveLength(1);

    const reverted = methods.rollback(second.id, "新方法回归");
    expect(reverted.status).toBe("reverted");
    expect(store.getMethodCandidate(first.id)?.status).toBe("adopted");
    expect(store.getMethodCandidate(first.id)?.retiredAt).toBeNull();
  });

  it("requires injection evidence for a trial", () => {
    const source = terminalTask("completed");
    const candidate = methods.generateFromTask(source.id);
    const uninjected = terminalTask("completed");
    expect(() => methods.recordTrial(candidate.id, uninjected.id))
      .toThrowError(expect.objectContaining({ code: "METHOD_TRIAL_NOT_INJECTED" }));

    injectMethod(uninjected.id, candidate.id, candidate.version + 1);
    expect(() => methods.recordTrial(candidate.id, uninjected.id))
      .toThrowError(expect.objectContaining({ code: "METHOD_TRIAL_VERSION_MISMATCH" }));
  });

  it("does not promote flat or permission-expanded candidates", () => {
    const source = terminalTask("completed");
    const baseline = [source, terminalTask("completed")];
    const trials = [terminalTask("completed"), terminalTask("completed")];
    const candidate = methods.generateFromTask(source.id);
    for (const trial of trials) {
      injectMethod(trial.id, candidate.id, candidate.version);
      methods.recordTrial(candidate.id, trial.id);
    }
    const evaluation = methods.evaluate(candidate.id, {
      baselineTaskIds: baseline.map((task) => task.id),
      trialTaskIds: trials.map((task) => task.id)
    });
    expect(evaluation.verdict).toBe("flat");
    expect(() => methods.promote(candidate.id)).toThrowError(MethodError);
  });

  it("suggests paired baseline and injected trial samples", () => {
    const source = terminalTask("completed");
    const otherBaseline = terminalTask("completed");
    const trials = [terminalTask("completed"), terminalTask("completed")];
    const candidate = methods.generateFromTask(source.id);
    for (const trial of trials) {
      injectMethod(trial.id, candidate.id, candidate.version);
      methods.recordTrial(candidate.id, trial.id);
    }

    const pairing = methods.pairingSuggestion(candidate.id);
    expect(pairing.trialTaskIds.sort()).toEqual(trials.map((task) => task.id).sort());
    expect(pairing.baselineTaskIds).toContain(otherBaseline.id);
    expect(pairing.baselineTaskIds).not.toContain(trials[0]?.id);
    expect(pairing.notes.length).toBeGreaterThan(0);
  });
});

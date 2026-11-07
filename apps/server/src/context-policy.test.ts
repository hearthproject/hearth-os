import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "@hearth/core";
import { DEFAULT_CONTEXT_SETTINGS } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { applyDiagnosisAdvice, classifyFailure, decideFailure, evaluateHandoff } from "./context-policy.ts";
import { HearthService } from "./service.ts";
import { UnsupportedInputError } from "./workspace.ts";

describe("context fallback policy", () => {
  let root: string | null = null;
  let store: HearthStore | null = null;
  let service: HearthService;

  afterEach(() => {
    store?.close();
    store = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function setup(): HearthService {
    root = mkdtempSync(join(tmpdir(), "hearth-policy-"));
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    return service;
  }

  it("classifies delivery failures as contract failures before missing input", () => {
    const service = setup();
    const task = service.createTask({ title: "delivery", goal: "write result" });
    const run = createRun(service, task.id);
    expect(classifyFailure({ service, task, run, error: new Error("缺少期望产物：result.md"), aborted: false, stopping: false })).toBe("contract_failure");
    expect(classifyFailure({ service, task, run, error: new Error("ECONNRESET"), aborted: false, stopping: false })).toBe("transient");
    expect(classifyFailure({ service, task, run, error: new Error("权限不足，需要审批"), aborted: false, stopping: false })).toBe("permission");
    expect(classifyFailure({ service, task, run, error: new Error("spawn native-runtime ENOENT: process crashed"), aborted: false, stopping: false })).toBe("runtime_fault");
    expect(classifyFailure({ service, task, run, error: new UnsupportedInputError("GitHub 输入不可用"), aborted: false, stopping: false })).toBe("input_missing");
  });

  it("lets uncertain effects block automatic handoff", () => {
    const service = setup();
    const task = service.createTask({ title: "risk", goal: "publish" });
    const run = createRun(service, task.id);
    service.createEffect({
      id: "effect-1", taskId: task.id, approvalId: "approval-1", kind: "github.comment",
      idempotencyKey: "comment:1", status: "uncertain", target: {}, receipt: null, error: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    expect(classifyFailure({ service, task, run, error: new Error("某一步失败"), aborted: false, stopping: false })).toBe("effect_uncertain");
    const evaluation = evaluateHandoff({
      service, task, targetExecutor: "codex", targetAvailable: true,
      settings: DEFAULT_CONTEXT_SETTINGS, taskWorkspace: join(root ?? "", "task")
    });
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.highRisk).toBe(false);
  });

  it("marks network and write-root expansion as high risk", () => {
    const service = setup();
    const task = service.createTask({ title: "network", goal: "fetch", networkHosts: ["api.example.com"] });
    const network = evaluateHandoff({
      service, task, targetExecutor: "codex", targetAvailable: true,
      settings: DEFAULT_CONTEXT_SETTINGS, taskWorkspace: join(root ?? "", "task")
    });
    expect(network.eligible).toBe(true);
    expect(network.highRisk).toBe(true);

    const writeTask = service.createTask({
      title: "write", goal: "edit", permissions: {
        readRoots: [], writeRoots: [join(root ?? "", "outside")], networkHosts: [], tools: []
      }
    });
    const write = evaluateHandoff({
      service, task: writeTask, targetExecutor: "codex", targetAvailable: true,
      settings: DEFAULT_CONTEXT_SETTINGS, taskWorkspace: join(root ?? "", "task")
    });
    expect(write.eligible).toBe(true);
    expect(write.highRisk).toBe(true);
    expect(write.reason).toContain("写权限");
  });

  it("marks approval templates as high risk", () => {
    const service = setup();
    const task = service.createTask({ templateId: "T08", executorId: "native" });
    const evaluation = evaluateHandoff({
      service, task, targetExecutor: "codex", targetAvailable: true,
      settings: DEFAULT_CONTEXT_SETTINGS, taskWorkspace: join(root ?? "", "task")
    });
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.highRisk).toBe(true);
  });

  it("applies retry, handoff limits and user confirmation", () => {
    const evaluation = { targetAvailable: true, eligible: true, highRisk: false, reason: "low risk" };
    expect(decideFailure({
      cause: "transient", settings: DEFAULT_CONTEXT_SETTINGS, evaluation, targetExecutor: "codex",
      retriesUsed: 0, handoffsUsed: 0, attemptedExecutors: ["native"]
    }).action).toBe("retry_same");
    expect(decideFailure({
      cause: "capability_gap", settings: DEFAULT_CONTEXT_SETTINGS, evaluation, targetExecutor: "codex",
      retriesUsed: 1, handoffsUsed: 0, attemptedExecutors: ["native"]
    }).action).toBe("handoff");
    expect(decideFailure({
      cause: "capability_gap", settings: DEFAULT_CONTEXT_SETTINGS, evaluation, targetExecutor: "codex",
      retriesUsed: 1, handoffsUsed: 1, attemptedExecutors: ["native"]
    }).action).toBe("ask_user");
    expect(decideFailure({
      cause: "capability_gap", settings: DEFAULT_CONTEXT_SETTINGS, evaluation, targetExecutor: "codex",
      retriesUsed: 1, handoffsUsed: 0, attemptedExecutors: ["native", "codex"]
    }).action).toBe("ask_user");
    expect(decideFailure({
      cause: "permission", settings: DEFAULT_CONTEXT_SETTINGS, evaluation, targetExecutor: "codex",
      retriesUsed: 0, handoffsUsed: 0, attemptedExecutors: ["native"]
    }).action).toBe("ask_user");
  });

  it("lets a confident model diagnosis tighten but not loosen the deterministic decision", () => {
    const decision = {
      cause: "capability_gap" as const,
      action: "handoff" as const,
      targetExecutor: "codex" as const,
      autoAllowed: true,
      highRisk: false,
      reason: "低风险"
    };
    expect(applyDiagnosisAdvice(decision, {
      source: "model", confidence: 0.9, summary: "需要用户确认外部账号", recommendedAction: "ask_user"
    }).action).toBe("ask_user");
    expect(applyDiagnosisAdvice(decision, {
      source: "model", confidence: 0.9, summary: "建议继续", recommendedAction: "handoff"
    }).action).toBe("handoff");
    expect(applyDiagnosisAdvice(decision, {
      source: "rules", confidence: 1, summary: "规则判断", recommendedAction: "ask_user"
    }).action).toBe("handoff");
  });
});

function createRun(service: HearthService, taskId: string): RunRecord {
  const now = new Date().toISOString();
  const run: RunRecord = {
    id: `run-${taskId}`, taskId, attempt: 1, status: "failed", threadId: null, workspace: "workspace",
    startedAt: now, endedAt: now, failure: null, usage: null, leaseEpoch: null, createdAt: now,
    executorId: "native"
  };
  service.createRun(run);
  return run;
}


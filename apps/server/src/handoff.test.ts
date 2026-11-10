import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HandoffPacket, RunRecord, TaskRecord } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { ContextService } from "./context.ts";
import { HandoffService } from "./handoff.ts";
import { HearthService } from "./service.ts";

describe("HandoffService", () => {
  let root: string;
  let store: HearthStore;
  let service: HearthService;
  let context: ContextService;
  let handoffs: HandoffService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-handoff-"));
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    context = new ContextService(service, join(root, "blobs"));
    handoffs = new HandoffService(service, context);
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("increments handoff generation and rejects writes from an older generation", () => {
    const task = createTask(service, root);
    const first = handoffs.prepare(prepareInput(task, "run-1", packet(task)));
    const run = createRun(service, task.id, "run-1", first.handoff.id);
    const second = handoffs.prepare(prepareInput(task, "run-2", packet(task)));

    expect(first.handoff.generation).toBe(1);
    expect(second.handoff.generation).toBe(2);
    expect(second.packet.sourceCursor).toBeGreaterThanOrEqual(0);
    expect(() => context.record({
      taskId: task.id,
      runId: run.id,
      executorId: "native",
      kind: "tool_result",
      role: "tool",
      content: "旧执行器继续写入",
      executorEventId: "stale-write-1"
    })).toThrowError(expect.objectContaining({ code: "HANDOFF_GENERATION_STALE" }));
    expect(() => handoffs.assertFreshGeneration(task.id, 1)).toThrowError(
      expect.objectContaining({ code: "HANDOFF_GENERATION_STALE" })
    );
  });

  it("redacts secrets and marks the redacted fields in the packet", () => {
    const task = createTask(service, root);
    const packetWithSecret = packet(task);
    packetWithSecret.goal = "同步 api_key=super-secret-value 到新执行器";
    const prepared = handoffs.prepare(prepareInput(task, "run-1", packetWithSecret));

    expect(prepared.packet.goal).not.toContain("super-secret-value");
    expect(prepared.packet.goal).toContain("[REDACTED]");
    expect(prepared.packet.redaction.redactedFields).toContain("goal");
    expect(store.getHandoff(prepared.handoff.id)?.packet?.goal).not.toContain("super-secret-value");
  });

  it("rejects permission escalation and defaults a missing verification action", () => {
    const task = createTask(service, root);
    const escalated = packet(task);
    escalated.permissions.readRoots = [join(root, "..", "outside")];
    expect(() => handoffs.prepare(prepareInput(task, "run-1", escalated))).toThrowError(
      expect.objectContaining({ code: "HANDOFF_PERMISSION_ESCALATION" })
    );

    const noAction = packet(task);
    noAction.verification.action = "";
    noAction.verification.expected = [];
    const prepared = handoffs.prepare(prepareInput(task, "run-1", noAction));
    expect(prepared.handoff.artifactRef).toBeNull();
    expect(prepared.packet.verification.action).toContain("最小验证");
    expect(prepared.packet.verification.expected.length).toBeGreaterThan(0);
    expect(prepared.packet.verification.status).toBe("pending");
  });

  it("allows terminal evidence from a closed handoff but rejects execution writes", () => {
    const task = createTask(service, root);
    const first = handoffs.prepare(prepareInput(task, "run-1", packet(task)));
    const run = createRun(service, task.id, "run-1", first.handoff.id);
    context.updateHandoff(first.handoff.id, { status: "failed" });

    expect(() => context.record({
      taskId: task.id,
      runId: run.id,
      executorId: "native",
      kind: "tool_result",
      role: "tool",
      content: "失败后继续执行",
      executorEventId: "closed-write-1"
    })).toThrowError(expect.objectContaining({ code: "HANDOFF_GENERATION_STALE" }));

    const diagnosis = context.record({
      taskId: task.id,
      runId: run.id,
      executorId: "native",
      kind: "diagnosis",
      role: "system",
      content: "执行器失败，记录终态诊断",
      executorEventId: "closed-diagnosis-1"
    });
    expect(diagnosis.kind).toBe("diagnosis");
  });

  it("verifies artifact hashes and persists passed or failed verification", () => {
    const task = createTask(service, root);
    const artifactDir = join(root, "artifacts");
    const artifactPath = join(artifactDir, "report.md");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(artifactPath, "verified evidence\n", "utf8");
    const sha256 = createHash("sha256").update("verified evidence\n").digest("hex");
    const packetWithArtifact = packet(task);
    packetWithArtifact.artifacts = [{
      path: "report.md",
      sha256,
      bytes: Buffer.byteLength("verified evidence\n"),
      mimeType: "text/markdown; charset=utf-8"
    }];
    const prepared = handoffs.prepare(prepareInput(task, "run-1", packetWithArtifact));

    const passed = handoffs.verify(prepared.packet, { baseDir: artifactDir });
    expect(passed.status).toBe("passed");
    const marked = handoffs.markVerification(prepared.handoff.id, passed);
    expect(marked?.verification?.status).toBe("passed");

    writeFileSync(artifactPath, "tampered evidence\n", "utf8");
    const failed = handoffs.verify(prepared.packet, { baseDir: artifactDir });
    expect(failed.status).toBe("failed");
    expect(failed.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "artifact:report.md", ok: false, detail: "哈希不一致" })
    ]));
    const markedFailed = handoffs.markVerification(prepared.handoff.id, failed);
    expect(markedFailed?.verification?.status).toBe("failed");
    expect(store.getHandoff(prepared.handoff.id)?.packet?.verification.status).toBe("failed");
  });
});

function createTask(service: HearthService, root: string): TaskRecord {
  return service.createTask({
    title: "跨 Provider 交接",
    goal: "保持目标、约束、证据和下一步可追溯",
    permissions: {
      readRoots: [root],
      writeRoots: [root],
      networkHosts: ["api.example.com"],
      tools: ["read_file", "finish_task"]
    }
  });
}

function packet(task: TaskRecord): HandoffPacket {
  const now = "2026-11-10T03:10:00.000Z";
  return {
    handoffId: "pending",
    taskId: task.id,
    fromRunId: "run-1",
    fromExecutor: "native",
    toExecutor: "codex",
    generation: 0,
    sourceCursor: 0,
    createdAt: now,
    goal: task.goal,
    acceptance: ["所有证据可读取", "下一步明确"],
    permissions: {
      readRoots: [...(task.permissions?.readRoots ?? [])],
      writeRoots: [...(task.permissions?.writeRoots ?? [])],
      networkHosts: [...(task.permissions?.networkHosts ?? [])],
      tools: [...(task.permissions?.tools ?? [])]
    },
    remainingBudget: { maxTurns: 4, maxToolCalls: 8, maxTokens: 4_000, maxDurationMs: 60_000 },
    summary: "已完成只读检索，下一步补丁提案",
    completed: [{ text: "检索目录", contextItemId: null }],
    failed: [],
    artifacts: [],
    doNotRepeat: ["不要重复发送外部消息"],
    openQuestions: [],
    nextAction: "读取报告并提交补丁提案",
    omittedHistory: ["thread:omitted-1"],
    redaction: { policy: "host-redaction-v1", redactedFields: [] },
    verification: {
      action: "读取工作区并核对目标、权限和证据",
      expected: ["目标一致", "权限未扩大", "证据可读取"],
      status: "pending",
      checkedAt: null,
      evidenceRefs: []
    }
  };
}

function prepareInput(task: TaskRecord, fromRunId: string, packetValue: HandoffPacket) {
  return {
    taskId: task.id,
    fromRunId,
    fromExecutor: "native" as const,
    toExecutor: "codex" as const,
    status: "prepared" as const,
    reasonCode: "capability_gap" as const,
    diagnosis: null,
    packet: packetValue,
    initiatedBy: "auto" as const,
    contextWatermarkSeq: 2
  };
}

function createRun(service: HearthService, taskId: string, id: string, handoffId: string): RunRecord {
  const now = "2026-11-10T03:10:00.000Z";
  const run: RunRecord = {
    id,
    taskId,
    attempt: 1,
    status: "running",
    threadId: null,
    workspace: "workspace",
    startedAt: now,
    endedAt: null,
    failure: null,
    usage: null,
    leaseEpoch: null,
    createdAt: now,
    executorId: "native",
    handoffId
  };
  service.createRun(run);
  return run;
}

import { describe, expect, it } from "vitest";
import type { ArtifactRecord, ContextItem, RunCheckpointRecord, RunRecord, TaskRecord } from "@hearth/core";
import { buildRunEvidence } from "./run-evidence.ts";

const now = new Date("2026-11-23T00:00:00.000Z");

it("exports recovery, cleanup, usage, artifacts and checkpoint references", () => {
  const task = {
    id: "task-1", title: "演示", status: "failed", executorId: "native",
    error: { kind: "execution_failed", message: "boom", recoverable: true }
  } as TaskRecord;
  const run = {
    id: "run-2", taskId: "task-1", attempt: 2, status: "failed", threadId: null,
    startedAt: "2026-11-20T00:00:00.000Z", endedAt: "2026-11-20T00:01:00.000Z",
    failure: { kind: "execution_failed", message: "boom", recoverable: true },
    usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 },
    leaseEpoch: 1, createdAt: "2026-11-20T00:00:00.000Z", executorId: "native", checkpointSeq: 1, budget: {},
    parentRunId: "run-1", handoffId: null
  } as RunRecord;
  const checkpoint = {
    id: "cp", runId: "run-2", taskId: "task-1", seq: 4, kind: "tool", path: ".hearth/checkpoints/run-2/4.json",
    sha256: "a".repeat(64), usage: null, createdAt: now.toISOString(), eventSeq: 88
  } as RunCheckpointRecord;
  const artifacts = [{
    id: "art-1", taskId: "task-1", runId: "run-2", relativePath: "result.md", absolutePath: "/tmp/result.md",
    mimeType: "text/markdown", sha256: "b".repeat(64), bytes: 20, createdAt: now.toISOString()
  } satisfies ArtifactRecord];
  const recovery = [
    recoveryItem("resume", "auto_resume_check"),
    recoveryItem("reconcile", "retry_gate"),
    { ...recoveryItem("manual", "other"), provenance: { source: "codex" } }
  ] as ContextItem[];

  const evidence = buildRunEvidence({
    task, run, runs: [run], checkpoint, artifacts, recovery, now,
    operations: [
      { operationId: "op-1", runId: "run-2", toolName: "shell", effect: "external_write", phase: "settled", cleanupState: "pending", cleanupAttempts: 1, resources: [{ kind: "process", pid: 42 }], cleanupError: null, settledAt: now.toISOString() },
      { operationId: "op-old", runId: "run-1", toolName: "read_file", effect: "read", phase: "settled", cleanupState: "confirmed", cleanupAttempts: 0, resources: [], cleanupError: null, settledAt: now.toISOString() }
    ]
  });

  expect(evidence.format).toBe("hearth-run-evidence");
  expect(evidence.task.status).toBe("failed");
  expect(evidence.run.usage?.inputTokens).toBe(10);
  expect(evidence.checkpoint).toMatchObject({ seq: 4, eventSeq: 88 });
  expect(evidence.recovery.map((item) => item.decision)).toEqual(["resume", "reconcile"]);
  expect(evidence.operations.map((operation) => operation.operationId)).toEqual(["op-1"]);
  expect(evidence.operations[0]?.resources).toEqual([{ kind: "process", pid: 42 }]);
  expect(evidence.artifacts[0]?.relativePath).toBe("result.md");
  expect(evidence.runs[0]?.parentRunId).toBe("run-1");
});

function recoveryItem(decision: string, phase: string): ContextItem {
  return {
    seq: 1, id: `ctx-${phase}`, conversationId: null, taskId: "task-1", runId: "run-2", executorId: "native",
    kind: "decision", role: "system", content: `recovery:${decision}`, contentRef: null, sha256: null, tokens: 1,
    sensitivity: "normal", provenance: { source: "scheduler-recovery", phase, decision, reasons: [] },
    parentId: null, executorEventId: null, createdAt: now.toISOString()
  };
}

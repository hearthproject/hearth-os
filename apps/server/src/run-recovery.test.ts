import { describe, expect, it } from "vitest";
import {
  evaluateRunRecovery,
  runChainFor,
  stableDigest,
  type RecoveryView
} from "./run-recovery.ts";
import type { RunOperationRecord } from "@hearth/eventlog";

const NOW = Date.parse("2026-11-23T10:00:00.000Z");

const PERMISSIONS = {
  readRoots: ["."],
  writeRoots: ["."],
  networkHosts: [],
  tools: ["read_file", "shell"],
  approvalMode: "workspace" as const,
  sandboxMode: "workspace-write" as const
};

function permissionDigest(): string {
  return stableDigest(PERMISSIONS);
}

function operation(overrides: Partial<RunOperationRecord>): RunOperationRecord {
  return {
    operationId: "run-1:call-1",
    runId: "run-1",
    taskId: "task-1",
    toolCallId: "call-1",
    toolName: "shell",
    argsHash: "args",
    effect: "unknown",
    phase: "dispatched",
    attempt: 1,
    beforeDigest: null,
    workspaceDigest: null,
    permissionsDigest: permissionDigest(),
    startedAt: "2026-11-23T08:00:00.000Z",
    dispatchedAt: "2026-11-23T08:00:01.000Z",
    settledAt: null,
    resultDigest: null,
    outputRef: null,
    errorCode: null,
    effectRef: null,
    receipt: null,
    cleanupState: "none",
    cleanupAttempts: 0,
    resources: [],
    cleanupError: null,
    cleanupAt: null,
    updatedAt: "2026-11-23T08:00:02.000Z",
    ...overrides
  };
}

function view(overrides: Partial<RecoveryView> = {}): RecoveryView {
  return {
    task: {
      id: "task-1",
      executorId: "native",
      permissions: PERMISSIONS
    },
    run: {
      id: "run-1",
      attempt: 1,
      status: "failed",
      executorId: "native",
      startedAt: "2026-11-23T08:00:00.000Z",
      parentRunId: null
    },
    runChain: [],
    operations: [],
    effects: [],
    checkpoint: {
      id: "checkpoint-1",
      runId: "run-1",
      taskId: "task-1",
      seq: 3,
      kind: "turn",
      path: "checkpoint.json",
      sha256: "sha",
      usage: null,
      createdAt: "2026-11-23T08:00:00.000Z",
      proof: {
        attemptId: "run-1",
        identity: { executorId: "native", runtimeVersion: "test" },
        phasePrefix: ["run.start"],
        effectReceipts: [],
        preparedIntents: [],
        createdAt: "2026-11-23T08:00:00.000Z",
        permissionsDigest: permissionDigest()
      }
    },
    checkpointReadable: true,
    interruptedCount: 0,
    nowMs: NOW,
    ...overrides
  };
}

describe("evaluateRunRecovery", () => {
  it("resumes when no side effect is unsettled", () => {
    const decision = evaluateRunRecovery(view());
    expect(decision.kind).toBe("resume");
    expect(decision.autoResume).toBe(true);
  });

  it("treats a prepared-only operation as replayable", () => {
    const decision = evaluateRunRecovery(view({
      operations: [operation({ phase: "prepared", effect: "external_write" })]
    }));
    expect(decision.kind).toBe("resume");
    expect(decision.reasons.some((reason) => reason.code === "OPERATION_PREPARED")).toBe(true);
  });

  it("reconciles an unsettled external write instead of replaying it", () => {
    const decision = evaluateRunRecovery(view({
      operations: [operation({ effect: "external_write", phase: "dispatched" })]
    }));
    expect(decision.kind).toBe("reconcile");
    expect(decision.autoResume).toBe(false);
    expect(decision.reasons.some((reason) => reason.code === "OPERATION_UNSETTLED_UNSAFE")).toBe(true);
  });

  it("reconciles an unsettled destructive or unknown effect", () => {
    for (const effect of ["destructive", "unknown"]) {
      const decision = evaluateRunRecovery(view({
        operations: [operation({ effect })]
      }));
      expect(decision.kind).toBe("reconcile");
    }
  });

  it("auto-resumes when an unsettled read or local write can be verified", () => {
    for (const effect of ["read", "local_write"]) {
      const decision = evaluateRunRecovery(view({
        operations: [operation({ effect })]
      }));
      expect(decision.kind).toBe("resume");
      expect(decision.reasons.some((reason) => reason.code === "OPERATION_UNSETTLED_READ")).toBe(true);
    }
  });

  it("reconciles unresolved effects from the effect ledger", () => {
    const decision = evaluateRunRecovery(view({
      effects: [{ id: "effect-1", status: "uncertain" } as never]
    }));
    expect(decision.kind).toBe("reconcile");
  });

  it("requires a manual decision when the checkpoint is missing or unreadable", () => {
    expect(evaluateRunRecovery(view({ checkpoint: null })).kind).toBe("manual");
    expect(evaluateRunRecovery(view({ checkpointReadable: false })).kind).toBe("manual");
    expect(evaluateRunRecovery(view({
      checkpoint: { ...view().checkpoint!, kind: "final" }
    })).kind).toBe("manual");
  });

  it("requires a manual decision when permissions changed", () => {
    const decision = evaluateRunRecovery(view({
      task: {
        id: "task-1",
        executorId: "native",
        permissions: { ...PERMISSIONS, tools: ["read_file"] }
      }
    }));
    expect(decision.kind).toBe("manual");
    expect(decision.reasons.some((reason) => reason.code === "PERMISSIONS_CHANGED")).toBe(true);
  });

  it("stops auto-resume after too many interruptions or when too old", () => {
    expect(evaluateRunRecovery(view({ interruptedCount: 5 })).kind).toBe("manual");
    expect(evaluateRunRecovery(view({
      run: { ...view().run, startedAt: "2026-11-19T08:00:00.000Z" }
    })).kind).toBe("manual");
  });
});

describe("runChainFor", () => {
  it("walks parentRunId to the root so old attempts stay in scope", () => {
    const runs = [
      { id: "run-1", taskId: "task-1", attempt: 1, status: "failed", threadId: null, workspace: "w", startedAt: "2026-11-23T08:00:00.000Z", endedAt: null, failure: null, usage: null, leaseEpoch: 1, createdAt: "2026-11-23T08:00:00.000Z", executorId: "native", parentRunId: null },
      { id: "run-2", taskId: "task-1", attempt: 2, status: "failed", threadId: null, workspace: "w", startedAt: "2026-11-23T09:00:00.000Z", endedAt: null, failure: null, usage: null, leaseEpoch: 1, createdAt: "2026-11-23T09:00:00.000Z", executorId: "native", parentRunId: "run-1" },
      { id: "run-3", taskId: "task-1", attempt: 3, status: "running", threadId: null, workspace: "w", startedAt: "2026-11-23T10:00:00.000Z", endedAt: null, failure: null, usage: null, leaseEpoch: 1, createdAt: "2026-11-23T10:00:00.000Z", executorId: "native", parentRunId: "run-2" }
    ] as never[];
    const chain = runChainFor(runs, "run-3");
    expect(chain.map((run) => run.id)).toEqual(["run-1", "run-2", "run-3"]);
  });
});

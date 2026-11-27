import type { ArtifactRecord, ContextItem, RunCheckpointRecord, RunRecord, TaskRecord } from "@hearth/core";

/** `RunOperationRecord` is owned by eventlog; accept the shape without coupling services. */
export interface RunEvidenceOperation {
  operationId: string;
  runId: string;
  toolName: string;
  effect: string;
  phase: string;
  cleanupState: string;
  cleanupAttempts: number;
  resources: unknown[];
  cleanupError: string | null;
  settledAt: string | null;
}

export interface AgentModeEvidence {
  requested: "single" | "team";
  /** Old evidence may say executor-managed; new runs always resolve to single/team. */
  effective: "single" | "team" | "executor-managed";
  executorId: string;
  owner?: string;
  guarantee?: string;
  capability?: string;
  visibility?: string;
  configApplied?: boolean;
  degraded?: boolean;
  observed?: { members: number; eventsReceived: boolean; source: string };
  usage?: "full" | "total-only" | "none";
  reason?: string;
}

export interface RunEvidenceInput {
  task: TaskRecord;
  run: RunRecord;
  runs: RunRecord[];
  checkpoint: RunCheckpointRecord | null;
  operations: RunEvidenceOperation[];
  artifacts: ArtifactRecord[];
  recovery: ContextItem[];
  agentMode?: AgentModeEvidence | null;
  now?: Date;
}

export interface RunEvidence {
  format: "hearth-run-evidence";
  version: 1;
  generatedAt: string;
  task: Pick<TaskRecord, "id" | "title" | "status" | "executorId" | "error">;
  run: Pick<RunRecord, "id" | "attempt" | "status" | "threadId" | "startedAt" | "endedAt" | "failure" | "usage">;
  agentMode?: AgentModeEvidence | null;
  checkpoint: { seq: number; kind: string; path: string; sha256: string; eventSeq: number | null } | null;
  recovery: Array<{ phase: unknown; decision: unknown; reasons: unknown; content: string; createdAt: string }>;
  operations: RunEvidenceOperation[];
  artifacts: Array<Pick<ArtifactRecord, "id" | "runId" | "relativePath" | "mimeType" | "sha256" | "bytes">>;
  runs: Array<Pick<RunRecord, "id" | "attempt" | "status" | "endedAt" | "parentRunId">>;
}

export function buildRunEvidence(input: RunEvidenceInput): RunEvidence {
  return {
    format: "hearth-run-evidence",
    version: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    task: {
      id: input.task.id,
      title: input.task.title,
      status: input.task.status,
      ...(input.task.executorId ? { executorId: input.task.executorId } : {}),
      error: input.task.error
    },
    run: {
      id: input.run.id,
      attempt: input.run.attempt,
      status: input.run.status,
      threadId: input.run.threadId,
      startedAt: input.run.startedAt,
      endedAt: input.run.endedAt,
      failure: input.run.failure,
      usage: input.run.usage
    },
    ...(input.agentMode ? { agentMode: input.agentMode } : {}),
    checkpoint: input.checkpoint ? {
      seq: input.checkpoint.seq,
      kind: input.checkpoint.kind,
      path: input.checkpoint.path,
      sha256: input.checkpoint.sha256,
      eventSeq: input.checkpoint.eventSeq ?? null
    } : null,
    recovery: input.recovery
      .filter((item) => item.provenance.source === "scheduler-recovery")
      .slice(0, 10)
      .map((item) => ({
        phase: item.provenance.phase ?? null,
        decision: item.provenance.decision ?? null,
        reasons: item.provenance.reasons ?? [],
        content: item.content,
        createdAt: item.createdAt
      })),
    operations: input.operations.map((operation) => ({
      operationId: operation.operationId,
      runId: operation.runId,
      toolName: operation.toolName,
      effect: operation.effect,
      phase: operation.phase,
      cleanupState: operation.cleanupState,
      cleanupAttempts: operation.cleanupAttempts,
      resources: operation.resources,
      cleanupError: operation.cleanupError,
      settledAt: operation.settledAt
    })).filter((operation) => operation.runId === input.run.id || operation.cleanupState === "pending"),
    artifacts: input.artifacts.map((artifact) => ({
      id: artifact.id,
      runId: artifact.runId,
      relativePath: artifact.relativePath,
      mimeType: artifact.mimeType,
      sha256: artifact.sha256,
      bytes: artifact.bytes
    })),
    runs: input.runs.map((run) => ({
      id: run.id,
      attempt: run.attempt,
      status: run.status,
      endedAt: run.endedAt,
      parentRunId: run.parentRunId ?? null
    }))
  };
}

/** Accepts the eventlog record shape; the scheduler maps it into this view. */

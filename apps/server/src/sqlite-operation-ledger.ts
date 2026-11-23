import type {
  AgentToolEffect,
  DispatchOperationInput,
  OperationFact,
  OperationLedger,
  OperationPhase,
  OperationResourceRef,
  PrepareOperationInput,
  SettleCleanupInput,
  SettleOperationInput
} from "@hearth/agent-runtime";
import type { HearthStore, RunOperationRecord } from "@hearth/eventlog";

/**
 * Server-mode operation ledger backed by the single SQLite writer.
 *
 * The runtime only sees the OperationLedger interface; it never imports
 * node:sqlite and remains usable in standalone/eval mode.
 */
export class SqliteOperationLedger implements OperationLedger {
  constructor(private readonly store: HearthStore) {}

  async prepare(input: PrepareOperationInput): Promise<OperationFact> {
    return toFact(this.store.prepareRunOperation({
      operationId: input.operationId,
      runId: input.runId,
      taskId: input.taskId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      argsHash: input.argsHash,
      effect: input.effect,
      attempt: input.attempt ?? 1,
      beforeDigest: input.beforeDigest ?? null,
      workspaceDigest: input.workspaceDigest ?? null,
      permissionsDigest: input.permissionsDigest ?? null,
      ...(input.startedAt ? { startedAt: input.startedAt } : {})
    }));
  }

  async dispatch(input: DispatchOperationInput): Promise<OperationFact> {
    return toFact(this.store.dispatchRunOperation(input.operationId, input.dispatchedAt));
  }

  async settle(input: SettleOperationInput): Promise<OperationFact> {
    return toFact(this.store.settleRunOperation({
      operationId: input.operationId,
      phase: input.phase,
      resultDigest: input.resultDigest ?? null,
      outputRef: input.outputRef ?? null,
      errorCode: input.errorCode ?? null,
      effectRef: input.effectRef ?? null,
      ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
      ...(input.resources ? { resources: input.resources as OperationResourceRef[] } : {}),
      ...(input.settledAt ? { settledAt: input.settledAt } : {})
    }));
  }

  async settleCleanup(input: SettleCleanupInput): Promise<OperationFact> {
    return toFact(this.store.settleRunOperationCleanup({
      operationId: input.operationId,
      state: input.state,
      error: input.error ?? null,
      ...(input.at ? { at: input.at } : {})
    }));
  }

  async get(operationId: string): Promise<OperationFact | null> {
    const row = this.store.getRunOperation(operationId);
    return row ? toFact(row) : null;
  }

  async listUnsettled(runId: string): Promise<OperationFact[]> {
    return this.store.listUnsettledRunOperations(runId).map(toFact);
  }
}

function toFact(row: RunOperationRecord): OperationFact {
  return {
    operationId: row.operationId,
    runId: row.runId,
    taskId: row.taskId,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    argsHash: row.argsHash,
    effect: row.effect as AgentToolEffect,
    phase: row.phase as OperationPhase,
    attempt: row.attempt,
    beforeDigest: row.beforeDigest,
    workspaceDigest: row.workspaceDigest,
    permissionsDigest: row.permissionsDigest,
    startedAt: row.startedAt,
    dispatchedAt: row.dispatchedAt,
    settledAt: row.settledAt,
    resultDigest: row.resultDigest,
    outputRef: row.outputRef,
    errorCode: row.errorCode,
    effectRef: row.effectRef,
    receipt: row.receipt,
    cleanupState: row.cleanupState,
    cleanupAttempts: row.cleanupAttempts,
    resources: row.resources as OperationResourceRef[],
    cleanupError: row.cleanupError,
    cleanupAt: row.cleanupAt,
    updatedAt: row.updatedAt
  };
}

import type { AgentToolEffect } from "../types.ts";

/**
 * Durable phases for a single tool operation.
 *
 * prepared   — intent is durable, but no side effect may have happened yet.
 * dispatched — T1 is committed; the tool may have started and produced effects.
 * settled    — T2 is committed; the outcome is known and must not be replayed blindly.
 * unknown    — the outcome could not be settled (timeout, abort, crash, failed settle).
 */
export type OperationPhase = "prepared" | "dispatched" | "settled" | "unknown";

export type OperationFinalPhase = Extract<OperationPhase, "settled" | "unknown">;

/**
 * Physical cleanup is a separate axis from the business outcome.
 *
 * none      — the operation owns no physical resource.
 * pending   — the operation registered a resource (process, browser lease, ...)
 *             and it has not been confirmed gone yet.
 * confirmed — the resource is verifiably cleaned up.
 * failed    — cleanup was attempted and could not be confirmed.
 */
export type OperationCleanupState = "none" | "pending" | "confirmed" | "failed";

export interface OperationResourceRef {
  kind: "process" | "browser" | "worktree" | "subagent";
  id: string;
  meta?: Record<string, unknown>;
}

export interface OperationFact {
  operationId: string;
  runId: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  argsHash: string;
  effect: AgentToolEffect;
  phase: OperationPhase;
  attempt: number;
  beforeDigest: string | null;
  workspaceDigest: string | null;
  permissionsDigest: string | null;
  startedAt: string;
  dispatchedAt: string | null;
  settledAt: string | null;
  resultDigest: string | null;
  outputRef: string | null;
  errorCode: string | null;
  effectRef: string | null;
  receipt: unknown;
  cleanupState: OperationCleanupState;
  cleanupAttempts: number;
  resources: OperationResourceRef[];
  cleanupError: string | null;
  cleanupAt: string | null;
  updatedAt: string;
}

export interface PrepareOperationInput {
  operationId: string;
  runId: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  argsHash: string;
  effect: AgentToolEffect;
  attempt?: number;
  beforeDigest?: string | null;
  workspaceDigest?: string | null;
  permissionsDigest?: string | null;
  startedAt?: string;
}

export interface DispatchOperationInput {
  operationId: string;
  dispatchedAt?: string;
}

export interface SettleOperationInput {
  operationId: string;
  phase: OperationFinalPhase;
  resultDigest?: string | null;
  outputRef?: string | null;
  errorCode?: string | null;
  effectRef?: string | null;
  receipt?: unknown;
  resources?: OperationResourceRef[];
  settledAt?: string;
}

export interface SettleCleanupInput {
  operationId: string;
  state: Exclude<OperationCleanupState, "none" | "pending">;
  error?: string | null;
  at?: string;
}

export interface OperationLedger {
  prepare(input: PrepareOperationInput): Promise<OperationFact>;
  dispatch(input: DispatchOperationInput): Promise<OperationFact>;
  settle(input: SettleOperationInput): Promise<OperationFact>;
  settleCleanup(input: SettleCleanupInput): Promise<OperationFact>;
  get(operationId: string): Promise<OperationFact | null>;
  listUnsettled(runId: string): Promise<OperationFact[]>;
}

export type OperationLedgerErrorCode =
  | "OPERATION_NOT_PREPARED"
  | "OPERATION_NOT_DISPATCHED"
  | "OPERATION_ALREADY_DISPATCHED"
  | "OPERATION_ALREADY_SETTLED"
  | "OPERATION_ARGS_MISMATCH"
  | "OPERATION_SETTLE_MISMATCH"
  | "OPERATION_CLEANUP_SETTLED";

export class OperationLedgerError extends Error {
  readonly code: OperationLedgerErrorCode;

  constructor(code: OperationLedgerErrorCode, message: string) {
    super(message);
    this.name = "OperationLedgerError";
    this.code = code;
  }
}

export function operationIdFor(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}

export function isOperationFinalPhase(phase: OperationPhase): phase is OperationFinalPhase {
  return phase === "settled" || phase === "unknown";
}

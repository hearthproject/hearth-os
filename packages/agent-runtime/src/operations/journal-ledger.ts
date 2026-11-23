import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import {
  OperationLedgerError,
  isOperationFinalPhase,
  type DispatchOperationInput,
  type OperationFact,
  type OperationLedger,
  type PrepareOperationInput,
  type SettleCleanupInput,
  type SettleOperationInput
} from "./types.ts";

export interface JsonlOperationLedgerOptions {
  /** Omit for an in-memory ledger used by standalone tests and evals. */
  path?: string;
  /** Flush every transition before returning. Defaults to true. */
  fsync?: boolean;
}

interface JsonlEntry {
  version: 1;
  at: string;
  fact: OperationFact;
}

/**
 * Single-process JSONL operation ledger.
 *
 * Server mode injects the SQLite ledger instead. This implementation is the
 * standalone/eval path and the reference implementation for the contract.
 */
export class JsonlOperationLedger implements OperationLedger {
  private readonly path: string | null;
  private readonly fsyncEnabled: boolean;
  private readonly facts = new Map<string, OperationFact>();
  private fd: number | null = null;

  constructor(options: JsonlOperationLedgerOptions = {}) {
    this.path = options.path ?? null;
    this.fsyncEnabled = options.fsync !== false;
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.load();
      this.fd = openSync(this.path, "a");
    }
  }

  async prepare(input: PrepareOperationInput): Promise<OperationFact> {
    const existing = this.facts.get(input.operationId);
    if (existing) {
      if (existing.argsHash !== input.argsHash) {
        throw new OperationLedgerError(
          "OPERATION_ARGS_MISMATCH",
          `operation ${input.operationId} was prepared with different arguments`
        );
      }
      return cloneFact(existing);
    }
    const now = input.startedAt ?? new Date().toISOString();
    const fact: OperationFact = {
      operationId: input.operationId,
      runId: input.runId,
      taskId: input.taskId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      argsHash: input.argsHash,
      effect: input.effect,
      phase: "prepared",
      attempt: input.attempt ?? 1,
      beforeDigest: input.beforeDigest ?? null,
      workspaceDigest: input.workspaceDigest ?? null,
      permissionsDigest: input.permissionsDigest ?? null,
      startedAt: now,
      dispatchedAt: null,
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
      updatedAt: now
    };
    this.commit(fact);
    return cloneFact(fact);
  }

  async dispatch(input: DispatchOperationInput): Promise<OperationFact> {
    const existing = this.require(input.operationId);
    if (existing.phase === "dispatched") {
      throw new OperationLedgerError(
        "OPERATION_ALREADY_DISPATCHED",
        `operation ${input.operationId} is already dispatched`
      );
    }
    if (existing.phase === "settled" || existing.phase === "unknown") {
      throw new OperationLedgerError(
        "OPERATION_ALREADY_SETTLED",
        `operation ${input.operationId} is already ${existing.phase}`
      );
    }
    const now = input.dispatchedAt ?? new Date().toISOString();
    const fact: OperationFact = {
      ...existing,
      phase: "dispatched",
      dispatchedAt: now,
      updatedAt: now
    };
    this.commit(fact);
    return cloneFact(fact);
  }

  async settle(input: SettleOperationInput): Promise<OperationFact> {
    const existing = this.require(input.operationId);
    if (isOperationFinalPhase(existing.phase)) {
      if (existing.phase === input.phase
        && existing.resultDigest === (input.resultDigest ?? null)
        && existing.errorCode === (input.errorCode ?? null)) {
        return cloneFact(existing);
      }
      throw new OperationLedgerError(
        "OPERATION_SETTLE_MISMATCH",
        `operation ${input.operationId} is already ${existing.phase} with a different outcome`
      );
    }
    if (existing.phase === "prepared") {
      throw new OperationLedgerError(
        "OPERATION_NOT_DISPATCHED",
        `operation ${input.operationId} cannot settle before dispatch`
      );
    }
    const now = input.settledAt ?? new Date().toISOString();
    const resources = [...(input.resources ?? [])];
    const fact: OperationFact = {
      ...existing,
      phase: input.phase,
      settledAt: now,
      resultDigest: input.resultDigest ?? null,
      outputRef: input.outputRef ?? null,
      errorCode: input.errorCode ?? null,
      effectRef: input.effectRef ?? null,
      receipt: input.receipt ?? null,
      cleanupState: resources.length > 0 ? "pending" : "none",
      cleanupAttempts: resources.length > 0 ? 1 : 0,
      resources,
      cleanupError: null,
      cleanupAt: null,
      updatedAt: now
    };
    this.commit(fact);
    return cloneFact(fact);
  }

  async settleCleanup(input: SettleCleanupInput): Promise<OperationFact> {
    const existing = this.require(input.operationId);
    if (existing.cleanupState === "confirmed" || existing.cleanupState === "failed") {
      if (existing.cleanupState === input.state) return cloneFact(existing);
      throw new OperationLedgerError(
        "OPERATION_CLEANUP_SETTLED",
        `operation ${input.operationId} cleanup is already ${existing.cleanupState}`
      );
    }
    const now = input.at ?? new Date().toISOString();
    const fact: OperationFact = {
      ...existing,
      cleanupState: input.state,
      cleanupAttempts: existing.cleanupAttempts + 1,
      cleanupError: input.error ?? null,
      cleanupAt: now,
      updatedAt: now
    };
    this.commit(fact);
    return cloneFact(fact);
  }

  async get(operationId: string): Promise<OperationFact | null> {
    const fact = this.facts.get(operationId);
    return fact ? cloneFact(fact) : null;
  }

  async listUnsettled(runId: string): Promise<OperationFact[]> {
    return [...this.facts.values()]
      .filter((fact) => fact.runId === runId && fact.phase !== "settled")
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map(cloneFact);
  }

  list(): OperationFact[] {
    return [...this.facts.values()].map(cloneFact);
  }

  close(): void {
    if (this.fd === null) return;
    try {
      fsyncSync(this.fd);
    } catch {
      // best effort
    }
    closeSync(this.fd);
    this.fd = null;
  }

  private require(operationId: string): OperationFact {
    const fact = this.facts.get(operationId);
    if (!fact) {
      throw new OperationLedgerError(
        "OPERATION_NOT_PREPARED",
        `operation ${operationId} was not prepared`
      );
    }
    return fact;
  }

  private commit(fact: OperationFact): void {
    this.facts.set(fact.operationId, fact);
    if (this.fd === null) return;
    const line = `${JSON.stringify({ version: 1, at: fact.updatedAt, fact } satisfies JsonlEntry)}\n`;
    writeSync(this.fd, line);
    if (this.fsyncEnabled) fsyncSync(this.fd);
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    let content = "";
    try {
      content = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as JsonlEntry;
        if (!parsed.fact || typeof parsed.fact.operationId !== "string") continue;
        this.facts.set(parsed.fact.operationId, parsed.fact);
      } catch {
        // A torn tail is ignored; it never becomes a committed T1/T2 transition.
      }
    }
  }
}

function cloneFact(fact: OperationFact): OperationFact {
  return {
    ...fact,
    receipt: fact.receipt == null ? null : structuredClone(fact.receipt),
    resources: fact.resources.map((resource) => ({
      ...resource,
      ...(resource.meta ? { meta: structuredClone(resource.meta) } : {})
    }))
  };
}

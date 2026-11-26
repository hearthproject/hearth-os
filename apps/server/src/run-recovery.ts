import { createHash } from "node:crypto";
import type {
  EffectRecord,
  RunCheckpointRecord,
  RunRecord,
  TaskPermissions
} from "@hearth/core";
import type { RunOperationRecord } from "@hearth/eventlog";

/**
 * Task-level recovery gate.
 *
 * The runtime owns a single attempt. This module owns the question the runtime
 * must never answer alone: "may a new attempt start, given everything the run
 * family left behind?" It is a pure function over durable facts so it can be
 * tested without a store, a clock or a model.
 */

export type RecoveryKind = "resume" | "reconcile" | "manual";

export interface RecoveryReason {
  code: string;
  message: string;
  severity: "blocking" | "advisory";
  /** Present when the reason belongs to one concrete tool operation. */
  operationId?: string;
  toolName?: string;
  effect?: string;
}

export interface RecoveryDecision {
  kind: RecoveryKind;
  reasons: RecoveryReason[];
  /** True only when kind === "resume". */
  autoResume: boolean;
}

export interface RecoveryRun {
  id: string;
  attempt: number;
  status: string;
  executorId: string | null;
  startedAt: string;
  parentRunId: string | null;
}

export interface RecoveryView {
  task: {
    id: string;
    executorId: string | null;
    permissions: TaskPermissions | undefined;
  };
  /** The attempt that would be resumed or superseded. */
  run: RecoveryRun;
  /** Oldest → newest, including `run`. */
  runChain: RecoveryRun[];
  operations: RunOperationRecord[];
  effects: EffectRecord[];
  checkpoint: RunCheckpointRecord | null;
  checkpointReadable: boolean;
  interruptedCount: number;
  nowMs?: number;
}

const UNSAFE_EFFECTS = new Set(["external_write", "destructive", "unknown"]);
const OPEN_EFFECT_STATUSES = new Set(["prepared", "admitted", "executing", "uncertain"]);
const TERMINAL_CHECKPOINT_KINDS = new Set(["final", "waiting_input"]);

export function evaluateRunRecovery(view: RecoveryView): RecoveryDecision {
  const reasons: RecoveryReason[] = [];
  const blocking = (
    code: string,
    message: string,
    operation?: Pick<RunOperationRecord, "operationId" | "toolName" | "effect">
  ): void => {
    reasons.push({
      code,
      message,
      severity: "blocking",
      ...(operation
        ? { operationId: operation.operationId, toolName: operation.toolName, effect: operation.effect }
        : {})
    });
  };
  const advisory = (
    code: string,
    message: string,
    operation?: Pick<RunOperationRecord, "operationId" | "toolName" | "effect">
  ): void => {
    reasons.push({
      code,
      message,
      severity: "advisory",
      ...(operation
        ? { operationId: operation.operationId, toolName: operation.toolName, effect: operation.effect }
        : {})
    });
  };

  if ((view.task.executorId ?? view.run.executorId) !== "native") {
    blocking("EXECUTOR_NOT_NATIVE", "只有 native 执行器支持自动恢复");
  }

  const nowMs = view.nowMs ?? Date.now();
  const startedMs = Date.parse(view.run.startedAt);
  if (Number.isFinite(startedMs) && nowMs - startedMs > 72 * 60 * 60 * 1000) {
    blocking("RUN_TOO_OLD", "运行已超过 72 小时，等待用户确认");
  }

  if (view.interruptedCount >= 5) {
    blocking("INTERRUPTED_TOO_OFTEN", "自动恢复次数已达上限");
  }

  const openEffects = view.effects.filter((effect) => OPEN_EFFECT_STATUSES.has(effect.status));
  if (openEffects.length > 0) {
    blocking(
      "EFFECT_UNRESOLVED",
      `存在 ${openEffects.length} 个状态不确定的外部动作，必须先对账`
    );
  }

  for (const operation of view.operations) {
    // `unknown` normally means "we do not know whether it ran"; only an
    // explicit user reconciliation turns it into an accepted outcome.
    if (operation.phase === "settled" || operation.errorCode === "USER_RECONCILED") continue;
    if (operation.phase === "prepared") {
      // T1 was never committed, so no side effect can have happened. The next
      // attempt may dispatch the same call again.
      advisory(
        "OPERATION_PREPARED",
        `${operation.toolName}（${operation.toolCallId}）已登记但未派发，将重新执行`,
        operation
      );
      continue;
    }
    if (UNSAFE_EFFECTS.has(operation.effect)) {
      blocking(
        "OPERATION_UNSETTLED_UNSAFE",
        `${operation.toolName}（${operation.toolCallId}）结果未知（${operation.effect}），需要先核对工作区或外部状态`,
        operation
      );
      continue;
    }
    advisory(
      "OPERATION_UNSETTLED_READ",
      `${operation.toolName}（${operation.toolCallId}）结果未知，但属于 ${operation.effect}，可以核对后继续`,
      operation
    );
  }

  if (!view.checkpoint) {
    blocking("NO_CHECKPOINT", "没有可用检查点");
  } else {
    if (TERMINAL_CHECKPOINT_KINDS.has(view.checkpoint.kind)) {
      blocking("CHECKPOINT_TERMINAL", "检查点不是可继续状态");
    }
    if (!view.checkpointReadable) {
      blocking("CHECKPOINT_BODY_MISSING", "检查点文件缺失且事件日志中没有快照");
    }
    const expected = view.task.permissions ? stableDigest(view.task.permissions) : null;
    const recorded = view.checkpoint.proof?.permissionsDigest ?? null;
    if (recorded && expected && recorded !== expected) {
      blocking("PERMISSIONS_CHANGED", "权限已变化，等待用户确认");
    }
  }

  const blockingReasons = reasons.filter((reason) => reason.severity === "blocking");
  if (blockingReasons.length > 0) {
    const unsafe = blockingReasons.some((reason) =>
      reason.code === "OPERATION_UNSETTLED_UNSAFE"
      || reason.code === "EFFECT_UNRESOLVED"
    );
    return { kind: unsafe ? "reconcile" : "manual", reasons, autoResume: false };
  }
  return { kind: "resume", reasons, autoResume: true };
}

/**
 * Key-order-stable SHA-256 digest. Must stay byte-identical to the scheduler's
 * `hashStable`, because it is compared with `checkpoint.proof.permissionsDigest`.
 */
export function stableDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value) ?? "undefined").digest("hex");
}

function stableJson(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function runChainFor(runs: RunRecord[], runId: string | null): RecoveryRun[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const chain: RecoveryRun[] = [];
  let cursor = runId ? byId.get(runId) ?? null : null;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(toRecoveryRun(cursor));
    cursor = cursor.parentRunId ? byId.get(cursor.parentRunId) ?? null : null;
  }
  return chain.reverse();
}

function toRecoveryRun(run: RunRecord): RecoveryRun {
  return {
    id: run.id,
    attempt: run.attempt,
    status: run.status,
    executorId: run.executorId ?? null,
    startedAt: run.startedAt ?? run.createdAt,
    parentRunId: run.parentRunId ?? null
  };
}

/** Used by tests and diagnostics; never mutates the decision. */
export function describeDecision(decision: RecoveryDecision): string {
  const summary = decision.reasons
    .filter((reason) => reason.severity === "blocking")
    .map((reason) => `${reason.code}: ${reason.message}`)
    .join("; ");
  return summary || "可以自动继续";
}

import { estimateTokens } from "./context.ts";
import type { HearthService } from "./service.ts";

export interface ContextMetricsSnapshot {
  generatedAt: string;
  ledger: {
    tasks: number;
    items: number;
  };
  handoffs: {
    total: number;
    automatic: number;
    userConfirmed: number;
    pendingUser: number;
    prepared: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    successRate: number | null;
    averageContextTokens: number | null;
    averageRecoveryMs: number | null;
  };
  diagnosis: {
    total: number;
    model: number;
    rules: number;
    averageDurationMs: number | null;
    averageContextTokens: number | null;
  };
}

export function contextMetrics(service: HearthService): ContextMetricsSnapshot {
  const db = service.store.db;
  const handoffRows = db.prepare(
    "SELECT status, initiated_by, created_at, updated_at, packet_json FROM handoffs"
  ).all() as Array<Record<string, unknown>>;
  const statusCount = (status: string): number => handoffRows.filter((row) => String(row.status) === status).length;
  const completed = statusCount("completed");
  const failed = statusCount("failed");
  const contextTokens = handoffRows
    .map((row) => row.packet_json == null ? null : estimateTokens(String(row.packet_json)))
    .filter((value): value is number => value !== null);
  const recoveryMs = handoffRows
    .filter((row) => String(row.status) === "completed" && row.created_at != null && row.updated_at != null)
    .map((row) => Date.parse(String(row.updated_at)) - Date.parse(String(row.created_at)))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const diagnosisRows = db.prepare(
    "SELECT payload_json FROM events WHERE type = 'execution.diagnosed'"
  ).all() as Array<Record<string, unknown>>;
  const diagnosis = { total: 0, model: 0, rules: 0, durations: [] as number[], tokens: [] as number[] };
  for (const row of diagnosisRows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
    } catch {
      continue;
    }
    diagnosis.total += 1;
    if (payload.source === "model") diagnosis.model += 1;
    else diagnosis.rules += 1;
    const observability = payload.observability;
    if (!observability || typeof observability !== "object") continue;
    const meta = observability as Record<string, unknown>;
    if (typeof meta.durationMs === "number" && Number.isFinite(meta.durationMs)) diagnosis.durations.push(meta.durationMs);
    if (typeof meta.contextTokens === "number" && Number.isFinite(meta.contextTokens)) diagnosis.tokens.push(meta.contextTokens);
  }
  const ledgerTasks = db.prepare("SELECT COUNT(DISTINCT task_id) AS total FROM context_items").get() as Record<string, unknown> | undefined;
  const ledgerItems = db.prepare("SELECT COUNT(*) AS total FROM context_items").get() as Record<string, unknown> | undefined;
  return {
    generatedAt: new Date().toISOString(),
    ledger: {
      tasks: Number(ledgerTasks?.total ?? 0),
      items: Number(ledgerItems?.total ?? 0)
    },
    handoffs: {
      total: handoffRows.length,
      automatic: handoffRows.filter((row) => String(row.initiated_by) === "auto").length,
      userConfirmed: handoffRows.filter((row) => String(row.initiated_by) === "user").length,
      pendingUser: statusCount("pending_user"),
      prepared: statusCount("prepared"),
      running: statusCount("running"),
      completed,
      failed,
      cancelled: statusCount("cancelled"),
      successRate: completed + failed > 0 ? completed / (completed + failed) : null,
      averageContextTokens: average(contextTokens),
      averageRecoveryMs: average(recoveryMs)
    },
    diagnosis: {
      total: diagnosis.total,
      model: diagnosis.model,
      rules: diagnosis.rules,
      averageDurationMs: average(diagnosis.durations),
      averageContextTokens: average(diagnosis.tokens)
    }
  };
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

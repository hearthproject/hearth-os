// Cost ledger, budgets and the degradation ladder.
//
// Money is tracked in USD from a versioned pricing snapshot. Unpriced usage is
// stored as `unpriced`, never as zero. Budget enforcement has explicit scopes
// (task / project / day / experiment / CI) and an audit trail for every
// degradation step.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord, RunUsage, TaskRecord } from "@hearth/core";
import type { EvidenceStore, CostEntry } from "./store.ts";
import type { PricingRegistry } from "./pricing.ts";

export type BudgetScopeKind = "task" | "project" | "daily" | "experiment" | "ci";

export interface BudgetSpec {
  scopeKey: string;
  kind: BudgetScopeKind;
  limitUsd: number;
  softLimitUsd: number | null;
  degradeAtUsd: number | null;
  onExceed: "warn" | "degrade" | "block";
  source: string;
}

export interface BudgetStatus {
  scopeKey: string;
  kind: BudgetScopeKind;
  limitUsd: number | null;
  spentUsd: number;
  projectedUsd: number;
  ratio: number | null;
  decision: "ok" | "soft" | "degrade" | "block" | "unpriced" | "unbounded";
  reason: string;
  unpricedRuns: number;
}

export interface BudgetConfig {
  task?: { defaultUsd?: number; onExceed?: BudgetSpec["onExceed"] };
  project?: { defaultUsd?: number; onExceed?: BudgetSpec["onExceed"] };
  daily?: { limitUsd?: number; onExceed?: BudgetSpec["onExceed"] };
  experiments?: Record<string, number>;
  ci?: { limitUsd?: number; regressionBudgetUsd?: number };
}

export function loadBudgetConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): BudgetConfig {
  const file = join(dataDir, "budgets.json");
  const base: BudgetConfig = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as BudgetConfig : {};
  const numberOrNull = (value: string | undefined): number | null => {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const taskUsd = numberOrNull(env.HEARTH_BUDGET_TASK_USD);
  const dailyUsd = numberOrNull(env.HEARTH_BUDGET_DAILY_USD);
  const projectUsd = numberOrNull(env.HEARTH_BUDGET_PROJECT_USD);
  return {
    ...base,
    ...(taskUsd !== null ? { task: { ...base.task, defaultUsd: taskUsd } } : {}),
    ...(dailyUsd !== null ? { daily: { ...base.daily, limitUsd: dailyUsd } } : {}),
    ...(projectUsd !== null ? { project: { ...base.project, defaultUsd: projectUsd } } : {})
  };
}

function spec(kind: BudgetScopeKind, scopeKey: string, limitUsd: number, onExceed: BudgetSpec["onExceed"], source: string): BudgetSpec {
  return {
    scopeKey,
    kind,
    limitUsd,
    softLimitUsd: limitUsd * 0.8,
    degradeAtUsd: limitUsd,
    onExceed,
    source
  };
}

export function budgetsForTask(task: TaskRecord, config: BudgetConfig): BudgetSpec[] {
  const specs: BudgetSpec[] = [];
  const projectId = task.projectId ?? null;
  if (config.task?.defaultUsd) {
    specs.push(spec("task", `task:${task.id}`, config.task.defaultUsd, config.task.onExceed ?? "warn", "task.defaultUsd"));
  }
  if (projectId && config.project?.defaultUsd) {
    specs.push(spec("project", `project:${projectId}`, config.project.defaultUsd, config.project.onExceed ?? "warn", "project.defaultUsd"));
  }
  if (config.daily?.limitUsd) {
    specs.push(spec("daily", `daily:${new Date().toISOString().slice(0, 10)}`, config.daily.limitUsd, config.daily.onExceed ?? "warn", "daily.limitUsd"));
  }
  return specs;
}

export class CostLedger {
  constructor(readonly store: EvidenceStore, readonly pricing: PricingRegistry) {}

  recordRun(input: {
    run: RunRecord;
    task: TaskRecord;
    usage: RunUsage | null | undefined;
    providerId: string | null;
    modelId: string | null;
    at?: Date;
  }): CostEntry | null {
    const usage = input.usage;
    if (!usage) return null;
    const totalTokens = usage.inputTokens + usage.outputTokens;
    if (totalTokens <= 0) return null;
    const estimate = this.pricing.estimate({
      providerId: input.providerId,
      modelId: input.modelId ?? "unknown",
      usage
    });
    const at = input.at ?? new Date();
    const entry: CostEntry = {
      id: `run:${input.run.id}:${estimate.snapshotId}`,
      scopeKey: `task:${input.task.id}`,
      runId: input.run.id,
      taskId: input.task.id,
      projectId: input.task.projectId ?? null,
      provider: input.providerId,
      model: input.modelId,
      usd: estimate.priced ? estimate.usd : 0,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens ?? 0,
      atDate: at.toISOString().slice(0, 10),
      createdAt: at.toISOString(),
      pricingSnapshotId: estimate.snapshotId,
      pricingVersion: estimate.pricingVersion,
      breakdown: {
        priced: estimate.priced ? 1 : 0,
        ...Object.fromEntries(estimate.components.map((component) => [component.component, component.usd]))
      }
    };
    this.store.appendCost(entry);
    return entry;
  }

  spent(scopeKey: string, day?: string): { usd: number; unpricedRuns: number } {
    const rows = this.store.listCosts({ scopeKey, ...(day ? { day } : {}) });
    return {
      usd: Number(rows.reduce((sum, row) => sum + row.usd, 0).toFixed(6)),
      unpricedRuns: rows.filter((row) => !row.breakdown?.priced).length
    };
  }

  spentForProject(projectId: string, day?: string): { usd: number; unpricedRuns: number } {
    const rows = this.store.listCosts(day ? { day } : {}).filter((row) => row.projectId === projectId);
    return {
      usd: Number(rows.reduce((sum, row) => sum + row.usd, 0).toFixed(6)),
      unpricedRuns: rows.filter((row) => !row.breakdown?.priced).length
    };
  }

  spentForDay(day: string): { usd: number; unpricedRuns: number } {
    const rows = this.store.listCosts({ day });
    return {
      usd: Number(rows.reduce((sum, row) => sum + row.usd, 0).toFixed(6)),
      unpricedRuns: rows.filter((row) => !row.breakdown?.priced).length
    };
  }

  check(budget: BudgetSpec, projectedUsd = 0): BudgetStatus {
    const spent = budget.scopeKey.startsWith("project:")
      ? this.spentForProject(budget.scopeKey.slice("project:".length))
      : budget.scopeKey.startsWith("daily:")
        ? this.spentForDay(budget.scopeKey.slice("daily:".length))
        : this.spent(budget.scopeKey);
    const total = Number((spent.usd + projectedUsd).toFixed(6));
    const ratio = budget.limitUsd > 0 ? Number((total / budget.limitUsd).toFixed(4)) : null;
    if (total > budget.limitUsd) {
      return {
        scopeKey: budget.scopeKey,
        kind: budget.kind,
        limitUsd: budget.limitUsd,
        spentUsd: spent.usd,
        projectedUsd: total,
        ratio,
        decision: budget.onExceed === "block" ? "block" : budget.onExceed === "degrade" ? "degrade" : "soft",
        reason: budget.onExceed === "block" ? "budget_exceeded" : budget.onExceed === "degrade" ? "budget_degrade" : "budget_soft_limit",
        unpricedRuns: spent.unpricedRuns
      };
    }
    if (budget.softLimitUsd !== null && total >= budget.softLimitUsd) {
      return {
        scopeKey: budget.scopeKey,
        kind: budget.kind,
        limitUsd: budget.limitUsd,
        spentUsd: spent.usd,
        projectedUsd: total,
        ratio,
        decision: "soft",
        reason: "budget_soft_limit",
        unpricedRuns: spent.unpricedRuns
      };
    }
    return {
      scopeKey: budget.scopeKey,
      kind: budget.kind,
      limitUsd: budget.limitUsd,
      spentUsd: spent.usd,
      projectedUsd: total,
      ratio,
      decision: "ok",
      reason: "budget_ok",
      unpricedRuns: spent.unpricedRuns
    };
  }

  checkTask(task: TaskRecord, config: BudgetConfig): BudgetStatus[] {
    return budgetsForTask(task, config).map((budget) => this.check(budget));
  }

  summary(): Record<string, unknown> {
    const rows = this.store.listCosts({});
    const usd = Number(rows.reduce((sum, row) => sum + row.usd, 0).toFixed(6));
    const tokens = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
    return {
      entries: rows.length,
      usd,
      tokens,
      unpriced: rows.filter((row) => !row.breakdown?.priced).length,
      byDay: Object.entries(rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.atDate] = Number(((acc[row.atDate] ?? 0) + row.usd).toFixed(6));
        return acc;
      }, {})),
      pricing: this.pricing.active().id
    };
  }
}

export const DEGRADATION_STEPS = [
  "none",
  "context_shrink",
  "tool_call_reduce",
  "fallback_model",
  "stop"
] as const;
export type DegradationStep = (typeof DEGRADATION_STEPS)[number];

export interface DegradationDirective {
  step: DegradationStep;
  contextScale: number;
  maxRetries: number | null;
  fallbackModel: string | null;
  /** Upper bound for additional tool calls in this run; null means uncapped. */
  maxToolCallsPerRun: number | null;
  stop: boolean;
  reason: string;
}

export const DEGRADATION_DIRECTIVES: Record<DegradationStep, DegradationDirective> = {
  none: { step: "none", contextScale: 1, maxRetries: null, fallbackModel: null, maxToolCallsPerRun: null, stop: false, reason: "normal" },
  context_shrink: { step: "context_shrink", contextScale: 0.6, maxRetries: null, fallbackModel: null, maxToolCallsPerRun: null, stop: false, reason: "budget_pressure" },
  tool_call_reduce: { step: "tool_call_reduce", contextScale: 0.6, maxRetries: 0, fallbackModel: null, maxToolCallsPerRun: 24, stop: false, reason: "budget_pressure" },
  fallback_model: { step: "fallback_model", contextScale: 0.5, maxRetries: 0, fallbackModel: "fallback", maxToolCallsPerRun: 16, stop: false, reason: "budget_pressure" },
  stop: { step: "stop", contextScale: 0.5, maxRetries: 0, fallbackModel: "fallback", maxToolCallsPerRun: 0, stop: true, reason: "budget_hard_stop" }
};

export function nextStep(current: DegradationStep): DegradationStep {
  const index = DEGRADATION_STEPS.indexOf(current);
  return DEGRADATION_STEPS[Math.min(DEGRADATION_STEPS.length - 1, index + 1)] ?? "stop";
}

export class DegradationController {
  constructor(private readonly store: EvidenceStore) {}

  private stateKey(runId: string, scopeKey?: string): string {
    return `degrade:${scopeKey ?? runId}`;
  }

  current(runId: string, scopeKey?: string): DegradationStep {
    const state = this.store.getBudgetState(this.stateKey(runId, scopeKey));
    const step = typeof state?.step === "string" ? state.step : "none";
    return (DEGRADATION_STEPS as readonly string[]).includes(step) ? step as DegradationStep : "none";
  }

  directive(runId: string, scopeKey?: string): DegradationDirective {
    return DEGRADATION_DIRECTIVES[this.current(runId, scopeKey)];
  }

  /** Escalate exactly one step; repeated calls are monotonic and audited. */
  escalate(runId: string, reason: string, detail: Record<string, unknown> = {}, scopeKey?: string): DegradationDirective {
    const from = this.current(runId, scopeKey);
    const to = nextStep(from);
    if (to === from) return DEGRADATION_DIRECTIVES[from];
    const at = new Date().toISOString();
    this.store.appendDegradation({
      id: `degrade:${runId}:${from}->${to}:${at}`,
      runId,
      createdAt: at,
      from,
      to,
      reason,
      detail,
      directive: DEGRADATION_DIRECTIVES[to]
    });
    this.store.saveBudgetState(this.stateKey(runId, scopeKey), { step: to, reason, updatedAt: at }, at);
    return DEGRADATION_DIRECTIVES[to];
  }

  /** Recovery requires an explicit policy, never an implicit rescale. */
  recover(runId: string, policy: "manual_reset" | "new_run" = "manual_reset", scopeKey?: string): DegradationDirective {
    const at = new Date().toISOString();
    const from = this.current(runId, scopeKey);
    if (from === "none") return DEGRADATION_DIRECTIVES.none;
    this.store.appendDegradation({
      id: `degrade:${runId}:recover:${at}`,
      runId,
      createdAt: at,
      from,
      to: "none",
      reason: "explicit_recovery",
      detail: { policy }
    });
    this.store.saveBudgetState(this.stateKey(runId, scopeKey), { step: "none", reason: "explicit_recovery", updatedAt: at }, at);
    return DEGRADATION_DIRECTIVES.none;
  }

  history(runId: string): Array<Record<string, unknown>> {
    return this.store.listDegradations(runId);
  }
}

/** Per-run degradation directive consumed by the scheduler. */
export function degradationForRun(store: EvidenceStore, runId: string | null | undefined, scopeKey?: string): DegradationDirective {
  if (!runId) return DEGRADATION_DIRECTIVES.none;
  return new DegradationController(store).directive(runId, scopeKey);
}

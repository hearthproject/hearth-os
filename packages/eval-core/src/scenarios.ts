export const SCENARIO_MECHANISMS = [
  "action_resolver",
  "effect_outbox",
  "goal_judge",
  "failure_recovery",
  "memory",
  "skill",
  "proactive",
  "schedule",
  "connection",
  "sensitive_info",
  "delegation",
  "handoff",
  "sandbox",
  "channel"
] as const;
export type ScenarioMechanism = (typeof SCENARIO_MECHANISMS)[number];

export const SCENARIO_PRIORITIES = ["P0", "P1", "P2"] as const;
export type ScenarioPriority = (typeof SCENARIO_PRIORITIES)[number];

export const SCENARIO_FAULTS = [
  "none",
  "timeout",
  "disconnect",
  "crash",
  "duplicate",
  "delayed",
  "tamper",
  "stale_generation",
  "injection",
  "credential_expiry"
] as const;
export type ScenarioFault = (typeof SCENARIO_FAULTS)[number];

export interface ScenarioDefinition {
  id: string;
  title: string;
  mechanism: ScenarioMechanism;
  priority: ScenarioPriority;
  fault: ScenarioFault;
  expectedInvariant: string;
  evidence: string[];
  repeat: number;
  tags: string[];
}

export interface ScenarioManifest {
  version: 1;
  scenarios: ScenarioDefinition[];
}

export interface ScenarioAssertion {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ScenarioEvidence {
  summary: Record<string, unknown>;
  assertions: ScenarioAssertion[];
}

export type ScenarioRunStatus = "passed" | "failed" | "error";

export interface ScenarioRunRecord {
  scenarioId: string;
  title: string;
  mechanism: ScenarioMechanism;
  priority: ScenarioPriority;
  fault: ScenarioFault;
  repetition: number;
  status: ScenarioRunStatus;
  durationMs: number;
  evidencePath: string | null;
  error: string | null;
  assertions: ScenarioAssertion[];
}

export interface ScenarioAggregate {
  scenarioId: string;
  title: string;
  mechanism: ScenarioMechanism;
  priority: ScenarioPriority;
  fault: ScenarioFault;
  runs: number;
  passed: number;
  passRate: number;
  medianDurationMs: number;
  durationDispersionMs: number;
  failedAssertions: string[];
}

export interface ScenarioP0Coverage {
  mechanism: ScenarioMechanism;
  scenarios: number;
  faultInjectedScenarios: number;
  covered: boolean;
}

export interface ScenarioSuiteReport {
  version: 1;
  startedAt: string;
  completedAt: string;
  manifestPath: string;
  artifactRoot: string;
  runs: ScenarioRunRecord[];
  aggregates: ScenarioAggregate[];
  p0Coverage: ScenarioP0Coverage[];
  passRate: number;
}

export function validateScenarioManifest(value: unknown): ScenarioManifest {
  if (!value || typeof value !== "object") throw new Error("scenario manifest must be an object");
  const manifest = value as Partial<ScenarioManifest>;
  if (manifest.version !== 1 || !Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) {
    throw new Error("scenario manifest must use version 1 and contain scenarios");
  }
  const ids = new Set<string>();
  for (const scenario of manifest.scenarios) {
    if (!scenario || typeof scenario !== "object") throw new Error("scenario must be an object");
    const item = scenario as Partial<ScenarioDefinition>;
    if (!item.id || ids.has(item.id)) throw new Error(`scenario id missing or duplicated: ${item.id ?? "<empty>"}`);
    ids.add(item.id);
    if (!item.title || !item.expectedInvariant) throw new Error(`scenario ${item.id} is missing title or invariant`);
    if (!SCENARIO_MECHANISMS.includes(item.mechanism as ScenarioMechanism)) throw new Error(`scenario ${item.id} has unknown mechanism`);
    if (!SCENARIO_PRIORITIES.includes(item.priority as ScenarioPriority)) throw new Error(`scenario ${item.id} has unknown priority`);
    if (!SCENARIO_FAULTS.includes(item.fault as ScenarioFault)) throw new Error(`scenario ${item.id} has unknown fault`);
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) throw new Error(`scenario ${item.id} must declare evidence`);
    if (!Number.isInteger(item.repeat) || (item.repeat ?? 0) < 3 || (item.repeat ?? 0) > 5) {
      throw new Error(`scenario ${item.id} repeat must be between 3 and 5`);
    }
    if (!Array.isArray(item.tags)) throw new Error(`scenario ${item.id} tags must be an array`);
  }
  return manifest as ScenarioManifest;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function durationDispersionMs(values: number[]): number {
  if (values.length === 0) return 0;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

export function aggregateScenarioRuns(runs: ScenarioRunRecord[]): ScenarioAggregate[] {
  const groups = new Map<string, ScenarioRunRecord[]>();
  for (const run of runs) {
    const current = groups.get(run.scenarioId) ?? [];
    current.push(run);
    groups.set(run.scenarioId, current);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([scenarioId, group]) => {
      const first = group[0]!;
      const durations = group.map((run) => run.durationMs);
      const passed = group.filter((run) => run.status === "passed").length;
      return {
        scenarioId,
        title: first.title,
        mechanism: first.mechanism,
        priority: first.priority,
        fault: first.fault,
        runs: group.length,
        passed,
        passRate: group.length === 0 ? 0 : passed / group.length,
        medianDurationMs: median(durations),
        durationDispersionMs: durationDispersionMs(durations),
        failedAssertions: [...new Set(group.flatMap((run) => run.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name)))]
      };
    });
}

export function scenarioP0Coverage(manifest: ScenarioManifest): ScenarioP0Coverage[] {
  const p0Mechanisms = [...new Set(manifest.scenarios.filter((scenario) => scenario.priority === "P0").map((scenario) => scenario.mechanism))];
  return p0Mechanisms.map((mechanism) => {
    const scenarios = manifest.scenarios.filter((scenario) => scenario.mechanism === mechanism && scenario.priority === "P0");
    const faultInjectedScenarios = scenarios.filter((scenario) => scenario.fault !== "none").length;
    return {
      mechanism,
      scenarios: scenarios.length,
      faultInjectedScenarios,
      covered: faultInjectedScenarios > 0
    };
  });
}

export function summarizeScenarioSuite(input: {
  manifest: ScenarioManifest;
  manifestPath: string;
  artifactRoot: string;
  startedAt: string;
  completedAt: string;
  runs: ScenarioRunRecord[];
}): ScenarioSuiteReport {
  const p0Coverage = scenarioP0Coverage(input.manifest);
  const failedCoverage = p0Coverage.filter((item) => !item.covered);
  if (failedCoverage.length > 0) {
    throw new Error(`P0 mechanism coverage missing fault injection: ${failedCoverage.map((item) => item.mechanism).join(", ")}`);
  }
  const passed = input.runs.filter((run) => run.status === "passed").length;
  return {
    version: 1,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    manifestPath: input.manifestPath,
    artifactRoot: input.artifactRoot,
    runs: input.runs,
    aggregates: aggregateScenarioRuns(input.runs),
    p0Coverage,
    passRate: input.runs.length === 0 ? 0 : passed / input.runs.length
  };
}

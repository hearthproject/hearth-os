import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  aggregateScenarioRuns,
  durationDispersionMs,
  median,
  scenarioP0Coverage,
  validateScenarioManifest,
  type ScenarioRunRecord
} from "./scenarios.ts";

describe("personal agent scenario harness", () => {
  it("validates the local scenario manifest and P0 fault coverage", () => {
    const raw = readFileSync(new URL("../../../eval/scenarios/scenarios.json", import.meta.url), "utf8");
    const manifest = validateScenarioManifest(JSON.parse(raw));
    expect(manifest.scenarios).toHaveLength(30);
    expect(new Set(manifest.scenarios.map((scenario) => scenario.id)).size).toBe(30);
    expect(manifest.scenarios.every((scenario) => scenario.repeat >= 3 && scenario.repeat <= 5)).toBe(true);
    const coverage = scenarioP0Coverage(manifest);
    expect(coverage.length).toBeGreaterThanOrEqual(5);
    expect(coverage.every((item) => item.covered)).toBe(true);
  });

  it("aggregates repeats with median and dispersion instead of a single demo", () => {
    const runs: ScenarioRunRecord[] = [
      runRecord(1, 10, "passed"),
      runRecord(2, 20, "failed"),
      runRecord(3, 60, "passed")
    ];
    const [aggregate] = aggregateScenarioRuns(runs);
    expect(aggregate).toMatchObject({
      scenarioId: "scenario-1",
      runs: 3,
      passed: 2,
      passRate: 2 / 3,
      medianDurationMs: 20,
      durationDispersionMs: 10
    });
    expect(aggregate?.failedAssertions).toEqual(["invariant"]);
    expect(aggregate?.metrics).toEqual([
      { key: "attention_precision", unit: "ratio", samples: 3, median: 0.8, p95: 0.9, min: 0.7, max: 0.9 }
    ]);
    expect(median([5, 1, 3])).toBe(3);
  });
});

function runRecord(repetition: number, durationMs: number, status: ScenarioRunRecord["status"]): ScenarioRunRecord {
  return {
    scenarioId: "scenario-1",
    title: "scenario",
    mechanism: "goal_judge",
    priority: "P0",
    fault: "tamper",
    repetition,
    status,
    durationMs,
    evidencePath: null,
    error: status === "failed" ? "invariant" : null,
    assertions: [{ name: "invariant", passed: status === "passed", detail: "detail" }],
    metrics: [{
      key: "attention_precision",
      value: 0.6 + repetition * 0.1,
      unit: "ratio",
      detail: "test sample"
    }]
  };
}

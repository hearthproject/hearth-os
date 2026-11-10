import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  summarizeScenarioSuite,
  validateScenarioManifest,
  type ScenarioAssertion,
  type ScenarioDefinition,
  type ScenarioRunRecord,
  type ScenarioSuiteReport
} from "@hearth/eval-core";
import { redactSecrets } from "../context.ts";
import { scenarioHandler } from "./registry.ts";
import { fixedClock } from "./support.ts";
import type { ScenarioContext } from "./types.ts";

const args = process.argv.slice(2);
const manifestArg = option("--manifest") ?? "eval/scenarios/scenarios.json";
const only = new Set((option("--only") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const manifestPath = resolve(process.cwd(), manifestArg);
const manifest = validateScenarioManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
const selected = only.size === 0 ? manifest.scenarios : manifest.scenarios.filter((scenario) => only.has(scenario.id));
if (selected.length === 0) throw new Error("No scenarios selected");

const startedAt = new Date().toISOString();
const artifactRoot = resolve(process.cwd(), "eval", "scenario-runs", startedAt.replace(/[:.]/g, "-"));
mkdirSync(artifactRoot, { recursive: true });

const runs: ScenarioRunRecord[] = [];
for (const scenario of selected) {
  const handler = scenarioHandler(scenario.id);
  for (let repetition = 1; repetition <= scenario.repeat; repetition += 1) {
    const started = performance.now();
    const root = resolve(artifactRoot, scenario.id, `run-${repetition}`);
    mkdirSync(root, { recursive: true });
    const context = createContext(scenario, repetition, root);
    let error: string | null = null;
    let summary: Record<string, unknown> = {};
    try {
      const output = await handler(context);
      summary = output.summary;
      context.assertions.push(...output.assertions.filter((assertion) => !context.assertions.includes(assertion)));
    } catch (caught) {
      error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
      context.check("handler-completed", false, error);
    }
    const durationMs = Math.round((performance.now() - started) * 100) / 100;
    const assertions = context.assertions;
    const status: ScenarioRunRecord["status"] = error ? "error" : assertions.every((assertion) => assertion.passed) ? "passed" : "failed";
    const evidenceFile = resolve(root, "evidence.json");
    const payload = sanitize({
      scenario,
      repetition,
      status,
      durationMs,
      error,
      summary,
      assertions,
      environment: {
        cwd: process.cwd(),
        node: process.version,
        platform: process.platform,
        clockStart: context.clock.now().toISOString(),
        isolation: "temporary in-memory/temp-file store; fake user, fake preference, fake secret"
      }
    });
    writeFileSync(evidenceFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
    runs.push({
      scenarioId: scenario.id,
      title: scenario.title,
      mechanism: scenario.mechanism,
      priority: scenario.priority,
      fault: scenario.fault,
      repetition,
      status,
      durationMs,
      evidencePath: relative(process.cwd(), evidenceFile).replace(/\\/g, "/"),
      error,
      assertions
    });
    const icon = status === "passed" ? "PASS" : status === "failed" ? "FAIL" : "ERROR";
    console.log(`${icon} ${scenario.id} #${repetition} (${durationMs} ms)${error ? ` - ${error}` : ""}`);
  }
}

const completedAt = new Date().toISOString();
const report = summarizeScenarioSuite({
  manifest,
  manifestPath,
  artifactRoot,
  startedAt,
  completedAt,
  runs
});
writeFileSync(resolve(artifactRoot, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
writeFileSync(resolve(artifactRoot, "summary.md"), renderSummary(report), "utf8");

console.log(`\nScenarios: ${report.runs.filter((run) => run.status === "passed").length}/${report.runs.length} passed (${(report.passRate * 100).toFixed(1)}%)`);
console.log(`Report: ${relative(process.cwd(), resolve(artifactRoot, "report.json")).replace(/\\/g, "/")}`);
console.log(`Summary: ${relative(process.cwd(), resolve(artifactRoot, "summary.md")).replace(/\\/g, "/")}`);
if (report.runs.some((run) => run.status !== "passed")) process.exitCode = 1;

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function createContext(scenario: ScenarioDefinition, repetition: number, root: string): ScenarioContext {
  const clock = fixedClock();
  const assertions: ScenarioAssertion[] = [];
  const evidence: Record<string, unknown> = {};
  return {
    scenario,
    repetition,
    root,
    artifactDir: root,
    clock,
    fakeUser: { id: "fake-user-001", name: "假用户" },
    fakePreference: "假偏好：先给结论，再给证据",
    fakeSecret: "sk-scenario-0123456789abcdef",
    assertions,
    evidence,
    check(name, passed, detail) {
      assertions.push({ name, passed, detail });
      return passed;
    },
    record(key, value) {
      evidence[key] = value;
    }
  };
}

function sanitize(value: unknown): unknown {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value)));
  } catch {
    return value;
  }
}

function renderSummary(report: ScenarioSuiteReport): string {
  const lines = [
    "# Hearth Personal Agent Scenario Report",
    "",
    `- Started: ${report.startedAt}`,
    `- Completed: ${report.completedAt}`,
    `- Manifest: \`${report.manifestPath}\``,
    `- Runs: ${report.runs.filter((run) => run.status === "passed").length}/${report.runs.length} passed`,
    `- Pass rate: ${(report.passRate * 100).toFixed(1)}%`,
    "",
    "## Scenario aggregates",
    "",
    "| Scenario | Priority | Fault | Pass | Median ms | Dispersion ms | Evidence |",
    "|---|---|---|---:|---:|---:|---|"
  ];
  for (const aggregate of report.aggregates) {
    const first = report.runs.find((run) => run.scenarioId === aggregate.scenarioId);
    const link = first?.evidencePath ? relative(artifactRoot, resolve(process.cwd(), first.evidencePath)).replace(/\\/g, "/") : "";
    lines.push(`| ${aggregate.scenarioId} | ${aggregate.priority} | ${aggregate.fault} | ${aggregate.passed}/${aggregate.runs} | ${aggregate.medianDurationMs.toFixed(2)} | ${aggregate.durationDispersionMs.toFixed(2)} | [evidence](${link}) |`);
  }
  lines.push("", "## P0 mechanism coverage", "", "| Mechanism | Scenarios | Fault-injected | Covered |", "|---|---:|---:|---|");
  for (const coverage of report.p0Coverage) {
    lines.push(`| ${coverage.mechanism} | ${coverage.scenarios} | ${coverage.faultInjectedScenarios} | ${coverage.covered ? "yes" : "no"} |`);
  }
  const failures = report.runs.filter((run) => run.status !== "passed");
  lines.push("", "## Failures", "");
  if (failures.length === 0) {
    lines.push("No failed scenarios.");
  } else {
    for (const failure of failures) {
      const failed = failure.assertions.filter((assertion) => !assertion.passed).map((assertion) => `${assertion.name}: ${assertion.detail}`);
      lines.push(`### ${failure.scenarioId} #${failure.repetition}`, "", `- Status: ${failure.status}`, `- Error: ${failure.error ?? "none"}`, `- Evidence: \`${failure.evidencePath ?? ""}\``);
      for (const item of failed) lines.push(`- Failed assertion: ${item}`);
      lines.push("");
    }
  }
  return lines.join("\n") + "\n";
}

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord, TaskRecord } from "@hearth/core";
import { ExchangeRecorder } from "@hearth/agent-runtime";
import {
  buildArtifactProvenance,
  buildRuntimeManifest,
  compatibilityDiff,
  compatibilityFingerprint,
  manifestCompleteness,
  provenanceCompleteness,
  EVIDENCE_CONTRACT_ID,
  type RuntimeManifest
} from "./contracts.ts";
import { EvidenceStore } from "./store.ts";
import { PricingRegistry } from "./pricing.ts";
import { CostLedger, DegradationController, budgetsForTask } from "./cost.ts";
import { buildPolicyFromTask, defaultPolicy, evaluatePolicy, policyHash, preflightPolicy, validatePolicySpec, type PolicySpec } from "./policy.ts";
import { runVerificationSpec, validateVerificationSpec, productionGate, evalAdapter, defaultCommandRunner } from "./verification.ts";
import { effectiveConfig, validateVariant, BASELINE_VARIANT, type VariantBaseline } from "./variant.ts";
import { CassetteSession, loadCassette } from "./cassette-store.ts";
import { buildDivergenceReport } from "./replay.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-evidence-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Windows keeps the WAL file briefly locked; the temp dir is disposable.
    }
  }
});

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    templateId: null,
    title: "生成季度报告",
    goal: "写出一份可审计的报告",
    status: "completed",
    createdAt: "2026-11-27T00:00:00.000Z",
    updatedAt: "2026-11-27T00:01:00.000Z",
    deadline: null,
    inputs: [],
    networkHosts: ["api.example.com"],
    outputDir: ".hearth/artifacts/task-1",
    currentRunId: "run-1",
    nextAction: null,
    error: null,
    projectId: "proj-1",
    permissions: {
      readRoots: ["D:/work"],
      writeRoots: ["D:/work"],
      networkHosts: ["api.example.com"],
      tools: ["read_file", "write_file", "shell"],
      approvalMode: "necessary",
      networkMode: "deny"
    },
    ...overrides
  } as TaskRecord;
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    taskId: "task-1",
    attempt: 1,
    status: "completed",
    threadId: null,
    workspace: "D:/work",
    startedAt: "2026-11-27T00:00:10.000Z",
    endedAt: "2026-11-27T00:00:50.000Z",
    failure: null,
    usage: { inputTokens: 1_000_000, cachedInputTokens: 200_000, cacheWriteInputTokens: 0, outputTokens: 100_000, reasoningOutputTokens: 0 },
    leaseEpoch: 1,
    createdAt: "2026-11-27T00:00:05.000Z",
    executorId: "native",
    ...overrides
  } as RunRecord;
}

function manifest(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return buildRuntimeManifest({
    runId: "run-1",
    taskId: "task-1",
    createdAt: "2026-11-27T00:00:05.000Z",
    repos: [{ role: "hearth-os", commit: "abc", branch: "main", dirty: false, version: "0.9.0" }],
    model: {
      providerId: "p1", providerName: "Provider", protocol: "openai-chat", modelId: "model-a", modelVersion: null,
      sampling: { temperature: 0.2, maxTokens: 4096, reasoningEffort: "max", seed: null }, contextWindowTokens: 128_000
    },
    prompt: { registryVersion: "native-v1", systemPromptHash: "sys", finalPromptHash: "final", toolSchemaHash: "tools" },
    tools: { catalogDigest: "tools", catalogSize: 12, policy: "full", directTools: ["read_file"], mcpVersion: null },
    context: { policyVersion: "ctx", compactionThreshold: 0.68, packId: "pack-1", mode: "on" },
    approval: { mode: "necessary", policyVersion: "1", policyHash: "ph", teamMode: false, recoveryPolicy: "manual", retryPolicy: "none" },
    sandbox: { backend: "windows-acl", mode: "workspace-write", networkMode: "deny", image: null, appContainer: null },
    judge: null,
    pricing: { snapshotId: "pricing:x", version: "2026-11", asOf: "2026-11-01" },
    budget: { scope: "task", limits: { usd: 1 }, degradationPolicy: "budget-v1" },
    variant: { harnessVariantId: "baseline", effectiveConfigDigest: "d1" },
    deps: { lockfileDigest: "lock" },
    ...overrides
  });
}

describe("runtime manifest contract", () => {
  it("produces a stable fingerprint and reports missing facts honestly", () => {
    const complete = manifest();
    expect(compatibilityFingerprint(complete)).toBe(complete.compatibilityFingerprint);
    expect(complete.completeness).toEqual({ status: "complete", missing: [] });

    const incomplete = manifest({ prompt: null, tools: null, sandbox: null });
    expect(incomplete.completeness.status).toBe("incomplete_provenance");
    expect(incomplete.completeness.missing).toContain("prompt.systemPromptHash");
    expect(incomplete.completeness.missing).toContain("sandbox.backend");
  });

  it("changes the fingerprint when the prompt, approval policy or model changes", () => {
    const base = manifest();
    const promptChanged = manifest({ prompt: { registryVersion: "native-v1", systemPromptHash: "sys2", finalPromptHash: "final", toolSchemaHash: "tools" } });
    const approvalChanged = manifest({ approval: { mode: "full", policyVersion: "1", policyHash: "ph2", teamMode: false, recoveryPolicy: "manual", retryPolicy: "none" } });
    const modelChanged = manifest({ model: { ...base.model!, modelId: "model-b" } });
    for (const changed of [promptChanged, approvalChanged, modelChanged]) {
      expect(changed.compatibilityFingerprint).not.toBe(base.compatibilityFingerprint);
    }
  });

  it("explains which component diverged", () => {
    const left = manifest();
    const right = manifest({ sandbox: { backend: "container", mode: "workspace-write", networkMode: "deny", image: "img", appContainer: null } });
    const diff = compatibilityDiff(left, right);
    expect(diff.same).toBe(false);
    const sandbox = diff.components.find((component) => component.component === "sandbox");
    expect(sandbox?.status).toBe("changed");
    const model = diff.components.find((component) => component.component === "model");
    expect(model?.status).toBe("same");
  });

  it("marks provenance incomplete until every audit field exists", () => {
    const provenance = buildArtifactProvenance({
      artifact: {
        id: "art-1", taskId: "task-1", runId: "run-1", relativePath: "report.md",
        mimeType: "text/markdown", sha256: "sha", bytes: 100, createdAt: "2026-11-27T00:01:00.000Z"
      },
      producedBy: { runId: "run-1", toolCallId: "call-1", toolName: "write_file", inference: "explicit" },
      inputs: [{ kind: "input", ref: "brief.md", sha256: "x", bytes: 10, label: "brief" }],
      model: { providerId: "p1", modelId: "m", requestFingerprint: "fp" },
      toolSchemaHash: "tools",
      policy: { version: "1", hash: "ph", ruleId: "r", approvalId: "a", decision: "approved", permissionMode: "necessary" },
      environment: { digest: "env", sandbox: "windows-acl", workspaceDigest: "ws" }
    });
    expect(provenance.completeness.status).toBe("complete");
    expect(provenanceCompleteness(provenance).missing).toEqual([]);

    const missing = buildArtifactProvenance({
      artifact: {
        id: "art-2", taskId: "task-1", runId: "run-1", relativePath: "bare.md",
        mimeType: "text/plain", sha256: "sha2", bytes: 1, createdAt: "2026-11-27T00:02:00.000Z"
      },
      producedBy: { runId: "run-1", inference: "unknown" }
    });
    expect(missing.completeness.status).toBe("incomplete_provenance");
    expect(missing.completeness.missing).toContain("producedBy.toolCallId");
  });
});

describe("evidence store and artifact graph", () => {
  it("persists manifests, provenance and computes a graph", () => {
    const dir = tempDir();
    const store = new EvidenceStore(join(dir, "evidence.sqlite"));
    const first = buildArtifactProvenance({
      artifact: { id: "a1", taskId: "task-1", runId: "run-1", relativePath: "brief.md", mimeType: "text/markdown", sha256: "s1", bytes: 10, createdAt: "2026-11-27T00:00:20.000Z" },
      producedBy: { runId: "run-1", toolCallId: "c1", inference: "explicit" },
      inputs: [{ kind: "input", ref: "input-1", sha256: null, bytes: null, label: "brief" }],
      model: { providerId: "p", modelId: "m", requestFingerprint: "fp" },
      toolSchemaHash: "t",
      policy: { version: "1", hash: "h", ruleId: "r", approvalId: "a", decision: "approved", permissionMode: "necessary" },
      environment: { digest: "e", sandbox: "s", workspaceDigest: "w" }
    });
    const second = buildArtifactProvenance({
      artifact: { id: "a2", taskId: "task-1", runId: "run-1", relativePath: "report.md", mimeType: "text/markdown", sha256: "s2", bytes: 20, createdAt: "2026-11-27T00:00:30.000Z" },
      producedBy: { runId: "run-1", toolCallId: "c2", inference: "explicit" },
      parents: [{ artifactId: "a1", sha256: "s1", relation: "derived_from" }],
      model: { providerId: "p", modelId: "m", requestFingerprint: "fp" },
      toolSchemaHash: "t",
      policy: { version: "1", hash: "h", ruleId: "r", approvalId: "a", decision: "approved", permissionMode: "necessary" },
      environment: { digest: "e", sandbox: "s", workspaceDigest: "w" }
    });
    store.saveManifest(manifest());
    store.saveProvenance(first);
    store.saveProvenance(second);
    expect(store.getManifest("run-1")?.compatibilityFingerprint).toBe(manifest().compatibilityFingerprint);
    expect(store.listProvenanceForTask("task-1")).toHaveLength(2);
    const nodes = store.listProvenanceForTask("task-1");
    expect(nodes[1]?.parents[0]?.artifactId).toBe("a1");
    expect(store.getProvenance("a2")?.parents[0]?.relation).toBe("derived_from");
    store.close();
  });
});

describe("policy engine", () => {
  it("denies writes to secret paths and asks outside the workspace", () => {
    const spec = buildPolicyFromTask(task());
    const secret = evaluatePolicy(spec, { tool: "write_file", paths: ["C:/Users/x/.ssh/id_rsa"], effect: "write" });
    expect(secret.effectiveDecision).toBe("deny");
    expect(secret.reason).toContain("secret_path");
    const inside = evaluatePolicy(spec, { tool: "write_file", paths: ["D:/work/out/report.md"], effect: "write" });
    expect(inside.effectiveDecision).toBe("allow");
    const outside = evaluatePolicy(spec, { tool: "write_file", paths: ["C:/Windows/System32/x.dll"], effect: "write" });
    expect(outside.effectiveDecision).toBe("ask");
  });

  it("allows listed domains and denies others", () => {
    const spec = buildPolicyFromTask(task());
    expect(evaluatePolicy(spec, { tool: "web_fetch", domains: ["api.example.com"], effect: "external" }).effectiveDecision).toBe("allow");
    expect(evaluatePolicy(spec, { tool: "web_fetch", domains: ["evil.example"], effect: "external" }).effectiveDecision).toBe("deny");
  });

  it("does not let a workspace prefix match a path traversal", () => {
    const spec = buildPolicyFromTask(task());
    const traversal = evaluatePolicy(spec, { tool: "write_file", paths: ["D:/work/../../Windows/System32/x.dll"], effect: "write" });
    expect(traversal.effectiveDecision).toBe("ask");
  });

  it("treats exact domains and domain patterns as a union", () => {
    const spec: PolicySpec = {
      schemaVersion: 1, id: "domain-union", version: "1", mode: "enforce",
      defaults: { decision: "deny" },
      rules: [{
        id: "allow-example", priority: 80,
        match: { domains: ["api.example.com"], domainPatterns: ["*.example.com"] },
        decision: "allow", reason: "example_allowlist"
      }],
      approval: { mode: "ask", teamMode: false, recoveryPolicy: "manual", retryPolicy: "none" }
    };
    expect(evaluatePolicy(spec, { tool: "web_fetch", domains: ["v1.example.com"], effect: "external" }).effectiveDecision).toBe("allow");
    expect(evaluatePolicy(spec, { tool: "web_fetch", domains: ["other.example.org"], effect: "external" }).effectiveDecision).toBe("deny");
  });

  it("hashes policies deterministically and validates malformed specs", () => {
    expect(policyHash(defaultPolicy())).toBe(policyHash(defaultPolicy()));
    expect(policyHash(defaultPolicy())).not.toBe(policyHash(buildPolicyFromTask(task())));
    const invalid = validatePolicySpec({ schemaVersion: 1, id: "x", version: "1", mode: "wild", defaults: { decision: "allow" }, rules: [] });
    expect(invalid.ok).toBe(false);
  });

  it("previews a plan without executing it", () => {
    const spec = buildPolicyFromTask(task());
    const preflight = preflightPolicy({
      spec,
      taskId: "task-1",
      actions: [
        { tool: "write_file", paths: ["D:/work/a.md"], effect: "write" },
        { tool: "write_file", paths: ["C:/Users/x/.ssh/key"], effect: "write" },
        { tool: "web_fetch", domains: ["api.example.com"], effect: "external" }
      ]
    });
    expect(preflight.counts).toEqual({ allow: 2, ask: 0, deny: 1 });
    expect(preflight.blocked[0]).toContain("write_file");
    expect(preflight.policyHash).toBe(policyHash(spec));
  });
});

describe("verification spec", () => {
  it("rejects malformed specs", () => {
    expect(validateVerificationSpec({ schemaVersion: 1, id: "s", mode: "production", units: [], aggregate: { mode: "all" } }).ok).toBe(false);
    expect(validateVerificationSpec({
      schemaVersion: 1, id: "s", mode: "production",
      units: [{ type: "file_exists" }],
      aggregate: { mode: "all" }
    }).ok).toBe(false);
  });

  it("checks files, JSON, CSV and schema", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "report.md"), "# 报告\n关键结论：通过\n", "utf8");
    writeFileSync(join(dir, "data.json"), JSON.stringify({ summary: { total: 42 }, rows: [1, 2, 3] }), "utf8");
    writeFileSync(join(dir, "table.csv"), "id,name,amount\n1,a,10\n2,b,20\n", "utf8");
    const result = await runVerificationSpec({
      schemaVersion: 1,
      id: "spec-1",
      mode: "eval",
      units: [
        { type: "file_exists", path: "report.md", minBytes: 10 },
        { type: "text_contains", path: "report.md", contains: ["关键结论"], pattern: "通过" },
        { type: "json", path: "data.json", pointer: "/summary/total", equals: 42 },
        { type: "json", path: "data.json", requiredKeys: ["summary", "rows"] },
        { type: "csv", path: "table.csv", columns: ["id", "name", "amount"], minRows: 2, columnTypes: { amount: "number" }, unique: ["id"] },
        {
          type: "schema",
          path: "data.json",
          jsonSchema: { type: "object", required: ["summary", "rows"], properties: { summary: { type: "object" }, rows: { type: "array", minItems: 3 } } }
        }
      ],
      aggregate: { mode: "all" }
    }, { workspaceRoot: dir, artifacts: [] });
    expect(result.verdict).toBe("pass");
    expect(result.score).toBe(1);
    expect(evalAdapter(result).success).toBe(true);
  });

  it("fails on wrong content and marks judge/human without runners as inconclusive", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "report.md"), "wrong", "utf8");
    const failed = await runVerificationSpec({
      schemaVersion: 1, id: "spec-2", mode: "production",
      units: [{ type: "text_contains", path: "report.md", contains: ["关键结论"] }],
      aggregate: { mode: "all" }
    }, { workspaceRoot: dir });
    expect(failed.verdict).toBe("fail");
    expect(productionGate(failed).allowed).toBe(false);

    const inconclusive = await runVerificationSpec({
      schemaVersion: 1, id: "spec-3", mode: "eval",
      units: [{ type: "judge", rubric: "是否写得清楚" }],
      aggregate: { mode: "all" }
    }, { workspaceRoot: dir });
    expect(inconclusive.verdict).toBe("inconclusive");
    expect(inconclusive.units[0]?.status).toBe("inconclusive");
    expect(evalAdapter(inconclusive).success).toBe(false);
  });

  it("runs commands and evaluates trace invariants", async () => {
    const dir = tempDir();
    const ok = await runVerificationSpec({
      schemaVersion: 1, id: "spec-4", mode: "production",
      units: [{ type: "command", command: "node -e \"console.log('ok')\"", expectStdout: "ok" }],
      aggregate: { mode: "all" }
    }, { workspaceRoot: dir, runCommand: defaultCommandRunner });
    expect(ok.verdict).toBe("pass");

    const trace = await runVerificationSpec({
      schemaVersion: 1, id: "spec-5", mode: "eval",
      units: [
        { id: "model-limit", type: "trace", invariant: "max_model_requests", limit: 1 },
        { id: "approval", type: "trace", invariant: "approval_before_effect" }
      ],
      aggregate: { mode: "any" }
    }, {
      workspaceRoot: dir,
      runCommand: defaultCommandRunner,
      exchanges: [
        {
          schemaVersion: 1, id: "x1", runId: "r", parentId: null, kind: "tool.call", sequence: 1, stepId: null,
          requestFingerprint: "f", environmentDigest: "e",
          input: { ref: "sha256:i", sha256: "i", bytes: 1, summary: null },
          output: { ref: "sha256:o", sha256: "o", bytes: 1, summary: null },
          latencyMs: null, usage: null, sideEffectReceipt: { effect: "external" }, simulated: false, createdAt: "2026-11-27T00:00:00.000Z"
        }
      ]
    });
    expect(trace.units.find((unit) => unit.id === "model-limit")?.status).toBe("pass");
    expect(trace.units.find((unit) => unit.id === "approval")?.status).toBe("fail");
  });
});

describe("pricing and cost", () => {
  it("prices cached and uncached tokens separately, and never hides unpriced usage", () => {
    const registry = new PricingRegistry({
      rows: [{
        providerId: "p1", modelPattern: "model-a", inputPerMTok: 2, cachedInputPerMTok: 0.5, cacheWritePerMTok: 3,
        outputPerMTok: 10, reasoningPerMTok: 10, source: "test", asOf: "2026-11-01"
      }],
      version: "test-1"
    });
    const estimate = registry.estimate({
      providerId: "p1", modelId: "model-a-2026",
      usage: { inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 100_000 }
    });
    expect(estimate.priced).toBe(true);
    // 800k input * $2/M = 1.6, 200k cached * 0.5 = 0.1, 100k output * 10 = 1.0
    expect(estimate.usd).toBeCloseTo(2.7, 5);
    const unpriced = registry.estimate({ providerId: "p1", modelId: "unknown", usage: { inputTokens: 10, outputTokens: 10 } });
    expect(unpriced.priced).toBe(false);
    expect(unpriced.usd).toBe(0);
    expect(unpriced.unpricedReason).toContain("pricing_missing");
  });

  it("enforces task and daily budgets with real USD", () => {
    const dir = tempDir();
    const store = new EvidenceStore(join(dir, "evidence.sqlite"));
    const registry = new PricingRegistry({
      rows: [{ providerId: null, modelPattern: "m", inputPerMTok: 1, cachedInputPerMTok: 1, cacheWritePerMTok: 1, outputPerMTok: 1, reasoningPerMTok: 1, source: "t", asOf: "2026-11-01" }]
    });
    const ledger = new CostLedger(store, registry);
    const taskRecord = task({ id: "task-cost" });
    ledger.recordRun({
      run: run({ id: "run-cost", taskId: "task-cost" }),
      task: taskRecord,
      usage: { inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      providerId: "p",
      modelId: "m"
    });
    const statuses = ledger.checkTask(taskRecord, { daily: { limitUsd: 5 }, task: { defaultUsd: 2 } });
    const taskBudget = statuses.find((status) => status.kind === "task");
    expect(taskBudget?.spentUsd).toBeCloseTo(1, 5);
    const tight = ledger.checkTask(taskRecord, { task: { defaultUsd: 0.5, onExceed: "block" } })
      .find((status) => status.kind === "task");
    expect(tight?.decision).toBe("block");
    expect(tight?.reason).toBe("budget_exceeded");
    store.close();
  });

  it("escalates degradation monotonically and requires explicit recovery", () => {
    const dir = tempDir();
    const store = new EvidenceStore(join(dir, "evidence.sqlite"));
    const controller = new DegradationController(store);
    expect(controller.current("run-d")).toBe("none");
    expect(controller.escalate("run-d", "budget").step).toBe("context_shrink");
    expect(controller.escalate("run-d", "budget").step).toBe("tool_call_reduce");
    expect(controller.escalate("run-d", "budget").step).toBe("fallback_model");
    expect(controller.escalate("run-d", "budget").step).toBe("stop");
    expect(controller.escalate("run-d", "budget").step).toBe("stop");
    expect(controller.history("run-d")).toHaveLength(4);
    expect(controller.recover("run-d").step).toBe("none");
    expect(controller.history("run-d")).toHaveLength(5);
    store.close();
  });
});

describe("harness variants", () => {
  it("changes the effective digest only when a control changes", () => {
    const baseline: VariantBaseline = {
      contextPolicyVersion: "default", compactionThreshold: 0.68, maxParallelTools: 4, toolPolicy: "full",
      directTools: [], approvalMode: "necessary", retryMaxRetries: 2, promptRegistryVersion: "native-v1",
      maxTurns: 40, maxToolCalls: 200, degradationPolicy: "budget-v1"
    };
    const base = effectiveConfig(baseline, BASELINE_VARIANT);
    const compact = effectiveConfig(baseline, { schemaVersion: 1, id: "compact", label: "紧凑", description: "", overrides: { compactionThreshold: 0.5 } });
    expect(base.digest).not.toBe(compact.digest);
    expect(compact.compactionThreshold).toBe(0.5);
    expect(validateVariant({ schemaVersion: 1, id: "bad", label: "", overrides: { compactionThreshold: 2 } }).ok).toBe(false);
  });
});

describe("cassette storage and divergence", () => {
  it("records a cassette, reloads model responses and explains the first divergence", async () => {
    const dir = tempDir();
    const store = new EvidenceStore(join(dir, "evidence.sqlite"));
    const session = new CassetteSession({
      store,
      runId: "run-c",
      taskId: "task-1",
      goal: "写出报告",
      environmentDigest: "env"
    });
    const recorder = new ExchangeRecorder(session, "env");
    await recorder.record({
      kind: "model.request",
      requestFingerprint: "fp-1",
      input: {
        modelId: "model-a",
        protocol: "openai-chat",
        messages: [{ role: "system", content: "你是执行器" }, { role: "user", content: "写出报告" }],
        tools: [{ name: "write_file", description: "写", parameters: { type: "object" } }],
        sampling: { temperature: 0.2 }
      },
      output: { status: "sent" }
    });
    await recorder.record({
      kind: "model.response",
      requestFingerprint: "fp-1",
      input: { requestFingerprint: "fp-1" },
      output: { content: "done", toolCalls: [], finishReason: "stop" },
      usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 }
    });
    session.finish({ status: "completed" });
    const loaded = loadCassette(store, "cassette:run-c");
    expect(loaded?.metadata.systemPrompt).toBe("你是执行器");
    expect(loaded?.metadata.modelId).toBe("model-a");
    expect(loaded?.source.findModelResponse("fp-1")?.turn.content).toBe("done");

    const report = buildDivergenceReport({
      id: "report-1",
      cassette: loaded!,
      candidateRunId: "replay-1",
      mode: "strict_replay",
      recordedSteps: [{ kind: "model.request", fingerprint: "fp-1", sequence: 1, detail: { systemPromptHash: "s1", toolSchemaHash: "t1" } }],
      candidateSteps: [
        { kind: "model.request", fingerprint: "fp-1", simulated: true, detail: { systemPromptHash: "s1", toolSchemaHash: "t1" } },
        { kind: "model.response", fingerprint: "fp-1", simulated: true }
      ],
      termination: { recorded: { status: "completed" }, candidate: { status: "completed" } },
      origin: "replay",
      parentRunId: null,
      checkpointSeq: null
    });
    expect(report.matched).toBe(true);
    expect(report.providerCalls).toBe(0);

    const divergent = buildDivergenceReport({
      id: "report-2",
      cassette: loaded!,
      candidateRunId: "replay-2",
      mode: "live_on_divergence",
      recordedSteps: [{ kind: "model.request", fingerprint: "fp-1", sequence: 1, detail: { systemPromptHash: "s1" } }],
      candidateSteps: [{ kind: "model.request", fingerprint: "fp-2", simulated: false, detail: { systemPromptHash: "s2" } }],
      termination: { recorded: { status: "completed" }, candidate: { status: "failed" } },
      origin: "replay",
      parentRunId: null,
      checkpointSeq: null
    });
    expect(divergent.matched).toBe(false);
    expect(divergent.firstDivergence?.category).toBe("system_prompt");
    expect(divergent.providerCalls).toBe(1);
    store.close();
  });

  it("matches the evaluation-side golden compatibility fingerprint", () => {
    // Keep this fixture byte-for-byte aligned with
    // hearth-eval/packages/eval-core/src/evidence.test.ts. Both repositories
    // freeze the same sha256; a schema drift on either side breaks one of them.
    const manifest: RuntimeManifest = {
      schemaVersion: 1,
      kind: "hearth-runtime-manifest",
      contract: EVIDENCE_CONTRACT_ID,
      runId: "run-golden",
      taskId: "task-golden",
      taskTitle: "黄金契约",
      createdAt: "2026-11-27T00:00:00.000Z",
      finalizedAt: "2026-11-27T00:01:00.000Z",
      repos: [{ role: "hearth-os", commit: "abc123", branch: "main", dirty: false, version: "0.9.0" }],
      cases: { ids: ["case-a"], versions: { "case-a": 1 }, catalogDigest: "sha256:catalog" },
      model: {
        providerId: "deepseek",
        providerName: "DeepSeek",
        protocol: "openai-compatible",
        modelId: "deepseek-v4",
        modelVersion: null,
        sampling: { temperature: 0.2, maxTokens: 4096, reasoningEffort: null, seed: null },
        contextWindowTokens: 128000
      },
      prompt: { registryVersion: "prompt-r7", systemPromptHash: "sys", finalPromptHash: "final", toolSchemaHash: "tools" },
      tools: { catalogDigest: "catalog", catalogSize: 12, policy: "full", directTools: ["read_file"], mcpVersion: "1" },
      context: { policyVersion: "context-balanced", compactionThreshold: 0.7, packId: "pack-1", mode: "balanced" },
      approval: { mode: "necessary", policyVersion: "policy/1", policyHash: "ph", teamMode: true, recoveryPolicy: "manual", retryPolicy: "none" },
      sandbox: { backend: "windows-native", mode: "workspace-write", networkMode: "deny", image: null, appContainer: "hearth" },
      judge: { model: "judge-v1", promptHash: "jh", calibrationVersion: "cal-1" },
      pricing: { snapshotId: "pricing:abc", version: "2026-11", asOf: "2026-11-01" },
      budget: { scope: "task", limits: { maxCostUsd: 5 }, degradationPolicy: "quality_aware" },
      variant: { harnessVariantId: "baseline", effectiveConfigDigest: "cfg" },
      deps: { lockfileDigest: "lock" },
      executorId: "native",
      compatibilityFingerprint: "",
      completeness: { status: "complete", missing: [] }
    };
    expect(compatibilityFingerprint(manifest)).toBe("b7bd658cc1b0ba0039a6c0ff27c188052afcba30a0e8be920d551acec6755f4d");
  });
});

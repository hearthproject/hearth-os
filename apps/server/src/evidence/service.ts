// Evidence service: builds runtime manifests, records artifact provenance and
// policy decisions, and closes the cost ledger. It listens to the runtime
// event bus and never blocks a task: every handler is defensive.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ArtifactRecord, EventEnvelope, RunRecord, TaskRecord } from "@hearth/core";
import { ExchangeRecorder, toolCatalogDigest, type CassetteMetadata } from "@hearth/agent-runtime";
import type { HearthService } from "../service.ts";
import type { ModelSettings } from "../model-settings.ts";
import { CassetteSession } from "./cassette-store.ts";
import {
  buildArtifactProvenance,
  buildRuntimeManifest,
  canonicalJson,
  compatibilityFingerprint,
  digestOf,
  manifestCompleteness,
  sha256Hex,
  type ArtifactProvenance,
  type ProvenanceRef,
  type RuntimeManifest
} from "./contracts.ts";
import type { EvidenceStore } from "./store.ts";
import {
  CostLedger,
  DegradationController,
  budgetsForTask,
  loadBudgetConfig,
  type BudgetConfig,
  type DegradationDirective
} from "./cost.ts";
import type { PricingRegistry } from "./pricing.ts";
import { buildPolicyFromTask, evaluatePolicy, policyHash, type PolicySpec } from "./policy.ts";
import { BASELINE_VARIANT, effectiveConfig, type HarnessVariantSpec } from "./variant.ts";

export interface EvidenceServiceOptions {
  store: EvidenceStore;
  service: HearthService;
  pricing: PricingRegistry;
  dataDir: string;
  repoPaths: string[];
  evalRepoPath?: string | null;
  modelForExecutor: (executorId: string | null) => ModelSettings | null;
  budgetConfig?: BudgetConfig;
  variant?: HarnessVariantSpec;
  now?: () => Date;
  log?: (message: string) => void;
}

interface RepoFacts {
  role: "hearth-os" | "hearth-eval";
  commit: string | null;
  branch: string | null;
  dirty: boolean | null;
  version: string | null;
}

const repoCache = new Map<string, RepoFacts>();

function readRepoFacts(path: string, role: RepoFacts["role"]): RepoFacts {
  const cached = repoCache.get(path);
  if (cached) return cached;
  const facts: RepoFacts = { role, commit: null, branch: null, dirty: null, version: null };
  if (!existsSync(path)) {
    repoCache.set(path, facts);
    return facts;
  }
  try {
    facts.commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { /* not a git checkout */ }
  try {
    facts.branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { /* ignore */ }
  try {
    facts.dirty = execFileSync("git", ["status", "--porcelain"], { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch { /* ignore */ }
  try {
    const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { version?: string };
    facts.version = typeof pkg.version === "string" ? pkg.version : null;
  } catch { /* ignore */ }
  repoCache.set(path, facts);
  return facts;
}

function fileDigest(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return `sha256:${sha256Hex(readFileSync(path))}`;
  } catch {
    return null;
  }
}

function safe<T>(work: () => T, log: (message: string) => void, label: string): T | null {
  try {
    return work();
  } catch (error) {
    log(`[evidence] ${label} 失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function artifactInputs(artifact: ArtifactRecord): ProvenanceRef[] {
  try {
    const manifestPath = join(dirname(artifact.absolutePath), "run-manifest.json");
    if (!existsSync(manifestPath)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      inputs?: Array<{ label?: string; kind?: string; source?: string; sha256?: string }>;
    };
    return (manifest.inputs ?? [])
      .filter((input) => input.label || input.source)
      .map((input) => ({
        kind: "input" as const,
        ref: input.source ?? input.label ?? "input",
        sha256: input.sha256 ?? null,
        bytes: null,
        label: input.label ?? null
      }));
  } catch {
    return [];
  }
}

interface ProducingCall {
  toolCallId: string | null;
  toolName: string | null;
  turn: number | null;
  stepId: string | null;
  inference: "explicit" | "inferred" | "unknown";
}

function inferProducingCall(items: Array<{ kind: string; content: string; provenance: Record<string, unknown>; executorEventId: string | null }>, relativePath: string): ProducingCall {
  const base = basename(relativePath);
  const candidates = items.filter((item) => item.kind === "tool_call");
  for (const item of candidates.slice().reverse()) {
    const newline = item.content.indexOf("\n");
    const toolName = newline > 0 ? item.content.slice(0, newline) : item.content;
    const rawArgs = newline > 0 ? item.content.slice(newline + 1) : "";
    let args: Record<string, unknown> | null = null;
    try {
      args = rawArgs ? JSON.parse(rawArgs) as Record<string, unknown> : null;
    } catch {
      args = null;
    }
    const pathFields = ["path", "file_path", "outputPath", "target", "destination", "file"];
    const explicit = args !== null && pathFields.some((field) => {
      const value = args[field];
      return typeof value === "string" && (value === relativePath || value === base || value.endsWith(`/${relativePath}`));
    });
    const mentioned = item.content.includes(relativePath) || (base.length > 3 && item.content.includes(base));
    if (!explicit && !mentioned) continue;
    return {
      toolCallId: typeof item.provenance.toolCallId === "string" ? item.provenance.toolCallId : null,
      toolName,
      turn: typeof item.provenance.turn === "number" ? item.provenance.turn : null,
      stepId: item.executorEventId ?? null,
      inference: explicit ? "explicit" : "inferred"
    };
  }
  return { toolCallId: null, toolName: null, turn: null, stepId: null, inference: "unknown" };
}

export class EvidenceService {
  private readonly store: EvidenceStore;
  private readonly service: HearthService;
  private readonly pricing: PricingRegistry;
  private readonly cost: CostLedger;
  private readonly degradation: DegradationController;
  private readonly dataDir: string;
  private readonly repoPaths: string[];
  private readonly evalRepoPath: string | null;
  private readonly modelForExecutor: (executorId: string | null) => ModelSettings | null;
  private readonly budgetConfig: BudgetConfig;
  private readonly variant: HarnessVariantSpec;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly unsubscribe: () => void;
  private readonly factCache = new Map<string, { prompt?: RuntimeManifest["prompt"]; tools?: RuntimeManifest["tools"]; context?: RuntimeManifest["context"]; sandbox?: RuntimeManifest["sandbox"] }>();

  constructor(options: EvidenceServiceOptions) {
    this.store = options.store;
    this.service = options.service;
    this.pricing = options.pricing;
    this.cost = new CostLedger(options.store, options.pricing);
    this.degradation = new DegradationController(options.store);
    this.dataDir = options.dataDir;
    this.repoPaths = options.repoPaths;
    this.evalRepoPath = options.evalRepoPath ?? null;
    this.modelForExecutor = options.modelForExecutor;
    this.budgetConfig = options.budgetConfig ?? loadBudgetConfig(options.dataDir);
    this.variant = options.variant ?? BASELINE_VARIANT;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message) => console.warn(message));
    this.unsubscribe = this.service.bus.subscribe((event) => this.onEvent(event));
    // Runs that already exist when the service starts are backfilled lazily.
  }

  dispose(): void {
    this.unsubscribe();
  }

  get pricingRegistry(): PricingRegistry {
    return this.pricing;
  }

  private onEvent(event: EventEnvelope): void {
    switch (event.type) {
      case "run.created":
        safe(() => this.ensureManifest(event.payload as RunRecord), this.log, "run.created");
        break;
      case "runtime.prompt.snapshot":
        safe(() => this.applyPromptSnapshot(event.runId, event.payload as Record<string, unknown>), this.log, "prompt.snapshot");
        break;
      case "context.pack.created":
        safe(() => this.applyContextPack(event.runId, event.payload as Record<string, unknown>), this.log, "context.pack.created");
        break;
      case "sandbox.selected":
        safe(() => this.applySandbox(event.runId, event.payload as Record<string, unknown>), this.log, "sandbox.selected");
        break;
      case "artifact.published":
        safe(() => this.recordProvenance(event.payload as ArtifactRecord), this.log, "artifact.published");
        break;
      case "run.updated":
        safe(() => this.onRunUpdated(event.runId, event.taskId), this.log, "run.updated");
        break;
      case "approval.created":
        safe(() => this.recordApprovalPolicy(event.payload as Record<string, unknown>, "requested"), this.log, "approval.created");
        break;
      case "approval.decided":
        safe(() => this.recordApprovalPolicy(event.payload as Record<string, unknown>, "decided"), this.log, "approval.decided");
        break;
      default:
        break;
    }
  }

  repoFacts(): RepoFacts[] {
    const facts = this.repoPaths.map((path, index) => readRepoFacts(path, index === 0 ? "hearth-os" : "hearth-eval"));
    if (this.evalRepoPath) {
      const evalFacts = readRepoFacts(this.evalRepoPath, "hearth-eval");
      return [...facts.filter((item) => item.role !== "hearth-eval"), evalFacts];
    }
    return facts;
  }

  private baseFacts(run: RunRecord, task: TaskRecord) {
    const settings = this.modelForExecutor(run.executorId ?? task.executorId ?? null);
    const policy = buildPolicyFromTask(task);
    const packages = this.repoPaths.map((path) => fileDigest(join(path, "package-lock.json"))).filter((value): value is string => Boolean(value));
    return { settings, policy, lockfileDigest: packages.length > 0 ? digestOf(packages) : null };
  }

  private buildBaseManifest(run: RunRecord, task: TaskRecord): RuntimeManifest {
    const { settings, policy, lockfileDigest } = this.baseFacts(run, task);
    const budget = budgetsForTask(task, this.budgetConfig)[0] ?? null;
    const permissions = task.permissions ?? { readRoots: [], writeRoots: [], networkHosts: [], tools: [] };
    const effective = effectiveConfig({
      contextPolicyVersion: "default",
      compactionThreshold: 0.68,
      maxParallelTools: 4,
      toolPolicy: "full",
      directTools: [],
      approvalMode: permissions.approvalMode ?? "necessary",
      retryMaxRetries: 2,
      promptRegistryVersion: "native-v1",
      maxTurns: 40,
      maxToolCalls: 200,
      degradationPolicy: "budget-v1"
    }, this.variant);
    return buildRuntimeManifest({
      runId: run.id,
      taskId: task.id,
      taskTitle: task.title,
      createdAt: run.startedAt ?? this.now().toISOString(),
      finalizedAt: null,
      repos: this.repoFacts().map(({ role, commit, branch, dirty, version }) => ({ role, commit, branch, dirty, version })),
      model: settings ? {
        providerId: settings.providerId,
        providerName: settings.providerName,
        protocol: settings.protocol,
        modelId: settings.model,
        modelVersion: null,
        sampling: {
          temperature: 0.2,
          maxTokens: settings.maxOutputTokens,
          reasoningEffort: settings.reasoningEffort ?? "max",
          seed: null
        },
        contextWindowTokens: settings.contextWindowTokens
      } : null,
      prompt: null,
      tools: null,
      context: null,
      approval: {
        mode: permissions.approvalMode ?? "necessary",
        policyVersion: policy.version,
        policyHash: policyHash(policy),
        teamMode: false,
        recoveryPolicy: "manual",
        retryPolicy: "none"
      },
      sandbox: null,
      judge: null,
      pricing: {
        snapshotId: this.pricing.active().id,
        version: this.pricing.active().version,
        asOf: this.pricing.active().asOf
      },
      budget: budget ? {
        scope: budget.kind,
        limits: { usd: budget.limitUsd },
        degradationPolicy: "budget-v1"
      } : null,
      variant: { harnessVariantId: this.variant.id, effectiveConfigDigest: effective.digest },
      deps: { lockfileDigest },
      executorId: run.executorId ?? task.executorId ?? null
    });
  }

  ensureManifest(run: RunRecord): RuntimeManifest | null {
    const existing = this.store.getManifest(run.id);
    if (existing) return existing;
    const task = this.service.store.getTask(run.taskId);
    if (!task) return null;
    const manifest = this.buildBaseManifest(run, task);
    this.store.saveManifest(manifest);
    return manifest;
  }

  manifest(runId: string): RuntimeManifest | null {
    const existing = this.store.getManifest(runId);
    if (existing) return existing;
    const run = this.service.store.getRun(runId);
    if (!run) return null;
    return this.ensureManifest(run);
  }

  private updateManifest(runId: string | null, patch: Partial<RuntimeManifest>): RuntimeManifest | null {
    if (!runId) return null;
    const current = this.manifest(runId);
    if (!current) return null;
    const merged: RuntimeManifest = {
      ...current,
      ...patch,
      repos: patch.repos ?? current.repos,
      compatibilityFingerprint: current.compatibilityFingerprint,
      completeness: current.completeness
    };
    merged.compatibilityFingerprint = compatibilityFingerprint(merged);
    merged.completeness = manifestCompleteness(merged);
    this.store.saveManifest(merged);
    return merged;
  }

  applyPromptSnapshot(runId: string | null, payload: Record<string, unknown>): void {
    if (!runId) return;
    const facts = this.factCache.get(runId) ?? {};
    const prompt = {
      registryVersion: typeof payload.registryVersion === "string" ? payload.registryVersion : "native-v1",
      systemPromptHash: typeof payload.systemPromptHash === "string" ? payload.systemPromptHash : null,
      finalPromptHash: typeof payload.finalPromptHash === "string" ? payload.finalPromptHash : null,
      toolSchemaHash: typeof payload.toolSchemaHash === "string" ? payload.toolSchemaHash : null
    };
    const tools = {
      catalogDigest: typeof payload.toolSchemaHash === "string" ? payload.toolSchemaHash : null,
      catalogSize: typeof payload.toolCount === "number" ? payload.toolCount : null,
      policy: (["full", "deferred", "unknown"] as const).includes(payload.toolPolicy as never)
        ? payload.toolPolicy as "full" | "deferred" | "unknown"
        : "unknown",
      directTools: Array.isArray(payload.directTools) ? payload.directTools.filter((item): item is string => typeof item === "string") : [],
      mcpVersion: null
    };
    facts.prompt = prompt;
    facts.tools = tools;
    if (typeof payload.contextPolicyVersion === "string") {
      facts.context = {
        policyVersion: payload.contextPolicyVersion,
        compactionThreshold: typeof payload.compactionThreshold === "number" ? payload.compactionThreshold : null,
        packId: facts.context?.packId ?? null,
        mode: facts.context?.mode ?? null
      };
    }
    this.factCache.set(runId, facts);
    this.updateManifest(runId, {
      ...(facts.prompt ? { prompt: facts.prompt } : {}),
      ...(facts.tools ? { tools: facts.tools } : {}),
      ...(facts.context ? { context: facts.context } : {})
    });
  }

  applyContextPack(runId: string | null, payload: Record<string, unknown>): void {
    if (!runId) return;
    const facts = this.factCache.get(runId) ?? {};
    facts.context = {
      policyVersion: typeof payload.policyVersion === "string" ? payload.policyVersion : facts.context?.policyVersion ?? null,
      compactionThreshold: typeof payload.compactionThreshold === "number" ? payload.compactionThreshold : facts.context?.compactionThreshold ?? null,
      packId: typeof payload.packId === "string" ? payload.packId : facts.context?.packId ?? null,
      mode: typeof payload.mode === "string" ? payload.mode : facts.context?.mode ?? null
    };
    this.factCache.set(runId, facts);
    this.updateManifest(runId, { context: facts.context });
  }

  applySandbox(runId: string | null, payload: Record<string, unknown>): void {
    if (!runId) return;
    const facts = this.factCache.get(runId) ?? {};
    facts.sandbox = {
      backend: typeof payload.backend === "string" ? payload.backend : "none",
      mode: typeof payload.mode === "string" ? payload.mode : "unknown",
      networkMode: typeof payload.networkMode === "string" ? payload.networkMode : "unknown",
      image: typeof payload.image === "string" ? payload.image : null,
      appContainer: typeof payload.appContainer === "string" ? payload.appContainer : null
    };
    this.factCache.set(runId, facts);
    this.updateManifest(runId, { sandbox: facts.sandbox });
  }

  recordProvenance(artifact: ArtifactRecord): ArtifactProvenance | null {
    const run = this.service.store.getRun(artifact.runId);
    const task = this.service.store.getTask(artifact.taskId);
    const manifest = run ? this.manifest(run.id) ?? this.ensureManifest(run) : null;
    const contextItems = this.service.store.listContextItems(artifact.taskId, { limit: 500 }).items;
    const producing = inferProducingCall(contextItems, artifact.relativePath);
    const operations = run ? this.service.store.listRunOperations(run.id) : [];
    const operationIds = producing.toolCallId
      ? operations.filter((operation) => operation.toolCallId === producing.toolCallId).map((operation) => operation.operationId)
      : [];
    const priorArtifacts = this.service.store.listArtifacts(artifact.taskId).filter((item) => item.id !== artifact.id);
    const samePath = priorArtifacts.filter((item) => item.relativePath === artifact.relativePath);
    const companions = priorArtifacts.filter((item) => item.runId === artifact.runId && item.relativePath !== artifact.relativePath && item.relativePath !== "run-manifest.json").slice(0, 8);
    const parents: ArtifactProvenance["parents"] = [
      ...samePath.map((item) => ({ artifactId: item.id, sha256: item.sha256, relation: "replaces" as const })),
      ...companions.map((item) => ({ artifactId: item.id, sha256: item.sha256, relation: "companion" as const }))
    ];
    const approvals = this.service.store.listApprovals(artifact.taskId).filter((approval) => approval.runId === artifact.runId);
    const latestApproval = approvals.at(-1) ?? null;
    const requests = this.store.listExchanges(artifact.runId, "model.request");
    const lastRequest = requests.at(-1) ?? null;
    const derivedRequest = manifest?.prompt?.finalPromptHash ?? manifest?.prompt?.systemPromptHash ?? null;
    const hashes = [manifest?.tools?.catalogDigest, manifest?.prompt?.toolSchemaHash, manifest?.sandbox?.backend].filter(Boolean);
    const environmentDigest = digestOf({
      hashes,
      workspace: digestOf((task?.outputDir ?? "").replaceAll("\\", "/"))
    });
    const workspaceDigest = digestOf(artifact.relativePath);
    const provenance = buildArtifactProvenance({
      artifact: {
        id: artifact.id,
        taskId: artifact.taskId,
        runId: artifact.runId,
        relativePath: artifact.relativePath,
        mimeType: artifact.mimeType,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        createdAt: artifact.createdAt
      },
      inputs: artifactInputs(artifact),
      parents,
      producedBy: {
        runId: artifact.runId,
        stepId: producing.stepId,
        turn: producing.turn,
        toolCallId: producing.toolCallId,
        toolName: producing.toolName,
        operationIds,
        checkpointSeq: run?.checkpointSeq ?? null,
        inference: producing.inference
      },
      model: manifest?.model
        ? {
            providerId: manifest.model.providerId,
            modelId: manifest.model.modelId,
            requestFingerprint: lastRequest?.requestFingerprint ?? derivedRequest
          }
        : null,
      toolSchemaHash: manifest?.prompt?.toolSchemaHash ?? null,
      policy: manifest?.approval
        ? {
            version: manifest.approval.policyVersion,
            hash: manifest.approval.policyHash,
            ruleId: null,
            approvalId: latestApproval?.id ?? null,
            decision: latestApproval?.status ?? null,
            permissionMode: manifest.approval.mode
          }
        : null,
      environment: {
        digest: environmentDigest,
        sandbox: manifest?.sandbox?.backend ?? null,
        workspaceDigest
      },
      lineage: {
        parentRunId: run?.parentRunId ?? null,
        attempt: run?.attempt ?? null
      }
    });
    this.store.saveProvenance(provenance);
    return provenance;
  }

  private recordApprovalPolicy(payload: Record<string, unknown>, phase: "requested" | "decided"): void {
    const approvalId = typeof payload.id === "string" ? payload.id : null;
    const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
    const runId = typeof payload.runId === "string" ? payload.runId : null;
    if (!approvalId || !taskId) return;
    const task = this.service.store.getTask(taskId);
    if (!task) return;
    const spec: PolicySpec = buildPolicyFromTask(task);
    const target = (payload.target ?? {}) as Record<string, unknown>;
    const tool = typeof target.tool === "string" ? target.tool : typeof target.action === "string" ? target.action : "unknown";
    const paths = Array.isArray(target.paths) ? target.paths.filter((item): item is string => typeof item === "string") : [];
    const domains = Array.isArray(target.domains) ? target.domains.filter((item): item is string => typeof item === "string") : [];
    const evaluation = evaluatePolicy(spec, {
      tool,
      args: target,
      paths,
      domains,
      ...(target.effect === "external" || target.effect === "write" || target.effect === "money" || target.effect === "destructive" || target.effect === "read"
        ? { effect: target.effect }
        : {})
    });
    const status = typeof payload.status === "string" ? payload.status : phase;
    this.store.recordPolicyDecision({
      id: `approval:${approvalId}:${phase}`,
      runId,
      taskId,
      ruleId: evaluation.ruleId,
      policyVersion: evaluation.policyVersion,
      decision: phase === "decided" ? status : evaluation.effectiveDecision,
      createdAt: typeof payload.createdAt === "string" ? payload.createdAt : this.now().toISOString(),
      payload: {
        approvalId,
        phase,
        status,
        action: { tool, paths, domains },
        evaluation
      }
    });
  }

  private onRunUpdated(runId: string | null, taskId: string | null): void {
    if (!runId) return;
    const run = this.service.store.getRun(runId);
    if (!run) return;
    const task = this.service.store.getTask(run.taskId);
    if (!task) return;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      const current = this.manifest(run.id) ?? this.ensureManifest(run);
      if (current && !current.finalizedAt) {
        this.updateManifest(run.id, { finalizedAt: this.now().toISOString() });
      }
      const settings = this.modelForExecutor(run.executorId ?? null);
      const entry = this.cost.recordRun({
        run,
        task,
        usage: run.usage,
        providerId: settings?.providerId ?? null,
        modelId: settings?.model ?? null
      });
      if (entry && taskId) {
        // Cost is recorded once per run+pricing snapshot thanks to the entry id.
        this.log(`[evidence] run ${run.id} cost ${entry.breakdown.priced ? `$${entry.usd}` : "unpriced"}`);
      }
    } else if (!this.store.getManifest(run.id)) {
      this.ensureManifest(run);
    }
  }

  /** Starts a durable cassette for a native run; recording is 100% when enabled. */
  beginCassette(run: RunRecord, task: TaskRecord, goal: string): {
    session: CassetteSession;
    recorder: ExchangeRecorder;
    environmentDigest: string;
  } {
    const manifest = this.manifest(run.id) ?? this.ensureManifest(run);
    const environmentDigest = digestOf({
      sandbox: manifest?.sandbox ?? null,
      tools: manifest?.tools?.catalogDigest ?? null,
      prompt: manifest?.prompt?.systemPromptHash ?? null,
      workspace: task.outputDir.replaceAll("\\", "/")
    });
    const session = new CassetteSession({
      store: this.store,
      runId: run.id,
      taskId: task.id,
      goal,
      environmentDigest,
      ...(manifest?.tools?.catalogDigest ? { toolCatalogDigest: manifest.tools.catalogDigest } : {}),
      ...(this.now ? { now: this.now } : {})
    });
    const recorder = new ExchangeRecorder(session, environmentDigest);
    return { session, recorder, environmentDigest };
  }

  /** Called on every model request; supplies prompt/tool hashes without a parallel loop. */
  recordModelRequest(runId: string | null, info: {
    requestFingerprint: string;
    messageCount: number;
    toolCount: number;
    turn: number;
    request: unknown;
  }): void {
    if (!runId) return;
    const request = (info.request ?? {}) as {
      modelId?: string;
      systemMessage?: string | null;
      tools?: Array<{ name: string; description: string; parameters: unknown }>;
    };
    const systemPromptHash = typeof request.systemMessage === "string" ? sha256Hex(request.systemMessage) : null;
    const toolSchemaHash = Array.isArray(request.tools)
      ? toolCatalogDigest(request.tools.map((tool) => ({
          definition: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as Record<string, unknown>
          }
        })))
      : null;
    this.applyPromptSnapshot(runId, {
      registryVersion: "native-v1",
      systemPromptHash,
      finalPromptHash: info.requestFingerprint,
      toolSchemaHash,
      toolCount: info.toolCount,
      toolPolicy: "full",
      contextPolicyVersion: "native-v1",
      compactionThreshold: 0.68
    });
  }

  /** Manifest-driven view for the API. */
  manifestView(runId: string): Record<string, unknown> | null {    const manifest = this.manifest(runId);
    if (!manifest) return null;
    const run = this.service.store.getRun(runId);
    return {
      manifest,
      fingerprintValid: compatibilityFingerprint(manifest) === manifest.compatibilityFingerprint,
      exchanges: this.store.listExchanges(runId).length,
      costs: this.cost.store.listCosts({ runId }),
      run: run ? { id: run.id, status: run.status, attempt: run.attempt, usage: run.usage ?? null } : null
    };
  }

  taskEvidence(taskId: string): Record<string, unknown> {
    const manifests = this.service.store.listRuns(taskId).map((run) => this.manifest(run.id)).filter((manifest): manifest is RuntimeManifest => Boolean(manifest));
    const provenance = this.store.listProvenanceForTask(taskId);
    const complete = provenance.filter((item) => item.completeness.status === "complete").length;
    return {
      taskId,
      manifests,
      provenance,
      counts: {
        artifacts: provenance.length,
        complete,
        incomplete: provenance.length - complete,
        incompleteRate: provenance.length === 0 ? 0 : Number(((provenance.length - complete) / provenance.length).toFixed(4))
      }
    };
  }

  artifactGraph(taskId: string): Record<string, unknown> {
    const provenance = this.store.listProvenanceForTask(taskId);
    const nodes = provenance.map((item) => ({
      id: item.artifactId,
      path: item.relativePath,
      sha256: item.sha256,
      bytes: item.bytes,
      runId: item.runId,
      completeness: item.completeness.status
    }));
    const edges = provenance.flatMap((item) => [
      ...item.parents.map((parent) => ({ from: parent.artifactId, to: item.artifactId, relation: parent.relation })),
      ...item.inputs.filter((input) => input.kind === "artifact").map((input) => ({ from: input.ref, to: item.artifactId, relation: "derived_from" as const }))
    ]);
    return { taskId, nodes, edges, generatedAt: this.now().toISOString() };
  }

  policyForTask(taskId: string): PolicySpec | null {
    const task = this.service.store.getTask(taskId);
    return task ? buildPolicyFromTask(task) : null;
  }

  budgetStatus(taskId: string): ReturnType<CostLedger["checkTask"]> {
    const task = this.service.store.getTask(taskId);
    return task ? this.cost.checkTask(task, this.budgetConfig) : [];
  }

  costSummary(): Record<string, unknown> {
    return { ...this.cost.summary(), budgetConfig: this.budgetConfig };
  }

  /** Exposed to the scheduler for the pre-run funding gate. */
  budgetDecision(task: TaskRecord): { allowed: boolean; reason: string; statuses: ReturnType<CostLedger["checkTask"]> } {
    const statuses = this.cost.checkTask(task, this.budgetConfig);
    const blocking = statuses.find((status) => status.decision === "block");
    if (blocking) return { allowed: false, reason: `budget_exceeded:${blocking.scopeKey}`, statuses };
    return { allowed: true, reason: "budget_ok", statuses };
  }

  /** Escalate the quality-aware degradation ladder and return the active directive. */
  escalateBudget(runId: string, reason: string, detail: Record<string, unknown> = {}): DegradationDirective {
    return this.degradation.escalate(runId, reason, detail);
  }

  budgetDirective(runId: string): DegradationDirective {
    return this.degradation.directive(runId);
  }

  /** Predicted approvals (preflight) versus decisions actually recorded for a task. */
  policyActual(taskId: string): Record<string, unknown> {
    const task = this.service.store.getTask(taskId);
    if (!task) return { taskId, found: false, preflights: [], decisions: [], diff: null };
    const preflights = this.store.listPreflights(taskId, 20);
    const decisions = this.store.listPolicyDecisions({ taskId, limit: 500 });
    const count = (items: Array<Record<string, unknown>>, key: string, value: string) =>
      items.filter((item) => item[key] === value).length;
    const predicted = preflights[0] && typeof preflights[0].counts === "object"
      ? preflights[0].counts as Record<string, number>
      : null;
    const actual = {
      allow: count(decisions, "effectiveDecision", "allow"),
      ask: count(decisions, "effectiveDecision", "ask"),
      deny: count(decisions, "effectiveDecision", "deny"),
      total: decisions.length
    };
    const diff = predicted
      ? {
        allow: actual.allow - (predicted.allow ?? 0),
        ask: actual.ask - (predicted.ask ?? 0),
        deny: actual.deny - (predicted.deny ?? 0),
        unexpectedApprovals: Math.max(0, actual.ask - (predicted.ask ?? 0)),
        unexpectedDenials: Math.max(0, actual.deny - (predicted.deny ?? 0))
      }
      : null;
    return { taskId, found: true, policyHash: policyHash(buildPolicyFromTask(task)), preflights, decisions, actual, diff };
  }

  /** Liveness check for the read-only API. */
  stats(): Record<string, unknown> {
    return {
      contract: "hearth-evidence/1",
      manifests: this.store.listAllManifests(200).length,
      pricing: this.pricing.active().id,
      variant: this.variant.id,
      budgetConfig: this.budgetConfig
    };
  }
}


// Read-only evidence APIs plus controlled replay/fork, verification and policy
// preflight. Hearth Eval is the main consumer; it never opens OS databases.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ArtifactRecord } from "@hearth/core";
import type { HearthService } from "../service.ts";
import type { EvidenceService } from "./service.ts";
import type { EvidenceStore } from "./store.ts";
import type { ReplayService } from "./replay.ts";
import { runVerificationSpec, validateVerificationSpec, productionGate } from "./verification.ts";
import { buildPolicyFromTask, preflightPolicy, policyView, validatePolicySpec, type PolicyAction } from "./policy.ts";
import { budgetsForTask, DegradationController, loadBudgetConfig } from "./cost.ts";
import { pricingSnapshotView } from "./pricing.ts";
import { BUILTIN_VARIANTS, effectiveConfig, validateVariant, variantMetrics, type VariantBaseline } from "./variant.ts";
import { defaultCommandRunner } from "./verification.ts";
import { dirname, resolve } from "node:path";

const counterfactualSchema = z.object({
  toolName: z.string().min(1),
  ordinal: z.number().int().min(0).optional(),
  arguments: z.unknown(),
  replaceWith: z.string().min(1).optional()
}).strict();

function taskIdOf(query: Record<string, unknown>): string | null {
  return typeof query.taskId === "string" && query.taskId ? query.taskId : null;
}

function artifactLikes(items: ArtifactRecord[]): Array<{ relativePath: string; absolutePath: string; sha256: string; bytes: number; mimeType: string }> {
  return items.map((item) => ({
    relativePath: item.relativePath,
    absolutePath: item.absolutePath,
    sha256: item.sha256,
    bytes: item.bytes,
    mimeType: item.mimeType
  }));
}

const BASELINE: VariantBaseline = {
  contextPolicyVersion: "default",
  compactionThreshold: 0.68,
  maxParallelTools: 4,
  toolPolicy: "full",
  directTools: [],
  approvalMode: "necessary",
  retryMaxRetries: 2,
  promptRegistryVersion: "native-v1",
  maxTurns: 40,
  maxToolCalls: 200,
  degradationPolicy: "budget-v1"
};

export interface EvidenceRouteOptions {
  service: HearthService;
  evidence: EvidenceService;
  store: EvidenceStore;
  replay: ReplayService;
  dataDir: string;
}

export function registerEvidenceRoutes(app: FastifyInstance, options: EvidenceRouteOptions): void {
  const { service, evidence, store, replay } = options;

  app.get("/api/evidence/health", async (_request, reply: FastifyReply) => {
    return reply.send({ ok: true, ...evidence.stats() });
  });

  app.get("/api/evidence/runs/:runId/manifest", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const view = evidence.manifestView(runId);
    if (!view) return reply.code(404).send({ error: "MANIFEST_NOT_FOUND", message: `run 没有 manifest：${runId}` });
    return reply.send(view);
  });

  app.get("/api/evidence/runs/:runId/exchanges", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const query = request.query as Record<string, unknown>;
    const kind = typeof query.kind === "string" ? query.kind : undefined;
    return reply.send({ runId, exchanges: store.listExchanges(runId, kind) });
  });

  app.get("/api/evidence/cassettes", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const runId = typeof query.runId === "string" ? query.runId : undefined;
    return reply.send({ cassettes: store.listCassettes(runId) });
  });

  app.get("/api/evidence/tasks/:taskId/evidence", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    return reply.send(evidence.taskEvidence(taskId));
  });

  app.get("/api/evidence/tasks/:taskId/graph", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    return reply.send(evidence.artifactGraph(taskId));
  });

  app.get("/api/evidence/tasks/:taskId/provenance", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = service.store.getTask(taskId);
    if (!task) return reply.code(404).send({ error: "TASK_NOT_FOUND" });
    const graph = evidence.artifactGraph(taskId);
    const chains = store.listProvenanceForTask(taskId);
    return reply.send({ taskId, graph, chains });
  });

  app.get("/api/evidence/artifacts/:artifactId/provenance", async (request, reply) => {
    const { artifactId } = request.params as { artifactId: string };
    const provenance = store.getProvenance(artifactId);
    if (!provenance) return reply.code(404).send({ error: "PROVENANCE_NOT_FOUND", message: `没有 provenance：${artifactId}` });
    return reply.send({ provenance });
  });

  app.get("/api/evidence/compare", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    if (typeof query.left !== "string" || typeof query.right !== "string") {
      return reply.code(400).send({ error: "INVALID_COMPARE", message: "left 与 right 必须是 runId" });
    }
    return reply.send(store.compareManifests(query.left, query.right));
  });

  app.get("/api/evidence/pricing", async (_request, reply) => {
    return reply.send(pricingSnapshotView(evidence.pricingRegistry));
  });

  app.get("/api/evidence/variants", async (_request, reply) => {
    return reply.send({
      variants: store.listVariants().length > 0 ? store.listVariants() : BUILTIN_VARIANTS.map((variant) => ({
        ...variant,
        effective: effectiveConfig(BASELINE, variant)
      }))
    });
  });

  app.post("/api/evidence/variants", async (request, reply) => {
    const parsed = validateVariant(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: "INVALID_VARIANT", errors: parsed.errors });
    const effective = effectiveConfig(BASELINE, parsed.spec);
    store.saveVariant(parsed.spec.id, effective.digest, { ...parsed.spec, effective }, new Date().toISOString());
    return reply.send({ ok: true, variant: parsed.spec, effective });
  });

  app.get("/api/evidence/variants/metrics", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const taskId = taskIdOf(query);
    const manifests = taskId ? store.listManifests(taskId, 200) : store.listAllManifests(500);
    return reply.send(variantMetrics(manifests));
  });

  app.get("/api/evidence/policy/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const spec = evidence.policyForTask(taskId);
    if (!spec) return reply.code(404).send({ error: "TASK_NOT_FOUND" });
    return reply.send(policyView(spec));
  });

  app.post("/api/evidence/policy/preflight", async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body.taskId !== "string" || !Array.isArray(body.actions)) {
      return reply.code(400).send({ error: "INVALID_PREFLIGHT", message: "需要 taskId 与 actions" });
    }
    const task = service.store.getTask(body.taskId);
    if (!task) return reply.code(404).send({ error: "TASK_NOT_FOUND" });
    const actions: PolicyAction[] = body.actions.map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      return {
        tool: typeof record.tool === "string" ? record.tool : "unknown",
        ...(record.args !== undefined ? { args: record.args } : {}),
        ...(Array.isArray(record.paths) ? { paths: record.paths.filter((value): value is string => typeof value === "string") } : {}),
        ...(Array.isArray(record.domains) ? { domains: record.domains.filter((value): value is string => typeof value === "string") } : {}),
        ...(record.effect === "read" || record.effect === "write" || record.effect === "external" || record.effect === "money" || record.effect === "destructive"
          ? { effect: record.effect }
          : {})
      };
    });
    const spec = typeof body.policy === "object" && body.policy !== null
      ? (() => {
          const validated = validatePolicySpec(body.policy);
          return validated.ok ? validated.spec : buildPolicyFromTask(task);
        })()
      : buildPolicyFromTask(task);
    const preflight = preflightPolicy({ spec, taskId: task.id, actions });
    store.savePreflight({ id: preflight.id, policyHash: preflight.policyHash, taskId: task.id, createdAt: preflight.createdAt, payload: preflight as unknown as Record<string, unknown> });
    return reply.send(preflight);
  });

  app.get("/api/evidence/policy/preflights", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    return reply.send({ preflights: store.listPreflights(taskIdOf(query) ?? undefined) });
  });

  app.get("/api/evidence/policy/:taskId/actual", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const actual = evidence.policyActual(taskId);
    if (!actual.found) return reply.code(404).send({ error: "TASK_NOT_FOUND" });
    return reply.send(actual);
  });

  app.post("/api/evidence/verify", async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const validated = validateVerificationSpec(body?.spec);
    if (!validated.ok) return reply.code(400).send({ error: "INVALID_SPEC", errors: validated.errors });
    const taskId = typeof body?.taskId === "string" ? body.taskId : null;
    const runId = typeof body?.runId === "string" ? body.runId : null;
    const task = taskId ? service.store.getTask(taskId) : null;
    const workspaceRoot = typeof body?.workspaceRoot === "string"
      ? body.workspaceRoot
      : task?.outputDir
        ? resolve(dirname(options.dataDir), task.outputDir)
        : options.dataDir;
    const artifacts = taskId ? service.store.listArtifacts(taskId) : [];
    const result = await runVerificationSpec(validated.spec, {
      workspaceRoot,
      outDir: workspaceRoot,
      artifacts: artifactLikes(artifacts),
      exchanges: runId ? store.listExchanges(runId) : [],
      termination: runId ? (() => {
        const exchanges = store.listExchanges(runId, "termination");
        return exchanges.at(-1)?.output as unknown as Record<string, unknown> ?? null;
      })() : null,
      runCommand: defaultCommandRunner,
      now: () => new Date()
    });
    store.saveVerificationResult({
      id: `verification:${result.specId}:${Date.now()}`,
      specId: result.specId,
      runId,
      taskId,
      verdict: result.verdict,
      createdAt: result.finishedAt,
      payload: result as unknown as Record<string, unknown>
    });
    return reply.send({ result, gate: productionGate(result) });
  });

  app.get("/api/evidence/verifications", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const taskId = taskIdOf(query);
    const runId = typeof query.runId === "string" ? query.runId : undefined;
    return reply.send({ verifications: store.listVerificationResults({ ...(taskId ? { taskId } : {}), ...(runId ? { runId } : {}) }) });
  });

  app.get("/api/cost/summary", async (_request, reply) => {
    return reply.send(evidence.costSummary());
  });

  app.get("/api/cost/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = service.store.getTask(taskId);
    if (!task) return reply.code(404).send({ error: "TASK_NOT_FOUND" });
    return reply.send({
      taskId,
      statuses: evidence.budgetStatus(taskId),
      budgets: budgetsForTask(task, loadBudgetConfig(options.dataDir)),
      entries: store.listCosts({ taskId }),
      degradations: store.listDegradations()
    });
  });

  app.post("/api/cost/degrade", async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body.runId !== "string") return reply.code(400).send({ error: "INVALID_RUN" });
    const controller = new DegradationController(store);
    const directive = controller.escalate(body.runId, typeof body.reason === "string" ? body.reason : "manual_escalation", {
      scope: body.scope ?? null
    });
    return reply.send({ directive, history: controller.history(body.runId) });
  });

  app.post("/api/cost/recover", async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body.runId !== "string") return reply.code(400).send({ error: "INVALID_RUN" });
    const controller = new DegradationController(store);
    const directive = controller.recover(body.runId, body.policy === "new_run" ? "new_run" : "manual_reset");
    return reply.send({ directive, history: controller.history(body.runId) });
  });

  app.post("/api/replay/runs", async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body.cassetteId !== "string") {
      return reply.code(400).send({ error: "INVALID_REPLAY", message: "cassetteId 必填" });
    }
    if (body.replacement !== undefined) {
      const parsed = counterfactualSchema.safeParse(body.replacement);
      if (!parsed.success) return reply.code(400).send({ error: "INVALID_REPLACEMENT", message: parsed.error.issues[0]?.message });
    }
    try {
      const result = await replay.replay({
        cassetteId: body.cassetteId,
        ...(body.mode === "live_on_divergence" ? { mode: "live_on_divergence" as const } : {}),
        ...(body.replacement ? { replacement: body.replacement as never } : {}),
        ...(body.taskId === null || typeof body.taskId === "string" ? { taskId: body.taskId } : {}),
        ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {})
      });
      return reply.send(result);
    } catch (error) {
      return reply.code(409).send({
        error: "REPLAY_FAILED",
        message: error instanceof Error ? error.message : String(error),
        category: (error as { category?: string }).category ?? null
      });
    }
  });

  app.get("/api/replay/reports/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const report = replay.report(id);
    if (!report) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
    return reply.send({ report });
  });

  app.get("/api/replay/reports", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    return reply.send({
      reports: store.listReplayReports({
        ...(typeof query.cassetteId === "string" ? { cassetteId: query.cassetteId } : {}),
        ...(typeof query.runId === "string" ? { runId: query.runId } : {})
      })
    });
  });

  app.post("/api/runs/:runId/fork", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.replacement !== undefined) {
      const parsed = counterfactualSchema.safeParse(body.replacement);
      if (!parsed.success) return reply.code(400).send({ error: "INVALID_REPLACEMENT", message: parsed.error.issues[0]?.message });
    }
    try {
      const result = await replay.fork({
        parentRunId: runId,
        ...(typeof body.checkpointSeq === "number" ? { checkpointSeq: body.checkpointSeq } : {}),
        ...(body.replacement ? { replacement: body.replacement as never } : {}),
        ...(body.mode === "strict_replay" ? { mode: "strict_replay" as const } : {}),
        ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {})
      });
      return reply.send(result);
    } catch (error) {
      request.log.error({ err: error }, "fork failed");
      return reply.code(409).send({ error: "FORK_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });
}

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply } from "fastify";
import type { EventEnvelope } from "@hearth/core";
import { APPROVAL_STATUSES, DEVICE_CAPABILITY_KINDS, EFFECT_STATUSES, RUN_STATUSES, SOURCE_KINDS } from "@hearth/core";
import { loadCodexProfile } from "@hearth/codex-executor";
import { HearthStore, type PageOptions } from "@hearth/eventlog";
import { getTemplate } from "@hearth/templates";
import { z } from "zod";
import { DB_PATH, DEVICE_FRAME_DIR, OUTBOX_DIR, REPO_ROOT, SOURCE_CONTENT_DIR, WEB_DIST } from "./config.ts";
import { ApprovalError, ApprovalManager, type EffectExecutor } from "./approvals.ts";
import { executeEffect } from "./effects.ts";
import { HearthScheduler } from "./scheduler.ts";
import { HearthService, TaskInputSelectionError, type CreateTaskInput } from "./service.ts";
import { SourceRegistry, SourceRegistryError } from "./sources.ts";
import { OutboxError, OutboxService } from "./outbox.ts";
import { DesktopError, DesktopService } from "./desktop.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const createTaskSchema = z.object({
  templateId: z.string().trim().min(1).max(20).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  goal: z.string().trim().min(1).max(4000).optional(),
  textInput: z.string().max(100_000).optional(),
  sourceItemIds: z.array(z.string().trim().min(1).max(80)).max(20).optional()
}).strict();

const decideApprovalSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  parameterHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

const createSourceSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  displayName: z.string().trim().min(1).max(120).optional(),
  rootPath: z.string().trim().min(1).max(4096).optional(),
  allowedHosts: z.array(z.string().trim().min(1).max(253)).max(50).optional(),
  account: z.string().trim().min(1).max(200).optional()
}).strict();

const readSourceSchema = z.object({
  url: z.string().trim().min(1).max(2_048).optional()
}).strict();

const outboxDraftSchema = z.object({
  account: z.string().max(200).optional(),
  to: z.array(z.string().max(320)).max(50).optional(),
  cc: z.array(z.string().max(320)).max(50).optional(),
  bcc: z.array(z.string().max(320)).max(50).optional(),
  subject: z.string().max(500).optional(),
  body: z.string().max(200_000).optional(),
  attachmentIds: z.array(z.string().trim().min(1).max(80)).max(20).optional()
}).strict();

const pairingStartSchema = z.object({
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(40),
  deviceToken: z.string().min(32).max(256),
  apps: z.array(z.string().trim().min(1).max(120)).min(1).max(30),
  capabilities: z.array(z.enum(DEVICE_CAPABILITY_KINDS)).min(1).max(DEVICE_CAPABILITY_KINDS.length)
}).strict();

const capabilityApprovalSchema = z.object({
  apps: z.array(z.string().trim().min(1).max(120)).min(1).max(30)
}).strict();

const createDesktopSessionSchema = z.object({
  deviceId: z.string().trim().min(1).max(80),
  targetApp: z.string().trim().min(1).max(120).optional()
}).strict();

const desktopObservationRequestSchema = z.object({
  targetApp: z.string().trim().min(1).max(120).optional()
}).strict();

const desktopActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), frameId: z.string().trim().min(1).max(80), x: z.number(), y: z.number() }).strict(),
  z.object({ kind: z.literal("type"), frameId: z.string().trim().min(1).max(80), text: z.string().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal("press"), frameId: z.string().trim().min(1).max(80), keys: z.string().min(1).max(40) }).strict(),
  z.object({ kind: z.literal("focus"), frameId: z.string().trim().min(1).max(80), app: z.string().trim().min(1).max(120), windowTitle: z.string().trim().max(200).optional() }).strict(),
  z.object({ kind: z.literal("uia.invoke"), frameId: z.string().trim().min(1).max(80), elementName: z.string().trim().min(1).max(200), controlType: z.string().trim().max(40).optional() }).strict(),
  z.object({ kind: z.literal("uia.setvalue"), frameId: z.string().trim().min(1).max(80), elementName: z.string().trim().min(1).max(200), value: z.string().max(500), controlType: z.string().trim().max(40).optional() }).strict()
]);

const commandResultSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(1000).optional()
}).strict();

const observationSchema = z.object({
  sessionId: z.string().trim().min(1).max(80),
  commandId: z.string().trim().min(1).max(80).optional(),
  jpegBase64: z.string().min(1).max(5_500_000),
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
  activeApp: z.string().trim().min(1).max(120),
  windowTitle: z.string().trim().max(300),
  targetApp: z.string().trim().min(1).max(120).optional()
}).strict();

const sourceItemQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional()
}).strict();

const listQuerySchema = z.object({
  taskId: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  brief: z.enum(["0", "1"]).optional()
}).strict();

const runQuerySchema = listQuerySchema.extend({ status: z.enum(RUN_STATUSES).optional() }).strict();
const approvalQuerySchema = listQuerySchema.extend({ status: z.enum(APPROVAL_STATUSES).optional() }).strict();
const effectQuerySchema = listQuerySchema.extend({ status: z.enum(EFFECT_STATUSES).optional() }).strict();

const seqParam = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const eventQuerySchema = z.object({
  after: seqParam.optional(),
  before: seqParam.optional(),
  taskId: z.string().trim().min(1).max(80).optional(),
  type: z.string().trim().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
}).strict();

const taskEventQuerySchema = eventQuerySchema.omit({ taskId: true });

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_EVENT_LIMIT = 100;

export interface BuildServerOptions {
  store?: HearthStore;
  logger?: boolean;
  serveWeb?: boolean;
  startScheduler?: boolean;
  effectExecutor?: EffectExecutor;
  sourceContentRoot?: string;
  outboxRoot?: string;
  deviceFrameRoot?: string;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const ownsStore = !options.store;
  const store = options.store ?? new HearthStore(DB_PATH);
  const service = new HearthService(store);
  const sources = new SourceRegistry(service, {
    contentRoot: options.sourceContentRoot ?? SOURCE_CONTENT_DIR
  });
  const effectExecutor = options.effectExecutor ?? ((effect) => executeEffect(effect, {
    outboxRoot: options.outboxRoot ?? OUTBOX_DIR,
    getArtifact: (id) => store.getArtifact(id)
  }));
  const approvals = new ApprovalManager(service, effectExecutor);
  approvals.recoverInterruptedEffects();
  const outbox = new OutboxService(service, approvals);
  const desktop = new DesktopService(service, options.deviceFrameRoot ?? DEVICE_FRAME_DIR);
  const scheduler = options.startScheduler
    ? new HearthScheduler({
        service,
        approvals,
        ...(options.sourceContentRoot ? { sourceContentRoot: options.sourceContentRoot } : {})
      })
    : null;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 8_000_000
  });

  app.addHook("onClose", async () => {
    await scheduler?.stop();
    if (ownsStore) store.close();
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!LOOPBACK_HOSTS.has(request.hostname)) {
      return reply.code(403).send({ error: "LOCAL_ONLY", message: "Hearth 仅接受本机访问" });
    }
    if (request.headers["sec-fetch-site"] === "cross-site") {
      return reply.code(403).send({ error: "CROSS_SITE_BLOCKED", message: "已阻止跨站请求" });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin) {
      if (!isLoopbackOrigin(request.headers.origin)) {
        return reply.code(403).send({ error: "ORIGIN_BLOCKED", message: "请求来源不是本机页面" });
      }
    }
  });

  app.get("/api/health", async () => {
    const profile = loadCodexProfile();
    return {
      status: "ok",
      name: "Hearth",
      now: new Date().toISOString(),
      codex: {
        canRun: profile.canRun,
        providerId: profile.providerId,
        providerName: profile.providerName,
        model: profile.model,
        authSource: profile.authSource,
        issues: profile.issues
      }
    };
  });

  const systemStatus = () => {
    const tasks = service.listTasks();
    return {
      running: scheduler?.running ?? false,
      schedulerEnabled: Boolean(scheduler),
      queued: tasks.filter((task) => task.status === "queued").length,
      runningTasks: tasks.filter((task) => task.status === "running").length,
      waitingApproval: tasks.filter((task) => task.status === "waiting_approval").length
    };
  };

  app.get("/api/system", async () => systemStatus());

  app.post("/api/system/stop", async (_request, reply) => {
    if (!scheduler) {
      return reply.code(409).send({ error: "SCHEDULER_DISABLED", message: "执行器未启用，无需停止" });
    }
    await scheduler.stop();
    return systemStatus();
  });

  app.post("/api/system/start", async (_request, reply) => {
    if (!scheduler) {
      return reply.code(409).send({ error: "SCHEDULER_DISABLED", message: "执行器未启用" });
    }
    scheduler.start();
    return systemStatus();
  });

  app.get("/api/templates", async () => ({ templates: service.listTemplates() }));

  app.get("/api/sources", async () => ({ sources: sources.list() }));

  app.post("/api/sources", async (request, reply) => {
    const parsed = createSourceSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SOURCE", message: "来源参数不正确" });
    try {
      return reply.code(201).send(sources.create(parsed.data));
    } catch (error) {
      return sendSourceError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/sources/:id/items", async (request, reply) => {
    try {
      return { items: sources.items(request.params.id) };
    } catch (error) {
      return sendSourceError(reply, error);
    }
  });

  app.get<{ Params: { id: string; itemId: string } }>("/api/sources/:id/items/:itemId/content", async (request, reply) => {
    try {
      const item = sources.getItem(request.params.itemId);
      if (item.sourceId !== request.params.id) {
        return reply.code(404).send({ error: "SOURCE_ITEM_NOT_FOUND", message: "来源条目不存在" });
      }
      reply.header("content-type", "text/plain; charset=utf-8");
      return sources.readItemContent(item.id);
    } catch (error) {
      return sendSourceError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sources/:id/read", async (request, reply) => {
    const parsed = readSourceSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_READ_REQUEST", message: "读取参数不正确" });
    try {
      return await sources.read(request.params.id, parsed.data);
    } catch (error) {
      return sendSourceError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sources/:id/disconnect", async (request, reply) => {
    try {
      return sources.disconnect(request.params.id);
    } catch (error) {
      return sendSourceError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sources/:id/reconnect", async (request, reply) => {
    try {
      return sources.reconnect(request.params.id);
    } catch (error) {
      return sendSourceError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sources/:id/clear", async (request, reply) => {
    try {
      return sources.clear(request.params.id);
    } catch (error) {
      return sendSourceError(reply, error);
    }
  });

  app.get<{ Querystring: Record<string, string> }>("/api/source-items", async (request, reply) => {
    const parsed = sourceItemQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalidQuery(reply);
    reply.header("cache-control", "no-store");
    return { items: store.listReadySourceItems(parsed.data.limit ?? 100) };
  });

  app.get("/api/outbox", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      drafts: outbox.list().map((draft) => ({
        ...draft,
        effect: draft.effectId ? store.getEffect(draft.effectId) : null
      }))
    };
  });

  app.get<{ Params: { id: string } }>("/api/outbox/:id", async (request, reply) => {
    try {
      reply.header("cache-control", "no-store");
      const draft = outbox.get(request.params.id);
      return { ...draft, effect: draft.effectId ? store.getEffect(draft.effectId) : null };
    } catch (error) {
      return sendOutboxError(reply, error);
    }
  });

  app.post("/api/outbox", async (request, reply) => {
    const parsed = outboxDraftSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_OUTBOX_DRAFT", message: "发件箱草稿参数格式不正确" });
    }
    try {
      return reply.code(201).send(outbox.create(parsed.data));
    } catch (error) {
      return sendOutboxError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/outbox/:id", async (request, reply) => {
    const parsed = outboxDraftSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_OUTBOX_DRAFT", message: "发件箱草稿参数格式不正确" });
    }
    try {
      return outbox.update(request.params.id, parsed.data);
    } catch (error) {
      return sendOutboxError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/outbox/:id/discard", async (request, reply) => {
    try {
      return outbox.discard(request.params.id);
    } catch (error) {
      return sendOutboxError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/outbox/:id/submit", async (request, reply) => {
    try {
      return outbox.submit(request.params.id);
    } catch (error) {
      return sendOutboxError(reply, error);
    }
  });

  app.get("/api/desktop", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return desktop.dashboard();
  });

  app.get<{ Params: { id: string } }>("/api/desktop/sessions/:id", async (request, reply) => {
    try {
      reply.header("cache-control", "no-store");
      return desktop.sessionView(request.params.id);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post("/api/desktop/sessions", async (request, reply) => {
    const parsed = createDesktopSessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SESSION", message: "创建设备会话的参数不正确" });
    try {
      return reply.code(201).send(desktop.createSession(parsed.data.deviceId, parsed.data.targetApp));
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/desktop/sessions/:id/observe", async (request, reply) => {
    const parsed = desktopObservationRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_OBSERVATION_REQUEST", message: "观察请求的参数不正确" });
    try {
      return reply.code(202).send(desktop.requestObservation(request.params.id, parsed.data.targetApp));
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  for (const action of ["pause", "resume", "takeover", "release", "terminate"] as const) {
    app.post<{ Params: { id: string } }>(`/api/desktop/sessions/:id/${action}`, async (request, reply) => {
      try {
        if (action === "pause") return desktop.pauseSession(request.params.id);
        if (action === "resume") return desktop.resumeSession(request.params.id);
        if (action === "takeover") return desktop.takeOverSession(request.params.id);
        if (action === "release") return desktop.releaseSession(request.params.id);
        return desktop.terminateSession(request.params.id);
      } catch (error) {
        return sendDesktopError(reply, error);
      }
    });
  }

  app.post<{ Params: { id: string } }>("/api/desktop/sessions/:id/actions", async (request, reply) => {
    const parsed = desktopActionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_DESKTOP_ACTION", message: "桌面动作不在低风险白名单内" });
    }
    try {
      return reply.code(202).send(desktop.enqueueAction(request.params.id, parsed.data));
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post("/api/device-pairings", async (request, reply) => {
    const parsed = pairingStartSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_PAIRING", message: "配对请求参数不正确" });
    }
    try {
      return reply.code(201).send(desktop.createPairingRequest(parsed.data));
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/device-pairings/:id", async (request, reply) => {
    const secret = headerValue(request.headers["x-pairing-secret"]);
    try {
      reply.header("cache-control", "no-store");
      return desktop.getPairingStatus(request.params.id, secret);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/devices/pairing-requests/:id/approve", async (request, reply) => {
    try {
      return desktop.approvePairing(request.params.id);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/devices/pairing-requests/:id/reject", async (request, reply) => {
    try {
      return desktop.rejectPairing(request.params.id);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string; kind: string } }>("/api/devices/:id/capabilities/:kind/approve", async (request, reply) => {
    const kind = z.enum(DEVICE_CAPABILITY_KINDS).safeParse(request.params.kind);
    const parsed = capabilityApprovalSchema.safeParse(request.body ?? {});
    if (!kind.success || !parsed.success) {
      return reply.code(400).send({ error: "INVALID_CAPABILITY_APPROVAL", message: "能力审批参数不正确" });
    }
    try {
      return desktop.approveCapability(request.params.id, kind.data, parsed.data.apps);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string; kind: string } }>("/api/devices/:id/capabilities/:kind/revoke", async (request, reply) => {
    const kind = z.enum(DEVICE_CAPABILITY_KINDS).safeParse(request.params.kind);
    if (!kind.success) return reply.code(400).send({ error: "INVALID_CAPABILITY", message: "设备能力类型不正确" });
    try {
      return desktop.revokeCapability(request.params.id, kind.data);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/devices/:id/revoke", async (request, reply) => {
    try {
      return desktop.revokeDevice(request.params.id);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.get<{ Params: { deviceId: string; frameId: string } }>("/api/devices/:deviceId/frames/:frameId", async (request, reply) => {
    try {
      const stored = desktop.readFrame(request.params.deviceId, request.params.frameId);
      reply.header("cache-control", "no-store, max-age=0");
      reply.header("content-type", stored.frame.mimeType);
      return reply.send(readFileSync(stored.absolutePath));
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post("/api/device/heartbeat", async (request, reply) => {
    try {
      const device = desktop.authenticateDevice(bearerToken(request.headers.authorization));
      reply.header("cache-control", "no-store");
      return desktop.deviceState(device.id);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.get("/api/device/state", async (request, reply) => {
    try {
      const device = desktop.authenticateDevice(bearerToken(request.headers.authorization));
      reply.header("cache-control", "no-store");
      return desktop.deviceState(device.id);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.get("/api/device/commands/next", async (request, reply) => {
    try {
      const device = desktop.authenticateDevice(bearerToken(request.headers.authorization));
      reply.header("cache-control", "no-store");
      return { command: desktop.nextCommand(device) };
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/device/commands/:id/result", async (request, reply) => {
    const parsed = commandResultSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_COMMAND_RESULT", message: "桌面命令结果格式不正确" });
    try {
      const device = desktop.authenticateDevice(bearerToken(request.headers.authorization));
      return desktop.completeCommand(device, request.params.id, parsed.data);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post("/api/device/observations", async (request, reply) => {
    const parsed = observationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_OBSERVATION", message: "桌面观察参数格式不正确" });
    try {
      const device = desktop.authenticateDevice(bearerToken(request.headers.authorization));
      return desktop.uploadObservation(device, parsed.data);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.get("/api/export", async (_request, reply) => {
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="hearth-export-${stamp}.json"`);
    return service.exportSnapshot();
  });

  app.get("/api/backup", async (_request, reply) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(tmpdir(), `hearth-${stamp}-${randomUUID().slice(0, 8)}.sqlite`);
    try {
      store.db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      const bytes = readFileSync(backupPath);
      reply.header("content-type", "application/vnd.sqlite3");
      reply.header("content-disposition", `attachment; filename="hearth-${new Date().toISOString().slice(0, 10)}.sqlite"`);
      return reply.send(bytes);
    } finally {
      rmSync(backupPath, { force: true });
    }
  });

  app.post("/api/tasks", async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_INPUT",
        message: "任务参数不完整或格式不正确",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
    }

    const input: CreateTaskInput = {};
    if (parsed.data.templateId !== undefined) input.templateId = parsed.data.templateId;
    if (parsed.data.title !== undefined) input.title = parsed.data.title;
    if (parsed.data.goal !== undefined) input.goal = parsed.data.goal;
    if (parsed.data.textInput !== undefined) input.textInput = parsed.data.textInput;
    if (parsed.data.sourceItemIds !== undefined) input.sourceItemIds = parsed.data.sourceItemIds;
    if (input.templateId && !getTemplate(input.templateId)) {
      return reply.code(400).send({ error: "UNKNOWN_TEMPLATE", message: `没有找到任务模板 ${input.templateId}` });
    }

    try {
      const task = service.createTask(input);
      return reply.code(201).send(task);
    } catch (error) {
      if (error instanceof TaskInputSelectionError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/api/tasks", async () => ({ tasks: service.listTaskItems() }));

  app.get("/api/artifacts", async () => {
    const titles = service.taskTitles();
    return {
      artifacts: store.listAllArtifacts().map((artifact) => ({
        id: artifact.id,
        taskId: artifact.taskId,
        runId: artifact.runId,
        relativePath: artifact.relativePath,
        mimeType: artifact.mimeType,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        createdAt: artifact.createdAt,
        taskTitle: titles.get(artifact.taskId) ?? "未命名任务"
      }))
    };
  });

  app.get<{ Querystring: Record<string, string> }>("/api/runs", async (request, reply) => {
    const parsed = runQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalidQuery(reply);
    reply.header("cache-control", "no-store");
    return service.listRunItems(pageOptions(parsed.data));
  });

  app.get<{ Querystring: Record<string, string> }>("/api/approvals", async (request, reply) => {
    const parsed = approvalQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalidQuery(reply);
    reply.header("cache-control", "no-store");
    return service.listApprovalItems({ ...pageOptions(parsed.data), brief: parsed.data.brief === "1" });
  });

  app.get<{ Querystring: Record<string, string> }>("/api/effects", async (request, reply) => {
    const parsed = effectQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalidQuery(reply);
    reply.header("cache-control", "no-store");
    return service.listEffectItems(pageOptions(parsed.data));
  });

  app.get("/api/stats", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.stats();
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>("/api/tasks/:id/events", async (request, reply) => {
    const parsed = taskEventQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalidQuery(reply);
    if (!store.getTask(request.params.id)) {
      return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    }
    reply.header("cache-control", "no-store");
    return service.eventWindow({
      limit: parsed.data.limit ?? DEFAULT_EVENT_LIMIT,
      afterSeq: parsed.data.after,
      beforeSeq: parsed.data.before,
      taskId: request.params.id,
      type: parsed.data.type
    });
  });

  app.get<{ Querystring: Record<string, string> }>("/api/events/history", async (request, reply) => {
    const parsed = eventQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalidQuery(reply);
    reply.header("cache-control", "no-store");
    return service.eventWindow({
      limit: parsed.data.limit ?? DEFAULT_EVENT_LIMIT,
      afterSeq: parsed.data.after,
      beforeSeq: parsed.data.before,
      taskId: parsed.data.taskId,
      type: parsed.data.type
    });
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const view = service.view(request.params.id);
    if (!view) return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    return view;
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async (request, reply) => {
    if (!scheduler) return reply.code(503).send({ error: "SCHEDULER_OFF", message: "执行器未启动" });
    try {
      return scheduler.retry(request.params.id);
    } catch (error) {
      return reply.code(409).send({ error: "RETRY_NOT_ALLOWED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (request, reply) => {
    if (!scheduler) return reply.code(503).send({ error: "SCHEDULER_OFF", message: "执行器未启动" });
    try {
      const task = scheduler.cancel(request.params.id);
      outbox.reconcileTask(request.params.id);
      return task;
    } catch (error) {
      return reply.code(404).send({ error: "TASK_NOT_FOUND", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/approvals/:id/decide", async (request, reply) => {
    const parsed = decideApprovalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_DECISION", message: "需要明确批准或拒绝，并提交当前审批参数哈希" });
    }
    try {
      const result = await approvals.decide(request.params.id, parsed.data.decision, parsed.data.parameterHash);
      outbox.reconcileApproval(result.approval.id);
      return result;
    } catch (error) {
      if (error instanceof ApprovalError) {
        outbox.reconcileApproval(request.params.id);
        const status = error.code === "APPROVAL_NOT_FOUND" ? 404 : error.code === "APPROVAL_EXPIRED" ? 410 : 409;
        return reply.code(status).send({ error: error.code, message: error.message });
      }
      return reply.code(500).send({ error: "APPROVAL_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string; artifactId: string } }>("/api/tasks/:id/artifacts/:artifactId", async (request, reply) => {
    const artifact = store.getArtifact(request.params.artifactId);
    if (!artifact || artifact.taskId !== request.params.id) {
      return reply.code(404).send({ error: "ARTIFACT_NOT_FOUND", message: "产物不存在" });
    }
    if (!isPathInside(REPO_ROOT, artifact.absolutePath) || !existsSync(artifact.absolutePath)) {
      return reply.code(410).send({ error: "ARTIFACT_UNAVAILABLE", message: "产物文件已不可用" });
    }
    reply.header("content-type", artifact.mimeType);
    reply.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(basename(artifact.absolutePath))}`);
    return reply.send(readFileSync(artifact.absolutePath));
  });

  app.get<{ Querystring: { after?: string; taskId?: string } }>("/api/events", async (request, reply) => {
    const afterSeq = parseAfterSeq(request.query.after);
    if (afterSeq === null) {
      return reply.code(400).send({ error: "INVALID_CURSOR", message: "after 必须是非负整数" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    reply.raw.flushHeaders();

    let closed = false;
    let ready = false;
    let lastSeq = afterSeq;
    const buffered: EventEnvelope[] = [];
    const taskId = request.query.taskId;

    const writeEvent = (event: EventEnvelope) => {
      if (closed || (taskId && event.taskId !== taskId)) return;
      if (!ready) {
        buffered.push(event);
        return;
      }
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
      reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    const unsubscribe = service.bus.subscribe(writeEvent);
    for (const event of store.listEvents(afterSeq, taskId)) writeEvent(event);
    ready = true;
    for (const event of buffered.splice(0)) writeEvent(event);

    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(": heartbeat\n\n");
    }, 15_000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    reply.raw.on("close", cleanup);
    reply.raw.on("error", cleanup);
    request.raw.socket.on("close", cleanup);
    return reply;
  });

  const hasWeb = options.serveWeb !== false && existsSync(join(WEB_DIST, "index.html"));
  if (hasWeb) await app.register(fastifyStatic, { root: WEB_DIST });

  scheduler?.start();

  app.setNotFoundHandler((request, reply) => {
    if (hasWeb && request.method === "GET" && !request.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "NOT_FOUND", message: "没有找到这个页面" });
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    reply.code(500).send({ error: "INTERNAL_ERROR", message: "Hearth 处理请求时遇到问题" });
  });

  return app;
}

function parseAfterSeq(value: string | undefined): number | null {
  if (value === undefined || value === "") return 0;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function pageOptions(query: {
  taskId?: string | undefined;
  status?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}): PageOptions {
  const options: PageOptions = { limit: query.limit ?? DEFAULT_LIST_LIMIT, offset: query.offset ?? 0 };
  if (query.taskId !== undefined) options.taskId = query.taskId;
  if (query.status !== undefined) options.status = query.status;
  return options;
}

function invalidQuery(reply: FastifyReply) {
  return reply.code(400).send({ error: "INVALID_QUERY", message: "分页参数不正确" });
}

function sendSourceError(reply: FastifyReply, error: unknown) {
  if (error instanceof SourceRegistryError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function sendOutboxError(reply: FastifyReply, error: unknown) {
  if (error instanceof OutboxError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function sendDesktopError(reply: FastifyReply, error: unknown) {
  if (error instanceof DesktopError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function bearerToken(value: string | string[] | undefined): string {
  const header = headerValue(value);
  if (!header.startsWith("Bearer ")) throw new DesktopError("DEVICE_UNAUTHORIZED", "缺少设备令牌", 401);
  return header.slice(7).trim();
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}\\`) || candidate.startsWith(`${normalizedRoot}/`);
}

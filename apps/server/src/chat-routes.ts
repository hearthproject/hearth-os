import { randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ChatAttachment, ChatMessageRecord, ContextUsageSnapshot, ExecutorHealth, ExecutorId, LibrarySearchHit, LocalProject, TaskRecord } from "@hearth/core";
import { defaultConversationSettings, EXECUTOR_IDS, mergeConversationSettings } from "@hearth/core";
import { loadCodexProfile, probeCodex, type CodexProfile } from "@hearth/codex-executor";
import { loadExecutorSettings, type ExecutorSettingsStore } from "./executor-settings.ts";
import { executorName, resolveExecutorLocked } from "./executors.ts";
import { executorHealth } from "./executor-runtime.ts";
import type { ApprovalManager } from "./approvals.ts";
import type { HearthService } from "./service.ts";
import { projectMemoryScope, type MemoryService } from "./memory.ts";
import type { ContextBroker } from "./context-broker.ts";
import type { MentionResolver } from "./mentions.ts";
import type { OntologyService } from "./ontology.ts";
import type { OntologyWriter } from "./ontology-writer.ts";
import { ModelRegistryError, type ModelRegistry } from "./model-registry.ts";
import { conversationTitle, planExecution } from "./chat.ts";
import {
  defaultLocalFileRoots,
  extractFilePaths,
  parseLocalFileRequest,
  searchLocalFile,
  storeOutgoingAttachment
} from "./chat-file-delivery.ts";
import { listModels, ModelClientError, completeChat } from "./model-client.ts";
import { reasoningCapabilityView } from "./reasoning-capability.ts";
import {
  MODEL_PRESETS,
  chatModelConfigured,
  loadModelSettings,
  normalizeBaseUrl,
  normalizeProtocol,
  saveModelSettings,
  viewModelSettings,
  type ModelSettings
} from "./model-settings.ts";

const attachmentSchema = z.object({
  id: z.string().trim().min(8).max(80),
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(200),
  bytes: z.number().int().min(0)
}).strict();

const conversationSettingsSchema = z.object({
  executorEnabled: z.partialRecord(z.enum(EXECUTOR_IDS), z.boolean()).optional(),
  approvalMode: z.enum(["necessary", "workspace", "full"]).optional(),
  executionMode: z.enum(["quick", "standard", "deep"]).optional(),
  collaborationMode: z.enum(["build", "plan"]).optional(),
  preferredExecutorId: z.enum(EXECUTOR_IDS).nullable().optional()
}).strict();

const goalSettingsSchema = z.object({
  maxRounds: z.number().int().min(1).max(200).optional(),
  reviewPolicy: z.enum(["auto", "human_on_risk", "human_on_complete"]).optional(),
  deadline: z.string().datetime().optional(),
  forbiddenActions: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  evidenceRequirements: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  criteria: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
  commandsApproved: z.boolean().optional()
}).strict();

const chatSchema = z.object({
  // Accepted for compatibility with older clients. Every message is handled by
  // the selected executor's single agent harness, so this value is ignored.
  routeMode: z.unknown().optional(),
  conversationId: z.string().trim().min(1).max(80).optional(),
  projectId: z.string().trim().min(1).max(120).optional(),
  message: z.string().max(100_000).optional(),
  skillId: z.string().trim().min(1).max(120).optional(),
  mcpServerIds: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
  attachments: z.array(attachmentSchema).max(5).optional(),
  url: z.string().trim().max(2_048).optional(),
  goalMode: z.boolean().optional(),
  goalSettings: goalSettingsSchema.optional(),
  planMode: z.boolean().optional(),
  planId: z.string().trim().min(1).max(80).optional(),
  settings: conversationSettingsSchema.optional()
}).strict();

const conversationSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  projectId: z.string().trim().min(1).max(120).optional(),
  settings: conversationSettingsSchema.optional()
}).strict();

const conversationPatchSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  settings: conversationSettingsSchema.optional()
}).strict();

const deleteConversationSchema = z.object({
  cancelRunning: z.boolean().optional()
}).strict();

const modelProtocolSchema = z.enum(["openai-chat", "openai-responses", "anthropic-messages", "gemini"]);

const modelSettingsSchema = z.object({
  providerId: z.string().trim().min(1).max(60).optional(),
  providerName: z.string().trim().min(1).max(80).optional(),
  protocol: modelProtocolSchema.optional(),
  baseUrl: z.string().trim().max(500).optional(),
  model: z.string().trim().max(200).optional(),
  contextWindowTokens: z.number().int().min(4096).max(10_000_000).optional(),
  maxOutputTokens: z.number().int().min(256).max(1_000_000).optional(),
  reasoningEffort: z.enum(["off", "minimal", "low", "medium", "high", "max"]).optional(),
  apiKey: z.string().max(500).optional()
}).strict();

const modelProbeSchema = z.object({
  providerId: z.string().trim().max(60).optional(),
  providerName: z.string().trim().max(80).optional(),
  protocol: modelProtocolSchema.optional(),
  baseUrl: z.string().trim().max(500).optional(),
  model: z.string().trim().max(200).optional(),
  contextWindowTokens: z.number().int().min(4096).max(10_000_000).optional(),
  maxOutputTokens: z.number().int().min(256).max(1_000_000).optional(),
  apiKey: z.string().max(500).optional()
}).strict();

import type { LibraryService } from "./library/service.ts";
import type { SkillService } from "./skills/service.ts";
import type { GoalService } from "./goals.ts";
import type { PlanService } from "./plans.ts";
import type { ConversationContextService } from "./conversation-context.ts";
import type { McpServerService } from "./mcp-servers.ts";

export interface ChatRouteOptions {
  service: HearthService;
  modelSettingsPath: string;
  attachmentRoot: string;
  executorSettingsPath: string;
  executorSettingsStore?: ExecutorSettingsStore | undefined;
  registry?: ModelRegistry | undefined;
  codexProfile?: (() => CodexProfile) | undefined;
  codexEnv?: (() => Record<string, string>) | undefined;
  modelSettingsForExecutor?: ((executorId: ExecutorId) => ModelSettings | null) | undefined;
  executorHealth?: ((executorId: ExecutorId) => ExecutorHealth) | undefined;
  approvals?: ApprovalManager | undefined;
  cancelTask?: ((taskId: string) => unknown) | undefined;
  goals?: GoalService | undefined;
  plans?: PlanService | undefined;
  memory?: MemoryService | undefined;
  library?: LibraryService | undefined;
  skills?: SkillService | undefined;
  mcpServers?: McpServerService | undefined;
  conversationContext?: ConversationContextService | undefined;
  personal?: {
    ontology: OntologyService;
    mentions: MentionResolver;
    broker: ContextBroker;
    writer: OntologyWriter;
  } | undefined;
}

export async function registerChatRoutes(app: FastifyInstance, options: ChatRouteOptions): Promise<void> {
  const { service, modelSettingsPath, attachmentRoot, executorSettingsPath } = options;
  const store = service.store;
  const executorSettings = (): ReturnType<typeof loadExecutorSettings> => options.executorSettingsStore?.load() ?? loadExecutorSettings(executorSettingsPath);
  const chatSettings = (): ModelSettings => {
    const base = options.registry?.chatSettings() ?? loadModelSettings(modelSettingsPath);
    return { ...base, reasoningEffort: executorSettings().reasoningEffort ?? "max" };
  };
  let legacyTitleBackfillStarted = false;
  const backfillLegacyTitles = (): void => {
    if (legacyTitleBackfillStarted) return;
    try {
      if (store.getAppSetting("conversation.title.summary.v5") === "done") return;
      legacyTitleBackfillStarted = true;
    } catch {
      return;
    }
    // 标题兜底不依赖模型：只要首条用户消息可读，就先给出本地摘要，
    // 避免会话有内容但侧栏一直显示“新对话”。
    void (async () => {
      try {
        for (const conversation of store.listConversations()) {
          if (conversation.title !== "新对话" || !conversation.title.trim()) continue;
          const firstUser = store.listChatMessages(conversation.id).find((item) => item.role === "user");
          if (!firstUser) continue;
          const localTitle = conversationTitle(firstUser.content);
          if (localTitle) store.renameConversation(conversation.id, localTitle);
        }
        store.setAppSetting("conversation.title.summary.v5", "done");
      } catch {
        // 标题兜底失败不能阻塞会话列表。
      }
    })();
  };
  const executorAvailability = (): Record<ExecutorId, boolean> => {
    const settings = executorSettings();
    const availability = {} as Record<ExecutorId, boolean>;
    for (const id of EXECUTOR_IDS) {
      availability[id] = options.executorHealth
        ? options.executorHealth(id).canRun
        : executorHealth(id, settings, executorSettingsPath).canRun;
    }
    return availability;
  };
  const defaultSettings = () => {
    const settings = executorSettings();
    const enabled: Partial<Record<ExecutorId, boolean>> = { native: true, codex: true };
    if (options.registry?.settingsForExecutorOrChat("deepseek-harness")) enabled["deepseek-harness"] = true;
    return {
      ...defaultConversationSettings("full", enabled),
      preferredExecutorId: settings.preferredExecutorId ?? "native"
    };
  };
  mkdirSync(attachmentRoot, { recursive: true });
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 5, fields: 10, parts: 20 }
  });

  app.get("/api/model-settings", async () => {
    const settings = chatSettings();
    return {
      settings: viewModelSettings(settings),
      presets: options.registry?.presets() ?? MODEL_PRESETS,
      configured: chatModelConfigured(settings)
    };
  });

  app.put("/api/model-settings", async (request, reply) => {
    const parsed = modelSettingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MODEL_SETTINGS", message: "模型设置格式不正确" });
    if (parsed.data.baseUrl && !isHttpUrl(parsed.data.baseUrl)) {
      return reply.code(400).send({ error: "INVALID_BASE_URL", message: "服务地址必须是 http 或 https 网址" });
    }
    const patch = { ...parsed.data };
    if (patch.baseUrl !== undefined) patch.baseUrl = normalizeBaseUrl(patch.baseUrl);
    let settings: ModelSettings | null;
    try {
      settings = options.registry ? saveRegistryChatSettings(options.registry, patch) : saveModelSettings(modelSettingsPath, patch);
    } catch (error) {
      if (error instanceof ModelRegistryError) {
        const status = error.code === "MODEL_PROFILE_NOT_FOUND" ? 404 : 400;
        return reply.code(status).send({ error: error.code, message: error.message });
      }
      throw error;
    }
    if (!settings) return reply.code(400).send({ error: "INVALID_MODEL_SETTINGS", message: "新建模型档案需要填写服务名称、地址和模型名" });
    return { settings: viewModelSettings(settings), configured: chatModelConfigured(settings) };
  });

  app.post("/api/model-capabilities", async (request, reply) => {
    const parsed = modelProbeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MODEL_REQUEST", message: "模型参数格式不正确" });
    const settings = mergeModelSettings(chatSettings(), parsed.data);
    return { capability: reasoningCapabilityView(settings.model, settings.baseUrl, settings.protocol) };
  });

  app.post("/api/model-settings/models", async (request, reply) => {
    const parsed = modelProbeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MODEL_REQUEST", message: "模型参数格式不正确" });
    const settings = mergeModelSettings(chatSettings(), parsed.data);
    if (!isHttpUrl(settings.baseUrl)) return reply.code(400).send({ error: "INVALID_BASE_URL", message: "请先填写正确的服务地址" });
    try {
      const models = await listModels(settings, 25_000);
      return { models };
    } catch (error) {
      return reply.code(200).send({ models: [], error: errorMessage(error), code: errorCode(error) });
    }
  });

  app.post("/api/model-settings/test", async (request, reply) => {
    const parsed = modelProbeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MODEL_REQUEST", message: "模型参数格式不正确" });
    const settings = mergeModelSettings(chatSettings(), parsed.data);
    if (!isHttpUrl(settings.baseUrl)) return reply.code(200).send({ ok: false, error: "请先填写正确的服务地址" });
    const started = Date.now();
    try {
      const result = await completeChat(settings, [
        { role: "system", content: "你是连通性测试。只回复 OK。" },
        { role: "user", content: "请回复 OK" }
      ], { maxTokens: 16, temperature: 0, timeoutMs: 30_000 });
      return { ok: true, reply: result.content.slice(0, 200), elapsedMs: Date.now() - started };
    } catch (error) {
      return reply.code(200).send({ ok: false, error: errorMessage(error), code: errorCode(error), elapsedMs: Date.now() - started });
    }
  });

  app.post("/api/codex/probe", async () => {
    const profile = options.codexProfile?.() ?? loadCodexProfile();
    const started = Date.now();
    const result = await Promise.race([
      probeCodex(profile, options.codexEnv?.()),
      new Promise<{ ok: false; error: string }>((resolve) => {
        setTimeout(() => resolve({ ok: false, error: "执行器测试超时（60 秒）。请检查模型地址和 API Key。" }), 60_000);
      })
    ]);
    return {
      ...result,
      errors: profile.issues,
      configPath: profile.configPath,
      codexHome: profile.codexHome,
      providerId: profile.providerId,
      providerName: profile.providerName,
      model: profile.model,
      baseUrl: profile.baseUrl,
      wireApi: profile.wireApi,
      envKey: profile.envKey,
      envKeyPresent: profile.envKeyPresent,
      authSource: profile.authSource,
      canRun: profile.canRun,
      elapsedMs: Date.now() - started
    };
  });

  app.get("/api/conversation-defaults", async () => ({ settings: defaultSettings() }));

  app.get("/api/conversations", async () => {
    backfillLegacyTitles();
    return {
      conversations: store.listConversations().map((conversation) => {
        const messages = store.listChatMessages(conversation.id);
        const last = messages.at(-1);
        return {
          ...conversation,
          messageCount: messages.length,
          preview: last ? last.content.replace(/\s+/g, " ").slice(0, 60) : ""
        };
      })
    };
  });

  app.post("/api/conversations", async (request, reply) => {
    const parsed = conversationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CONVERSATION", message: "对话参数不正确" });
    const settings = parsed.data.settings
      ? mergeConversationSettings(defaultSettings(), parsed.data.settings)
      : defaultSettings();
    const projectId = parsed.data.projectId && store.getLocalProject(parsed.data.projectId)
      ? parsed.data.projectId
      : null;
    if (parsed.data.projectId && !projectId) {
      return reply.code(404).send({ error: "PROJECT_NOT_FOUND", message: "选择的项目不存在" });
    }
    const conversation = store.createConversation(parsed.data.title ?? "新对话", settings, projectId);
    return reply.code(201).send(conversation);
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND", message: "对话不存在" });
    return {
      conversation,
      messages: store.listChatMessages(conversation.id),
      tasks: store.listTasks().filter((task) => task.conversationId === conversation.id),
      proposals: store.listTaskProposals(conversation.id),
      contextUsage: store.getConversationContextState(conversation.id)?.lastUsage ?? null
    };
  });

  app.patch<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const parsed = conversationPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success || (!parsed.data.title && !parsed.data.settings)) {
      return reply.code(400).send({ error: "INVALID_CONVERSATION", message: "对话参数不正确" });
    }
    const existing = store.getConversation(request.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND", message: "对话不存在" });
    }
    let conversation = existing;
    if (parsed.data.title) conversation = store.renameConversation(request.params.id, parsed.data.title) ?? conversation;
    if (parsed.data.settings) conversation = store.updateConversationSettings(request.params.id, parsed.data.settings) ?? conversation;
    if (parsed.data.settings?.approvalMode === "full") {
      const resumable = store.listTasks().filter((task) =>
        task.conversationId === request.params.id
        && task.status === "waiting_input"
        && task.error === null
        && !store.listHandoffs(task.id).some((handoff) => handoff.status === "pending_user")
      );
      for (const task of resumable) {
        service.updateTask(task.id, {
          status: "queued",
          nextAction: "完全权限已开启，自动继续",
          pendingInput: "当前对话已切换为完全权限。请继续执行；只有无法从项目或环境中判断的关键歧义才调用 ask_user。"
        }, task.currentRunId ?? undefined);
      }
    }
    return conversation;
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/context", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND", message: "对话不存在" });
    return {
      state: store.getConversationContextState(conversation.id),
      compactions: store.listConversationCompactions(conversation.id, 20)
    };
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/context/compact", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND", message: "对话不存在" });
    if (!options.conversationContext) {
      return reply.code(503).send({ error: "CONTEXT_NOT_READY", message: "对话上下文服务尚未启动" });
    }
    const executorId = executorSettings().preferredExecutorId ?? "native";
    const settings = options.modelSettingsForExecutor?.(executorId) ?? null;
    const compaction = await options.conversationContext.compactNow(conversation.id, "manual", { settings });
    if (!compaction) {
      return reply.code(409).send({ error: "NOTHING_TO_COMPACT", message: "当前没有可压缩的对话内容" });
    }
    return {
      compaction,
      state: store.getConversationContextState(conversation.id)
    };
  });

  app.delete<{ Params: { id: string }; Body: unknown }>("/api/conversations/:id", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) {
      return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND", message: "对话不存在" });
    }
    const parsed = deleteConversationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_DELETE_REQUEST", message: "删除参数不正确" });
    const running = store.listTasks().filter((task) =>
      task.conversationId === conversation.id && task.status === "running"
    );
    if (running.length > 0 && !parsed.data.cancelRunning) {
      return reply.code(409).send({
        error: "TASK_RUNNING",
        message: "对话中还有任务在运行，请确认取消后再移入回收站",
        runningTaskIds: running.map((task) => task.id)
      });
    }
    if (parsed.data.cancelRunning) {
      for (const task of running) {
        if (options.cancelTask) options.cancelTask(task.id);
        else service.updateTask(task.id, {
          status: "cancelled", currentRunId: task.currentRunId, nextAction: null, error: null
        }, task.currentRunId ?? undefined);
      }
    }
    store.softDeleteConversation(conversation.id);
    return reply.code(204).send();
  });

  app.post("/api/attachments", async (request, reply) => {
    const files: ChatAttachment[] = [];
    try {
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        const id = randomUUID();
        const name = part.filename || "未命名文件";
        const extension = safeExtension(name);
        const buffer = await part.toBuffer();
        writeFileSync(join(attachmentRoot, `${id}${extension}`), buffer);
        files.push({ id, name: name.slice(0, 255), mimeType: part.mimetype || "application/octet-stream", bytes: buffer.byteLength });
      }
    } catch (error) {
      if (isFileTooLarge(error)) return reply.code(413).send({ error: "FILE_TOO_LARGE", message: "单个文件不能超过 25 MB" });
      throw error;
    }
    if (files.length === 0) return reply.code(400).send({ error: "NO_FILE", message: "没有收到文件" });
    return { attachments: files };
  });

  app.get<{ Params: { id: string } }>("/api/attachments/:id", async (request, reply) => {
    const path = findAttachmentPath(attachmentRoot, request.params.id);
    if (!path) return reply.code(404).send({ error: "ATTACHMENT_NOT_FOUND", message: "附件不存在" });
    try {
      if (!statSync(path).isFile()) throw new Error("not a file");
    } catch {
      return reply.code(404).send({ error: "ATTACHMENT_NOT_FOUND", message: "附件不存在" });
    }
    reply.header("content-type", attachmentMimeType(path));
    reply.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(basename(path))}`);
    reply.header("x-content-type-options", "nosniff");
    return reply.send(createReadStream(path));
  });

  app.post("/api/chat", async (request, reply) => {
    const parsed = chatSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CHAT", message: "消息格式不正确" });
    const message = (parsed.data.message ?? "").trim();
    const url = parsed.data.url?.trim() || null;
    const detectedUrl = url ?? extractUrl(message);
    const requested = parsed.data.attachments ?? [];
    if (!message && !url && requested.length === 0) {
      return reply.code(400).send({ error: "EMPTY_MESSAGE", message: "请输入内容" });
    }
    if (detectedUrl && !isHttpUrl(detectedUrl)) return reply.code(400).send({ error: "INVALID_URL", message: "网址必须是 http 或 https 链接" });

    const files = requested.map((attachment) => {
      const path = findAttachmentPath(attachmentRoot, attachment.id);
      return path ? { ...attachment, path } : null;
    });
    if (files.some((file) => file === null)) {
      return reply.code(400).send({ error: "ATTACHMENT_NOT_FOUND", message: "附件已失效，请重新上传" });
    }
    const storedFiles = files as (ChatAttachment & { path: string })[];

    let conversation = parsed.data.conversationId ? store.getConversation(parsed.data.conversationId) : null;
    if (parsed.data.conversationId && !conversation) {
      return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND", message: "对话不存在" });
    }
    if (!conversation) {
      const settings = parsed.data.settings
        ? mergeConversationSettings(defaultSettings(), parsed.data.settings)
        : defaultSettings();
      const projectId = parsed.data.projectId && store.getLocalProject(parsed.data.projectId)
        ? parsed.data.projectId
        : null;
      conversation = store.createConversation(
        "新对话",
        settings,
        projectId
      );
    }

    const userContent = message || (detectedUrl ? `请处理这个网址：${detectedUrl}` : `请处理附件：${storedFiles.map((file) => file.name).join("、")}`);
    const titleWasPlaceholder = conversation.title === "新对话";
    const userRecord = store.createChatMessage({
      id: randomUUID(),
      conversationId: conversation.id,
      role: "user",
      content: detectedUrl && message && !message.includes(detectedUrl) ? `${message}\n\n${detectedUrl}` : message || daemonUserContent(detectedUrl, storedFiles),
      taskId: null,
      attachments: storedFiles.map(({ id, name, mimeType, bytes }) => ({ id, name, mimeType, bytes })),
      createdAt: new Date().toISOString()
    });
    // 首轮先落一个本地标题，模型摘要稍后如果更好再替换；
    // 这样侧栏不会在摘要失败时一直停在“新对话”。
    if (titleWasPlaceholder) {
      const localTitle = conversationTitle(userContent);
      if (localTitle && localTitle !== conversation.title) {
        conversation = store.renameConversation(conversation.id, localTitle) ?? conversation;
      }
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
    const controller = new AbortController();
    const send = (event: string, data: unknown) => {
      if (closed || reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    reply.raw.on("close", () => {
      closed = true;
      controller.abort();
    });
    const conversationForTurn = conversation;
    const sendPersistedError = (code: string, text: string) => {
      const content = text.trim() || "处理消息时发生错误，请重试。";
      const assistant = service.appendChatMessage({
        id: randomUUID(),
        conversationId: conversationForTurn.id,
        role: "assistant",
        content,
        taskId: null,
        attachments: [],
        createdAt: new Date().toISOString()
      });
      send("status", { state: "failed", message: "执行失败" });
      send("error", { code, message: content });
      send("done", assistant);
    };

    send("conversation", conversation);
    send("user", userRecord);
    send("status", { state: "running", message: "正在执行中…" });
    try {
      options.personal?.writer.captureChatTurn(userRecord);
    } catch {
      // Ontology writeback is best effort and never blocks the reply.
    }

    const plan = planExecution(userContent);
    const effectiveSettings = parsed.data.settings
      ? mergeConversationSettings(conversation.settings, parsed.data.settings)
      : conversation.settings;
    const lockedExecutorId = executorSettings().preferredExecutorId ?? "native";
    const preferredExecutorId = lockedExecutorId;
    const executorEnabled = { ...effectiveSettings.executorEnabled, [lockedExecutorId]: true };
    const previousMessages = store.listChatMessages(conversation.id).filter((item) => item.id !== userRecord.id);
    const referencedFile = extractLocalFilePath(userContent);
    const chatProject = conversation.projectId ? store.getLocalProject(conversation.projectId) : null;
    const requestedMcpServerIds = [...new Set(parsed.data.mcpServerIds ?? [])];
    const pendingMcpServerIds = requestedMcpServerIds;
    if (pendingMcpServerIds.length > 0 && options.mcpServers) {
      const servers = options.mcpServers.list();
      const unavailable = pendingMcpServerIds.filter((id) => {
        const server = servers.find((item) => item.id === id);
        return !server || !server.enabled || server.status !== "ready";
      });
      if (unavailable.length > 0) {
        const reasons = unavailable.map((id) => {
          const server = servers.find((item) => item.id === id);
          if (!server) return `${id}：资料库中已不存在`;
          if (!server.enabled) return `${server.name}：已停用`;
          return `${server.name}：${server.error ?? "连接未就绪"}`;
        });
        sendPersistedError("MCP_NOT_AVAILABLE", `本轮选择的 MCP 没能启用，任务没有派出。${reasons.join("；")}`);
        finish(reply, send);
        return reply;
      }
    }
    const wantsGoal = parsed.data.goalMode === true;
    const wantsPlan = parsed.data.planMode === true || effectiveSettings.collaborationMode === "plan";
    const available = executorAvailability();
    const lockedHealth = options.executorHealth
      ? options.executorHealth(lockedExecutorId)
      : executorHealth(lockedExecutorId, executorSettings(), executorSettingsPath);
    const resolution = resolveExecutorLocked(lockedExecutorId, executorEnabled, available, plan.capability);
    const taskTitle = conversationTitle(userContent);

    // “把桌面上那个 PPT 发给我”应该真的把文件交出去，而不是让模型用一句
    // “已发给你”糊弄过去；IM 侧也只有拿到 ChatAttachment 才能上传文件本体。
    const localFileRequest = storedFiles.length === 0
      && !detectedUrl
      && !parsed.data.skillId
      && pendingMcpServerIds.length === 0
      && !wantsGoal
      && !wantsPlan
      ? parseLocalFileRequest(userContent)
      : null;
    if (localFileRequest) {
      const hintPaths = [
        ...extractFilePaths(userContent),
        ...previousMessages.flatMap((item) => extractFilePaths(item.content))
      ];
      const hit = searchLocalFile(localFileRequest, {
        roots: defaultLocalFileRoots(chatProject?.path ?? null),
        hintPaths
      });
      if (!hit) {
        sendPersistedError(
          "FILE_NOT_FOUND",
          `没有在桌面、下载、文档或当前项目目录找到「${localFileRequest.original}」。请确认文件名，或把文件拖进对话后再说一次“发给我”。`
        );
        finish(reply, send);
        return reply;
      }
      try {
        const attachment = storeOutgoingAttachment(hit.path, attachmentRoot);
        const assistant = service.appendChatMessage({
          id: randomUUID(),
          conversationId: conversation.id,
          role: "assistant",
          content: `已把《${attachment.name}》发给你。`,
          taskId: null,
          attachments: [attachment],
          createdAt: new Date().toISOString()
        });
        send("done", assistant);
      } catch (error) {
        sendPersistedError("FILE_SEND_FAILED", `文件发送失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
      finish(reply, send);
      return reply;
    }

    send("routing", {
      action: "task",
      harness: "agent",
      title: taskTitle,
      goal: userContent,
      reason: wantsPlan
        ? "进入统一 Agent Harness：本轮受计划模式只读约束"
        : wantsGoal
          ? "进入统一 Agent Harness：本轮受目标模式多轮约束"
          : "进入统一 Agent Harness，由模型根据实际需求决定直接回答或调用工具",
      plan: { ...plan, executorId: resolution.executorId ?? lockedExecutorId },
      preferredExecutorId,
      lockedExecutorId
    });

    let mentionResult: ReturnType<MentionResolver["resolveText"]> | null = null;
    if (options.personal) {
      try {
        mentionResult = options.personal.mentions.resolveText({
          text: userContent,
          conversationId: conversation.id,
          messageId: userRecord.id,
          irreversible: true
        });
        if (mentionResult.mentions.length > 0) {
          send("mentions", {
            resolved: mentionResult.mentions.filter((mention) => mention.resolution === "resolved").length,
            ambiguous: mentionResult.mentions.filter((mention) => mention.resolution !== "resolved").length
          });
        }
      } catch {
        mentionResult = null;
      }
    }

    let skillContext = "";
    if (parsed.data.skillId && options.skills) {
      try {
        const used = options.skills.use(parsed.data.skillId, {
          taskId: null,
          runId: null,
          note: `对话使用：${message.slice(0, 120)}`
        });
        skillContext = used.prompt;
        send("skill", { skill: used.skill });
      } catch (error) {
        sendPersistedError("SKILL_NOT_AVAILABLE", error instanceof Error ? error.message : "这个 Skill 暂时不能用");
        finish(reply, send);
        return reply;
      }
    }

    let createdGoalId: string | null = null;
    try {
      if (!resolution.executorId) {
        const lockedIssue = lockedHealth?.issues.filter(Boolean).join("；");
        const lockedText = `已锁定 ${executorName(lockedExecutorId)}，但${resolution.reason ?? "当前无法执行"}${lockedIssue ? `：${lockedIssue}` : ""}。消息没有派出；请检查该执行器的模型绑定和健康状态。`;
        const assistant = service.appendChatMessage({
          id: randomUUID(),
          conversationId: conversation.id,
          role: "assistant",
          content: lockedText,
          taskId: null,
          attachments: [],
          createdAt: new Date().toISOString()
        });
        send("done", assistant);
        finish(reply, send);
        return reply;
      }

      const taskSettings = options.modelSettingsForExecutor?.(resolution.executorId) ?? null;
      if (!taskSettings) {
        throw new Error(`${friendlyExecutorName(resolution.executorId)} 尚未绑定可用模型，不能启动任务。`);
      }
      const delegatedChatContext = options.conversationContext
        ? (await options.conversationContext.renderForTask(conversation.id, undefined, userRecord.id, { settings: taskSettings })).text
        : taskChatContext(previousMessages);
      const boundProject = chatProject;
      const boundProjectContext = boundProject ? projectPromptBlock(boundProject) : "";
      const workspacePath = boundProject ? null : referencedFile ? dirname(referencedFile) : extractWorkspacePath(message);
      const fileInputs = storedFiles.map((file) => ({ label: file.name, path: file.path }));
      if (referencedFile) fileInputs.push({ label: basename(referencedFile), path: referencedFile });

      let memoryContext = "";
      if (options.memory) {
        try {
          const projectScope = conversation.projectId ? projectMemoryScope(conversation.projectId) : null;
          const recalled = options.memory.recallForConversation({
            conversationId: conversation.id,
            text: userContent,
            ...(projectScope ? { scope: projectScope, scopes: [projectScope] } : {})
          });
          if (recalled.memories.length > 0) {
            memoryContext = recalled.contextPack;
            send("memory", {
              count: recalled.memories.length,
              recallIds: recalled.recalls.map((recall) => recall.id)
            });
          }
        } catch {
          // Context recall is best effort and never blocks the selected harness.
        }
      }

      let libraryContext = "";
      if (options.library) {
        try {
          const recalled = await options.library.search(userContent, 6);
          const hits = recalled.hits.filter((hit) => libraryHitAllowedForConversation(hit, conversation.projectId));
          if (hits.length > 0) {
            libraryContext = [
              "## 相关资料",
              ...hits.map((hit) => `### ${hit.node.title} [${hit.node.kind}]\n引用：${hit.node.ref}\n${hit.snippet}`)
            ].join("\n\n");
            send("library", { count: hits.length });
          }
        } catch {
          // Library recall is best effort and never blocks the selected harness.
        }
      }

      let personalContext = "";
      if (options.personal) {
        try {
          const pack = options.personal.broker.compile({
            scopeKind: "chat",
            scopeId: conversation.id,
            conversationId: conversation.id,
            query: userContent,
            budgetTokens: 1600,
            includeRecentContext: false
          });
          personalContext = options.personal.broker.render(pack);
          send("context", { packId: pack.id, usedTokens: pack.usedTokens, budgetTokens: pack.budgetTokens });
        } catch {
          personalContext = "";
        }
      }

      if (controller.signal.aborted) return reply;
      const taskGoal = [message, detectedUrl ? `参考网址：${detectedUrl}` : ""].filter(Boolean).join("\n")
        || `处理附件：${storedFiles.map((file) => file.name).join("、")}`;
      const attachmentContext = fileInputs.length > 0
        ? `本轮附件（需要时用执行器工具读取）：\n${fileInputs.map((file) => `- ${file.label}: ${file.path}`).join("\n")}`
        : "";
      const mentionContext = mentionResult?.blocksAction
        ? `指代需要先确认：${mentionResult.question ?? "请根据对话和当前工作区确认用户所指对象。"}`
        : "";
      const harnessPrompt = [
        message,
        boundProjectContext,
        skillContext,
        delegatedChatContext,
        personalContext,
        memoryContext,
        libraryContext,
        mentionContext,
        detectedUrl ? `参考网址：${detectedUrl}` : "",
        attachmentContext,
        "## 统一 Agent 执行契约",
        "根据用户实际请求自主决定直接回答、读取文件、检索资料、运行命令或修改代码。需要事实、本地文件、仓库或外部状态时必须调用可用工具读取真实状态。",
        "当前任务拥有完全权限。本地读取、检查、统计、测试和已授权的代码操作直接执行，不要声称需要额外授权，也不要要求用户先切换到所谓任务模式。",
        boundProject
          ? "当前会话绑定本地项目。先核对真实文件与当前工作区；除非用户明确要求修改，否则不要写入或删除项目文件。"
          : "",
        parsed.data.skillId
          ? "本轮选择了 Skill，优先遵循该 Skill 的流程。Skill 要求提问时，先取得真实所需信息再继续。"
          : "",
        pendingMcpServerIds.length > 0
          ? `本轮已选择 MCP 服务器：${pendingMcpServerIds.join("、")}。`
          : ""
      ].filter(Boolean).join("\n\n");

      let task: TaskRecord;
      if (wantsPlan) {
        if (!options.plans) throw new Error("计划服务没有启动");
        const activePlan = parsed.data.planId
          ? options.plans.get(parsed.data.planId)
          : options.plans.activeForConversation(conversation.id);
        if (activePlan) {
          if (activePlan.conversationId !== conversation.id) throw new Error("这个计划不属于当前对话");
          if (activePlan.stage !== "planning" && activePlan.stage !== "awaiting_approval") {
            throw new Error(`计划处于 ${activePlan.stage}，不能继续讨论；请先批准、重试或退出计划`);
          }
          const revised = options.plans.continuePlanning(activePlan.id, harnessPrompt, {
            title: taskTitle,
            textInput: harnessPrompt,
            ...(pendingMcpServerIds.length ? { mcpServerIds: pendingMcpServerIds } : {})
          });
          const planningTask = revised.planningTaskId ? service.store.getTask(revised.planningTaskId) : null;
          if (!planningTask) throw new Error("计划规划任务没有创建成功");
          task = planningTask;
        } else {
          const created = options.plans.create({
            conversationId: conversation.id,
            projectId: boundProject?.id ?? null,
            title: taskTitle,
            objective: taskGoal,
            textInput: harnessPrompt,
            ...(pendingMcpServerIds.length ? { mcpServerIds: pendingMcpServerIds } : {}),
            execution: {
              executorId: resolution.executorId,
              taskKind: plan.taskKind,
              expectedOutputs: plan.expectedOutputs,
              projectId: boundProject?.id ?? null,
              workspacePath: workspacePath ?? null,
              networkHosts: plan.networkHosts ?? [],
              ...(resolution.executorId === "native" ? { executionMode: effectiveSettings.executionMode ?? "standard" } : {})
            }
          });
          const planningTask = created.planningTaskId ? service.store.getTask(created.planningTaskId) : null;
          if (!planningTask) throw new Error("计划规划任务没有创建成功");
          task = planningTask;
        }
      } else {
        if (wantsGoal) {
          if (!options.goals) throw new Error("目标服务没有启动");
          const goalSettings = parsed.data.goalSettings ?? {};
          const created = options.goals.create({
            title: taskTitle,
            objective: taskGoal,
            conversationId: conversation.id,
            projectId: boundProject?.id ?? null,
            execution: {
              executorId: resolution.executorId,
              taskKind: plan.taskKind,
              expectedOutputs: plan.expectedOutputs,
              projectId: boundProject?.id ?? null,
              workspacePath: workspacePath ?? null,
              networkHosts: plan.networkHosts ?? [],
              ...(resolution.executorId === "native" ? { executionMode: effectiveSettings.executionMode ?? "standard" } : {})
            },
            criteria: (goalSettings.criteria ?? []).map((description, index) => ({
              id: `c${index + 1}`,
              description,
              validator: "llm_review" as const,
              check: description,
              required: true
            })),
            forbiddenActions: goalSettings.forbiddenActions ?? [],
            evidenceRequirements: goalSettings.evidenceRequirements ?? [],
            ...(goalSettings.maxRounds !== undefined ? { maxRounds: goalSettings.maxRounds } : {}),
            ...(goalSettings.reviewPolicy ? { reviewPolicy: goalSettings.reviewPolicy } : {}),
            ...(goalSettings.deadline ? { deadline: goalSettings.deadline } : {}),
            ...(goalSettings.commandsApproved ? { commandsApproved: true } : {})
          });
          createdGoalId = created.goalId;
        }
        task = service.createTask({
          title: taskTitle,
          goal: taskGoal,
          textInput: harnessPrompt,
          fileInputs,
          ...(detectedUrl ? { url: detectedUrl } : {}),
          ...(boundProject ? { projectId: boundProject.id } : {}),
          ...(workspacePath ? { workspacePath } : {}),
          ...(createdGoalId ? { goalId: createdGoalId } : {}),
          conversationId: conversation.id,
          executorId: resolution.executorId,
          ...(resolution.executorId === "native" ? { executionMode: effectiveSettings.executionMode ?? "standard" } : {}),
          taskKind: plan.taskKind,
          expectedOutputs: plan.expectedOutputs,
          ...(plan.networkHosts ? { networkHosts: plan.networkHosts } : {}),
          ...(pendingMcpServerIds.length ? { mcpServerIds: pendingMcpServerIds } : {})
        });
      }

      if (createdGoalId && options.goals) {
        options.goals.attachTask(createdGoalId, task.id);
        await options.goals.action(createdGoalId, "start");
      }
      const executorText = friendlyExecutorName(resolution.executorId);
      const openingText = wantsPlan
        ? `开始规划：${task.title}\n\n计划阶段只读调查，不会修改文件；完成后会给出可批准的实施计划。`
        : wantsGoal
          ? `开始目标：${task.title}\n\n执行器：${executorText}。目标会在当前执行器上持续推进直到完成或需要你的输入。`
          : `开始执行：${task.title}\n\n执行器：${executorText}。Hearth 会根据请求自主决定是否调用工具。`;
      const assistant = service.appendChatMessage({
        id: randomUUID(),
        conversationId: conversation.id,
        role: "assistant",
        content: openingText,
        taskId: task.id,
        attachments: [],
        createdAt: new Date().toISOString(),
        kind: "task_status",
        taskStatus: task.status
      });
      send("task", { task, conversationId: conversation.id, message: assistant });
      send("usage", contextUsagePayload({
        settings: taskSettings,
        source: "pending",
        scope: "task",
        inputTokens: 0,
        outputTokens: 0,
        breakdown: {}
      }));
      send("done", assistant);
    } catch (error) {
      if (createdGoalId && options.goals) {
        try {
          await options.goals.action(createdGoalId, "stop", { note: "任务创建失败，目标未开始" });
        } catch {
          // Keep the original task-creation error visible to the user.
        }
      }
      sendPersistedError("TASK_CREATE_FAILED", errorMessage(error));
    } finally {
      finish(reply, send);
    }
    return reply;
  });
}

function extractUrl(message: string): string | null {
  const match = message.match(/https?:\/\/\S+/i);
  if (!match) return null;
  return match[0].replace(/[),.;，。；）]+$/, "");
}

function localPathCandidates(message: string): string[] {
  if (!message) return [];
  return [
    ...(message.match(/[A-Za-z]:[\\/][^\s"'\`<>|?*]+/g) ?? []),
    ...(message.match(/\\\\[^\s"'\`<>|?*]+/g) ?? []),
    ...Array.from(message.matchAll(/(?:^|[\s"'`(])(\/[^\s"'`<>|?*]+)/g), (match) => match[1]!)
  ].map((raw) => raw.replace(/[.,;:!?，。；！？]+$/, ""));
}

function findExistingLocalPath(message: string): { path: string; isFile: boolean } | null {
  for (const raw of localPathCandidates(message)) {
    // A path followed immediately by prose (for example "...pdf这个文件")
    // shares the same token. Walk back to the longest existing filesystem
    // prefix so the prose suffix does not hide a real file.
    for (let end = raw.length; end >= 3; end -= 1) {
      const candidate = raw.slice(0, end);
      try {
        const stats = statSync(candidate);
        if (stats.isFile() || stats.isDirectory()) {
          return { path: realpathSync.native(candidate), isFile: stats.isFile() };
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function extractLocalFilePath(message: string): string | null {
  const found = findExistingLocalPath(message);
  return found?.isFile ? found.path : null;
}

export function extractWorkspacePath(message: string): string | null {
  const found = findExistingLocalPath(message);
  return found ? (found.isFile ? dirname(found.path) : found.path) : null;
}

export function taskChatContext(messages: Array<{ role: string; content: string; taskId?: string | null }>): string {
  let remaining = 12_000;
  const chunks: string[] = [];
  for (const message of messages.filter((item) => !item.taskId && ["user", "assistant"].includes(item.role)).slice(-8).reverse()) {
    if (remaining <= 0) break;
    const content = message.content.slice(0, Math.min(6000, remaining));
    remaining -= content.length;
    chunks.unshift(`${message.role === "user" ? "用户" : "助手"}：${content}`);
  }
  return chunks.length ? `以下为派出任务前的近期聊天上下文，仅供理解当前请求；历史内容不代表新的操作授权。\n<chat_context>\n${chunks.join("\n\n")}\n</chat_context>` : "";
}

function contextUsagePayload(input: {
  settings: ModelSettings;
  source: ContextUsageSnapshot["source"];
  scope?: ContextUsageSnapshot["scope"];
  inputTokens: number;
  outputTokens: number;
  breakdown: Record<string, number>;
}): ContextUsageSnapshot {
  return {
    inputTokens: Math.max(0, Math.round(input.inputTokens)),
    outputTokens: Math.max(0, Math.round(input.outputTokens)),
    contextWindowTokens: input.settings.contextWindowTokens,
    model: input.settings.model,
    reasoningEffort: input.settings.reasoningEffort ?? "max",
    source: input.source,
    scope: input.scope ?? "chat",
    breakdown: Object.fromEntries(
      Object.entries(input.breakdown).map(([key, value]) => [key, Math.max(0, Math.round(value))])
    ),
    measuredAt: new Date().toISOString()
  };
}

function daemonUserContent(url: string | null, files: (ChatAttachment & { path: string })[]): string {
  if (url) return `请处理这个网址：${url}`;
  return `请处理附件：${files.map((file) => file.name).join("、")}`;
}

function friendlyExecutorName(id: ExecutorId): string {
  if (id === "native") return "Hearth 原生执行器";
  if (id === "codex") return "Codex（工程任务）";
  return executorName(id);
}

function finish(reply: FastifyReply, send: (event: string, data: unknown) => void): void {
  send("end", {});
  if (!reply.raw.writableEnded) reply.raw.end();
}

function findAttachmentPath(root: string, id: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  try {
    for (const name of readdirSync(root)) {
      if (name.startsWith(`${id}.`)) return join(root, name);
    }
  } catch {
    return null;
  }
  return null;
}

const ATTACHMENT_MIME: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".text": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".markdown": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".js": "text/plain; charset=utf-8",
  ".jsx": "text/plain; charset=utf-8",
  ".mjs": "text/plain; charset=utf-8",
  ".cjs": "text/plain; charset=utf-8",
  ".css": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".html": "text/plain; charset=utf-8",
  ".htm": "text/plain; charset=utf-8",
  ".xml": "text/plain; charset=utf-8",
  ".svg": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4"
};

function attachmentMimeType(path: string): string {
  return ATTACHMENT_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function safeExtension(name: string): string {
  const extension = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
}

function mergeModelSettings(current: ModelSettings, patch: {
  providerId?: string | undefined;
  providerName?: string | undefined;
  protocol?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  contextWindowTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  apiKey?: string | undefined;
}): ModelSettings {
  return {
    ...current,
    ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
    ...(patch.providerName !== undefined ? { providerName: patch.providerName } : {}),
    ...(patch.protocol !== undefined ? { protocol: normalizeProtocol(patch.protocol) } : {}),
    ...(patch.baseUrl !== undefined ? { baseUrl: normalizeBaseUrl(patch.baseUrl) } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.contextWindowTokens !== undefined ? { contextWindowTokens: patch.contextWindowTokens } : {}),
    ...(patch.maxOutputTokens !== undefined ? { maxOutputTokens: patch.maxOutputTokens } : {}),
    ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey } : {})
  };
}

function saveRegistryChatSettings(
  registry: ModelRegistry,
  patch: {
    providerId?: string | undefined;
    providerName?: string | undefined;
    protocol?: string | undefined;
    baseUrl?: string | undefined;
    model?: string | undefined;
    contextWindowTokens?: number | undefined;
    maxOutputTokens?: number | undefined;
    apiKey?: string | undefined;
  }
): ModelSettings | null {
  const existing = registry.chatProfileId();
  if (existing) {
    registry.updateProfile(existing, {
      ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
      ...(patch.providerName !== undefined ? { providerName: patch.providerName } : {}),
      ...(patch.protocol !== undefined ? { protocol: normalizeProtocol(patch.protocol) } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: normalizeBaseUrl(patch.baseUrl) } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.contextWindowTokens !== undefined ? { contextWindowTokens: patch.contextWindowTokens } : {}),
      ...(patch.maxOutputTokens !== undefined ? { maxOutputTokens: patch.maxOutputTokens } : {}),
      ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey } : {})
    });
    return registry.chatSettings();
  }
  if (!patch.baseUrl?.trim() || !patch.model?.trim()) return null;
  const providerName = patch.providerName?.trim() || "自定义服务";
  const created = registry.createProfile({
    name: `${providerName} / ${patch.model.trim()}`,
    providerId: patch.providerId ?? "custom",
    providerName,
    protocol: patch.protocol ? normalizeProtocol(patch.protocol) : "openai-chat",
    baseUrl: normalizeBaseUrl(patch.baseUrl),
    model: patch.model,
    ...(patch.contextWindowTokens !== undefined ? { contextWindowTokens: patch.contextWindowTokens } : {}),
    ...(patch.maxOutputTokens !== undefined ? { maxOutputTokens: patch.maxOutputTokens } : {}),
    ...(patch.apiKey ? { apiKey: patch.apiKey } : {})
  });
  registry.setChatProfile(created.id);
  return registry.chatSettings();
}

/** Keep project-scoped library memories inside their own project conversations. */
export function libraryHitAllowedForConversation(hit: LibrarySearchHit, projectId: string | null | undefined): boolean {
  if (hit.node.kind !== "memory") return true;
  const scope = typeof hit.node.metadata.scope === "string" ? hit.node.metadata.scope : "";
  if (!/^project[.:]/i.test(scope)) return true;
  return typeof projectId === "string" && projectId.length > 0 && scope === projectMemoryScope(projectId);
}

function projectPromptBlock(project: Pick<LocalProject, "name" | "path" | "defaultBranch">): string {
  return [
    "## 当前项目",
    `- 项目名：${project.name}`,
    `- 仓库路径：${project.path}`,
    `- 默认分支：${project.defaultBranch || "main"}`,
    "用户是从这个项目打开当前对话的。提到“这个项目 / 当前仓库 / 代码结构 / 文件 / 目录 / 命令 / 实现”时，默认都指上面的仓库路径；不要用其他项目或历史记忆里的路径替换它。需要路径时直接引用这个绝对路径。"
  ].join("\n");
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return error instanceof ModelClientError ? error.code : "UNKNOWN";
}

function isFileTooLarge(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE");
}

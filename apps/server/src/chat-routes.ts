import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ChatAttachment, ChatMessageRecord, ExecutorHealth, ExecutorId } from "@hearth/core";
import { defaultConversationSettings, EXECUTOR_IDS, mergeConversationSettings } from "@hearth/core";
import { loadCodexProfile, probeCodex, type CodexProfile } from "@hearth/codex-executor";
import { loadExecutorSettings, type ExecutorSettingsStore } from "./executor-settings.ts";
import { EXECUTOR_FALLBACK_ORDER, executorName, resolveExecutorFromEnabled, resolveExecutorLocked } from "./executors.ts";
import { executorHealth, isExecutorManagedInstalled } from "./executor-runtime.ts";
import type { HearthService } from "./service.ts";
import type { MemoryService } from "./memory.ts";
import type { ContextBroker } from "./context-broker.ts";
import type { MentionResolver } from "./mentions.ts";
import type { OntologyService } from "./ontology.ts";
import type { OntologyWriter } from "./ontology-writer.ts";
import { ModelRegistryError, type ModelRegistry } from "./model-registry.ts";
import { chatSystemPrompt, conversationTitle, decideRoute, planExecution } from "./chat.ts";
import { listModels, ModelClientError, completeChat, streamChat, type ChatMessage } from "./model-client.ts";
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
  approvalMode: z.enum(["necessary", "full"]).optional(),
  preferredExecutorId: z.enum(EXECUTOR_IDS).nullable().optional()
}).strict();

const chatSchema = z.object({
  conversationId: z.string().trim().min(1).max(80).optional(),
  message: z.string().max(100_000).optional(),
  attachments: z.array(attachmentSchema).max(5).optional(),
  url: z.string().trim().max(2_048).optional(),
  settings: conversationSettingsSchema.optional()
}).strict();

const conversationSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  settings: conversationSettingsSchema.optional()
}).strict();

const conversationPatchSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  settings: conversationSettingsSchema.optional()
}).strict();

const modelProtocolSchema = z.enum(["openai-chat", "openai-responses", "anthropic-messages", "gemini"]);

const modelSettingsSchema = z.object({
  providerId: z.string().trim().min(1).max(60).optional(),
  providerName: z.string().trim().min(1).max(80).optional(),
  protocol: modelProtocolSchema.optional(),
  baseUrl: z.string().trim().max(500).optional(),
  model: z.string().trim().max(200).optional(),
  apiKey: z.string().max(500).optional()
}).strict();

const modelProbeSchema = z.object({
  providerId: z.string().trim().max(60).optional(),
  providerName: z.string().trim().max(80).optional(),
  protocol: modelProtocolSchema.optional(),
  baseUrl: z.string().trim().max(500).optional(),
  model: z.string().trim().max(200).optional(),
  apiKey: z.string().max(500).optional()
}).strict();

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
  memory?: MemoryService | undefined;
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
  const chatSettings = (): ModelSettings => options.registry?.chatSettings() ?? loadModelSettings(modelSettingsPath);
  const chatConfigured = (): boolean => chatModelConfigured(chatSettings());
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
    const enabled: Partial<Record<ExecutorId, boolean>> = { native: true, codex: true, hermes: true };
    if (options.registry?.settingsForExecutorOrChat("deepseek-harness")) enabled["deepseek-harness"] = true;
    for (const id of ["qoder", "workbuddy", "kimi"] as const) {
      const runtime = settings.executors[id];
      enabled[id] = isExecutorManagedInstalled(id, executorSettingsPath)
        || Boolean(runtime?.executablePath || runtime?.command || runtime?.installMode);
    }
    return {
      ...defaultConversationSettings(settings.defaultApprovalMode, enabled),
      preferredExecutorId: settings.preferredExecutorId
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
    const conversation = store.createConversation(parsed.data.title ?? "新对话", settings);
    return reply.code(201).send(conversation);
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND", message: "对话不存在" });
    return {
      conversation,
      messages: store.listChatMessages(conversation.id),
      tasks: store.listTasks().filter((task) => task.conversationId === conversation.id),
      proposals: store.listTaskProposals(conversation.id)
    };
  });

  app.patch<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const parsed = conversationPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success || (!parsed.data.title && !parsed.data.settings)) {
      return reply.code(400).send({ error: "INVALID_CONVERSATION", message: "对话参数不正确" });
    }
    if (!store.getConversation(request.params.id)) {
      return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND", message: "对话不存在" });
    }
    let conversation = store.getConversation(request.params.id);
    if (parsed.data.title) conversation = store.renameConversation(request.params.id, parsed.data.title);
    if (parsed.data.settings) conversation = store.updateConversationSettings(request.params.id, parsed.data.settings);
    return conversation;
  });

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    if (!store.getConversation(request.params.id)) {
      return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND", message: "对话不存在" });
    }
    store.deleteConversation(request.params.id);
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
      conversation = store.createConversation(conversationTitle(message || detectedUrl || "处理上传文件"), settings);
    }

    const userContent = message || (detectedUrl ? `请处理这个网址：${detectedUrl}` : `请处理附件：${storedFiles.map((file) => file.name).join("、")}`);
    const userRecord = store.createChatMessage({
      id: randomUUID(),
      conversationId: conversation.id,
      role: "user",
      content: detectedUrl && message && !message.includes(detectedUrl) ? `${message}\n\n${detectedUrl}` : message || daemonUserContent(detectedUrl, storedFiles),
      taskId: null,
      attachments: storedFiles.map(({ id, name, mimeType, bytes }) => ({ id, name, mimeType, bytes })),
      createdAt: new Date().toISOString()
    });

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

    send("conversation", conversation);
    send("user", userRecord);
    try {
      options.personal?.writer.captureChatTurn(userRecord);
    } catch {
      // Ontology writeback is best effort and never blocks the reply.
    }

    const settings = chatSettings();
    const plan = planExecution(userContent);
    const effectiveSettings = parsed.data.settings
      ? mergeConversationSettings(conversation.settings, parsed.data.settings)
      : conversation.settings;
    const lockedExecutorId = effectiveSettings.preferredExecutorId;
    const preferredExecutorId = lockedExecutorId ?? plan.executorId;
    const route = await decideRoute(userContent, storedFiles.length > 0, detectedUrl, settings, {
      preferredExecutorId: lockedExecutorId
    });
    const available = executorAvailability();
    const resolution = lockedExecutorId
      ? resolveExecutorLocked(lockedExecutorId, effectiveSettings.executorEnabled, available, plan.capability)
      : resolveExecutorFromEnabled(
          preferredExecutorId,
          effectiveSettings.executorEnabled,
          available,
          plan.capability,
          preferredExecutorId === plan.executorId
            ? [...EXECUTOR_FALLBACK_ORDER]
            : [plan.executorId, ...EXECUTOR_FALLBACK_ORDER.filter((id) => id !== plan.executorId)]
        );
    send("routing", {
      ...route,
      plan: { ...plan, executorId: resolution.executorId ?? lockedExecutorId ?? plan.executorId },
      preferredExecutorId,
      ...(lockedExecutorId ? { lockedExecutorId } : {}),
      ...(resolution.reroutedFrom ? { reroutedFrom: resolution.reroutedFrom } : {})
    });

    let mentionResult: ReturnType<MentionResolver["resolveText"]> | null = null;
    if (options.personal) {
      try {
        mentionResult = options.personal.mentions.resolveText({
          text: userContent,
          conversationId: conversation.id,
          messageId: userRecord.id,
          irreversible: route.action === "task"
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
    if (route.action === "task" && mentionResult?.blocksAction) {
      const assistant = store.createChatMessage({
        id: randomUUID(),
        conversationId: conversation.id,
        role: "assistant",
        content: `在派出任务前需要先确认指代：${mentionResult.question ?? "请补充具体对象。"}`,
        taskId: null,
        attachments: [],
        createdAt: new Date().toISOString()
      });
      send("clarification", { question: mentionResult.question, mentions: mentionResult.mentions });
      send("done", assistant);
      finish(reply, send);
      return reply;
    }

    if (route.action === "task") {
      try {
        if (!resolution.executorId) {
          const lockedText = lockedExecutorId
            ? `已锁定 ${executorName(lockedExecutorId)}，但${resolution.reason ?? "当前无法执行"}。任务没有派出；请检查该执行器设置，或切回“自动匹配（按任务）”后重试。`
            : plan.capability
              ? `${resolution.reason ?? "没有可用的执行器"}，暂时不能派出任务。请在输入框上方启用${plan.capability === "github" ? " Codex、Hermes 或 Native" : " Native"}后重试。`
              : "所有执行器都已关闭或不可用，暂时不能派出任务。请在输入框上方的执行器选择器中选择一个可用执行器，然后再发送。";
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
        const task = service.createTask({
          title: route.title || conversationTitle(userContent),
          goal: [message, detectedUrl ? `参考网址：${detectedUrl}` : ""].filter(Boolean).join("\n") || `处理附件：${storedFiles.map((file) => file.name).join("、")}`,
          ...(message ? { textInput: message } : {}),
          fileInputs: storedFiles.map((file) => ({ label: file.name, path: file.path })),
          ...(detectedUrl ? { url: detectedUrl } : {}),
          conversationId: conversation.id,
          executorId: resolution.executorId,
          taskKind: plan.taskKind,
          expectedOutputs: plan.expectedOutputs,
          ...(plan.networkHosts ? { networkHosts: plan.networkHosts } : {})
        });
        const executorText = friendlyExecutorName(resolution.executorId);
        const rerouteText = resolution.reroutedFrom
          ? `\n\n${resolution.reason ?? "原执行器不可用"}，已自动改由 ${executorText} 接管。`
          : "";
        const assistant = service.appendChatMessage({
          id: randomUUID(),
          conversationId: conversation.id,
          role: "assistant",
          content: `已派出任务：${task.title}\n\n执行器：${executorText}。任务已出现在左侧对话目录，也可以到“任务”页查看进度和结果。${rerouteText}`,
          taskId: task.id,
          attachments: [],
          createdAt: new Date().toISOString()
        });
        send("task", { task, conversationId: conversation.id, message: assistant });
        send("done", assistant);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        send("error", { message: messageText, code: "TASK_CREATE_FAILED" });
      } finally {
        finish(reply, send);
      }
      return reply;
    }

    if (!chatConfigured()) {
      send("error", {
        message: "还没有配置聊天模型。请到“设置”里选择服务商并填入 API Key，然后重新发送。",
        code: "MODEL_NOT_CONFIGURED"
      });
      finish(reply, send);
      return reply;
    }

    const history = store.listChatMessages(conversation.id)
      .slice(-24)
      .map((item): ChatMessage => ({ role: item.role, content: item.content }));
    let memoryContext = "";
    if (options.memory) {
      try {
        const recalled = options.memory.recallForConversation({
          conversationId: conversation.id,
          text: userContent
        });
        if (recalled.memories.length > 0) {
          memoryContext = recalled.contextPack;
          send("memory", {
            count: recalled.memories.length,
            recallIds: recalled.recalls.map((recall) => recall.id)
          });
        }
      } catch {
        // Memory recall is best effort and never blocks the answer.
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
    const messages: ChatMessage[] = [
      { role: "system", content: [chatSystemPrompt(), personalContext, memoryContext].filter(Boolean).join("\n\n") },
      ...history
    ];

    try {
      let answer = "";
      await streamChat(settings, messages, (delta, kind) => {
        if (kind === "reasoning") {
          send("reasoning", { text: delta });
          return;
        }
        answer += delta;
        send("delta", { text: delta });
      }, { signal: controller.signal, temperature: 0.5, timeoutMs: 180_000 });
      const assistant = store.createChatMessage({
        id: randomUUID(),
        conversationId: conversation.id,
        role: "assistant",
        content: answer,
        taskId: null,
        attachments: [],
        createdAt: new Date().toISOString()
      });
      send("done", assistant);
    } catch (error) {
      send("error", {
        message: errorMessage(error),
        code: errorCode(error)
      });
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
  apiKey?: string | undefined;
}): ModelSettings {
  return {
    ...current,
    ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
    ...(patch.providerName !== undefined ? { providerName: patch.providerName } : {}),
    ...(patch.protocol !== undefined ? { protocol: normalizeProtocol(patch.protocol) } : {}),
    ...(patch.baseUrl !== undefined ? { baseUrl: normalizeBaseUrl(patch.baseUrl) } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
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
    ...(patch.apiKey ? { apiKey: patch.apiKey } : {})
  });
  registry.setChatProfile(created.id);
  return registry.chatSettings();
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

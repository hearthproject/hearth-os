import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ChatAttachment, ChatMessageRecord } from "@hearth/core";
import { loadCodexProfile, probeCodex } from "@hearth/codex-executor";
import type { HearthService } from "./service.ts";
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

const chatSchema = z.object({
  conversationId: z.string().trim().min(1).max(80).optional(),
  message: z.string().max(100_000).optional(),
  attachments: z.array(attachmentSchema).max(5).optional(),
  url: z.string().trim().max(2_048).optional()
}).strict();

const conversationSchema = z.object({
  title: z.string().trim().min(1).max(80).optional()
}).strict();

const conversationPatchSchema = z.object({
  title: z.string().trim().min(1).max(80)
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
}

export async function registerChatRoutes(app: FastifyInstance, options: ChatRouteOptions): Promise<void> {
  const { service, modelSettingsPath, attachmentRoot } = options;
  const store = service.store;
  mkdirSync(attachmentRoot, { recursive: true });
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 5, fields: 10, parts: 20 }
  });

  app.get("/api/model-settings", async () => {
    const settings = loadModelSettings(modelSettingsPath);
    return {
      settings: viewModelSettings(settings),
      presets: MODEL_PRESETS,
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
    const settings = saveModelSettings(modelSettingsPath, patch);
    return { settings: viewModelSettings(settings), configured: chatModelConfigured(settings) };
  });

  app.post("/api/model-settings/models", async (request, reply) => {
    const parsed = modelProbeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MODEL_REQUEST", message: "模型参数格式不正确" });
    const settings = mergeModelSettings(loadModelSettings(modelSettingsPath), parsed.data);
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
    const settings = mergeModelSettings(loadModelSettings(modelSettingsPath), parsed.data);
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
    const profile = loadCodexProfile();
    const started = Date.now();
    const result = await Promise.race([
      probeCodex(profile),
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
    const conversation = store.createConversation(parsed.data.title ?? "新对话");
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
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CONVERSATION", message: "标题不能为空" });
    const conversation = store.renameConversation(request.params.id, parsed.data.title);
    if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND", message: "对话不存在" });
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
      conversation = store.createConversation(conversationTitle(message || detectedUrl || "处理上传文件"));
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

    const settings = loadModelSettings(modelSettingsPath);
    const route = await decideRoute(userContent, storedFiles.length > 0, detectedUrl, settings);
    const plan = planExecution(userContent);
    send("routing", { ...route, plan });

    if (route.action === "task") {
      try {
        const task = service.createTask({
          title: route.title || conversationTitle(userContent),
          goal: [message, detectedUrl ? `参考网址：${detectedUrl}` : ""].filter(Boolean).join("\n") || `处理附件：${storedFiles.map((file) => file.name).join("、")}`,
          ...(message ? { textInput: message } : {}),
          fileInputs: storedFiles.map((file) => ({ label: file.name, path: file.path })),
          ...(detectedUrl ? { url: detectedUrl } : {}),
          conversationId: conversation.id,
          executorId: plan.executorId,
          taskKind: plan.taskKind,
          expectedOutputs: plan.expectedOutputs
        });
        const assistant = store.createChatMessage({
          id: randomUUID(),
          conversationId: conversation.id,
          role: "assistant",
          content: `已派出任务：${task.title}\n\n执行器：${plan.executorId === "codex" ? "Codex（工程任务）" : "Hearth 原生执行器"}。任务已出现在左侧对话目录，也可以到“任务”页查看进度和结果。`,
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

    if (!chatModelConfigured(settings)) {
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
    const messages: ChatMessage[] = [{ role: "system", content: chatSystemPrompt() }, ...history];

    try {
      let answer = "";
      await streamChat(settings, messages, (delta) => {
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

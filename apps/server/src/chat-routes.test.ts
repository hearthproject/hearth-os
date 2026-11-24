import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { defaultConversationSettings, mergeConversationSettings } from "@hearth/core";
import { buildServer } from "./app.ts";
import { HearthService, visibleDeliverables } from "./service.ts";

async function createTestProfile(app: FastifyInstance, name = "Test model", protocol = "openai-chat"): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/model-profiles",
    payload: {
      name,
      providerId: "custom",
      providerName: "Test provider",
      protocol,
      baseUrl: "https://models.example.com/v1",
      model: "test-model",
      apiKey: "test-key"
    }
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().profile.id as string;
}

async function bindProfile(app: FastifyInstance, executorId: string, profileId: string): Promise<void> {
  const bound = await app.inject({
    method: "PUT",
    url: `/api/executors/${executorId}/model-binding`,
    payload: { profileId }
  });
  expect(bound.statusCode, bound.body).toBe(200);
}

describe("chat-first API", () => {
  let store: HearthStore;
  let root: string;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    root = mkdtempSync(join(tmpdir(), "hearth-chat-"));
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("drafts and revises a leave letter with one model call per message and no task", async () => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"老师您好，我是小兰，今天感冒不适，申请请假，明天返校。"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }));
    const app = await buildServer({ store, serveWeb: false, masterKeyPath: join(root, "master.key"), modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    try {
      await app.inject({ method: "PUT", url: "/api/model-settings", payload: { providerId: "custom", providerName: "Test", baseUrl: "https://models.example.com/v1", model: "test-model", apiKey: "test-key" } });
      const first = await app.inject({ method: "POST", url: "/api/chat", payload: { message: "我要跟lecture老师请假，帮我拟一封请假信，就说我感冒了不舒服 明天能来", settings: { preferredExecutorId: "native", executionMode: "quick" } } });
      const events = parseSse(first.body);
      expect(events.find((event) => event.event === "error")).toBeUndefined();
      const conversationId = events.find((event) => event.event === "conversation")!.data.id;
      const second = await app.inject({ method: "POST", url: "/api/chat", payload: { conversationId, message: "跟老师说我叫小兰" } });
      expect(parseSse(second.body).find((event) => event.event === "error")).toBeUndefined();
      expect(requests).toHaveLength(2);
      expect(requests.every((body) => body.stream === true && !body.tools && body.max_tokens === 1200)).toBe(true);
      expect(JSON.stringify(requests)).not.toContain("个人上下文包");
      expect(requests[1].messages.some((message: any) => message.role === "assistant")).toBe(true);
      const third = await app.inject({ method: "POST", url: "/api/chat", payload: { conversationId, message: "再加一句 这是由Hearth agent发送的邮件！" } });
      expect(parseSse(third.body).some((event) => event.event === "task" || event.event === "error")).toBe(false);
      expect(requests).toHaveLength(3);
      expect(requests[2].messages.some((message: any) => message.role === "assistant" && message.content.includes("小兰"))).toBe(true);
      const forcedChat = await app.inject({ method: "POST", url: "/api/chat", payload: { conversationId, routeMode: "chat", message: "帮我运行项目测试" } });
      expect(parseSse(forcedChat.body).some((event) => event.event === "task" || event.event === "error")).toBe(false);
      expect(requests).toHaveLength(4);
      expect(store.listTasks()).toHaveLength(0);
    } finally { await app.close(); vi.unstubAllGlobals(); }
  });

  it("recalls project-scoped memory in project conversations but not unrelated sessions", async () => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"已了解项目背景。"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }));
    const app = await buildServer({
      store,
      serveWeb: false,
      masterKeyPath: join(root, "master.key"),
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files")
    });
    try {
      await app.inject({
        method: "PUT",
        url: "/api/model-settings",
        payload: {
          providerId: "custom",
          providerName: "Test",
          baseUrl: "https://models.example.com/v1",
          model: "test-model",
          apiKey: "test-key"
        }
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "Ember", path: root }
      });
      expect(created.statusCode, created.body).toBe(201);
      const projectId = created.json().project.id as string;
      const memory = await app.inject({
        method: "POST",
        url: "/api/memory",
        payload: {
          kind: "project",
          content: "Ember private project memory marker",
          subjectKey: `project.${projectId}.test`,
          scope: `project:${projectId}`,
          source: { type: "user", id: projectId, label: "Ember project note", excerpt: null },
          confidence: "high",
          tier: "curated",
          originClass: "user",
          trust: "high"
        }
      });
      expect(memory.statusCode, memory.body).toBe(201);
      await app.inject({
        method: "POST",
        url: `/api/memory/${memory.json().id}/confirm`
      });
      const projectConversation = store.createConversation("Ember session", defaultConversationSettings(), projectId);
      const unrelatedConversation = store.createConversation("Other session", defaultConversationSettings());

      const projectChat = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: { conversationId: projectConversation.id, routeMode: "chat", message: "What should I remember?" }
      });
      expect(projectChat.statusCode).toBe(200);
      expect(JSON.stringify(requests[0]?.messages)).toContain("Ember private project memory marker");

      const unrelatedChat = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: { conversationId: unrelatedConversation.id, routeMode: "chat", message: "What should I remember?" }
      });
      expect(unrelatedChat.statusCode).toBe(200);
      const unrelatedSystem = requests[1]?.messages.find((message: { role: string }) => message.role === "system")?.content as string;
      expect(unrelatedSystem).not.toContain("Ember private project memory marker");
    } finally {
      await app.close();
      vi.unstubAllGlobals();
    }
  });

  it("saves model settings and never returns the raw key", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      modelSettingsPath: join(root, "model-settings.json"),
      attachmentRoot: join(root, "attachments")
    });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/model-settings",
      payload: {
        providerId: "deepseek",
        providerName: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1/",
        model: "deepseek-chat",
        apiKey: "sk-test-secret-123456"
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(saved.json().settings.protocol).toBe("openai-chat");
    expect(saved.json().settings.protocol).toBe("openai-chat");
    expect(saved.json().settings.hasApiKey).toBe(true);
    expect(saved.json().settings.apiKeyMasked).toContain("sk-t");
    expect(saved.body).not.toContain("sk-test-secret-123456");

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().chatModel.configured).toBe(true);
    expect(health.body).not.toContain("sk-test-secret-123456");

    const list = await app.inject({ method: "GET", url: "/api/model-settings" });
    const presetIds = list.json().presets.map((preset: { id: string }) => preset.id) as string[];
    expect(presetIds).toContain("dashscope");
    expect(presetIds).not.toContain("siliconflow");
    expect(list.json().presets.map((preset: { protocol: string }) => preset.protocol)).toEqual(
      expect.arrayContaining(["openai-chat", "anthropic-messages", "gemini"])
    );
    expect(list.body).not.toContain("sk-test-secret-123456");
    await app.close();
  });

  it("rejects local model endpoints with a 400 instead of a server error", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      modelSettingsPath: join(root, "model-settings.json"),
      attachmentRoot: join(root, "attachments")
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/model-settings",
      payload: {
        providerName: "Local",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen"
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("LOCAL_MODEL_NOT_MANAGED");
    expect(response.json().message).toContain("本地模型");
    await app.close();
  });

  it("creates and manages conversations", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { title: "测试对话" } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json().settings).toEqual(defaultConversationSettings());

    const renamed = await app.inject({ method: "PATCH", url: `/api/conversations/${id}`, payload: { title: "改名后" } });
    expect(renamed.json().title).toBe("改名后");

    const configured = await app.inject({
      method: "PATCH",
      url: `/api/conversations/${id}`,
      payload: { settings: { executorEnabled: { codex: false }, approvalMode: "full" } }
    });
    expect(configured.json().settings).toEqual(
      mergeConversationSettings(defaultConversationSettings(), { executorEnabled: { codex: false }, approvalMode: "full" })
    );

    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/conversations/${id}`,
      payload: { settings: { approvalMode: "everything" } }
    });
    expect(invalid.statusCode).toBe(400);

    const detail = await app.inject({ method: "GET", url: `/api/conversations/${id}` });
    expect(detail.json().conversation.title).toBe("改名后");
    expect(detail.json().conversation.settings.approvalMode).toBe("full");
    expect(detail.json().messages).toEqual([]);

    const deleted = await app.inject({ method: "DELETE", url: `/api/conversations/${id}` });
    expect(deleted.statusCode).toBe(204);
    const missing = await app.inject({ method: "GET", url: `/api/conversations/${id}` });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("forces full permission on every conversation regardless of saved defaults", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files"),
      executorSettingsPath: join(root, "executor-settings.json")
    });
    const oldConversation = await app.inject({ method: "POST", url: "/api/conversations", payload: { title: "旧对话" } });
    expect(oldConversation.json().settings.approvalMode).toBe("full");

    const saved = await app.inject({
      method: "PUT",
      url: "/api/executor-settings",
      payload: { defaultApprovalMode: "full" }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.defaultApprovalMode).toBe("full");

    const newConversation = await app.inject({ method: "POST", url: "/api/conversations", payload: { title: "新对话" } });
    expect(newConversation.json().settings.approvalMode).toBe("full");

    const oldDetail = await app.inject({ method: "GET", url: `/api/conversations/${oldConversation.json().id}` });
    expect(oldDetail.json().conversation.settings.approvalMode).toBe("full");
    await app.close();
  });

  it("resumes waiting-input tasks when the conversation switches to full permission", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const service = new HearthService(store);
    const conversation = store.createConversation("自动继续", defaultConversationSettings());
    const task = service.createTask({ title: "Publish PR", goal: "Publish a reviewed pull request", conversationId: conversation.id });
    service.updateTask(task.id, { status: "running" });
    service.updateTask(task.id, { status: "waiting_input", nextAction: "等待你补充信息", error: null });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/conversations/${conversation.id}`,
      payload: { settings: { approvalMode: "full" } }
    });
    expect(response.statusCode).toBe(200);
    const resumed = store.getTask(task.id);
    expect(resumed?.status).toBe("queued");
    expect(resumed?.pendingInput).toContain("完全权限");
    await app.close();
  });

  it("merges executor settings patches without dropping fields", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files"),
      executorSettingsPath: join(root, "executor-settings.json")
    });

    const concurrency = await app.inject({
      method: "PUT",
      url: "/api/executor-settings",
      payload: { concurrency: { codex: 2 } }
    });
    expect(concurrency.statusCode).toBe(200);
    expect(concurrency.json().settings.concurrency).toEqual(
      expect.objectContaining({ native: 3, codex: 2, "deepseek-harness": 3 })
    );

    const command = await app.inject({
      method: "PUT",
      url: "/api/executor-settings",
      payload: { executors: { codex: { command: "codex-custom" } } }
    });
    expect(command.statusCode).toBe(200);

    const auth = await app.inject({
      method: "PUT",
      url: "/api/executor-settings",
      payload: { executors: { codex: { authMode: "pat" } }, preferredExecutorId: "codex" }
    });
    expect(auth.statusCode).toBe(200);
    expect(auth.json().settings.preferredExecutorId).toBe("codex");

    const view = await app.inject({ method: "GET", url: "/api/executor-settings" });
    expect(view.json().settings.executors.codex).toEqual({ command: "codex-custom", authMode: "pat" });
    expect(view.json().settings.concurrency.codex).toBe(2);
    await app.close();
  }, 30_000);

  it("accepts empty executor fields and exposes conversation defaults", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files"),
      executorSettingsPath: join(root, "executor-settings.json")
    });

    const seeded = await app.inject({
      method: "PUT",
      url: "/api/executor-settings",
      payload: { executors: { codex: { command: "codex-custom" } } }
    });
    expect(seeded.statusCode).toBe(200);

    const empty = await app.inject({
      method: "PUT",
      url: "/api/executor-settings",
      payload: {
        defaultApprovalMode: "full",
        preferredExecutorId: "native",
        executors: { codex: { command: "", executablePath: "  " } }
      }
    });
    expect(empty.statusCode, empty.body).toBe(200);

    const view = await app.inject({ method: "GET", url: "/api/executor-settings" });
    expect(view.json().settings.executors.codex).toEqual({ command: "codex-custom" });
    expect(view.json().settings.defaultApprovalMode).toBe("full");

    const defaults = await app.inject({ method: "GET", url: "/api/conversation-defaults" });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().settings.preferredExecutorId).toBe("native");
    expect(defaults.json().settings.approvalMode).toBe("full");
    await app.close();
  });

  it("lists every executor with runtime health", async () => {
    const previous = process.env.HEARTH_EXECUTOR_DETECT;
    process.env.HEARTH_EXECUTOR_DETECT = "off";
    try {
      const app = await buildServer({
        store,
        serveWeb: false,
        modelSettingsPath: join(root, "settings.json"),
        attachmentRoot: join(root, "files"),
        executorSettingsPath: join(root, "executor-settings.json")
      });
      const listed = await app.inject({ method: "GET", url: "/api/executors" });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().executors.map((executor: { id: string }) => executor.id)).toEqual([
        "native", "codex", "deepseek-harness"
      ]);
      expect(listed.json().executors.every((executor: { health: unknown }) => Boolean(executor.health))).toBe(true);
      expect(listed.json().preferredExecutorId).toBe("native");
      const native = listed.json().executors.find((executor: { id: string }) => executor.id === "native");
      expect(native.health.canRun).toBe(false);
      expect(native.health.issues.join(" ")).toContain("聊天模型");

      const unbound = await app.inject({ method: "GET", url: "/api/executors" });
      expect(unbound.json().executors.find((executor: { id: string }) => executor.id === "deepseek-harness").health.issues.join(" ")).toContain("绑定模型");

      const probed = await app.inject({ method: "POST", url: "/api/executors/native/probe" });
      expect(probed.statusCode).toBe(200);
      expect(probed.json().ok).toBe(false);
      expect(probed.json().health.state).toBe("unconfigured");

      const unknown = await app.inject({ method: "POST", url: "/api/executors/unknown/probe" });
      expect(unknown.statusCode).toBe(404);
      await app.close();
    } finally {
      if (previous === undefined) delete process.env.HEARTH_EXECUTOR_DETECT;
      else process.env.HEARTH_EXECUTOR_DETECT = previous;
    }
  });

  it("routes an execution request to a task and keeps the conversation link", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    await bindProfile(app, "native", await createTestProfile(app));
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "帮我写一份本周工作周报", settings: { executionMode: "quick" } }
    });
    expect(response.statusCode).toBe(200);
    const events = parseSse(response.body);
    const dispatchedTask = events.find((event) => event.event === "task")?.data.task;
    expect(dispatchedTask.executionMode).toBe("quick");
    expect(store.getTask(dispatchedTask.id)?.executionMode).toBe("quick");
    const routing = events.find((event) => event.event === "routing");
    expect(routing?.data.action).toBe("task");
    const taskEvent = events.find((event) => event.event === "task");
    expect(taskEvent?.data.task.id).toContain("CUSTOM-");
    expect(taskEvent?.data.task.conversationId).toBeTruthy();
    expect(taskEvent?.data.task.executorId).toBe("native");
    expect(events.some((event) => event.event === "done")).toBe(true);

    const tasks = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(tasks.json().tasks).toHaveLength(1);
    expect(tasks.json().tasks[0].summary.phase).toBe("排队中");

    const detail = await app.inject({ method: "GET", url: `/api/conversations/${taskEvent?.data.conversationId}` });
    expect(detail.json().tasks).toHaveLength(1);
    expect(detail.json().tasks[0].executorId).toBe("native");
    store.createChatMessage({ id: "draft-context", conversationId: taskEvent!.data.conversationId, role: "assistant", content: "主题：12月初回国\n妈，我12月初回国。", taskId: null, attachments: [], createdAt: new Date().toISOString() });
    const forced = await app.inject({ method: "POST", url: "/api/chat", payload: { conversationId: taskEvent!.data.conversationId, message: "再加一句这是 Hearth 写的", routeMode: "task" } });
    const forcedTask = parseSse(forced.body).find((event) => event.event === "task")?.data.task;
    expect(forcedTask).toBeDefined();
    expect(forcedTask.inputs.some((input: { kind: string; value?: string }) => input.kind === "text" && input.value?.includes("妈，我12月初回国"))).toBe(true);
    await app.close();
  });

  it("dispatches engineering work to the native executor without a pre-execution proposal", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    await bindProfile(app, "native", await createTestProfile(app));
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "帮我修复项目里的 TypeScript 错误" }
    });
    const events = parseSse(response.body);
    expect(events.some((event) => event.event === "proposal")).toBe(false);
    const taskEvent = events.find((event) => event.event === "task");
    const task = taskEvent?.data.task;
    expect(task.executorId).toBe("native");
    expect(task.taskKind).toBe("workspace");
    expect(task.inputs.some((input: { kind: string }) => input.kind === "text")).toBe(true);

    const detail = await app.inject({ method: "GET", url: `/api/conversations/${taskEvent?.data.conversationId}` });
    expect(detail.json().tasks).toHaveLength(1);
    expect(detail.json().proposals).toHaveLength(0);
    await app.close();
  });

  it("uploads an attachment and routes it into a task input", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    await bindProfile(app, "native", await createTestProfile(app));
    const form = new FormData();
    form.append("file", new Blob(["会议记录正文"], { type: "text/plain" }), "notes.txt");
    const request = new Request("http://localhost/api/attachments", { method: "POST", body: form });
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      payload: Buffer.from(await request.arrayBuffer())
    });
    expect(uploaded.statusCode).toBe(200);
    const attachment = uploaded.json().attachments[0];
    expect(attachment.name).toBe("notes.txt");
    expect(fs.existsSync(join(root, "files", attachment.id + ".txt"))).toBe(true);

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "帮我总结这个附件", attachments: [attachment] }
    });
    const task = parseSse(response.body).find((event) => event.event === "task")?.data.task;
    expect(task.inputs.some((input: { kind: string; value: string }) => input.kind === "file" && input.value.endsWith(".txt"))).toBe(true);
    await app.close();
  });

  it("serves uploaded attachments inline for preview without executing markup", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const textForm = new FormData();
    textForm.append("file", new Blob(["会议记录正文"], { type: "text/plain" }), "notes.txt");
    const textRequest = new Request("http://localhost/api/attachments", { method: "POST", body: textForm });
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { "content-type": textRequest.headers.get("content-type") ?? "" },
      payload: Buffer.from(await textRequest.arrayBuffer())
    });
    const attachment = uploaded.json().attachments[0];
    const preview = await app.inject({ method: "GET", url: `/api/attachments/${attachment.id}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toContain("text/plain");
    expect(preview.headers["content-disposition"]).toContain("inline");
    expect(preview.body).toBe("会议记录正文");

    const htmlForm = new FormData();
    htmlForm.append("file", new Blob(["<script>alert(1)</script>"], { type: "text/html" }), "page.html");
    const htmlRequest = new Request("http://localhost/api/attachments", { method: "POST", body: htmlForm });
    const htmlUpload = await app.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { "content-type": htmlRequest.headers.get("content-type") ?? "" },
      payload: Buffer.from(await htmlRequest.arrayBuffer())
    });
    const htmlPreview = await app.inject({ method: "GET", url: `/api/attachments/${htmlUpload.json().attachments[0].id}` });
    expect(htmlPreview.headers["content-type"]).toContain("text/plain");

    const missing = await app.inject({ method: "GET", url: "/api/attachments/not-a-uuid" });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
  it("routes an attachment-only message into a task instead of asking for a chat model", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    await bindProfile(app, "native", await createTestProfile(app));
    const form = new FormData();
    form.append("file", new Blob(["附件正文"], { type: "text/plain" }), "notes.txt");
    const request = new Request("http://localhost/api/attachments", { method: "POST", body: form });
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      payload: Buffer.from(await request.arrayBuffer())
    });
    const attachment = uploaded.json().attachments[0];

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { attachments: [attachment] }
    });
    const events = parseSse(response.body);
    expect(events.some((event) => event.event === "error" && event.data.code === "MODEL_NOT_CONFIGURED")).toBe(false);
    const task = events.find((event) => event.event === "task")?.data.task;
    expect(task).toBeTruthy();
    expect(task.inputs.some((input: { kind: string; value: string }) => input.kind === "file" && input.value.endsWith(".txt"))).toBe(true);
    await app.close();
  });

  it("does not reroute a selected Codex executor that has a bound model", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const created = await app.inject({
      method: "POST",
      url: "/api/model-profiles",
      payload: {
        name: "Codex test",
        providerId: "custom",
        providerName: "Responses",
        protocol: "openai-responses",
        baseUrl: "https://responses.example.com/v1",
        model: "responses-model",
        apiKey: "test-key"
      }
    });
    expect(created.statusCode, created.body).toBe(201);
    await bindProfile(app, "codex", created.json().profile.id);
    await app.inject({ method: "PUT", url: "/api/executor-settings", payload: { preferredExecutorId: "codex" } });

    const conversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: {
        title: "Codex 绑定",
        settings: { preferredExecutorId: "codex", executorEnabled: { codex: true } }
      }
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { conversationId: conversation.json().id, message: "帮我修复项目里的 TypeScript 错误" }
    });
    const events = parseSse(response.body);
    const routing = events.find((event) => event.event === "routing")?.data;
    expect(routing.preferredExecutorId).toBe("codex");
    expect(routing.reroutedFrom).toBeUndefined();
    expect(events.find((event) => event.event === "task")?.data.task.executorId).toBe("codex");
    await app.close();
  });

  it("locks a selected native executor for GitHub work instead of rerouting", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    await bindProfile(app, "native", await createTestProfile(app));
    const conversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: {
        title: "Native GitHub 锁定",
        settings: { preferredExecutorId: "native", executorEnabled: { native: true, codex: true } }
      }
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: conversation.json().id,
        message: "请你审核我的 GitHub 仓库中目前开着的 PR，列出需要回复修改或 rebase 的"
      }
    });
    const events = parseSse(response.body);
    const routing = events.find((event) => event.event === "routing")?.data;
    expect(routing.preferredExecutorId).toBe("native");
    expect(routing.lockedExecutorId).toBe("native");
    expect(routing.reroutedFrom).toBeUndefined();
    const task = events.find((event) => event.event === "task")?.data.task;
    expect(task.executorId).toBe("native");
    expect(task.networkHosts).toEqual(expect.arrayContaining(["github.com", "api.github.com"]));
    await app.close();
  });

  it("refuses a task when the locked executor is disabled instead of rerouting", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const conversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: {
        title: "锁定但关闭",
        settings: { preferredExecutorId: "native", executorEnabled: { native: false, codex: true } }
      }
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { conversationId: conversation.json().id, message: "帮我修复项目里的 TypeScript 错误" }
    });
    const events = parseSse(response.body);
    const routing = events.find((event) => event.event === "routing")?.data;
    expect(routing.lockedExecutorId).toBe("native");
    expect(routing.reroutedFrom).toBeUndefined();
    expect(events.some((event) => event.event === "task")).toBe(false);
    expect(events.find((event) => event.event === "done")?.data.content).toContain("已锁定 Hearth 原生执行器");
    await app.close();
  });

  it("keeps a method question in chat when no router model is configured", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "怎么测试这个函数" }
    });
    const events = parseSse(response.body);
    expect(events.find((event) => event.event === "routing")?.data.action).toBe("chat");
    expect(events.some((event) => event.event === "task")).toBe(false);
    expect(events.find((event) => event.event === "error")?.data.code).toBe("MODEL_NOT_CONFIGURED");
    expect(events.find((event) => event.event === "done")?.data.content).toContain("还没有配置聊天模型");
    await app.close();
  });

  it("applies per-message settings to an existing conversation without persisting them", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    await bindProfile(app, "native", await createTestProfile(app));
    const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { title: "设置覆盖" } });
    const conversation = created.json();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: conversation.id,
        message: "帮我修复项目里的 TypeScript 错误",
        settings: { preferredExecutorId: "native", executorEnabled: { codex: false } }
      }
    });
    const events = parseSse(response.body);
    const routing = events.find((event) => event.event === "routing")?.data;
    expect(routing.preferredExecutorId).toBe("native");
    const task = events.find((event) => event.event === "task")?.data.task;
    expect(task.executorId).toBe("native");

    const stored = await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}` });
    expect(stored.json().conversation.settings.preferredExecutorId).toBe("native");
    await app.close();
  });

  it("keeps a pasted URL in the directly dispatched task", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    await bindProfile(app, "native", await createTestProfile(app));
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "帮我总结这个网页 https://example.com/article" }
    });
    const events = parseSse(response.body);
    expect(events.some((event) => event.event === "proposal")).toBe(false);
    const task = events.find((event) => event.event === "task")?.data.task;
    expect(task.networkHosts).toContain("example.com");
    expect(task.inputs.some((input: { kind: string; value: string }) => input.kind === "url" && input.value === "https://example.com/article")).toBe(true);
    await app.close();
  });

  it("keeps the selected executor instead of rerouting when another executor is disabled", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    await bindProfile(app, "native", await createTestProfile(app));
    const conversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "只开 Native", settings: { executorEnabled: { codex: false } } }
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { conversationId: conversation.json().id, message: "帮我修复项目里的 TypeScript 错误" }
    });
    const events = parseSse(response.body);
    expect(events.find((event) => event.event === "routing")?.data.reroutedFrom).toBeUndefined();
    const taskEvent = events.find((event) => event.event === "task");
    expect(taskEvent?.data.task.executorId).toBe("native");
    await app.close();
  });

  it("uses the global preferred executor for new conversations", async () => {
    const executorSettingsPath = join(root, "executor-settings.json");
    const app = await buildServer({
      store,
      serveWeb: false,
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files"),
      executorSettingsPath
    });
    await bindProfile(app, "native", await createTestProfile(app));
    await bindProfile(app, "codex", await createTestProfile(app, "Codex test", "openai-responses"));
    const saved = await app.inject({
      method: "PUT",
      url: "/api/executor-settings",
      payload: { preferredExecutorId: "codex" }
    });
    expect(saved.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "帮我写一份本周工作周报" }
    });
    const events = parseSse(response.body);
    const routing = events.find((event) => event.event === "routing")?.data;
    expect(routing.preferredExecutorId).toBe("codex");
    expect(routing.plan.executorId).toBe("codex");
    expect(events.find((event) => event.event === "task")?.data.task.executorId).toBe("codex");
    await app.close();
  });

  it("uses the global preference even when an old conversation saved another executor", async () => {
    const executorSettingsPath = join(root, "executor-settings.json");
    const app = await buildServer({
      store,
      serveWeb: false,
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files"),
      executorSettingsPath
    });
    await bindProfile(app, "native", await createTestProfile(app));
    const conversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "旧选择 Codex", settings: { preferredExecutorId: "codex" } }
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: conversation.json().id,
        message: "帮我审查这个 PR https://github.com/acme/repo/pull/12 并生成 result.md"
      }
    });
    const events = parseSse(response.body);
    const routing = events.find((event) => event.event === "routing")?.data;
    expect(routing.preferredExecutorId).toBe("native");
    expect(routing.lockedExecutorId).toBe("native");
    expect(routing.reroutedFrom).toBeUndefined();
    expect(events.find((event) => event.event === "task")?.data.task.executorId).toBe("native");
    await app.close();
  });

  it("does not create a task when the explicitly selected DeepSeek Harness is still unverified", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":"chat","title":"","reason":"误判为问答"}' } }]
    }), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const app = await buildServer({
        store,
        serveWeb: false,
        modelSettingsPath: join(root, "settings.json"),
        attachmentRoot: join(root, "files"),
        executorSettingsPath: join(root, "executor-settings.json")
      });
      const saved = await app.inject({
        method: "PUT",
        url: "/api/model-settings",
        payload: {
          providerId: "custom",
          providerName: "Router",
          baseUrl: "https://router.example.com/v1",
          model: "router-model",
          apiKey: "test-key"
        }
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const registry = await app.inject({ method: "GET", url: "/api/model-registry" });
      await bindProfile(app, "deepseek-harness", registry.json().chatProfileId);
      await app.inject({ method: "PUT", url: "/api/executor-settings", payload: { preferredExecutorId: "deepseek-harness" } });
      const conversation = await app.inject({
        method: "POST",
        url: "/api/conversations",
        payload: {
          title: "DSH 审核",
          settings: { preferredExecutorId: "deepseek-harness", executorEnabled: { "deepseek-harness": true } }
        }
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          conversationId: conversation.json().id,
          message: "请你审核我的 GitHub 仓库中目前开着的 PR，列出需要回复修改或 rebase 的"
        }
      });
      const events = parseSse(response.body);
      const routing = events.find((event) => event.event === "routing")?.data;
      expect(routing.action).toBe("task");
      expect(routing.preferredExecutorId).toBe("deepseek-harness");
      expect(events.find((event) => event.event === "task")).toBeUndefined();
      const done = events.find((event) => event.event === "done")?.data as { content?: string } | undefined;
      expect(done?.content).toContain("任务没有派出");
      expect(done?.content).toMatch(/尚未验证|未安装/);
      await app.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not create tasks when both executors are disabled but leaves chat available", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const conversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "全关", settings: { executorEnabled: { native: false, codex: false } } }
    });
    const conversationId = conversation.json().id as string;

    const taskResponse = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { conversationId, message: "帮我写一份本周工作周报" }
    });
    const taskEvents = parseSse(taskResponse.body);
    expect(taskEvents.some((event) => event.event === "task")).toBe(false);
    const done = taskEvents.find((event) => event.event === "done")?.data;
    expect(done.content).toContain("已锁定 Hearth 原生执行器");
    expect((await app.inject({ method: "GET", url: "/api/tasks" })).json().tasks).toHaveLength(0);

    const chatResponse = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { conversationId, message: "你好" }
    });
    const chatEvents = parseSse(chatResponse.body);
    expect(chatEvents.find((event) => event.event === "routing")?.data.action).toBe("chat");
    expect(chatEvents.some((event) => event.event === "task")).toBe(false);
    expect(chatEvents.find((event) => event.event === "error")?.data.code).toBe("MODEL_NOT_CONFIGURED");
    await app.close();
  });

  it("injects confirmed memories into direct chat and reports them", async () => {
    const modelRequests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      const messages = Array.isArray(body.messages) ? body.messages as Array<{ content?: string }> : [];
      // Background model discovery is not a chat completion request.
      if (!Array.isArray(body.messages)) return new Response(JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" }
      });
      if (messages.some((message) => message.content?.includes("意图路由器"))) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: '{"action":"chat","title":"","reason":"普通问答"}' } }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      modelRequests.push(body);
      return new Response(
        'data: {"choices":[{"delta":{"content":"项目代号是 Ember。"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }));
    try {
      const app = await buildServer({
        store,
        serveWeb: false,
        masterKeyPath: join(root, "master.key"),
        modelSettingsPath: join(root, "settings.json"),
        attachmentRoot: join(root, "files")
      });
      const saved = await app.inject({
        method: "PUT",
        url: "/api/model-settings",
        payload: {
          providerId: "custom",
          providerName: "Test",
          baseUrl: "https://models.example.com/v1",
          model: "test-model",
          apiKey: "test-key"
        }
      });
      expect(saved.statusCode, saved.body).toBe(200);

      const created = await app.inject({
        method: "POST",
        url: "/api/memory",
        payload: {
          kind: "project",
          content: "项目代号是 Ember，发布窗口在十一月。",
          subjectKey: "project.ember",
          scope: "global",
          source: { type: "user", id: null, label: "用户说明", excerpt: null },
          confidence: "high",
          sensitivity: "normal",
          allowRecall: true
        }
      });
      expect(created.statusCode, created.body).toBe(201);
      const confirmed = await app.inject({
        method: "POST",
        url: `/api/memory/${created.json().id as string}/confirm`
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);

      const response = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: { message: "我们项目的发布窗口是什么时候？" }
      });
      const events = parseSse(response.body);
      expect(events.find((event) => event.event === "memory")?.data.count).toBe(1);
      expect(events.find((event) => event.event === "error")).toBeUndefined();
      const memoryRequests = modelRequests.filter((request) => {
        const messages = Array.isArray(request.messages) ? request.messages as Array<{ content?: string }> : [];
        return messages.some((message) => message.content?.includes("<hearth-memories"));
      });
      expect(memoryRequests).toHaveLength(1);
      const system = (memoryRequests[0]?.messages as Array<{ content: string }>)[0]?.content ?? "";
      expect(system).toContain("<hearth-memories");
      expect(system).toContain("Ember");
      await app.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("answers a question about a pasted URL instead of dispatching a task", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "介绍一下这个 GitHub 项目，根据实际代码告诉我 https://github.com/openai/codex" }
    });
    const events = parseSse(response.body);
    expect(events.find((event) => event.event === "routing")?.data.action).toBe("chat");
    expect(events.some((event) => event.event === "task")).toBe(false);
    await app.close();
  });

  it("persists a visible assistant message when the chat model is not configured", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const response = await app.inject({ method: "POST", url: "/api/chat", payload: { message: "你好" } });
    const events = parseSse(response.body);
    const error = events.find((event) => event.event === "error");
    expect(error?.data.code).toBe("MODEL_NOT_CONFIGURED");
    const done = events.find((event) => event.event === "done")?.data;
    expect(done.content).toContain("还没有配置聊天模型");
    const conversationId = events.find((event) => event.event === "conversation")?.data.id;
    const stored = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}` });
    expect(stored.json().messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
    expect(stored.json().messages[1].content).toContain("还没有配置聊天模型");
    await app.close();
  });

  it("routes an existing local file reference into a task that receives the file", async () => {
    const file = join(root, "handbook.txt");
    writeFileSync(file, "这是本地文件内容", "utf8");
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    await bindProfile(app, "native", await createTestProfile(app));
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: `${file}这个文件主要讲了什么` }
    });
    const events = parseSse(response.body);
    expect(events.find((event) => event.event === "routing")?.data.action).toBe("task");
    const task = events.find((event) => event.event === "task")?.data.task;
    expect(task).toBeTruthy();
    expect(task.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "file", value: file }),
      expect.objectContaining({ kind: "workspace" })
    ]));
    expect(events.find((event) => event.event === "done")?.data.taskId).toBe(task.id);
    await app.close();
  });

  it("filters internal artifacts out of user deliverables", () => {
    const base = {
      taskId: "task-1", runId: "run-1", absolutePath: "C:/tmp/file", sha256: "a".repeat(64),
      bytes: 12, createdAt: "2026-11-06T00:00:00.000Z"
    };
    const deliverables = visibleDeliverables([
      { ...base, id: "1", relativePath: "result.md", mimeType: "text/markdown" },
      { ...base, id: "2", relativePath: "run-manifest.json", mimeType: "application/json" },
      { ...base, id: "3", relativePath: "pr-preview.json", mimeType: "application/json" },
      { ...base, id: "4", relativePath: "inputs/02-file.pdf", mimeType: "application/pdf" },
      { ...base, id: "5", relativePath: "manifest.json", mimeType: "application/json" }
    ]);
    expect(deliverables.map((item) => item.name)).toEqual(["result.md", "manifest.json"]);

    const filtered = visibleDeliverables(
      [
        { ...base, id: "1", relativePath: "result.md", mimeType: "text/markdown" },
        { ...base, id: "2", relativePath: "manifest.json", mimeType: "application/json" },
        { ...base, id: "3", relativePath: "reports/summary.json", mimeType: "application/json" },
        { ...base, id: "4", relativePath: "reports/summary.md", mimeType: "text/markdown" }
      ],
      ["reports"]
    );
    expect(filtered.map((item) => item.name)).toEqual(["result.md", "summary.json", "summary.md"]);

    const jsonDeliverable = visibleDeliverables(
      [{ ...base, id: "1", relativePath: "manifest.json", mimeType: "application/json" }],
      ["manifest.json"]
    );
    expect(jsonDeliverable.map((item) => item.name)).toEqual(["manifest.json"]);
  });
});

function parseSse(body: string): { event: string; data: any }[] {
  return body
    .split(/\n\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let event = "message";
      const lines: string[] = [];
      for (const line of block.split(/\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) lines.push(line.slice(5).trim());
      }
      return { event, data: JSON.parse(lines.join("\n") || "{}") };
    });
}


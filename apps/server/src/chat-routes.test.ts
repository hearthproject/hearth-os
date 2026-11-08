import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { defaultConversationSettings, mergeConversationSettings } from "@hearth/core";
import { buildServer } from "./app.ts";
import { visibleDeliverables } from "./service.ts";

async function createTestProfile(app: FastifyInstance, name = "Test model"): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/model-profiles",
    payload: {
      name,
      providerId: "custom",
      providerName: "Test provider",
      protocol: "openai-chat",
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

  it("applies the global approval default only to new conversations", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files"),
      executorSettingsPath: join(root, "executor-settings.json")
    });
    const oldConversation = await app.inject({ method: "POST", url: "/api/conversations", payload: { title: "旧对话" } });
    expect(oldConversation.json().settings.approvalMode).toBe("necessary");

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
    expect(oldDetail.json().conversation.settings.approvalMode).toBe("necessary");
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
      payload: { concurrency: { qoder: 2 } }
    });
    expect(concurrency.statusCode).toBe(200);
    expect(concurrency.json().settings.concurrency).toEqual(
      expect.objectContaining({ native: 3, codex: 3, hermes: 3, qoder: 2, kimi: 3 })
    );

    const command = await app.inject({
      method: "PUT",
      url: "/api/executor-settings",
      payload: { executors: { qoder: { command: "qodercli" } } }
    });
    expect(command.statusCode).toBe(200);

    const auth = await app.inject({
      method: "PUT",
      url: "/api/executor-settings",
      payload: { executors: { qoder: { authMode: "pat" } }, preferredExecutorId: "kimi" }
    });
    expect(auth.statusCode).toBe(200);
    expect(auth.json().settings.preferredExecutorId).toBe("kimi");

    const view = await app.inject({ method: "GET", url: "/api/executor-settings" });
    expect(view.json().settings.executors.qoder).toEqual({ command: "qodercli", authMode: "pat" });
    expect(view.json().settings.concurrency.qoder).toBe(2);
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
      payload: { executors: { qoder: { command: "qodercli" } } }
    });
    expect(seeded.statusCode).toBe(200);

    const empty = await app.inject({
      method: "PUT",
      url: "/api/executor-settings",
      payload: {
        defaultApprovalMode: "full",
        preferredExecutorId: "native",
        executors: { qoder: { command: "", executablePath: "  " }, hermes: { command: "" } },
        hermesCommand: " "
      }
    });
    expect(empty.statusCode, empty.body).toBe(200);

    const view = await app.inject({ method: "GET", url: "/api/executor-settings" });
    expect(view.json().settings.executors.qoder).toEqual({ command: "qodercli" });
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
        "native", "codex", "deepseek-harness", "hermes", "qoder", "workbuddy", "kimi"
      ]);
      expect(listed.json().executors.every((executor: { health: unknown }) => Boolean(executor.health))).toBe(true);
      expect(listed.json().preferredExecutorId).toBeNull();
      const native = listed.json().executors.find((executor: { id: string }) => executor.id === "native");
      expect(native.health.canRun).toBe(false);
      expect(native.health.issues.join(" ")).toContain("聊天模型");

      const unbound = await app.inject({ method: "GET", url: "/api/executors" });
      expect(unbound.json().executors.find((executor: { id: string }) => executor.id === "deepseek-harness").health.issues.join(" ")).toContain("绑定模型");

      const probed = await app.inject({ method: "POST", url: "/api/executors/native/probe" });
      expect(probed.statusCode).toBe(200);
      expect(probed.json().ok).toBe(true);

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
      payload: { message: "帮我写一份本周工作周报" }
    });
    expect(response.statusCode).toBe(200);
    const events = parseSse(response.body);
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
    await app.close();
  });

  it("dispatches engineering work to codex without a pre-execution proposal", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "帮我修复项目里的 TypeScript 错误" }
    });
    const events = parseSse(response.body);
    expect(events.some((event) => event.event === "proposal")).toBe(false);
    const taskEvent = events.find((event) => event.event === "task");
    const task = taskEvent?.data.task;
    expect(task.executorId).toBe("codex");
    expect(task.taskKind).toBe("workspace");
    expect(task.inputs.some((input: { kind: string }) => input.kind === "text")).toBe(true);

    const detail = await app.inject({ method: "GET", url: `/api/conversations/${taskEvent?.data.conversationId}` });
    expect(detail.json().tasks).toHaveLength(1);
    expect(detail.json().proposals).toHaveLength(0);
    await app.close();
  });

  it("uploads an attachment and routes it into a task input", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
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

  it("routes an attachment-only message into a task instead of asking for a chat model", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
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
    expect(stored.json().conversation.settings.preferredExecutorId).toBeNull();
    await app.close();
  });

  it("keeps a pasted URL in the directly dispatched task", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
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

  it("reroutes a disabled executor to the other enabled executor", async () => {
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
    expect(events.find((event) => event.event === "routing")?.data.reroutedFrom).toBe("codex");
    const taskEvent = events.find((event) => event.event === "task");
    expect(taskEvent?.data.task.executorId).toBe("native");
    expect(taskEvent?.data.message.content).toContain("已自动改由");
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

  it("lets a conversation override the global preference and falls back on capability gaps", async () => {
    const executorSettingsPath = join(root, "executor-settings.json");
    const app = await buildServer({
      store,
      serveWeb: false,
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files"),
      executorSettingsPath
    });
    await app.inject({
      method: "PUT",
      url: "/api/executor-settings",
      payload: { preferredExecutorId: "codex" }
    });
    const conversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Native 优先", settings: { preferredExecutorId: "native" } }
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
    expect(routing.reroutedFrom).toBe("native");
    expect(events.find((event) => event.event === "task")?.data.task.executorId).toBe("codex");
    await app.close();
  });

  it("falls back to the task-matched executor when the preferred external executor is unavailable", async () => {
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
      const conversation = await app.inject({
        method: "POST",
        url: "/api/conversations",
        payload: {
          title: "Qoder 优先",
          settings: { preferredExecutorId: "qoder", executorEnabled: { qoder: true } }
        }
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: { conversationId: conversation.json().id, message: "帮我修复项目里的 TypeScript 错误" }
      });
      const events = parseSse(response.body);
      const routing = events.find((event) => event.event === "routing")?.data;
      expect(routing.preferredExecutorId).toBe("qoder");
      expect(routing.reroutedFrom).toBe("qoder");
      expect(events.find((event) => event.event === "task")?.data.task.executorId).toBe("codex");
      await app.close();
    } finally {
      if (previous === undefined) delete process.env.HEARTH_EXECUTOR_DETECT;
      else process.env.HEARTH_EXECUTOR_DETECT = previous;
    }
  });

  it("uses the explicitly selected executor when the router misclassifies GitHub PR work as chat", async () => {
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
      expect(events.find((event) => event.event === "task")?.data.task.executorId).toBe("deepseek-harness");
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
      payload: { title: "全关", settings: { executorEnabled: { native: false, codex: false, hermes: false } } }
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
    expect(done.content).toContain("所有执行器都已关闭或不可用");
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
      expect(modelRequests).toHaveLength(1);
      const system = (modelRequests[0]?.messages as Array<{ content: string }>)[0]?.content ?? "";
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

  it("explains missing chat model configuration instead of hanging", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const response = await app.inject({ method: "POST", url: "/api/chat", payload: { message: "你好" } });
    const events = parseSse(response.body);
    const error = events.find((event) => event.event === "error");
    expect(error?.data.code).toBe("MODEL_NOT_CONFIGURED");
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

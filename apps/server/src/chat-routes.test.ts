import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { defaultConversationSettings, mergeConversationSettings, type LibrarySearchHit } from "@hearth/core";
import { buildServer } from "./app.ts";
import { libraryHitAllowedForConversation } from "./chat-routes.ts";
import { HearthService, visibleDeliverables } from "./service.ts";

async function createTestProfile(
  app: FastifyInstance,
  name = "Test model",
  protocol = "openai-chat",
  model = "test-model"
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/model-profiles",
    payload: {
      name,
      providerId: "custom",
      providerName: "Test provider",
      protocol,
      baseUrl: "https://models.example.com/v1",
      model,
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

describe("unified harness API", () => {
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

  it("routes drafts and revisions through one harness even when a legacy client says chat", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    await bindProfile(app, "native", await createTestProfile(app));
    const first = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        message: "我要跟 lecture 老师请假，帮我拟一封请假信，就说我感冒了不舒服，明天能来",
        routeMode: "chat",
        settings: { preferredExecutorId: "native", executionMode: "quick" }
      }
    });
    const firstEvents = parseSse(first.body);
    expect(firstEvents.find((event) => event.event === "routing")?.data.action).toBe("task");
    expect(firstEvents.find((event) => event.event === "error")).toBeUndefined();
    const conversationId = firstEvents.find((event) => event.event === "conversation")!.data.id as string;
    const firstConversation = firstEvents.find((event) => event.event === "conversation")!.data;
    expect(firstConversation.title).not.toBe("新对话");

    const second = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { conversationId, routeMode: "chat", message: "跟老师说我叫小兰" }
    });
    expect(parseSse(second.body).find((event) => event.event === "routing")?.data.action).toBe("task");
    const third = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { conversationId, message: "再加一句，这是由 Hearth agent 发送的邮件" }
    });
    expect(parseSse(third.body).find((event) => event.event === "routing")?.data.action).toBe("task");
    const forcedChat = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { conversationId, routeMode: "chat", message: "帮我运行项目测试" }
    });
    const forcedEvents = parseSse(forcedChat.body);
    expect(forcedEvents.find((event) => event.event === "routing")?.data.action).toBe("task");
    expect(forcedEvents.some((event) => event.event === "error")).toBe(false);
    expect(store.listTasks()).toHaveLength(4);
    expect(store.listTasks().every((task) => task.conversationId === conversationId)).toBe(true);
    expect(store.getConversation(conversationId)?.title).not.toBe("新对话");
    await app.close();
  });

  it("recalls project-scoped memory inside the same harness without leaking it to unrelated sessions", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      masterKeyPath: join(root, "master.key"),
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files")
    });
    try {
      await bindProfile(app, "native", await createTestProfile(app));
      const created = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Ember", path: root } });
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
      await app.inject({ method: "POST", url: `/api/memory/${memory.json().id}/confirm` });
      const projectConversation = store.createConversation("Ember session", defaultConversationSettings(), projectId);
      const unrelatedConversation = store.createConversation("Other session", defaultConversationSettings());

      const projectChat = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: { conversationId: projectConversation.id, routeMode: "chat", message: "What should I remember?" }
      });
      const projectEvents = parseSse(projectChat.body);
      expect(projectEvents.find((event) => event.event === "routing")?.data.action).toBe("task");
      const projectTask = projectEvents.find((event) => event.event === "task")?.data.task;
      const projectInput = projectTask.inputs.find((input: { kind: string }) => input.kind === "text")?.value as string;
      expect(projectInput).toContain("Ember private project memory marker");
      expect(projectInput).toContain("Ember");
      expect(projectInput).toContain(root.replace(/\\/g, "\\"));
      expect(projectTask.permissions).toMatchObject({ approvalMode: "full", fullAccess: true, sandboxMode: "danger-full-access" });

      const unrelatedChat = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: { conversationId: unrelatedConversation.id, routeMode: "chat", message: "What should I remember?" }
      });
      const unrelatedEvents = parseSse(unrelatedChat.body);
      expect(unrelatedEvents.find((event) => event.event === "routing")?.data.action).toBe("task");
      const unrelatedTask = unrelatedEvents.find((event) => event.event === "task")?.data.task;
      const unrelatedInput = unrelatedTask.inputs.find((input: { kind: string }) => input.kind === "text")?.value as string;
      expect(unrelatedInput).not.toContain("Ember private project memory marker");
    } finally {
      await app.close();
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

  it("backfills versioned legacy placeholder titles from the first user message", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const conversation = store.createConversation("新对话", defaultConversationSettings());
    store.createChatMessage({
      id: "legacy-placeholder-message",
      conversationId: conversation.id,
      role: "user",
      content: "请检查发布流水线的失败日志并找出原因",
      taskId: null,
      attachments: [],
      createdAt: new Date().toISOString()
    });

    const listed = await app.inject({ method: "GET", url: "/api/conversations" });
    expect(listed.statusCode).toBe(200);
      expect(store.getConversation(conversation.id)?.title).toBe("检查发布流水线的失败日志并找出原因");
    expect(store.getAppSetting("conversation.title.summary.v5")).toBe("done");
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

    const followUp = await app.inject({
      method: "PUT",
      url: "/api/executor-settings",
      payload: { followUpMode: "steer" }
    });
    expect(followUp.statusCode).toBe(200);
    expect(followUp.json().settings.followUpMode).toBe("steer");

    const view = await app.inject({ method: "GET", url: "/api/executor-settings" });
    expect(view.json().settings.executors.codex).toEqual({ command: "codex-custom", authMode: "pat" });
    expect(view.json().settings.followUpMode).toBe("steer");
    expect(view.json().settings).not.toHaveProperty("concurrency");
    expect(view.json().settings).not.toHaveProperty("concurrencyLimit");
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
      expect(native.health.issues.join(" ")).toContain("尚未绑定模型");

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

  it("routes a conceptual method question through the selected executor as a task", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    await bindProfile(app, "native", await createTestProfile(app));
    const response = await app.inject({ method: "POST", url: "/api/chat", payload: { routeMode: "chat", message: "怎么测试这个函数" } });
    const events = parseSse(response.body);
    expect(events.find((event) => event.event === "routing")?.data).toMatchObject({
      action: "task",
      harness: "agent",
      lockedExecutorId: "native"
    });
    const task = events.find((event) => event.event === "task")?.data.task;
    expect(task.executorId).toBe("native");
    expect(task.inputs.some((input: { kind: string; value?: string }) => input.kind === "text" && input.value?.includes("怎么测试这个函数"))).toBe(true);
    expect(events.some((event) => event.event === "error")).toBe(false);
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

  it("keeps the executor view and model binding aligned after switching models", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files")
    });
    const firstProfileId = await createTestProfile(app, "First model", "openai-chat", "first-model");
    const secondProfileId = await createTestProfile(app, "Second model", "openai-chat", "second-model");
    await bindProfile(app, "native", firstProfileId);

    const beforeSwitch = await app.inject({ method: "GET", url: "/api/executors" });
    const nativeBefore = beforeSwitch.json().executors.find((executor: { id: string }) => executor.id === "native");
    expect(nativeBefore.modelBinding.profileId).toBe(firstProfileId);
    expect(nativeBefore.effectiveModel.model).toBe("first-model");

    const switched = await app.inject({
      method: "PUT",
      url: "/api/executors/native/model-binding",
      payload: { profileId: secondProfileId, protocolOverride: null, modelOverride: null }
    });
    expect(switched.statusCode, switched.body).toBe(200);

    const afterSwitch = await app.inject({ method: "GET", url: "/api/executors" });
    const nativeAfter = afterSwitch.json().executors.find((executor: { id: string }) => executor.id === "native");
    expect(nativeAfter.modelBinding.profileId).toBe(secondProfileId);
    expect(nativeAfter.modelBinding.effectiveModel).toBe("second-model");
    expect(nativeAfter.effectiveModel.model).toBe("second-model");

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().chatModel).toMatchObject({
      configured: true,
      executorId: "native",
      settings: { model: "second-model" }
    });
    const onboarding = await app.inject({ method: "GET", url: "/api/onboarding" });
    expect(onboarding.json().checks.chatModelConfigured).toBe(true);

    const registry = await app.inject({ method: "GET", url: "/api/model-registry" });
    expect(registry.json().bindings.find((binding: { executorId: string }) => binding.executorId === "native").profileId)
      .toBe(secondProfileId);
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
      expect(done?.content).toContain("消息没有派出");
      expect(done?.content).toMatch(/尚未验证|未安装|执行失败/);
      await app.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routes greetings and work identically when every executor is unavailable", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const conversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "全关", settings: { executorEnabled: { native: false, codex: false } } }
    });
    const conversationId = conversation.json().id as string;

    for (const message of ["帮我写一份本周工作周报", "你好"]) {
      const response = await app.inject({ method: "POST", url: "/api/chat", payload: { conversationId, routeMode: "chat", message } });
      const events = parseSse(response.body);
      expect(events.find((event) => event.event === "routing")?.data.action).toBe("task");
      expect(events.some((event) => event.event === "task")).toBe(false);
      expect(events.find((event) => event.event === "done")?.data.content).toContain("消息没有派出");
    }
    expect((await app.inject({ method: "GET", url: "/api/tasks" })).json().tasks).toHaveLength(0);
    await app.close();
  });
  it("injects confirmed memories into the unified harness prompt and reports them", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      masterKeyPath: join(root, "master.key"),
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files")
    });
    await bindProfile(app, "native", await createTestProfile(app));
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
    const confirmed = await app.inject({ method: "POST", url: `/api/memory/${created.json().id as string}/confirm` });
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    const response = await app.inject({ method: "POST", url: "/api/chat", payload: { routeMode: "chat", message: "我们项目的发布窗口是什么时候？" } });
    const events = parseSse(response.body);
    expect(events.find((event) => event.event === "memory")?.data.count).toBe(1);
    expect(events.find((event) => event.event === "routing")?.data.action).toBe("task");
    const task = events.find((event) => event.event === "task")?.data.task;
    const input = task.inputs.find((entry: { kind: string }) => entry.kind === "text")?.value as string;
    expect(input).toContain("<hearth-memories");
    expect(input).toContain("Ember");
    expect(events.find((event) => event.event === "error")).toBeUndefined();
    await app.close();
  });
  it("dispatches a URL question as a harness task with the URL preserved", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    await bindProfile(app, "native", await createTestProfile(app));
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { routeMode: "chat", message: "介绍一下这个 GitHub 项目，根据实际代码告诉我 https://github.com/openai/codex" }
    });
    const events = parseSse(response.body);
    expect(events.find((event) => event.event === "routing")?.data.action).toBe("task");
    const task = events.find((event) => event.event === "task")?.data.task;
    expect(task.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "url", value: "https://github.com/openai/codex" })]));
    expect(task.networkHosts).toEqual(expect.arrayContaining(["github.com"]));
    await app.close();
  });

  it("persists an actionable executor error instead of falling back to a global chat model", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const response = await app.inject({ method: "POST", url: "/api/chat", payload: { routeMode: "chat", message: "你好" } });
    const events = parseSse(response.body);
    expect(events.find((event) => event.event === "routing")?.data.action).toBe("task");
    expect(events.some((event) => event.event === "task")).toBe(false);
    const done = events.find((event) => event.event === "done")?.data;
    expect(done.content).toContain("消息没有派出");
    expect(done.content).toMatch(/模型绑定|不可用|尚未验证/);
    const conversationId = events.find((event) => event.event === "conversation")?.data.id;
    expect(events.find((event) => event.event === "conversation")?.data.title).not.toBe("新对话");
    const stored = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}` });
    expect(stored.json().messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
    expect(stored.json().tasks).toHaveLength(0);
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

  it("returns reasoning capabilities for a configured model", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
    const response = await app.inject({
      method: "POST",
      url: "/api/model-capabilities",
      payload: {
        protocol: "openai-chat",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        model: "glm-5.3-flash"
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    const { capability } = response.json();
    expect(capability.family).toBe("glm");
    expect(capability.levels).toEqual(["low", "high", "max"]);
    expect(capability.canDisable).toBe(false);
    expect(capability.model).toBe("glm-5.3-flash");
  });

  it("keeps project-scoped library memories out of unrelated conversations", () => {
    const memoryHit = {
      node: { kind: "memory", metadata: { scope: "project:project-ember" } },
      score: 1,
      snippet: "private marker",
      matchedBy: "fts"
    } as unknown as LibrarySearchHit;

    expect(libraryHitAllowedForConversation(memoryHit, null)).toBe(false);
    expect(libraryHitAllowedForConversation(memoryHit, "project-ember")).toBe(true);
    expect(libraryHitAllowedForConversation({
      ...memoryHit,
      node: { kind: "task", metadata: {} }
    } as unknown as LibrarySearchHit, null)).toBe(true);
  });

  it("rejects plan+goal and cross-mode conflicts before writing the user message", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files")
    });
    try {
      const conversation = store.createConversation("mode conflict");
      const before = store.listChatMessages(conversation.id).length;
      const both = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: { conversationId: conversation.id, message: "do both", planMode: true, goalMode: true }
      });
      expect(both.statusCode, both.body).toBe(409);
      expect(both.json().error).toBe("MODE_CONFLICT");
      expect(store.listChatMessages(conversation.id)).toHaveLength(before);

      const goal = await app.inject({
        method: "POST",
        url: "/api/goals",
        payload: {
          conversationId: conversation.id,
          objective: "active goal",
          start: false,
          execution: { executorId: "native", taskKind: "general", expectedOutputs: [], networkHosts: [] }
        }
      });
      expect(goal.statusCode, goal.body).toBe(201);
      const planWhileGoal = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: { conversationId: conversation.id, message: "plan", planMode: true }
      });
      expect(planWhileGoal.statusCode, planWhileGoal.body).toBe(409);
      expect(planWhileGoal.json().error).toBe("PLAN_GOAL_CONFLICT");
      const directPlan = await app.inject({
        method: "POST",
        url: "/api/plans",
        payload: { conversationId: conversation.id, objective: "blocked plan", start: false }
      });
      expect(directPlan.statusCode, directPlan.body).toBe(409);
      expect(directPlan.json().error).toBe("PLAN_GOAL_CONFLICT");

      const other = store.createConversation("plan conflict");
      const plan = await app.inject({
        method: "POST",
        url: "/api/plans",
        payload: { conversationId: other.id, objective: "active plan", start: false }
      });
      expect(plan.statusCode, plan.body).toBe(201);
      const bothWhilePlan = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: { conversationId: other.id, message: "both again", planMode: true, goalMode: true }
      });
      expect(bothWhilePlan.statusCode, bothWhilePlan.body).toBe(409);
      expect(bothWhilePlan.json().error).toBe("MODE_CONFLICT");
      const goalWhilePlan = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: { conversationId: other.id, message: "goal", goalMode: true }
      });
      expect(goalWhilePlan.statusCode, goalWhilePlan.body).toBe(409);
      expect(goalWhilePlan.json().error).toBe("GOAL_PLAN_CONFLICT");
      const directGoal = await app.inject({
        method: "POST",
        url: "/api/goals",
        payload: {
          conversationId: other.id,
          objective: "blocked goal",
          start: false,
          execution: { executorId: "native", taskKind: "general", expectedOutputs: [], networkHosts: [] }
        }
      });
      expect(directGoal.statusCode, directGoal.body).toBe(409);
      expect(directGoal.json().error).toBe("GOAL_PLAN_CONFLICT");
    } finally {
      await app.close();
    }
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


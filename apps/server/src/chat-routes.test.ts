import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { defaultConversationSettings, mergeConversationSettings } from "@hearth/core";
import { buildServer } from "./app.ts";
import { visibleDeliverables } from "./service.ts";

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

  it("routes an execution request to a task and keeps the conversation link", async () => {
    const app = await buildServer({ store, serveWeb: false, modelSettingsPath: join(root, "settings.json"), attachmentRoot: join(root, "files") });
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

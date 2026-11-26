import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment, ChatMessageRecord, TaskRecord } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import { ImBridgeService } from "./im-bridge.ts";
import { SecretBox } from "./secrets.ts";

let root = "";
let store: HearthStore;

function seedTask(store: HearthStore, status: TaskRecord["status"], resultSummary: string): TaskRecord {
  const record: TaskRecord = {
    id: "task-im",
    templateId: null,
    title: "查看桌面文件列表",
    goal: "看看我桌面有哪些文件",
    status,
    createdAt: "2026-11-24T00:00:00.000Z",
    updatedAt: "2026-11-24T00:00:00.000Z",
    deadline: null,
    inputs: [],
    networkHosts: [],
    outputDir: ".hearth/artifacts/task-im",
    currentRunId: null,
    nextAction: null,
    error: null,
    resultSummary,
    conversationId: null,
    executorId: "native",
    taskKind: "general",
    expectedOutputs: []
  };
  store.appendEvent({ type: "task.created", taskId: record.id, payload: record });
  return record;
}

function statusMessage(taskId: string): ChatMessageRecord {
  return {
    id: "msg-task-status",
    conversationId: "im-conversation",
    role: "assistant",
    content: "开始执行：查看桌面文件列表\n\n执行器：Hearth 原生执行器。",
    taskId,
    attachments: [],
    createdAt: "2026-11-24T00:00:01.000Z",
    kind: "task_status",
    taskStatus: "running"
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hearth-im-"));
  store = new HearthStore(join(root, "hearth.sqlite"));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("IM bridge settings", () => {
  it("binds a channel to a dedicated, persisted project conversation", async () => {
    const projectId = "project-im";
    store.upsertLocalProject({
      id: projectId,
      name: "GoldMind",
      path: root,
      defaultBranch: "main",
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z"
    });
    const app = await buildServer({
      store,
      serveWeb: false,
      dataDir: root,
      secretBox: new SecretBox(Buffer.alloc(32, 9)),
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files"),
      executorSettingsPath: join(root, "executor-settings.json"),
      startMaintenance: false
    });
    const saved = await app.inject({
      method: "PUT",
      url: "/api/integrations/im/wechat",
      payload: { projectId }
    });
    expect(saved.statusCode).toBe(200);
    const settings = saved.json().settings.wechat;
    expect(settings).toMatchObject({
      projectId,
      projectTitle: "GoldMind",
      conversationTitle: "IM · GoldMind"
    });
    const conversation = store.getConversation(settings.conversationId);
    expect(conversation).toMatchObject({ title: "IM · GoldMind", projectId });

    const again = await app.inject({ method: "GET", url: "/api/integrations/im" });
    expect(again.json().settings.wechat.conversationId).toBe(settings.conversationId);
    await app.close();
  });

  it("does not send status chatter and returns the task conclusion", async () => {
    seedTask(store, "completed", "桌面有 2 个文件：报价表.xlsx、说明.txt。");
    const bridge = new ImBridgeService({
      store,
      secretBox: new SecretBox(Buffer.alloc(32, 9)),
      baseUrl: () => "http://127.0.0.1:4319",
      chatClient: {
        send: async () => ({
          conversationId: "ignored",
          messages: [statusMessage("task-im")],
          error: null
        })
      } as never
    });
    const replies: string[] = [];
    const internal = bridge as unknown as {
      deliverChat(channel: "wechat", text: string, reply: (text: string) => Promise<void>): Promise<void>;
    };
    await internal.deliverChat("wechat", "看看我桌面有哪些文件", async (text) => { replies.push(text); });
    expect(replies).toEqual(["桌面有 2 个文件：报价表.xlsx、说明.txt。"]);
    expect(replies.join("\n")).not.toContain("收到，正在处理");
    expect(replies.join("\n")).not.toContain("开始执行");
  });

  it("does not stream WeChat deltas; it sends one final answer after the status message", async () => {
    const bridge = new ImBridgeService({
      store,
      secretBox: new SecretBox(Buffer.alloc(32, 9)),
      baseUrl: () => "http://127.0.0.1:4319",
      chatClient: {
        send: async (_input: unknown, hooks?: { onDelta?: (text: string) => void }) => {
          hooks?.onDelta?.("这是第一句完整的话。");
          hooks?.onDelta?.("这是第二句。");
          return {
            conversationId: "ignored",
            messages: [{
              id: "msg-final",
              conversationId: "im-conversation",
              role: "assistant",
              content: "这是第一句完整的话。这是第二句。",
              taskId: null,
              attachments: [],
              createdAt: "2026-11-24T00:00:02.000Z",
              kind: "text"
            } satisfies ChatMessageRecord],
            error: null
          };
        }
      } as never
    });
    const replies: string[] = [];
    const internal = bridge as unknown as {
      deliverChat(channel: "wechat", text: string, reply: (text: string) => Promise<void>): Promise<void>;
    };
    await internal.deliverChat("wechat", "讲两句", async (text) => { replies.push(text); });
    expect(replies).toEqual(["这是第一句完整的话。这是第二句。"]);
  });

  it("uploads and sends a WeChat file_item for an assistant attachment", async () => {
    const attachmentRoot = join(root, "attachments");
    mkdirSync(attachmentRoot, { recursive: true });
    const id = "11111111-2222-3333-4444-555555555555";
    writeFileSync(join(attachmentRoot, `${id}.pptx`), "slides");
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : init?.body ?? null;
      requests.push({ url, body });
      if (url.endsWith("/ilink/bot/getuploadurl")) {
        return new Response(JSON.stringify({ upload_full_url: "https://cdn.test/upload" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url === "https://cdn.test/upload") {
        return new Response("", { status: 200, headers: { "x-encrypted-param": "download-param" } });
      }
      return new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    try {
      const bridge = new ImBridgeService({
        store,
        secretBox: new SecretBox(Buffer.alloc(32, 9)),
        baseUrl: () => "http://127.0.0.1:4319",
        attachmentRoot
      });
      const internal = bridge as unknown as {
        sendWechat(
          to: string,
          contextToken: string,
          text: string,
          token: string,
          attachments?: ChatAttachment[]
        ): Promise<void>;
      };
      await internal.sendWechat(
        "wx-user",
        "ctx-token",
        "已把《孙中山的一生.pptx》发给你。",
        "bot-token",
        [{ id, name: "孙中山的一生.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: 6 }]
      );
      expect(requests.some((request) => request.url.endsWith("/ilink/bot/getuploadurl"))).toBe(true);
      expect(requests.some((request) => request.url === "https://cdn.test/upload")).toBe(true);
      const fileMessage = requests
        .map((request) => request.body as { msg?: { item_list?: Array<Record<string, unknown>> } })
        .find((body) => body.msg?.item_list?.[0]?.type === 4);
      expect(fileMessage?.msg?.item_list?.[0]).toMatchObject({
        file_item: {
          file_name: "孙中山的一生.pptx",
          len: "6"
        }
      });
      const aesKey = (fileMessage?.msg?.item_list?.[0] as { file_item?: { media?: { aes_key?: string } } })
        ?.file_item?.media?.aes_key;
      expect(Buffer.from(String(aesKey), "base64").toString("utf8")).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("caps a WeChat turn at three messages: status, file, result", async () => {
    const attachmentRoot = join(root, "attachments-cap");
    mkdirSync(attachmentRoot, { recursive: true });
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    mkdirSync(attachmentRoot, { recursive: true });
    writeFileSync(join(attachmentRoot, `${id}.txt`), "small");
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : init?.body ?? null;
      requests.push({ url, body });
      if (url.endsWith("/ilink/bot/getuploadurl")) {
        return new Response(JSON.stringify({ upload_full_url: "https://cdn.test/upload" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url === "https://cdn.test/upload") {
        return new Response("", { status: 200, headers: { "x-encrypted-param": "download-param" } });
      }
      return new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    try {
      const bridge = new ImBridgeService({
        store,
        secretBox: new SecretBox(Buffer.alloc(32, 9)),
        baseUrl: () => "http://127.0.0.1:4319",
        attachmentRoot
      });
      const internal = bridge as unknown as {
        sendWechat(to: string, contextToken: string, text: string, token: string, attachments?: ChatAttachment[]): Promise<void>;
      };
      await internal.sendWechat("wx-user", "cap-token", "正在执行中…", "bot-token");
      await internal.sendWechat("wx-user", "cap-token", "结果", "bot-token", [
        { id, name: "结果.txt", mimeType: "text/plain", bytes: 5 }
      ]);
      await internal.sendWechat("wx-user", "cap-token", "第四条", "bot-token");

      const sendMessages = requests.filter((request) => request.url.endsWith("/ilink/bot/sendmessage"));
      expect(sendMessages).toHaveLength(3);
      const first = sendMessages[0]!.body as { msg: { item_list: Array<{ type: number }> } };
      expect(first.msg.item_list[0]!.type).toBe(1);
      const fileIndex = sendMessages.findIndex((request) => {
        const body = request.body as { msg: { item_list: Array<{ type: number }> } };
        return body.msg.item_list[0]!.type === 4;
      });
      expect(fileIndex).toBe(1);
      expect(fileIndex).toBeLessThan(sendMessages.length - 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("starts disabled and never returns secrets", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      dataDir: root,
      secretBox: new SecretBox(Buffer.alloc(32, 9)),
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files"),
      executorSettingsPath: join(root, "executor-settings.json"),
      startMaintenance: false
    });
    const response = await app.inject({ method: "GET", url: "/api/integrations/im" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.settings.wechat).toMatchObject({ enabled: false, hasToken: false });
    expect(body.settings.qq).toMatchObject({ enabled: false, hasClientSecret: false });
    expect(body.status.wechat.state).toBe("disabled");
    expect(body.status.qq.state).toBe("disabled");
    await app.close();
  });

  it("refuses to enable without credentials and stores tokens encrypted", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      dataDir: root,
      secretBox: new SecretBox(Buffer.alloc(32, 9)),
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files"),
      executorSettingsPath: join(root, "executor-settings.json"),
      startMaintenance: false
    });
    const missing = await app.inject({
      method: "PUT",
      url: "/api/integrations/im/wechat",
      payload: { enabled: true }
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("WECHAT_TOKEN_REQUIRED");

    const saved = await app.inject({
      method: "PUT",
      url: "/api/integrations/im/wechat",
      payload: { enabled: false, token: "wechat-token", baseUrl: "https://ilinkai.weixin.qq.com/" }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.wechat).toMatchObject({
      hasToken: true,
      enabled: false,
      baseUrl: "https://ilinkai.weixin.qq.com"
    });
    expect(JSON.stringify(saved.json())).not.toContain("wechat-token");

    const qq = await app.inject({
      method: "PUT",
      url: "/api/integrations/im/qq",
      payload: { enabled: false, appId: "1024", clientSecret: "qq-secret" }
    });
    expect(qq.statusCode).toBe(200);
    expect(qq.json().settings.qq).toMatchObject({ hasClientSecret: true, appId: "1024" });
    expect(JSON.stringify(qq.json())).not.toContain("qq-secret");
    await app.close();
  });
});

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatAttachment, ChatMessageRecord } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import {
  FeishuService,
  FeishuSettingsStore,
  parseFeishuMessage,
  type FeishuChatClient,
  type FeishuChatResult,
  type FeishuInboundMessage,
  type FeishuTransport,
  type FeishuTransportCallbacks
} from "./feishu.ts";
import { SecretBox } from "./secrets.ts";

function event(overrides: { text?: string; chatType?: string; mentions?: unknown[]; messageType?: string; content?: Record<string, unknown> } = {}) {
  return {
    sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
    message: {
      message_id: "om_1",
      chat_id: "oc_chat",
      chat_type: overrides.chatType ?? "p2p",
      message_type: overrides.messageType ?? "text",
      content: JSON.stringify(overrides.content ?? { text: overrides.text ?? "你好" }),
      mentions: overrides.mentions ?? []
    }
  };
}

function assistant(id = "msg-a", content = "已处理"): ChatMessageRecord {
  return {
    id,
    conversationId: "conv-1",
    role: "assistant",
    content,
    taskId: null,
    attachments: [],
    createdAt: "2026-11-08T00:00:00.000Z"
  };
}

class FakeTransport implements FeishuTransport {
  handler: ((message: FeishuInboundMessage) => void) | null = null;
  started = 0;
  stopped = 0;
  sent: string[] = [];
  downloads = 0;

  async start(onMessage: (message: FeishuInboundMessage) => void): Promise<void> {
    this.started += 1;
    this.handler = onMessage;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }

  async sendText(_chatId: string, text: string): Promise<void> {
    this.sent.push(text);
  }

  async downloadResource(): Promise<{ buffer: Buffer; mimeType: string }> {
    this.downloads += 1;
    return { buffer: Buffer.from("attachment body"), mimeType: "text/plain" };
  }
}

class FakeChat implements FeishuChatClient {
  calls: Array<{ conversationId?: string | undefined; message: string; attachments: ChatAttachment[] }> = [];

  async send(input: { conversationId?: string | undefined; message: string; attachments: ChatAttachment[] }): Promise<FeishuChatResult> {
    this.calls.push(input);
    return { conversationId: "conv-1", messages: [assistant()], error: null };
  }
}

async function waitFor(condition: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met");
}

describe("parseFeishuMessage", () => {
  it("parses user text and strips mention placeholders", () => {
    expect(parseFeishuMessage(event({ text: "@_user_1 帮我整理周报" }))).toMatchObject({
      messageId: "om_1",
      chatId: "oc_chat",
      senderOpenId: "ou_user",
      messageType: "text",
      text: "帮我整理周报",
      chatType: "p2p"
    });
  });

  it("ignores group messages without a mention and bot senders", () => {
    expect(parseFeishuMessage(event({ chatType: "group" }))).toBeNull();
    expect(parseFeishuMessage(event({ chatType: "group", mentions: [{ key: "@_user_1" }] }))).not.toBeNull();
    const bot = event();
    bot.sender.sender_type = "app";
    expect(parseFeishuMessage(bot)).toBeNull();
  });

  it("parses file and image messages", () => {
    expect(parseFeishuMessage(event({ messageType: "file", content: { file_key: "file-1", file_name: "notes.txt" } })))
      .toMatchObject({ messageType: "file", fileKey: "file-1", fileName: "notes.txt" });
    expect(parseFeishuMessage(event({ messageType: "image", content: { image_key: "img-1" } })))
      .toMatchObject({ messageType: "image", imageKey: "img-1" });
  });
});

describe("FeishuSettingsStore", () => {
  let store: HearthStore;
  let root: string;
  let settings: FeishuSettingsStore;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    root = mkdtempSync(join(tmpdir(), "hearth-feishu-settings-"));
    settings = new FeishuSettingsStore(store, new SecretBox(Buffer.alloc(32, 7)));
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("encrypts the app secret and masks it in views", () => {
    expect(() => settings.save({ enabled: true, appId: "cli_x", appSecret: "secret", allowedOpenIds: [] })).toThrow(/至少加入一个/);
    settings.save({ enabled: true, appId: "cli_x", appSecret: "super-secret", allowedOpenIds: ["ou_user"] });
    expect(settings.view()).toMatchObject({ enabled: true, appId: "cli_x", hasAppSecret: true, appSecretMasked: "••••••••" });
    expect(JSON.stringify(settings.view())).not.toContain("super-secret");
    expect(store.getAppSetting("integrations.feishu.v1")).not.toContain("super-secret");
    expect(settings.secret()).toBe("super-secret");

    settings.save({ appId: "cli_y" });
    expect(settings.secret()).toBe("super-secret");
  });
});

describe("FeishuService", () => {
  let store: HearthStore;
  let root: string;
  let service: FeishuService;
  let transport: FakeTransport;
  let chat: FakeChat;

  beforeEach(async () => {
    store = new HearthStore(":memory:");
    root = mkdtempSync(join(tmpdir(), "hearth-feishu-"));
    transport = new FakeTransport();
    chat = new FakeChat();
    service = new FeishuService({
      store,
      secretBox: new SecretBox(Buffer.alloc(32, 9)),
      attachmentRoot: join(root, "attachments"),
      transportFactory: (_settings, _callbacks: FeishuTransportCallbacks) => transport,
      chatClient: chat
    });
    service.settingsStore.save({
      enabled: true,
      appId: "cli_x",
      appSecret: "secret",
      allowedOpenIds: ["ou_user"],
      domain: "feishu"
    });
    await service.start("http://127.0.0.1:4317");
  });

  afterEach(async () => {
    await service.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("routes allowlisted text to chat, maps the conversation, and replies", async () => {
    const parsed = parseFeishuMessage(event());
    expect(parsed).not.toBeNull();
    transport.handler?.(parsed!);
    await waitFor(() => chat.calls.length === 1 && transport.sent.some((text) => text === "已处理"));
    expect(chat.calls[0]?.message).toBe("你好");
    expect(service.route("oc_chat")?.conversationId).toBe("conv-1");
    expect(transport.sent).toContain("收到，正在处理…");
    expect(service.snapshot().lastEventAt).toBeTruthy();
  });

  it("deduplicates redelivered messages and ignores other users", async () => {
    const parsed = parseFeishuMessage(event())!;
    transport.handler?.(parsed);
    transport.handler?.(parsed);
    await waitFor(() => chat.calls.length === 1);
    expect(chat.calls).toHaveLength(1);

    const stranger = parseFeishuMessage(event({ text: "陌生人的消息" }))!;
    stranger.senderOpenId = "ou_other";
    transport.handler?.(stranger);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chat.calls).toHaveLength(1);
  });

  it("downloads file attachments into the managed attachment directory", async () => {
    const parsed = parseFeishuMessage(event({ messageType: "file", content: { file_key: "file-1", file_name: "notes.txt" } }))!;
    transport.handler?.(parsed);
    await waitFor(() => chat.calls.length === 1);
    expect(transport.downloads).toBe(1);
    expect(chat.calls[0]?.attachments).toHaveLength(1);
    expect(chat.calls[0]?.attachments[0]).toMatchObject({ name: "notes.txt", mimeType: "text/plain", bytes: 15 });
    expect(readdirSync(join(root, "attachments")).some((name) => name.endsWith(".txt"))).toBe(true);
  });
});

describe("Feishu API", () => {
  let store: HearthStore;
  let root: string;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    root = mkdtempSync(join(tmpdir(), "hearth-feishu-api-"));
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("saves settings without exposing the app secret and validates the allowlist", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      masterKeyPath: join(root, "master.key"),
      attachmentRoot: join(root, "attachments"),
      feishuTransportFactory: () => new FakeTransport(),
      feishuChatClient: new FakeChat()
    });
    try {
      const initial = await app.inject({ method: "GET", url: "/api/integrations/feishu" });
      expect(initial.statusCode).toBe(200);
      expect(initial.json().settings).toMatchObject({ enabled: false, hasAppSecret: false });

      const invalid = await app.inject({
        method: "PUT",
        url: "/api/integrations/feishu",
        payload: { enabled: true, appId: "cli_x", appSecret: "super-secret", allowedOpenIds: [] }
      });
      expect(invalid.statusCode).toBe(400);

      const saved = await app.inject({
        method: "PUT",
        url: "/api/integrations/feishu",
        payload: { enabled: true, appId: "cli_x", appSecret: "super-secret", allowedOpenIds: ["ou_user"] }
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().settings).toMatchObject({ enabled: true, hasAppSecret: true, appSecretMasked: "••••••••" });
      expect(saved.body).not.toContain("super-secret");

      const fetched = await app.inject({ method: "GET", url: "/api/integrations/feishu" });
      expect(fetched.json().settings.allowedOpenIds).toEqual(["ou_user"]);
      expect(fetched.body).not.toContain("super-secret");
    } finally {
      await app.close();
    }
  });
});
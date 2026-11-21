import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, chatStream } from "./api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chatStream", () => {
  it("preserves the HTTP status and API error code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "CONVERSATION_NOT_FOUND", message: "对话不存在" }),
      { status: 404, headers: { "content-type": "application/json" } }
    )));

    await expect(chatStream({ message: "你好" }, { onEvent: () => undefined }))
      .rejects.toMatchObject({ name: "ApiError", status: 404, code: "CONVERSATION_NOT_FOUND", message: "对话不存在" });
    await expect(chatStream({ message: "你好" }, { onEvent: () => undefined })).rejects.toBeInstanceOf(ApiError);
  });

  it("parses CRLF streams and dispatches a final block without a trailing blank line", async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'event: conversation\r\ndata: {"id":"conversation-1"}\r\n\r\nevent: done\r\ndata: {"id":"message-1","content":"回答"}',
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )));

    await chatStream({ message: "你好" }, { onEvent: (event, data) => events.push({ event, data }) });
    expect(events).toEqual([
      { event: "conversation", data: { id: "conversation-1" } },
      { event: "done", data: { id: "message-1", content: "回答" } }
    ]);
  });

  it("fails instead of leaving the composer stuck when the stream ends without a terminal event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'event: delta\ndata: {"text":"半条回答"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )));

    await expect(chatStream({ message: "你好" }, { onEvent: () => undefined }))
      .rejects.toThrow("聊天连接提前结束，请重试。");
  });
});

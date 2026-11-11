import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeChat, listModels, streamChat } from "./model-client.ts";
import { decideRoute } from "./chat.ts";
import type { ModelSettings } from "./model-settings.ts";

let server: Server;
let baseUrl = "";
let mode: "chat" | "route" | "route-chat" = "chat";

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.endsWith("/models")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body || "{}") as { stream?: boolean };
    if (payload.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "你" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    if (mode === "route") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: '{"action":"task","title":"写报告","reason":"需要产出文件"}' } }] }));
      return;
    }
    if (mode === "route-chat") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: '{"action":"chat","title":"","reason":"看起来像问答"}' } }] }));
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function settings(): ModelSettings {
  return {
    providerId: "custom",
    providerName: "Test",
    protocol: "openai-chat",
    baseUrl,
    model: "test-model",
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_000,
    apiKey: "test-key",
    updatedAt: null
  };
}

describe("OpenAI-compatible model client", () => {
  it("streams deltas from SSE", async () => {
    const deltas: string[] = [];
    const result = await streamChat(settings(), [{ role: "user", content: "hi" }], (delta) => deltas.push(delta));
    expect(deltas.join("")).toBe("你好");
    expect(result.content).toBe("你好");
  });

  it("streams reasoning separately from answer content", async () => {
    const reasoningServer = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the request body before replying.
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "先想" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "答案" } }] })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
    await new Promise<void>((resolve) => reasoningServer.listen(0, "127.0.0.1", resolve));
    const address = reasoningServer.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    const deltas: Array<{ text: string; kind: string | undefined }> = [];
    try {
      const result = await streamChat(
        { ...settings(), baseUrl: `http://127.0.0.1:${address.port}/v1` },
        [{ role: "user", content: "hi" }],
        (text, kind) => deltas.push({ text, kind })
      );
      expect(deltas).toEqual([
        { text: "先想", kind: "reasoning" },
        { text: "答案", kind: "content" }
      ]);
      expect(result.content).toBe("答案");
    } finally {
      await new Promise<void>((resolve, reject) => reasoningServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("parses non-stream replies and usage", async () => {
    mode = "chat";
    const result = await completeChat(settings(), [{ role: "user", content: "hi" }]);
    expect(result.content).toBe("OK");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
  });

  it("lists provider models from /models", async () => {
    expect(await listModels(settings())).toEqual(["model-a", "model-b"]);
  });

  it("uses the router response to choose task execution", async () => {
    mode = "route";
    const route = await decideRoute("整理一下这些内容", false, null, settings());
    expect(route).toMatchObject({ action: "task", title: "写报告" });
    mode = "chat";
  });

  it("overrides a chat classification when an explicit executor is selected and the request needs GitHub PR work", async () => {
    mode = "route-chat";
    const route = await decideRoute(
      "请你审核我的 GitHub 仓库中目前开着的 PR，列出需要回复修改或 rebase 的",
      false,
      null,
      settings(),
      { preferredExecutorId: "deepseek-harness" }
    );
    expect(route.action).toBe("task");
    expect(route.reason).toContain("GitHub");
    mode = "chat";
  });

  it("keeps a general GitHub PR question in chat even when an executor is selected", async () => {
    mode = "route-chat";
    const route = await decideRoute(
      "PR 审核一般看什么",
      false,
      null,
      settings(),
      { preferredExecutorId: "deepseek-harness" }
    );
    expect(route.action).toBe("chat");
    mode = "chat";
  });

  it("still detects GitHub PR work when the router model is not configured", async () => {
    const route = await decideRoute(
      "请你审核我的 GitHub 仓库中目前开着的 PR，列出需要回复修改或 rebase 的",
      false,
      null,
      { ...settings(), apiKey: "" },
      { preferredExecutorId: "deepseek-harness" }
    );
    expect(route.action).toBe("task");
  });
});

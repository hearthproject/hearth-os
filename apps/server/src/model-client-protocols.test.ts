import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProtocol } from "@hearth/core";
import { completeChat, listModels, streamChat } from "./model-client.ts";
import type { ModelSettings } from "./model-settings.ts";

let server: Server;
let origin = "";
const seen: { path: string; headers: Record<string, unknown>; body: any }[] = [];

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as any : null;
    seen.push({ path: url.pathname, headers: request.headers, body });

    const json = (payload: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    const sse = () => response.writeHead(200, { "content-type": "text/event-stream" });

    if (url.pathname === "/openai/v1/responses") {
      if (body?.stream) {
        sse();
        response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "你" })}\n\n`);
        response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "好" })}\n\n`);
        response.write(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 2 } } })}\n\n`);
        response.end();
        return;
      }
      return json({ output_text: "OK", usage: { input_tokens: 3, output_tokens: 1 } });
    }

    if (url.pathname === "/openai/v1/models") {
      return json({ data: [{ id: "model-b" }, { id: "model-a" }] });
    }

    if (url.pathname === "/anthropic/v1/messages") {
      if (body?.stream) {
        sse();
        response.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } })}\n\n`);
        response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "你" } })}\n\n`);
        response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "好" } })}\n\n`);
        response.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 2 } })}\n\n`);
        response.end();
        return;
      }
      return json({ content: [{ type: "text", text: "OK" }], usage: { input_tokens: 3, output_tokens: 1 } });
    }

    if (url.pathname === "/anthropic/v1/models") {
      return json({ data: [{ id: "claude-b" }, { id: "claude-a" }] });
    }

    if (url.pathname === "/gemini/v1beta/models") {
      return json({
        models: [
          { name: "models/gemini-b", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-x", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] }
        ]
      });
    }

    if (url.pathname.startsWith("/gemini/v1beta/models/")) {
      if (url.pathname.includes(":streamGenerateContent")) {
        sse();
        response.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "你" }] } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "好" }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } })}\n\n`);
        response.end();
        return;
      }
      return json({ candidates: [{ content: { parts: [{ text: "OK" }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } });
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function settings(protocol: ModelProtocol): ModelSettings {
  const baseUrl = protocol === "gemini" ? `${origin}/gemini/v1beta` : protocol === "anthropic-messages" ? `${origin}/anthropic/v1` : `${origin}/openai/v1`;
  return {
    providerId: "custom",
    providerName: "Test",
    protocol,
    baseUrl,
    model: "test-model",
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_000,
    apiKey: "test-key",
    updatedAt: null
  };
}

const messages = [
  { role: "system" as const, content: "sys" },
  { role: "user" as const, content: "hi" },
  { role: "assistant" as const, content: "hello" },
  { role: "user" as const, content: "again" }
];

describe("OpenAI Responses protocol", () => {
  it("completes and streams with instructions", async () => {
    const config = settings("openai-responses");
    const completed = await completeChat(config, messages);
    expect(completed).toEqual({ content: "OK", usage: { inputTokens: 3, outputTokens: 1 } });

    const deltas: string[] = [];
    const streamed = await streamChat(config, messages, (delta) => deltas.push(delta));
    expect(deltas.join("")).toBe("你好");
    expect(streamed.usage).toEqual({ inputTokens: 4, outputTokens: 2 });

    const request = seen.filter((item) => item.path === "/openai/v1/responses").at(-1);
    expect(request?.body.instructions).toBe("sys");
    expect(request?.headers.authorization).toBe("Bearer test-key");
  });
});

describe("Anthropic Messages protocol", () => {
  it("completes and streams with system prompt and x-api-key", async () => {
    const config = settings("anthropic-messages");
    const completed = await completeChat(config, messages);
    expect(completed).toEqual({ content: "OK", usage: { inputTokens: 3, outputTokens: 1 } });

    const deltas: string[] = [];
    const streamed = await streamChat(config, messages, (delta) => deltas.push(delta));
    expect(deltas.join("")).toBe("你好");
    expect(streamed.usage).toEqual({ inputTokens: 5, outputTokens: 2 });

    const request = seen.filter((item) => item.path === "/anthropic/v1/messages").at(-1);
    expect(request?.body.system).toBe("sys");
    expect(request?.body.messages.map((item: any) => item.role)).toEqual(["user", "assistant", "user"]);
    expect(request?.headers["x-api-key"]).toBe("test-key");
    expect(await listModels(config)).toEqual(["claude-a", "claude-b"]);
  });
});

describe("Gemini protocol", () => {
  it("completes, streams, and lists text models", async () => {
    const config = settings("gemini");
    const completed = await completeChat(config, messages);
    expect(completed).toEqual({ content: "OK", usage: { inputTokens: 3, outputTokens: 1 } });

    const deltas: string[] = [];
    const streamed = await streamChat(config, messages, (delta) => deltas.push(delta));
    expect(deltas.join("")).toBe("你好");
    expect(streamed.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    const request = seen.filter((item) => item.path.includes(":generateContent")).at(-1);
    expect(request?.body.systemInstruction.parts[0].text).toBe("sys");
    expect(request?.body.contents.map((item: any) => item.role)).toEqual(["user", "model", "user"]);
    expect(request?.headers["x-goog-api-key"]).toBe("test-key");
    expect(await listModels(config)).toEqual(["gemini-a", "gemini-b"]);
  });
});

describe("OpenAI model list", () => {
  it("sorts ids from the models endpoint", async () => {
    expect(await listModels(settings("openai-chat"))).toEqual(["model-a", "model-b"]);
  });
});

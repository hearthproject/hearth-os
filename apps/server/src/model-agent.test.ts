import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProtocol } from "@hearth/core";
import { streamAgentTurn, type AgentMessage, type AgentToolDefinition } from "./model-agent.ts";
import type { ModelSettings } from "./model-settings.ts";

let server: Server;
let origin = "";
const seen: { path: string; body: any }[] = [];

const tools: AgentToolDefinition[] = [{
  name: "read_file",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
}];

const messages: AgentMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "read a" },
  { role: "assistant", content: "", toolCalls: [{ id: "call_prev", name: "read_file", arguments: { path: "a.txt" }, rawArguments: "{\"path\":\"a.txt\"}" }] },
  { role: "tool", toolCallId: "call_prev", name: "read_file", content: "alpha" },
  { role: "user", content: "continue" }
];

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as any : null;
    seen.push({ path: url.pathname, body });
    response.writeHead(200, { "content-type": "text/event-stream" });

    if (url.pathname === "/openai/v1/chat/completions") {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "查" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "{\"path\":\"a" } }] } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ".txt\"}" } }] } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
      response.end();
      return;
    }

    if (url.pathname === "/responses/v1/responses") {
      response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "好" })}\n\n`);
      response.write(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_r", name: "read_file", arguments: "" } })}\n\n`);
      response.write(`data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{\"path\":\"b.txt\"}" })}\n\n`);
      response.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_r", name: "read_file", arguments: "{\"path\":\"b.txt\"}" } })}\n\n`);
      response.write(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 8, output_tokens: 3 } } })}\n\n`);
      response.end();
      return;
    }

    if (url.pathname === "/anthropic/v1/messages") {
      response.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 7 } } })}\n\n`);
      response.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_a", name: "read_file" } })}\n\n`);
      response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"c.txt\"}" } })}\n\n`);
      response.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`);
      response.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } })}\n\n`);
      response.end();
      return;
    }

    if (url.pathname.includes(":streamGenerateContent")) {
      response.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "看" }] } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "d.txt" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2 } })}\n\n`);
      response.end();
      return;
    }

    response.end();
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
  const baseUrl = protocol === "gemini"
    ? `${origin}/gemini/v1beta`
    : protocol === "anthropic-messages"
      ? `${origin}/anthropic/v1`
      : protocol === "openai-responses"
        ? `${origin}/responses/v1`
        : `${origin}/openai/v1`;
  return { providerId: "custom", providerName: "Test", protocol, baseUrl, model: "test-model", contextWindowTokens: 128_000, maxOutputTokens: 8_000, apiKey: "test-key", updatedAt: null };
}

describe("agent tool calling", () => {
  it("assembles OpenAI chat tool arguments from stream deltas", async () => {
    const deltas: string[] = [];
    const result = await streamAgentTurn(settings("openai-chat"), messages, tools, (delta) => deltas.push(delta));
    expect(deltas.join("")).toBe("查");
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "read_file", arguments: { path: "a.txt" }, rawArguments: "{\"path\":\"a.txt\"}" }]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const request = seen.find((item) => item.path === "/openai/v1/chat/completions");
    expect(request?.body.tools[0].function.name).toBe("read_file");
    expect(request?.body.messages.some((item: any) => item.role === "tool" && item.tool_call_id === "call_prev")).toBe(true);
  });

  it("assembles OpenAI Responses function calls", async () => {
    const result = await streamAgentTurn(settings("openai-responses"), messages, tools, () => undefined);
    expect(result.content).toBe("好");
    expect(result.toolCalls[0]?.arguments).toEqual({ path: "b.txt" });
    const request = seen.find((item) => item.path === "/responses/v1/responses");
    expect(request?.body.tools[0].type).toBe("function");
    expect(request?.body.input.some((item: any) => item.type === "function_call_output" && item.call_id === "call_prev")).toBe(true);
  });

  it("assembles Anthropic tool_use blocks", async () => {
    const result = await streamAgentTurn(settings("anthropic-messages"), messages, tools, () => undefined);
    expect(result.toolCalls).toEqual([{ id: "call_a", name: "read_file", arguments: { path: "c.txt" }, rawArguments: "{\"path\":\"c.txt\"}" }]);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 4 });
    const request = seen.find((item) => item.path === "/anthropic/v1/messages");
    expect(request?.body.tools[0].input_schema.properties.path.type).toBe("string");
    expect(request?.body.messages.some((item: any) => item.content?.some((block: any) => block.type === "tool_result"))).toBe(true);
  });

  it("maps Gemini function calls and responses", async () => {
    const result = await streamAgentTurn(settings("gemini"), messages, tools, () => undefined);
    expect(result.content).toBe("看");
    expect(result.toolCalls[0]?.arguments).toEqual({ path: "d.txt" });
    const request = seen.find((item) => item.path.includes(":streamGenerateContent"));
    expect(request?.body.tools[0].functionDeclarations[0].name).toBe("read_file");
    expect(request?.body.contents.some((item: any) => item.parts?.some((part: any) => part.functionResponse))).toBe(true);
  });
});

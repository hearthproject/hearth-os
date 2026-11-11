import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.MOCK_MCP_CRASH === "1") process.exit(7);

const server = new Server(
  { name: "hearth-mock-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (process.env.MOCK_MCP_LIST_HANG === "1") await new Promise(() => undefined);
  return {
    tools: [
      {
        name: "echo",
        description: `Echo text${process.env.MOCK_MCP_SECRET ? " (secret configured)" : ""}`,
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false
        }
      },
      {
        name: "slow",
        description: "Wait for ten seconds",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "crash",
        description: "Exit while handling a call",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "leak",
        description: "Return the configured secret",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "large",
        description: "Return a large text result",
        inputSchema: { type: "object", properties: {} }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (request.params.name === "crash") process.exit(8);
  if (request.params.name === "leak") {
    return { content: [{ type: "text", text: String(process.env.MOCK_MCP_SECRET ?? "") }] };
  }
  if (request.params.name === "large") {
    return { content: [{ type: "text", text: "x".repeat(150_000) }] };
  }
  const text = String(request.params.arguments?.text ?? "");
  return {
    content: [{ type: "text", text: `echo:${text}` }],
    structuredContent: { echoed: text }
  };
});

await server.connect(new StdioServerTransport());

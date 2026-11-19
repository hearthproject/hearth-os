import type { AgentTool, AgentToolResult } from "@hearth/agent-runtime";
import { KnowledgeClient } from "./client.ts";
import type { KnowledgeSettings, KnowledgeSettingsStore } from "./settings.ts";

export const KNOWLEDGE_TOOL_NAMES = ["ov_find", "ov_read", "ov_status"] as const;

const MAX_FIND_RESULTS = 10;
const MAX_READ_CHARS = 12_000;

export interface KnowledgeToolDeps {
  settings: KnowledgeSettingsStore;
  clientFactory?: (settings: KnowledgeSettings) => KnowledgeClient;
}

export function createKnowledgeTools(deps: KnowledgeToolDeps): AgentTool[] {
  const factory = deps.clientFactory ?? ((settings: KnowledgeSettings) => new KnowledgeClient(settings));
  return [
    {
      definition: {
        name: "ov_find",
        description: "只读语义检索 OpenViking 知识库。用于查找项目资料、已完成任务和长期记忆；返回 URI、摘要与相关度，不改动任何数据。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "检索词或自然语言问题" },
            uri: { type: "string", description: "可选的限定范围，例如 viking://resources/hearth/projects/xxx" },
            limit: { type: "number", description: "返回条数，1–10，默认 5" }
          },
          required: ["query"],
          additionalProperties: false
        }
      },
      async execute(input): Promise<AgentToolResult> {
        const args = objectArgs(input);
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return failure("缺少 query。", "INVALID_ARGUMENT");
        try {
          const hits = await factory(deps.settings.get()).find({
            query,
            limit: clamp(Number(args.limit ?? 5), 1, MAX_FIND_RESULTS),
            timeoutMs: 5000,
            ...(typeof args.uri === "string" && args.uri.trim() ? { targetUri: args.uri.trim() } : {})
          });
          return { content: JSON.stringify({ query, hits }, null, 2) };
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error), "KNOWLEDGE_QUERY_FAILED");
        }
      }
    },
    {
      definition: {
        name: "ov_read",
        description: "按 URI 读取 OpenViking 中的资料原文（最多 12000 字符）。只读，不会修改知识库。",
        parameters: {
          type: "object",
          properties: { uri: { type: "string", description: "viking:// 开头的资料 URI" } },
          required: ["uri"],
          additionalProperties: false
        }
      },
      async execute(input): Promise<AgentToolResult> {
        const uri = typeof objectArgs(input).uri === "string" ? String(objectArgs(input).uri).trim() : "";
        if (!uri.startsWith("viking://")) return failure("uri 必须以 viking:// 开头。", "INVALID_ARGUMENT");
        try {
          const text = await factory(deps.settings.get()).read(uri, { timeoutMs: 5000 });
          return { content: text.slice(0, MAX_READ_CHARS) };
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error), "KNOWLEDGE_READ_FAILED");
        }
      }
    },
    {
      definition: {
        name: "ov_status",
        description: "查看 OpenViking 服务是否可用、版本与当前连接地址。只读健康检查。",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      },
      async execute(): Promise<AgentToolResult> {
        try {
          const settings = deps.settings.get();
          const health = await factory(settings).health();
          return { content: JSON.stringify({ baseUrl: settings.baseUrl, enabled: settings.enabled, ...health }, null, 2) };
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error), "KNOWLEDGE_UNREACHABLE");
        }
      }
    }
  ];
}

function objectArgs(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function failure(message: string, code: string): AgentToolResult {
  return { content: JSON.stringify({ error: code, message }, null, 2), isError: true };
}

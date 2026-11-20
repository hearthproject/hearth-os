import type { AgentTool, AgentToolResult } from "@hearth/agent-runtime";
import type { LibraryNode } from "@hearth/core";
import type { LibraryService } from "./service.ts";

export const LIBRARY_TOOL_NAMES = ["library_search", "library_read", "library_summary", "library_tree"] as const;

const MAX_READ_CHARS = 12_000;

export function createLibraryTools(library: LibraryService): AgentTool[] {
  return [
    {
      definition: {
        name: "library_search",
        description: "只读搜索 Hearth 资料库。资料库统一包含记忆、任务、来源资料、产物、技能、项目和本地文件；同时使用关键词与本地语义检索。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "自然语言问题或检索词" },
            limit: { type: "number", description: "返回条数，1–30，默认 8" }
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
          const result = await library.search(query, clamp(Number(args.limit ?? 8), 1, 30));
          return {
            content: JSON.stringify({
              query: result.query,
              semanticUsed: result.semanticUsed,
              hits: result.hits.map((hit) => ({
                id: hit.node.id,
                ref: hit.node.ref,
                path: hit.node.path,
                title: hit.node.title,
                kind: hit.node.kind,
                snippet: hit.snippet,
                matchedBy: hit.matchedBy
              }))
            }, null, 2)
          };
        } catch (error) {
          return failure(message(error), "LIBRARY_SEARCH_FAILED");
        }
      }
    },
    {
      definition: {
        name: "library_read",
        description: "按资料 ID、hearth:// 引用或路径读取资料库中的原文或目录内容。只读，不会修改资料。",
        parameters: {
          type: "object",
          properties: {
            node: { type: "string", description: "资料 ID、hearth:// 引用或资料库路径" }
          },
          required: ["node"],
          additionalProperties: false
        }
      },
      async execute(input): Promise<AgentToolResult> {
        const selector = typeof objectArgs(input).node === "string" ? String(objectArgs(input).node).trim() : "";
        if (!selector) return failure("缺少 node。", "INVALID_ARGUMENT");
        try {
          const node = resolveNode(library, selector);
          if (!node) return failure("没有找到这份资料。", "NODE_NOT_FOUND");
          const details = library.getNodeDetails(node.id);
          if (details.document) return { content: details.document.content.slice(0, MAX_READ_CHARS) };
          const children = details.children.map((child) => `- ${child.title} [${child.kind}] ${child.ref}`).join("\n");
          return { content: `# ${node.title}\n路径：${node.path}\n\n${children || "这个目录目前没有内容。"}` };
        } catch (error) {
          return failure(message(error), "LIBRARY_READ_FAILED");
        }
      }
    },
    {
      definition: {
        name: "library_summary",
        description: "获取资料或目录的摘要；目录摘要会按需生成并缓存。只读，不会修改资料正文。",
        parameters: {
          type: "object",
          properties: {
            node: { type: "string", description: "资料 ID、hearth:// 引用或资料库路径" }
          },
          required: ["node"],
          additionalProperties: false
        }
      },
      async execute(input): Promise<AgentToolResult> {
        const selector = typeof objectArgs(input).node === "string" ? String(objectArgs(input).node).trim() : "";
        if (!selector) return failure("缺少 node。", "INVALID_ARGUMENT");
        try {
          const node = resolveNode(library, selector);
          if (!node) return failure("没有找到这份资料。", "NODE_NOT_FOUND");
          const summary = await library.summarizeNode(node.id);
          return { content: summary.content };
        } catch (error) {
          return failure(message(error), "LIBRARY_SUMMARY_FAILED");
        }
      }
    },
    {
      definition: {
        name: "library_tree",
        description: "浏览 Hearth 统一资料树。可传目录路径或 ID；不传时返回顶层分类。只读。",
        parameters: {
          type: "object",
          properties: {
            node: { type: "string", description: "可选的目录 ID、hearth:// 引用或路径" },
            depth: { type: "number", description: "展开层数，1–4，默认 2" }
          },
          additionalProperties: false
        }
      },
      async execute(input): Promise<AgentToolResult> {
        try {
          const args = objectArgs(input);
          const selector = typeof args.node === "string" ? args.node.trim() : "";
          const depth = clamp(Number(args.depth ?? 2), 1, 4);
          const node = selector ? resolveNode(library, selector) : null;
          if (selector && !node) return failure("没有找到这个目录。", "NODE_NOT_FOUND");
          const nodes = library.tree.buildTree(depth, node?.id ?? null);
          return { content: JSON.stringify(slimTree(nodes), null, 2) };
        } catch (error) {
          return failure(message(error), "LIBRARY_TREE_FAILED");
        }
      }
    }
  ];
}

function resolveNode(library: LibraryService, selector: string): LibraryNode | null {
  return library.resolveNode(selector);
}

function slimTree(nodes: ReturnType<LibraryService["tree"]["buildTree"]>): unknown[] {
  return nodes.map((node) => ({
    id: node.id,
    ref: node.ref,
    title: node.title,
    kind: node.kind,
    path: node.path,
    childCount: node.childCount,
    summary: node.summary,
    ...(node.children ? { children: slimTree(node.children) } : {})
  }));
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

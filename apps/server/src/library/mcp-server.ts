import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = (process.env.HEARTH_BASE_URL ?? "http://127.0.0.1:4317").replace(/\/+$/, "");
const MAX_READ_CHARS = 12_000;

const server = new McpServer({ name: "hearth-library", version: "1.0.0" });

server.registerTool("library_search", {
  description: "只读搜索 Hearth 统一资料库。资料库包含记忆、任务、来源资料、产物、技能、项目和本地文件，并使用关键词与本地语义混合检索。",
  inputSchema: {
    query: z.string().min(1).describe("自然语言问题或检索词"),
    limit: z.number().int().min(1).max(30).optional().describe("返回条数，默认 8")
  },
  annotations: { readOnlyHint: true }
}, async ({ query, limit }) => {
  try {
    const result = await request<{
      semanticUsed: boolean;
      hits: Array<{ id: string; ref: string; path: string; title: string; kind: string; snippet: string; matchedBy: string }>;
    }>(`/api/library/search?q=${encodeURIComponent(query)}&limit=${limit ?? 8}`);
    return text(JSON.stringify({
      semanticUsed: result.semanticUsed,
      hits: result.hits.map((hit) => ({
        id: hit.id,
        ref: hit.ref,
        path: hit.path,
        title: hit.title,
        kind: hit.kind,
        snippet: hit.snippet,
        matchedBy: hit.matchedBy
      }))
    }, null, 2));
  } catch (error) {
    return failure(error);
  }
});

server.registerTool("library_read", {
  description: "按资料 ID、hearth:// 引用或资料库路径读取原文或目录内容。只读。",
  inputSchema: { node: z.string().min(1).describe("资料 ID、hearth:// 引用或路径") },
  annotations: { readOnlyHint: true }
}, async ({ node }) => {
  try {
    const resolved = await resolveNode(node);
    const details = await request<{
      node: { id: string; title: string; path: string };
      document: { content: string } | null;
      children: Array<{ title: string; kind: string; ref: string }>;
    }>(`/api/library/nodes/${encodeURIComponent(resolved.id)}`);
    if (details.document) return text(details.document.content.slice(0, MAX_READ_CHARS));
    const children = details.children.map((child) => `- ${child.title} [${child.kind}] ${child.ref}`).join("\n");
    return text(`# ${details.node.title}\n路径：${details.node.path}\n\n${children || "这个目录目前没有内容。"}`);
  } catch (error) {
    return failure(error);
  }
});

server.registerTool("library_summary", {
  description: "获取资料或目录的摘要；目录摘要按需生成并缓存。只读。",
  inputSchema: { node: z.string().min(1).describe("资料 ID、hearth:// 引用或路径") },
  annotations: { readOnlyHint: true }
}, async ({ node }) => {
  try {
    const resolved = await resolveNode(node);
    const result = await request<{ summary: { content: string } }>(
      `/api/library/nodes/${encodeURIComponent(resolved.id)}/summary`,
      { method: "POST", body: JSON.stringify({ force: false }) }
    );
    return text(result.summary.content);
  } catch (error) {
    return failure(error);
  }
});

server.registerTool("library_tree", {
  description: "浏览 Hearth 统一资料树。不传 node 时返回顶层分类。只读。",
  inputSchema: {
    node: z.string().min(1).optional().describe("可选的目录 ID、hearth:// 引用或路径"),
    depth: z.number().int().min(1).max(4).optional().describe("展开层数，默认 2")
  },
  annotations: { readOnlyHint: true }
}, async ({ node, depth }) => {
  try {
    const resolved = node ? await resolveNode(node) : null;
    const query = new URLSearchParams({ depth: String(depth ?? 2) });
    if (resolved) query.set("parentId", resolved.id);
    const result = await request<{ nodes: unknown[] }>(`/api/library/tree?${query.toString()}`);
    return text(JSON.stringify(result.nodes, null, 2));
  } catch (error) {
    return failure(error);
  }
});

async function resolveNode(selector: string): Promise<{ id: string }> {
  const result = await request<{ node: { id: string } }>(`/api/library/resolve?node=${encodeURIComponent(selector)}`);
  return result.node;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "message" in payload
      ? String((payload as { message: unknown }).message)
      : `Hearth 返回 HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function failure(error: unknown) {
  return {
    content: [{ type: "text" as const, text: `资料库读取失败：${error instanceof Error ? error.message : String(error)}` }],
    isError: true
  };
}

await server.connect(new StdioServerTransport());

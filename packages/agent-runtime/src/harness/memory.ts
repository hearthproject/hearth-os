import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentTool, AgentToolContext } from "../types.ts";

const MAX_MEMORY_BYTES = 100_000;

export function createMemoryTools(): AgentTool[] {
  return [memoryReadTool, memoryWriteTool, memorySearchTool];
}

const memoryReadTool: AgentTool = {
  definition: {
    name: "memory_read",
    description: "Read the repository memory index, one memory entry, or the list of stored entries.",
    executionMode: "parallel",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Entry name; omit to read MEMORY.md and list entries" } },
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const root = memoryRoot(context);
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (name) {
      const path = entryPath(root, name);
      if (!existsSync(path)) throw new Error(`记忆条目不存在：${name}`);
      return { content: readFileSync(path, "utf8") };
    }
    const index = existsSync(join(root, "MEMORY.md")) ? readFileSync(join(root, "MEMORY.md"), "utf8") : "";
    const entries = existsSync(root) ? readdirSync(root).filter((file) => file.endsWith(".md") && file !== "MEMORY.md") : [];
    return { content: [index.trim() || "(empty memory)", "", "entries:", ...entries.map((file) => `- ${file.slice(0, -3)}`)].join("\n") };
  }
};

const memoryWriteTool: AgentTool = {
  definition: {
    name: "memory_write",
    description: "Persist an explicit repository memory entry and add it to the memory index.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short stable name, e.g. build-commands or auth-flow" },
        content: { type: "string", description: "Durable fact, decision or command; do not store transient guesses" },
        description: { type: "string", description: "One-line index description" }
      },
      required: ["name", "content"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const content = typeof args.content === "string" ? args.content.trim() : "";
    const description = typeof args.description === "string" ? args.description.trim().replace(/\s+/g, " ").slice(0, 200) : "";
    if (!name || !content) throw new Error("memory_write 需要 name 和 content");
    if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES) throw new Error("记忆条目过大");
    const root = memoryRoot(context);
    assertWritable(root, context);
    const path = entryPath(root, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(path, `# ${name}\n\n${content}\n`, "utf8");
    const index = join(root, "MEMORY.md");
    const slug = relative(root, path).replace(/\\/g, "/");
    const line = `- [${name}](${slug})${description ? ` — ${description}` : ""}`;
    const existing = existsSync(index) ? readFileSync(index, "utf8") : "# Repository Memory\n";
    if (!existing.includes(`](${slug})`)) writeFileSync(index, `${existing.trimEnd()}\n${line}\n`, "utf8");
    return { content: `已写入记忆：${slug}` };
  }
};

const memorySearchTool: AgentTool = {
  definition: {
    name: "memory_search",
    description: "Search repository memory entries by literal text or regular expression.",
    executionMode: "parallel",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Text or regex to search" } },
      required: ["query"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) throw new Error("memory_search 需要 query");
    const root = memoryRoot(context);
    if (!existsSync(root)) return { content: "没有记忆条目" };
    let matcher: RegExp;
    try {
      matcher = new RegExp(query, "i");
    } catch {
      matcher = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const results: string[] = [];
    for (const file of readdirSync(root).filter((item) => item.endsWith(".md") && item !== "MEMORY.md")) {
      const body = readFileSync(join(root, file), "utf8");
      for (const line of body.split(/\r?\n/)) {
        if (matcher.test(line)) results.push(`${file.slice(0, -3)}: ${line.trim().slice(0, 300)}`);
        if (results.length >= 20) break;
      }
      if (results.length >= 20) break;
    }
    return { content: results.length > 0 ? results.join("\n") : "没有匹配的记忆" };
  }
};

function memoryRoot(context: AgentToolContext): string {
  return resolve(context.workspaceRoot, ".hearth", "memory");
}

function entryPath(root: string, name: string): string {
  const slug = name.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[.-]+/, "").slice(0, 100);
  if (!slug) throw new Error("记忆名称无效");
  return join(root, `${slug}.md`);
}

function assertWritable(path: string, context: AgentToolContext): void {
  const inside = context.permissions.writeRoots.some((root) => {
    const relativePath = relative(isAbsolute(root) ? root : resolve(context.workspaceRoot, root), path);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  });
  if (!inside) throw new Error("当前任务没有写入记忆目录的权限");
}

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentToolContext } from "../types.ts";
import { codingPromptSections } from "./prompt.ts";
import { createMemoryTools, memoryIndexBlock } from "./memory.ts";

describe("repository memory index", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function contextFor(root: string, out: string): AgentToolContext {
    mkdirSync(out, { recursive: true });
    return {
      workspaceRoot: root,
      outDir: out,
      permissions: { readRoots: [root], writeRoots: [root, out], networkHosts: [], tools: ["memory_write", "memory_read"] },
      signal: new AbortController().signal
    };
  }

  it("writes frontmatter and injects only a bounded index into the prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-memory-"));
    roots.push(root);
    const memory = join(root, ".hearth", "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "MEMORY.md"), Array.from({ length: 260 }, (_, index) => `- entry ${index} ${"x".repeat(40)}`).join("\n"), "utf8");
    const index = memoryIndexBlock(root);
    expect(index).toContain("Memory may be stale");
    expect(index).toContain("truncated");
    expect(index!.split("\n").length).toBeLessThanOrEqual(203);
    expect(Buffer.byteLength(index!, "utf8")).toBeLessThan(25 * 1024 + 120);
    const prompt = codingPromptSections({ workspaceRoot: root, outDir: join(root, "out"), memoryIndex: index! });
    expect(prompt.map((section) => section.id)).toContain("memory");

    const context = contextFor(root, join(root, "out"));
    const write = createMemoryTools().find((tool) => tool.definition.name === "memory_write")!;
    await write.execute({ name: "Build Commands", content: "Use pnpm test.", description: "test command", type: "command" }, context);
    const body = readFileSync(join(memory, "Build-Commands.md"), "utf8");
    expect(body).toContain("type: command");
    expect(body).toContain("name: Build Commands");
    expect(body).toContain("Use pnpm test.");
  });
});

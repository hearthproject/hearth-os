import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookRunner, loadWorkspaceHooks, type AgentHookDefinition } from "./hooks.ts";
import { runAgent } from "../runtime.ts";
import { createBuiltinTools } from "../tools.ts";
import { createFakeModel, fakeToolCall } from "../test-support/fake-model.ts";
import type { AgentTool, AgentToolContext } from "../types.ts";

describe("lifecycle hooks", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("loads workspace hooks only when the workspace is trusted", () => {
    const root = tempRoot(roots);
    const path = join(root, ".hearth", "hooks.json");
    mkdirSync(join(root, ".hearth"), { recursive: true });
    writeFileSync(path, JSON.stringify({ hooks: [{ event: "PreToolUse", command: "node hook.mjs" }, { event: "NotAnEvent", command: "x" }] }), "utf8");
    expect(loadWorkspaceHooks(root, false)).toMatchObject({ trusted: false, skipped: 1, hooks: [] });
    const trusted = loadWorkspaceHooks(root, true);
    expect(trusted.trusted).toBe(true);
    expect(trusted.hooks).toHaveLength(1);
    expect(trusted.hooks[0]?.event).toBe("PreToolUse");
  });

  it("denies a tool and records a post-tool file hash", async () => {
    const root = tempRoot(roots);
    const hookScript = join(root, "hook.mjs");
    writeFileSync(hookScript, hookSource(), "utf8");
    const target = join(root, "artifact.txt");
    const hooks: AgentHookDefinition[] = [
      { event: "PreToolUse", matcher: "^shell$", command: `node "${hookScript}"` },
      { event: "PostToolUse", matcher: "^record_tool$", command: `node "${hookScript}"` }
    ];
    const fake = createFakeModel([
      { content: "", toolCalls: [fakeToolCall("shell", { command: "git status" })], finishReason: "tool_calls" },
      { content: "", toolCalls: [fakeToolCall("record_tool", { path: target })], finishReason: "tool_calls" },
      { content: "done", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
    ]);
    const result = await runAgent({
      model: fake.model,
      tools: [shellTool(), recordTool(), ...createBuiltinTools().filter((tool) => tool.definition.name === "finish_task")],
      goal: "hooks",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["shell", "record_tool", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      hooks
    });

    expect(result.status).toBe("completed");
    expect(result.messages.some((message) => message.role === "tool" && message.content.includes("Hook 拒绝了工具 shell"))).toBe(true);
    const hash = createHash("sha256").update(readFileSync(target, "utf8")).digest("hex");
    expect(result.messages.some((message) => message.content.includes(`sha256=${hash}`))).toBe(true);
  });

  it("fails closed when a blocking hook exits non-zero", async () => {
    const root = tempRoot(roots);
    const runner = new HookRunner([{ event: "PreToolUse", command: "node -e \"process.exit(3)\"" }], { workspaceRoot: root });
    const result = await runner.run("PreToolUse", { toolName: "shell" });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("退出码");
  });
});

function hookSource(): string {
  return [
    'import { readFileSync } from "node:fs";',
    'import { createHash } from "node:crypto";',
    'let data = "";',
    'process.stdin.on("data", (chunk) => { data += chunk; });',
    'process.stdin.on("end", () => {',
    "  const payload = JSON.parse(data);",
    '  if (payload.event === "PreToolUse") {',
    '    console.log(JSON.stringify({ decision: "deny", reason: "no shell today" }));',
    "    return;",
    "  }",
    '  if (payload.event === "PostToolUse") {',
    '    const file = payload.metadata.filesChanged?.[0];',
    '    const hash = file ? createHash("sha256").update(readFileSync(file, "utf8")).digest("hex") : "none";',
    '    console.log(JSON.stringify({ decision: "allow", additionalContext: `sha256=${hash}` }));',
    "    return;",
    "  }",
    '  console.log(JSON.stringify({ decision: "allow" }));',
    "});"
  ].join("\n");
}

function shellTool(): AgentTool {
  return {
    definition: { name: "shell", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } } } },
    async execute() {
      return { content: "should not run" };
    }
  };
}

function recordTool(): AgentTool {
  return {
    definition: { name: "record_tool", description: "write a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
    async execute(input: unknown, _context: AgentToolContext) {
      const path = (input as { path: string }).path;
      writeFileSync(path, "artifact\n", "utf8");
      return { content: "written", metadata: { filesChanged: [path] } };
    }
  };
}

function tempRoot(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-hooks-"));
  roots.push(root);
  return root;
}

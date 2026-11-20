import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compactAgentMessagesWithSummary } from "../compaction.ts";
import { createAgentState } from "./file-state.ts";
import { buildPostCompactContext } from "./post-compact.ts";
import type { AgentMessage } from "../types.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-post-compact-"));
  roots.push(root);
  return root;
}

describe("post-compact context", () => {
  it("restores file references, todos, plan, skills and subagents", () => {
    const root = workspace();
    const state = createAgentState(root);
    state.readFiles.set(join(root, "src", "cart.ts"), {
      size: 120,
      mtimeMs: 1_700_000_000_000,
      hash: "abcdef0123456789",
      ranges: [{ start: 1, end: 40 }, { start: 80, end: 120 }]
    });
    state.todos = [
      { id: "1", content: "Fix cart rounding", status: "in_progress" },
      { id: "2", content: "Run checkout tests", status: "pending" },
      { id: "3", content: "Already done", status: "completed" }
    ];
    state.planPath = join(root, ".hearth", "plans", "cart.md");
    state.activeSkills = ["typescript-review"];
    state.subagents = [{ id: "explore-1", type: "explore", status: "completed", transcriptPath: join(root, ".hearth", "subagents", "explore-1.jsonl") }];

    const block = buildPostCompactContext(state, { mode: "plan" });

    expect(block).toContain("<post_compact_context>");
    expect(block).toContain("mode: plan");
    expect(block).toContain("src/cart.ts");
    expect(block).toContain("lines=1-40,80-120");
    expect(block).toContain("Fix cart rounding");
    expect(block).not.toContain("Already done");
    expect(block).toContain("active_plan: .hearth/plans/cart.md");
    expect(block).toContain("active_skills: typescript-review");
    expect(block).toContain("explore-1 explore completed");
    expect(block).toContain("Re-read any file before editing");
  });

  it("caps the block so restoration cannot undo compaction", () => {
    const root = workspace();
    const state = createAgentState(root);
    for (let index = 0; index < 40; index += 1) {
      state.readFiles.set(join(root, "src", `file-${index}.ts`), {
        size: 1,
        mtimeMs: index,
        hash: "a".repeat(40),
        ranges: [{ start: 1, end: 500 }]
      });
    }
    const block = buildPostCompactContext(state, { maxChars: 1_000 });
    expect(block.length).toBeLessThanOrEqual(1_000);
    expect(block).toContain("[truncated]");
  });

  it("appends the restoration block after compacting messages", async () => {
    const root = workspace();
    const state = createAgentState(root);
    state.todos = [{ id: "1", content: "Finish the fix", status: "pending" }];
    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "goal" },
      ...Array.from({ length: 12 }, (_, index) => [
        { role: "assistant" as const, content: "", toolCalls: [{ id: `old-${index}`, name: "read_file", arguments: {}, rawArguments: "{}" }] },
        { role: "tool" as const, toolCallId: `old-${index}`, name: "read_file", content: "history ".repeat(2_000) }
      ]).flat()
    ];
    const restoredContext = buildPostCompactContext(state, { mode: "build" });
    const result = await compactAgentMessagesWithSummary(messages, {
      contextWindowTokens: 2_000,
      reserveTokens: 200,
      recentTokens: 100,
      restoredContext
    }, async () => "summary");
    expect(result.compacted).toBe(true);
    expect(result.restoredContext).toContain("Finish the fix");
    expect(result.messages.some((message) => message.role === "user" && message.content.includes("Finish the fix"))).toBe(true);
  });
});

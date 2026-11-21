import { describe, expect, it } from "vitest";
import { compactAgentMessages, compactAgentMessagesWithSummary, estimateMessageTokens, microcompactMessages, shouldCompactContext } from "./compaction.ts";
import type { AgentMessage } from "./types.ts";

const MESSAGES: AgentMessage[] = [
  { role: "system", content: "system prompt" },
  { role: "user", content: "goal" },
  { role: "assistant", content: "working", toolCalls: [] }
];

describe("provider usage anchored compaction", () => {
  it("triggers on provider usage even when the local estimate is small", async () => {
    const options = {
      contextWindowTokens: 120_000,
      reserveTokens: 16_000,
      maxOutputTokens: 8_000,
      usageAnchor: { inputTokens: 100_000, outputTokens: 5, messageCount: 3 }
    };

    expect(shouldCompactContext(MESSAGES, 120_000, 16_000)).toBe(false);
    expect(shouldCompactContext(MESSAGES, 120_000, 16_000, options.usageAnchor, options.maxOutputTokens)).toBe(true);

    const compacted = await compactAgentMessagesWithSummary(MESSAGES, options);
    expect(compacted.compacted).toBe(true);
  });

  it("uses a chars/3 delta only after the provider anchor", () => {
    const tail: AgentMessage[] = [{ role: "user", content: "x".repeat(18_000) }];
    expect(estimateMessageTokens(tail, 3)).toBe(6_000);
    expect(shouldCompactContext([...MESSAGES, ...tail], 120_000, 16_000, {
      inputTokens: 90_000,
      outputTokens: 1_000,
      messageCount: 3
    }, 8_000)).toBe(true);
  });

  it("folds old tool results without touching the newest ones", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "tool", toolCallId: "1", name: "shell", content: "a".repeat(10_000) },
      { role: "tool", toolCallId: "2", name: "shell", content: "b".repeat(10_000) }
    ];
    const result = microcompactMessages(messages, { maxToolChars: 1_000, keepRecentToolOutputs: 1 });

    expect(result.changed).toBe(true);
    expect(result.messages[1]?.role).toBe("tool");
    expect((result.messages[1] as { content: string }).content.length).toBeLessThan(10_000);
    expect((result.messages[2] as { content: string }).content).toBe("b".repeat(10_000));
  });

  it("replaces old stored tool outputs with a path placeholder and keeps the newest output", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "goal" },
      { role: "assistant", content: "", toolCalls: ["1", "2", "3", "4"].map((id) => ({ id, name: "shell", arguments: {}, rawArguments: "{}" })) },
      ...["1", "2", "3", "4"].map((id) => ({ role: "tool" as const, toolCallId: id, name: "shell", content: `${id}:${"x".repeat(5_000)}` }))
    ];
    const toolOutputs = Object.fromEntries(["1", "2", "3", "4"].map((id) => [id, { path: `C:/tmp/${id}.txt`, bytes: 5_001, tokens: 1_250 }]));
    const result = compactAgentMessages(messages, { maxChars: 10_000, keepRecent: 30, keepRecentToolOutputs: 1, toolOutputs });
    expect(result.compacted).toBe(true);
    const tools = result.messages.filter((message) => message.role === "tool") as Array<{ toolCallId: string; content: string }>;
    expect(tools[0]?.content).toContain("tool result pruned");
    expect(tools[0]?.content).toContain("C:/tmp/1.txt");
    expect(tools[0]?.content).toContain("callId: 1");
    expect(tools[1]?.content).toContain("C:/tmp/2.txt");
    expect(tools[3]?.content).toBe("4:" + "x".repeat(5_000));
  });

  it("drops orphan tool results left behind by summarized turns", async () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "goal" },
      { role: "assistant", content: "", toolCalls: [{ id: "old-call", name: "read_file", arguments: {}, rawArguments: "{}" }] },
      { role: "tool", toolCallId: "old-call", name: "read_file", content: "old result".repeat(3_000) },
      { role: "user", content: "continue ".repeat(2_000) },
      { role: "tool", toolCallId: "orphan-call", name: "shell", content: "orphan" }
    ];
    const compacted = await compactAgentMessagesWithSummary(messages, {
      contextWindowTokens: 4_096,
      reserveTokens: 512,
      recentTokens: 1
    });
    expect(compacted.compacted).toBe(true);
    const toolIds = compacted.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId);
    expect(toolIds).not.toContain("orphan-call");
  });
});

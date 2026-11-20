import { describe, expect, it } from "vitest";
import { compactAgentMessagesWithSummary, estimateMessageTokens, shouldCompactContext } from "./compaction.ts";
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
});

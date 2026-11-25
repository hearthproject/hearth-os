import { describe, expect, it } from "vitest";
import { openAiChatReasoningFields, responsesReasoningFields } from "./model-client.ts";

describe("reasoning request fields", () => {
  it("disables thinking on DeepSeek when effort is off", () => {
    expect(openAiChatReasoningFields("https://api.deepseek.com", "off")).toEqual({ thinking: { type: "disabled" } });
  });

  it("omits the off switch for providers that do not document it", () => {
    expect(openAiChatReasoningFields("https://api.openai.com/v1", "off")).toEqual({});
    expect(responsesReasoningFields("off")).toEqual({});
  });

  it("sends the effort level as reasoning_effort when thinking is on", () => {
    expect(openAiChatReasoningFields("https://api.deepseek.com", "minimal")).toEqual({ reasoning_effort: "minimal" });
    expect(responsesReasoningFields("high")).toEqual({ reasoning: { effort: "high" } });
  });

  it("sends nothing when no effort is configured", () => {
    expect(openAiChatReasoningFields("https://api.deepseek.com", undefined)).toEqual({});
    expect(responsesReasoningFields(undefined)).toEqual({});
  });
});

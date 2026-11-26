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

  describe("GLM thinking fields", () => {
    const url = "https://open.bigmodel.cn/api/paas/v4";

    it("maps GLM-5.3 efforts to low/high/max with forced thinking", () => {
      expect(openAiChatReasoningFields(url, "low", "glm-5.3")).toEqual({
        thinking: { type: "enabled" }, reasoning_effort: "low"
      });
      expect(openAiChatReasoningFields(url, "high", "glm-5.3")).toEqual({
        thinking: { type: "enabled" }, reasoning_effort: "high"
      });
      expect(openAiChatReasoningFields(url, "max", "glm-5.3")).toEqual({
        thinking: { type: "enabled" }, reasoning_effort: "max"
      });
    });

    it("never disables thinking on models that force it", () => {
      expect(openAiChatReasoningFields(url, "off", "glm-5.3")).toEqual({
        thinking: { type: "enabled" }, reasoning_effort: "low"
      });
    });

    it("uses legacy effort values on GLM-5.2", () => {
      expect(openAiChatReasoningFields(url, "minimal", "glm-5.2")).toEqual({
        thinking: { type: "enabled" }, reasoning_effort: "minimal"
      });
      expect(openAiChatReasoningFields(url, "off", "glm-5.2")).toEqual({
        thinking: { type: "disabled" }
      });
    });

    it("only sends the thinking switch on GLM models without effort levels", () => {
      expect(openAiChatReasoningFields(url, "high", "glm-5.1")).toEqual({
        thinking: { type: "enabled" }
      });
      expect(openAiChatReasoningFields(url, "off", "glm-4.6")).toEqual({
        thinking: { type: "disabled" }
      });
    });

    it("detects GLM by model name on custom endpoints", () => {
      expect(openAiChatReasoningFields("https://proxy.example.com/v1", "low", "glm-5.3")).toEqual({
        thinking: { type: "enabled" }, reasoning_effort: "low"
      });
    });
  });
});

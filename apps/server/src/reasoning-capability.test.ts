import { describe, expect, it } from "vitest";
import { reasoningCapabilityFor, reasoningCapabilityView } from "./reasoning-capability.ts";
import { openAiChatReasoningFields, reasoningFieldsFor } from "./model-client.ts";

const url = "https://open.bigmodel.cn/api/paas/v4";

describe("reasoning capability table", () => {
  it("only advertises low/high/max on forced-thinking GLM models", () => {
    for (const model of ["glm-5.3", "glm-5.3-flash", "glm-5.4", "glm-6"]) {
      const cap = reasoningCapabilityFor(model, url);
      expect(cap.family).toBe("glm");
      expect(cap.levels).toEqual(["low", "high", "max"]);
      expect(cap.canDisable).toBe(false);
      expect(cap.supportsEffort).toBe(true);
      expect(cap.defaultLevel).toBe("max");
      expect(cap.source).toBe("catalog");
    }
  });

  it("recognises GLM on a custom endpoint by baseUrl", () => {
    const cap = reasoningCapabilityFor("my-alias", "https://proxy.example.com/v1");
    expect(cap.family).toBe("openai-compatible");
    const glm = reasoningCapabilityFor("my-alias", url);
    expect(glm.family).toBe("glm");
    expect(glm.source).toBe("endpoint");
  });

  it("exposes legacy effort levels for GLM-5.2", () => {
    const cap = reasoningCapabilityFor("glm-5.2", url);
    expect(cap.levels).toEqual(["off", "minimal", "medium", "high", "max"]);
    expect(cap.canDisable).toBe(true);
    expect(cap.nativeValues?.max).toBe("xhigh");
  });

  it("marks switch-only GLM models as not supporting effort", () => {
    const cap = reasoningCapabilityFor("glm-4.6", url);
    expect(cap.supportsEffort).toBe(false);
    expect(cap.canDisable).toBe(true);
  });

  it("uses the capability view for non-openai protocols", () => {
    expect(reasoningCapabilityFor("claude-x", "", "anthropic-messages").family).toBe("anthropic");
    expect(reasoningCapabilityFor("gemini-x", "", "gemini").family).toBe("gemini");
    expect(reasoningCapabilityFor("gpt-x", "https://api.openai.com/v1", "openai-responses").family).toBe("openai");
  });

  it("returns a self-describing view for the API", () => {
    const view = reasoningCapabilityView("glm-5.3-flash", url, "openai-chat");
    expect(view.model).toBe("glm-5.3-flash");
    expect(view.baseUrl).toBe(url);
    expect(view.protocol).toBe("openai-chat");
    expect(view.levels).toEqual(["low", "high", "max"]);
  });
});

describe("request fields follow the advertised capability", () => {
  it("degrades off to the lightest level when thinking cannot be disabled", () => {
    const cap = reasoningCapabilityFor("glm-5.3", url);
    expect(reasoningFieldsFor(cap, "off")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "low" });
    expect(openAiChatReasoningFields(url, "off", "glm-5.3")).toEqual(reasoningFieldsFor(cap, "off"));
  });

  it("never offers a level that is not in the capability list", () => {
    const cap = reasoningCapabilityFor("glm-5.3-flash", url);
    for (const level of cap.levels) {
      const fields = openAiChatReasoningFields(url, level, "glm-5.3-flash");
      expect(fields).toHaveProperty("thinking");
      expect(fields.reasoning_effort).toBe(level);
    }
  });
});

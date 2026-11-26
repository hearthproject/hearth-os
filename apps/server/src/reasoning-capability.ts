import type { ModelProtocol, ReasoningCapability, ReasoningCapabilityView, ReasoningEffort } from "@hearth/core";

/**
 * Single source of truth for reasoning/thinking capabilities.
 * Both the request-field builder and the public capability endpoint read this
 * table, so the UI can only offer effort levels that the model actually accepts.
 */
const FORCED_GLM_LEVELS: ReasoningEffort[] = ["low", "high", "max"];
const LEGACY_GLM_LEVELS: ReasoningEffort[] = ["off", "minimal", "medium", "high", "max"];
const FULL_LEVELS: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "max"];

export function isGlmModel(model: string): boolean {
  return /^glm-/i.test(model.trim());
}

/** GLM models that think unconditionally and reject thinking:disabled. */
export function isForcedThinkingGlm(model: string): boolean {
  return /^glm-(5\.3|5\.4|5\.5|6\b)/i.test(model.trim());
}

/** GLM-5.2 accepts the legacy effort vocabulary (minimal/medium/high/xhigh). */
export function isLegacyEffortGlm(model: string): boolean {
  return /^glm-5\.2(?:\D|$)/i.test(model.trim());
}

export function reasoningCapabilityFor(
  model: string,
  baseUrl: string,
  protocol: ModelProtocol = "openai-chat"
): ReasoningCapability {
  const trimmedModel = model.trim();
  const glm = isGlmModel(trimmedModel) || /bigmodel\.cn/i.test(baseUrl);

  if (protocol === "anthropic-messages") {
    return {
      family: "anthropic",
      levels: ["off", "low", "medium", "high", "max"],
      defaultLevel: "high",
      canDisable: true,
      supportsEffort: true,
      note: "Claude 使用 output_config.effort；关闭档取消思考，其余档位直接下发。",
      source: "fallback"
    };
  }
  if (protocol === "gemini") {
    return {
      family: "gemini",
      levels: ["minimal", "low", "medium", "high", "max"],
      defaultLevel: "high",
      canDisable: false,
      supportsEffort: true,
      note: "Gemini 通过 thinking_level 控制思考，不支持完全关闭。",
      source: "fallback"
    };
  }
  if (protocol === "openai-responses") {
    return {
      family: "openai",
      levels: ["off", "low", "medium", "high", "max"],
      defaultLevel: "medium",
      canDisable: true,
      supportsEffort: true,
      note: "Responses API 使用 reasoning.effort；可用档位以模型为准。",
      source: "fallback"
    };
  }

  if (glm) {
    if (isForcedThinkingGlm(trimmedModel)) {
      return {
        family: "glm",
        levels: FORCED_GLM_LEVELS,
        defaultLevel: "max",
        canDisable: false,
        supportsEffort: true,
        note: "该模型强制开启思考，只接受 low / high / max；界面上的关闭/极简/中会自动降为 low/high。",
        source: isGlmModel(trimmedModel) ? "catalog" : "endpoint"
      };
    }
    if (isLegacyEffortGlm(trimmedModel)) {
      return {
        family: "glm",
        levels: LEGACY_GLM_LEVELS,
        defaultLevel: "max",
        canDisable: true,
        supportsEffort: true,
        nativeValues: {
          off: "disabled", minimal: "minimal", low: "minimal",
          medium: "medium", high: "high", max: "xhigh"
        },
        note: "GLM-5.2 使用 minimal / medium / high / xhigh；界面的低对应 minimal、极高对应 xhigh，关闭档关闭思考。",
        source: "catalog"
      };
    }
    return {
      family: "glm",
      levels: ["off", "high"],
      defaultLevel: "high",
      canDisable: true,
      supportsEffort: false,
      note: "该 GLM 模型只有思考开关，不区分强度；关闭档关闭思考，其余档开启思考。",
      source: isGlmModel(trimmedModel) ? "catalog" : "endpoint"
    };
  }

  if (/deepseek/i.test(baseUrl) || /^deepseek/i.test(trimmedModel)) {
    return {
      family: "deepseek",
      levels: FULL_LEVELS,
      defaultLevel: "max",
      canDisable: true,
      supportsEffort: true,
      note: "DeepSeek 用 thinking 开关控制思考，并用 reasoning_effort 控制强度。",
      source: /^deepseek/i.test(trimmedModel) ? "catalog" : "endpoint"
    };
  }
  if (/api\.openai\.com/i.test(baseUrl)) {
    return {
      family: "openai",
      levels: ["off", "minimal", "low", "medium", "high", "max"],
      defaultLevel: "high",
      canDisable: false,
      supportsEffort: true,
      note: "OpenAI 兼容接口按 reasoning_effort 下发；关闭档不发送该字段。",
      source: "endpoint"
    };
  }
  return {
    family: "openai-compatible",
    levels: FULL_LEVELS,
    defaultLevel: "max",
    canDisable: false,
    supportsEffort: true,
    note: "通用 OpenAI 兼容接口：按 reasoning_effort 下发，关闭档不发送该字段；实际档位以服务商为准。",
    source: "fallback"
  };
}

/** Build the public view for a given model configuration. */
export function reasoningCapabilityView(
  model: string,
  baseUrl: string,
  protocol: ModelProtocol = "openai-chat"
): ReasoningCapabilityView {
  return { ...reasoningCapabilityFor(model, baseUrl, protocol), model, baseUrl, protocol };
}

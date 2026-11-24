/**
 * 模型档案的统一默认值。上下文窗口属于模型本身，不应因为接口协议不同而变化。
 * 未知模型按 256K 起步；已知模型（如 deepseek-flash）由
 * `suggestContextWindowTokens` 给出各自的真实窗口。
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;

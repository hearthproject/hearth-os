/**
 * Context-window arithmetic shared by the server, the web UI, and the
 * executors. A model's window is a property of the model itself, never of the
 * wire protocol or of the executor that happens to run it.
 */

export const CONTEXT_COMPACT_RATIO = 0.8;
export const MIN_CONTEXT_WINDOW_TOKENS = 4_096;

const EXPLICIT_WINDOW_SUFFIXES: Array<[RegExp, number]> = [
  [/(?:^|[-_.])(?:1m|1000k|1\s*million)(?:$|[-_.])/i, 1_000_000],
  [/(?:^|[-_.])(?:256k|262144)(?:$|[-_.])/i, 256_000],
  [/(?:^|[-_.])(?:200k|200000)(?:$|[-_.])/i, 200_000],
  [/(?:^|[-_.])(?:128k|131072)(?:$|[-_.])/i, 128_000],
  [/(?:^|[-_.])(?:32k|32768)(?:$|[-_.])/i, 32_000]
];

/**
 * Known model families whose public context window differs from the generic
 * profile default. Keep this list deliberately small: a wrong guess is worse
 * than letting the user's profile value win.
 */
const KNOWN_MODEL_WINDOWS: Array<[RegExp, number]> = [
  // DeepSeek V4/V4.1 Flash (official id `deepseek-flash`) is a 1M model.
  [/deepseek[-_.]?(?:v\d+(?:[.\-]\d+)?[-_.]?)?flash/i, 1_000_000]
];

export interface ContextWindowSettingsLike {
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
}

export interface ContextWindowPolicy {
  /** Effective window advertised by the profile/model. */
  contextWindowTokens: number;
  /** Per-request output reserve. */
  maxOutputTokens: number;
  /** Compaction trigger as a fraction of the window. */
  compactRatio: number;
  /** Absolute token count at which compaction starts (80% by default). */
  compactThresholdTokens: number;
  /** Prompt budget remaining after output + headroom reserves. */
  inputBudgetTokens: number;
  /** Recent conversation tail retained by Hearth conversation compaction. */
  keepTokens: number;
  /** Maximum summary size produced by Hearth conversation compaction. */
  summaryMaxTokens: number;
}

function clampWindow(value: number | null | undefined, fallback: number): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  const window = candidate > 0 ? candidate : fallback;
  return Math.max(MIN_CONTEXT_WINDOW_TOKENS, window);
}

/**
 * Returns a model-specific window hint when the model id carries one, otherwise
 * the caller's fallback. This is used when a profile is created or when a model
 * name is changed; it never silently rewrites a larger manual value.
 */
export function suggestContextWindowTokens(
  model: string | null | undefined,
  fallback: number = 256_000
): number {
  const id = (model ?? "").trim();
  if (!id) return clampWindow(fallback, fallback);
  for (const [pattern, tokens] of KNOWN_MODEL_WINDOWS) {
    if (pattern.test(id)) return tokens;
  }
  for (const [pattern, tokens] of EXPLICIT_WINDOW_SUFFIXES) {
    if (pattern.test(id)) return tokens;
  }
  return clampWindow(fallback, fallback);
}

/**
 * Derive every context number from the active model profile.
 *
 * The 80% trigger is evaluated against the raw window. The prompt budget is
 * slightly lower than the trigger so the provider still has room for the
 * output and a safety headroom. This is the only place those numbers should be
 * computed; callers must not add their own fixed 12K/8K budgets.
 */
export function resolveContextWindowPolicy(
  settings: ContextWindowSettingsLike | null | undefined,
  options: { compactRatio?: number | null; fallbackWindowTokens?: number } = {}
): ContextWindowPolicy {
  const fallbackWindow = clampWindow(options.fallbackWindowTokens ?? 256_000, 256_000);
  const window = clampWindow(settings?.contextWindowTokens, fallbackWindow);
  const requestedOutput = typeof settings?.maxOutputTokens === "number" && Number.isFinite(settings.maxOutputTokens)
    ? Math.floor(settings.maxOutputTokens)
    : 8_000;
  const maxOutput = Math.max(256, Math.min(requestedOutput, Math.max(256, window - MIN_CONTEXT_WINDOW_TOKENS)));
  const ratio = typeof options.compactRatio === "number" && Number.isFinite(options.compactRatio)
    ? Math.min(0.95, Math.max(0.5, options.compactRatio))
    : CONTEXT_COMPACT_RATIO;
  const compactThresholdTokens = Math.max(MIN_CONTEXT_WINDOW_TOKENS, Math.floor(window * ratio));
  const headroom = Math.max(4_000, Math.floor(window * 0.15));
  const inputBudgetTokens = Math.max(
    MIN_CONTEXT_WINDOW_TOKENS,
    Math.min(compactThresholdTokens, window - maxOutput - headroom)
  );
  const keepTokens = Math.max(2_000, Math.min(Math.floor(window * 0.15), 200_000));
  const summaryMaxTokens = Math.min(32_768, Math.max(2_048, Math.floor(window * 0.03)));
  return {
    contextWindowTokens: window,
    maxOutputTokens: maxOutput,
    compactRatio: ratio,
    compactThresholdTokens,
    inputBudgetTokens,
    keepTokens,
    summaryMaxTokens
  };
}

/**
 * Budget for the shared conversation brief injected into a task executor. The
 * remaining window belongs to the executor's own system prompt, tools and
 * internal transcript, so Hearth deliberately hands over less than the full
 * prompt budget. Executor-internal compaction is still allowed to run as a
 * second line of defence.
 */
export function taskContextBudgetTokens(policy: ContextWindowPolicy): number {
  const reserve = Math.max(8_000, Math.floor(policy.contextWindowTokens * 0.1));
  return Math.max(MIN_CONTEXT_WINDOW_TOKENS, policy.inputBudgetTokens - reserve);
}

// Structured failure codes shared by the runtime, native executor and scheduler.

export type AgentFailureCode =
  | "MODEL_RATE_LIMIT"
  | "MODEL_CAPACITY"
  | "MODEL_TIMEOUT"
  | "MODEL_TRANSPORT"
  | "MODEL_AUTH"
  | "MODEL_CONTEXT_OVERFLOW"
  | "MODEL_BAD_REQUEST"
  | "TOOL_TIMEOUT"
  | "TOOL_ABORTED"
  | "TOOL_ORPHANED"
  | "TOOL_EXEC_FAILED"
  | "SANDBOX_DENIED"
  | "SANDBOX_RUNNER_FAILURE"
  | "CHECKPOINT_FAILED"
  | "JOURNAL_FAILED"
  | "STALLED"
  | "VALIDATION_FAILED"
  | "INTERRUPTED"
  | "INTERNAL";

export interface AgentFailure {
  code: AgentFailureCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  detail?: unknown;
}

export interface AgentToolError {
  code: AgentFailureCode;
  retryable?: boolean;
  retryAfterMs?: number;
  detail?: unknown;
}

const RETRYABLE_MODEL_CODES = new Set<AgentFailureCode>([
  "MODEL_RATE_LIMIT",
  "MODEL_CAPACITY",
  "MODEL_TIMEOUT",
  "MODEL_TRANSPORT"
]);

const RETRYABLE_TOOL_CODES = new Set<AgentFailureCode>([
  "TOOL_TIMEOUT",
  "TOOL_ORPHANED",
  "TOOL_EXEC_FAILED"
]);

export function isRetryableFailureCode(code: AgentFailureCode): boolean {
  return RETRYABLE_MODEL_CODES.has(code) || RETRYABLE_TOOL_CODES.has(code);
}

export function modelFailureCode(error: unknown): AgentFailureCode {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof record.status === "number" ? record.status : null;
  const code = typeof record.code === "string" ? record.code : "";
  const message = error instanceof Error
    ? error.message
    : typeof record.message === "string" ? record.message : String(error);
  if (isContextOverflowMessage(message) || status === 413) return "MODEL_CONTEXT_OVERFLOW";
  if (status === 401 || status === 403 || code === "EAUTH" || /unauthorized|invalid api key|authentication/i.test(message)) return "MODEL_AUTH";
  if (/upstream_error|upstream error|could not be completed|bad gateway|gateway timeout|service unavailable/i.test(message) || code === "upstream_error") return "MODEL_TRANSPORT";
  if (status === 429 || code === "EMODELRATE" || /rate limit|too many requests|限流/i.test(message)) return "MODEL_RATE_LIMIT";
  if (status === 408) return "MODEL_TIMEOUT";
  if (status !== null && status >= 500 && status <= 599) {
    return /overload|capacity|quota|过载|配额/i.test(message) ? "MODEL_CAPACITY" : "MODEL_TRANSPORT";
  }
  if (/ETIMEDOUT|timed? ?out|timeout|超时/i.test(message)) return "MODEL_TIMEOUT";
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network error|网络|断连/i.test(message)) return "MODEL_TRANSPORT";
  if (status === 400 || status === 422) return "MODEL_BAD_REQUEST";
  return "INTERNAL";
}

export function modelRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const direct = record.retryAfterMs;
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  const nested = record.detail && typeof record.detail === "object" ? record.detail as Record<string, unknown> : {};
  const nestedValue = nested.retryAfterMs;
  if (typeof nestedValue === "number" && Number.isFinite(nestedValue) && nestedValue > 0) return Math.floor(nestedValue);
  return undefined;
}

export function normalizeModelFailure(error: unknown): AgentFailure {
  const code = modelFailureCode(error);
  const retryAfterMs = modelRetryAfterMs(error);
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return {
    code,
    message: error instanceof Error ? error.message : typeof record.message === "string" ? record.message : String(error),
    retryable: isRetryableFailureCode(code),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  };
}

export function normalizeToolFailure(error: unknown, fallback: AgentFailureCode = "TOOL_EXEC_FAILED"): AgentFailure {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof record.code === "string" && isAgentFailureCode(record.code)
    ? record.code
    : fallback;
  const retryAfterMs = modelRetryAfterMs(error);
  return {
    code,
    message: error instanceof Error ? error.message : typeof record.message === "string" ? record.message : String(error),
    retryable: typeof record.retryable === "boolean" ? record.retryable : isRetryableFailureCode(code),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(record.detail !== undefined ? { detail: record.detail } : {})
  };
}

export function isAgentFailureCode(value: string): value is AgentFailureCode {
  return value === "MODEL_RATE_LIMIT"
    || value === "MODEL_CAPACITY"
    || value === "MODEL_TIMEOUT"
    || value === "MODEL_TRANSPORT"
    || value === "MODEL_AUTH"
    || value === "MODEL_CONTEXT_OVERFLOW"
    || value === "MODEL_BAD_REQUEST"
    || value === "TOOL_TIMEOUT"
    || value === "TOOL_ABORTED"
    || value === "TOOL_ORPHANED"
    || value === "TOOL_EXEC_FAILED"
    || value === "SANDBOX_DENIED"
    || value === "SANDBOX_RUNNER_FAILURE"
    || value === "CHECKPOINT_FAILED"
    || value === "JOURNAL_FAILED"
    || value === "STALLED"
    || value === "VALIDATION_FAILED"
    || value === "INTERRUPTED"
    || value === "INTERNAL";
}

function isContextOverflowMessage(message: string): boolean {
  return /context[_ ]length|context window|maximum context|too many tokens|prompt is too long|input is too long|token limit/i.test(message);
}

import type { TaskProgressDetail } from "@hearth/core";

const MAX_FIELD_CHARS = 8_000;
const MAX_TOTAL_CHARS = 24_000;

const SECRET_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED PRIVATE KEY]" },
  { pattern: /\b(sk-[A-Za-z0-9_-]{12,})\b/g, replacement: "sk-[REDACTED]" },
  { pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, replacement: "gh_[REDACTED]" },
  { pattern: /\b(AKIA[0-9A-Z]{16})\b/g, replacement: "AKIA[REDACTED]" },
  { pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "$1[REDACTED]" },
  {
    pattern: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|authorization|token)\b(\s*[:=]\s*)(["']?)([^\s"',;}]{4,})/gi,
    replacement: "$1$2$3[REDACTED]"
  },
  {
    pattern: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)=([^\s"';]{4,})/g,
    replacement: "$1=[REDACTED]"
  }
];

export function redactProgressText(value: string): string {
  let text = value;
  for (const { pattern, replacement } of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

export function sanitizeProgressDetail(detail: TaskProgressDetail | null | undefined): TaskProgressDetail | undefined {
  if (!detail) return undefined;
  const cleaned = redactValue(detail) as TaskProgressDetail;
  const json = safeStringify(cleaned);
  if (json.length <= MAX_TOTAL_CHARS) return cleaned;
  return {
    ...cleaned,
    ...(cleaned.output === undefined ? {} : { output: clip(cleaned.output, 4_000) ?? "" }),
    ...(cleaned.text === undefined ? {} : { text: clip(cleaned.text, 4_000) ?? "" }),
    ...(cleaned.input === undefined ? {} : { input: clip(safeStringify(cleaned.input), 2_000) ?? "" }),
    truncated: true
  };
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return clip(redactProgressText(value), MAX_FIELD_CHARS);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSecretKey(key) ? "[REDACTED]" : redactValue(item);
    }
    return result;
  }
  return value;
}

function isSecretKey(key: string): boolean {
  return /^(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|authorization|token)$/i.test(key);
}

function clip(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

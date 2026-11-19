import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface TruncatedText {
  content: string;
  truncated: boolean;
  fullOutputPath?: string;
}

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_API_KEY]" },
  { pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED_AWS_KEY]" },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "[REDACTED_SLACK_TOKEN]" },
  { pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY]" },
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, replacement: "$1[REDACTED]" },
  { pattern: /([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, replacement: "$1[REDACTED]" },
  { pattern: /((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{12,}/gi, replacement: "$1[REDACTED]" }
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

export function truncateToolOutput(text: string, options: { maxChars?: number; maxLines?: number; label?: string } = {}): TruncatedText {
  const maxChars = options.maxChars ?? 8_000;
  const maxLines = options.maxLines ?? 240;
  const normalized = redactSecrets(text).replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.length <= maxChars && lines.length <= maxLines) return { content: normalized, truncated: false };

  const headLines = Math.max(1, Math.floor(maxLines * 0.6));
  const tailLines = Math.max(1, maxLines - headLines);
  const head = lines.slice(0, headLines).join("\n").slice(0, Math.floor(maxChars * 0.6));
  const tail = lines.slice(Math.max(headLines, lines.length - tailLines)).join("\n").slice(-Math.floor(maxChars * 0.35));
  const omittedLines = Math.max(0, lines.length - headLines - tailLines);
  const content = [
    head,
    `\n[... ${omittedLines} lines / ${Math.max(0, normalized.length - head.length - tail.length)} chars omitted; ${options.label ?? "use a narrower command or offset"} ...]\n`,
    tail
  ].join("");
  return { content, truncated: true };
}

export function writeFullToolOutput(outDir: string, name: string, text: string): string {
  const directory = join(outDir, ".hearth", "tool-outputs");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${sanitize(name)}-${randomUUID().slice(0, 8)}.log`);
  writeFileSync(path, text, "utf8");
  return path;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "output";
}

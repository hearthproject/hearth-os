import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface TruncatedText {
  content: string;
  truncated: boolean;
  fullOutputPath?: string;
}

export function truncateToolOutput(text: string, options: { maxChars?: number; maxLines?: number; label?: string } = {}): TruncatedText {
  const maxChars = options.maxChars ?? 8_000;
  const maxLines = options.maxLines ?? 240;
  const normalized = text.replace(/\r\n/g, "\n");
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

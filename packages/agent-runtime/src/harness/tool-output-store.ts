import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_INLINE_CHARS = 16_000;
const HEAD_CHARS = 8_000;
const TAIL_CHARS = 4_000;

export interface StoredToolResult {
  content: string;
  fullOutputPath: string | null;
}

export function storeOversizedToolResult(outDir: string, name: string, content: string): StoredToolResult {
  if (content.length <= MAX_INLINE_CHARS) return { content, fullOutputPath: null };
  const normalized = content.replace(/\r\n/g, "\n");
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  const directory = join(outDir, ".hearth", "tool-results");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${digest}.txt`);
  if (!existsSync(path)) {
    const temp = `${path}.tmp`;
    writeFileSync(temp, normalized, "utf8");
    renameSync(temp, path);
  }
  const omitted = Math.max(0, normalized.length - HEAD_CHARS - TAIL_CHARS);
  return {
    content: [
      normalized.slice(0, HEAD_CHARS),
      `\n\n[... ${omitted} chars omitted from ${name}; full output: ${path.replace(/\\/g, "/")} ...]\n\n`,
      normalized.slice(-TAIL_CHARS)
    ].join(""),
    fullOutputPath: path
  };
}

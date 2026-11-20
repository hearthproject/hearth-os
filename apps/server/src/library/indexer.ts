import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, normalize } from "node:path";
import { extractSourceBytes } from "@hearth/agent-runtime";
import type { LibraryNode } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";
import { redactSecrets } from "../context.ts";
import type { LibraryChunkInput, LibraryRepository } from "./repository.ts";
import type { LibraryTreeService } from "./tree.ts";

const DEFAULT_MAX_CHARS = 1_000;
const DEFAULT_OVERLAP_CHARS = 150;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build"
]);

const EXCLUDED_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx|kdbx)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^master\.key$/i,
  /^credentials?(?:\.|$)/i,
  /^secrets?(?:\.|$)/i,
  /^cookies?(?:\.|$)/i,
  /^auth\.json$/i,
  /^wallet\.dat$/i
];

export interface LibraryChunkDraft {
  text: string;
  startOffset: number;
  endOffset: number;
  tokenCount: number;
  contentHash: string;
}

export interface LibraryIndexDocument {
  content: string;
  contentHash: string;
  extractor: string;
  language: string | null;
}

export interface LibraryIndexResult {
  indexed: number;
  unchanged: number;
  skipped: number;
  failed: number;
  chunks: number;
  errors: Array<{ nodeId: string; message: string }>;
}

export interface LibraryIndexerOptions {
  maxChars?: number;
  overlapChars?: number;
  maxFileBytes?: number;
  readFile?: (path: string) => Uint8Array;
}

interface ResolvedLibraryIndexerOptions {
  maxChars: number;
  overlapChars: number;
  maxFileBytes: number;
  readFile?: (path: string) => Uint8Array;
}

export class LibraryIndexer {
  private readonly store: HearthStore;
  private readonly tree: LibraryTreeService;
  private readonly repository: LibraryRepository;
  private readonly options: ResolvedLibraryIndexerOptions;

  constructor(store: HearthStore, tree: LibraryTreeService, options: LibraryIndexerOptions = {}) {
    this.store = store;
    this.tree = tree;
    this.repository = tree.repository;
    this.options = {
      maxChars: Math.max(200, options.maxChars ?? DEFAULT_MAX_CHARS),
      overlapChars: Math.max(0, options.overlapChars ?? DEFAULT_OVERLAP_CHARS),
      maxFileBytes: Math.max(1_024, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES),
      ...(options.readFile ? { readFile: options.readFile } : {})
    };
    if (this.options.overlapChars >= this.options.maxChars) {
      throw new Error("library chunk overlap must be smaller than chunk size");
    }
  }

  async indexAll(): Promise<LibraryIndexResult> {
    this.tree.syncAll();
    const nodes = this.repository.listNodes({ limit: 10_000 });
    const result: LibraryIndexResult = { indexed: 0, unchanged: 0, skipped: 0, failed: 0, chunks: 0, errors: [] };
    for (const node of nodes) {
      const item = await this.indexNode(node);
      result[item.status] += 1;
      result.chunks += item.chunks;
      if (item.error) result.errors.push({ nodeId: node.id, message: item.error });
    }
    return result;
  }

  async indexNode(node: LibraryNode): Promise<{ status: "indexed" | "unchanged" | "skipped" | "failed"; chunks: number; error?: string }> {
    if (node.sensitivity === "secret") return { status: "skipped", chunks: 0 };
    const source = this.resolveSource(node);
    if (!source) {
      this.repository.deleteDocument(node.id);
      return { status: "skipped", chunks: 0 };
    }
    if (source.path && isSensitivePath(source.path)) {
      this.repository.deleteDocument(node.id);
      this.repository.updateNode(node.id, { status: "blocked", updatedAt: new Date().toISOString() });
      return { status: "skipped", chunks: 0 };
    }

    try {
      const document = await this.extractDocument(source);
      if (!document.content.trim()) {
        this.repository.deleteDocument(node.id);
        return { status: "skipped", chunks: 0 };
      }
      const previous = this.repository.getDocument(node.id);
      if (previous?.contentHash === document.contentHash && previous.extractor === document.extractor) {
        this.repository.updateNode(node.id, { status: "ready", updatedAt: new Date().toISOString() });
        return { status: "unchanged", chunks: this.repository.listChunks(node.id).length };
      }

      const drafts = chunkText(document.content, this.options.maxChars, this.options.overlapChars);
      const maxChunks = this.repository.getSettings().maxChunksPerNode;
      const chunks: LibraryChunkInput[] = drafts.slice(0, maxChunks).map((chunk, ordinal) => ({
        id: createHash("sha256").update(`${node.id}:${ordinal}:${chunk.contentHash}`).digest("hex").slice(0, 32),
        ordinal,
        text: chunk.text,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        tokenCount: chunk.tokenCount,
        contentHash: chunk.contentHash
      }));

      this.repository.upsertDocument({
        nodeId: node.id,
        content: document.content,
        contentHash: document.contentHash,
        extractor: document.extractor,
        language: document.language,
        charCount: document.content.length,
        updatedAt: new Date().toISOString()
      });
      this.repository.replaceChunks(node.id, chunks);
      this.repository.updateNode(node.id, {
        status: "ready",
        sizeBytes: Buffer.byteLength(document.content, "utf8"),
        contentHash: document.contentHash,
        updatedAt: new Date().toISOString()
      });
      this.repository.markSummaryStale(node.id);
      return { status: "indexed", chunks: chunks.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repository.updateNode(node.id, { status: "error", updatedAt: new Date().toISOString() });
      return { status: "failed", chunks: 0, error: message };
    }
  }

  private resolveSource(node: LibraryNode): { path: string | null; inline: string | null; fileName: string; extractor: string } | null {
    if (node.kind === "memory") {
      const content = typeof node.metadata.content === "string" ? node.metadata.content : "";
      return { path: null, inline: content, fileName: `${node.title}.md`, extractor: "memory" };
    }
    if (node.kind === "task") {
      const goal = typeof node.metadata.goal === "string" ? node.metadata.goal : "";
      const summary = typeof node.metadata.resultSummary === "string" ? node.metadata.resultSummary : "";
      return { path: null, inline: `# ${node.title}\n\n${goal}\n\n${summary}`.trim(), fileName: `${node.title}.md`, extractor: "task" };
    }
    if (node.kind === "source") {
      const sourceItemId = typeof node.metadata.sourceItemId === "string" ? node.metadata.sourceItemId : null;
      if (!sourceItemId) return null;
      const item = this.store.getSourceItem(sourceItemId);
      if (!item?.contentPath || item.status !== "ready") return null;
      return { path: item.contentPath, inline: null, fileName: item.locator || item.title || item.itemKey, extractor: "source" };
    }
    if (node.kind === "artifact") {
      const absolutePath = typeof node.metadata.absolutePath === "string" ? node.metadata.absolutePath : null;
      const relativePath = typeof node.metadata.relativePath === "string" ? node.metadata.relativePath : node.title;
      if (!absolutePath) return null;
      return { path: absolutePath, inline: null, fileName: relativePath, extractor: "artifact" };
    }
    if (node.kind === "skill") {
      const skillPath = typeof node.metadata.path === "string" ? node.metadata.path : null;
      if (!skillPath || !existsSync(skillPath)) return null;
      const actual = statSync(skillPath).isDirectory() ? join(skillPath, "SKILL.md") : skillPath;
      if (!existsSync(actual)) return null;
      return { path: actual, inline: null, fileName: basename(actual), extractor: "skill" };
    }
    const filePath = typeof node.metadata.absolutePath === "string" ? node.metadata.absolutePath : null;
    if (node.kind === "file" && filePath) return { path: filePath, inline: null, fileName: node.title, extractor: "file" };
    return null;
  }

  private async extractDocument(source: { path: string | null; inline: string | null; fileName: string; extractor: string }): Promise<LibraryIndexDocument> {
    let content: string;
    let extractor = source.extractor;
    if (source.path) {
      const path = normalize(source.path);
      const size = statSync(path).size;
      const maxBytes = Math.min(this.options.maxFileBytes, this.repository.getSettings().maxFileBytes);
      if (size > maxBytes) throw new Error(`文件超过 ${maxBytes} 字节，未加入资料库`);
      const bytes = this.options.readFile?.(path) ?? readFileSync(path);
      const extension = extname(source.fileName).toLowerCase() || extname(path).toLowerCase();
      if ([".md", ".markdown", ".txt"].includes(extension)) {
        content = Buffer.from(bytes).toString("utf8");
        extractor = `${extractor}:text`;
      } else {
        const extracted = await extractSourceBytes(bytes, source.fileName);
        content = extracted.markdown;
        extractor = `${extractor}:${extension.slice(1) || "document"}`;
      }
    } else {
      content = source.inline ?? "";
    }
    const safe = redactSecrets(content.replace(/\r\n?/g, "\n")).trim();
    return {
      content: safe,
      contentHash: createHash("sha256").update(safe).digest("hex"),
      extractor,
      language: detectLanguage(safe)
    };
  }
}

export function chunkText(text: string, maxChars = DEFAULT_MAX_CHARS, overlapChars = DEFAULT_OVERLAP_CHARS): LibraryChunkDraft[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return [];
  if (normalized.length <= maxChars) {
    return [chunkDraft(normalized, 0, normalized.length)];
  }
  const chunks: LibraryChunkDraft[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + maxChars);
    if (end < normalized.length) {
      const minBoundary = start + Math.floor(maxChars * 0.6);
      const boundary = findBoundary(normalized, end, minBoundary);
      if (boundary > minBoundary) end = boundary;
    }
    let trimmedStart = start;
    let trimmedEnd = end;
    while (trimmedStart < trimmedEnd && /\s/.test(normalized[trimmedStart] ?? "")) trimmedStart += 1;
    while (trimmedEnd > trimmedStart && /\s/.test(normalized[trimmedEnd - 1] ?? "")) trimmedEnd -= 1;
    if (trimmedEnd > trimmedStart) chunks.push(chunkDraft(normalized.slice(trimmedStart, trimmedEnd), trimmedStart, trimmedEnd));
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

export function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.toLowerCase().split("/").filter(Boolean);
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) return true;
  if (segments.some((segment) => [".ssh", ".aws", ".azure", ".gnupg"].includes(segment))) return true;
  const name = segments.at(-1) ?? "";
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function findBoundary(text: string, proposedEnd: number, minimum: number): number {
  const searchStart = Math.max(minimum, proposedEnd - 240);
  const slice = text.slice(searchStart, proposedEnd);
  const punctuation = /[。！？!?；;\n]/g;
  let match: RegExpExecArray | null;
  let last = -1;
  while ((match = punctuation.exec(slice)) !== null) last = searchStart + match.index + 1;
  if (last > minimum) return last;
  const whitespace = slice.lastIndexOf(" ");
  return whitespace >= 0 ? searchStart + whitespace + 1 : proposedEnd;
}

function chunkDraft(text: string, startOffset: number, endOffset: number): LibraryChunkDraft {
  return {
    text,
    startOffset,
    endOffset,
    tokenCount: Math.max(1, Math.ceil([...text].length * 0.8)),
    contentHash: createHash("sha256").update(text).digest("hex")
  };
}

function detectLanguage(text: string): string | null {
  const han = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (han === 0 && latin === 0) return null;
  return han >= latin / 2 ? "zh" : "en";
}

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type { ChatAttachment } from "@hearth/core";

const MAX_SEARCH_ENTRIES = 8_000;
const MAX_SEARCH_DEPTH = 3;
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hearth",
  ".workbuddy",
  ".xhs_tmp",
  "node_modules",
  "AppData",
  "Application Data",
  "Library",
  "$Recycle.Bin",
  "System Volume Information",
  "Windows"
]);

const FILE_EXTENSION = /\.(pptx?|docx?|xlsx?|xlsm|csv|pdf|zip|rar|7z|tar|gz|txt|md|json|html?|png|jpe?g|gif|webp|bmp|svg|mp4|mov|avi|mkv|mp3|wav|m4a|apk|exe)$/i;

const TYPE_HINTS: Array<{ pattern: RegExp; extensions: string[] }> = [
  { pattern: /(?:ppt|幻灯片|演示文稿)$/i, extensions: [".ppt", ".pptx"] },
  { pattern: /(?:word|文档)$/i, extensions: [".doc", ".docx"] },
  { pattern: /(?:excel|表格)$/i, extensions: [".xls", ".xlsx", ".csv"] },
  { pattern: /(?:pdf)$/i, extensions: [".pdf"] },
  { pattern: /(?:图片|照片)$/i, extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"] },
  { pattern: /(?:视频)$/i, extensions: [".mp4", ".mov", ".avi", ".mkv"] }
];

export interface LocalFileRequest {
  /** User-facing file name fragment, without a trailing type word or extension. */
  query: string;
  /** Extensions implied by the request ("这个 PPT" -> .ppt/.pptx). */
  extensions: string[];
  original: string;
}

export interface LocalFileSearchOptions {
  roots: string[];
  hintPaths?: string[];
}

export interface LocalFileSearchResult {
  path: string;
  score: number;
  candidates: string[];
}

/**
 * Parse "把孙中山的一生这个PPT发给我" and similar file-send requests.
 * Returns null for generation requests such as "把方案写成 Word 发给我":
 * those must become a task, not a lookup of an existing file.
 */
export function parseLocalFileRequest(text: string): LocalFileRequest | null {
  const source = text.trim();
  if (!source) return null;
  const patterns = [
    /(?:把|将)\s*(.+?)\s*(?:发给我|发我|发送给我|传给我|发一下|发过来|传过来|发到我(?:这里)?|给我发)/,
    /^(?:发我|发给我|发送给我|传给我|给我发|帮我发)\s*(.+)$/,
    /(.+?)\s*(?:发给我|发我|发送给我|传给我|发一下|发过来|传过来)$/
  ];
  let target = "";
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      target = match[1].trim();
      break;
    }
  }
  if (!target) return null;

  // "把方案写成 Word 发给我" is authoring, not sending an existing file.
  if (/(?:写成|做成|生成|制作|整理|导出|转换|新建|创建)/.test(target)) return null;

  target = target
    .replace(/^(?:请|麻烦|帮我|给我)\s*/, "")
    .replace(/^["“”'‘’《》]+|["“”'‘’《》]+$/g, "")
    .replace(/[，。；;：:、!?！？]+$/g, "")
    .trim();
  if (!target || target.length > 120) return null;

  let extensions: string[] = [];
  let query = target;
  const explicitExtension = target.match(FILE_EXTENSION);
  if (explicitExtension) {
    extensions = [explicitExtension[0].toLowerCase()];
    query = target.slice(0, -explicitExtension[0].length);
  } else {
    const stripped = target.match(/(?:这个|那个|这份|那份)?\s*(ppt|幻灯片|演示文稿|word|文档|excel|表格|pdf|图片|照片|视频)\s*$/i);
    if (stripped?.[0]) {
      const typeWord = stripped[1] ?? "";
      const hint = TYPE_HINTS.find((item) => item.pattern.test(typeWord));
      extensions = hint?.extensions ?? [];
      query = target.slice(0, target.length - stripped[0].length);
    }
  }
  query = query.replace(/(?:这个|那个|这份|那份)$/g, "").trim();
  if (!query) return null;

  // Without an extension or a type word we still search: the phrase may name a
  // real file ("把季度财报发我"). If nothing matches, the chat path falls back.
  return { query, extensions, original: target };
}

/**
 * Search the user's visible document folders plus any paths already mentioned
 * in the conversation. The best match wins; up to three candidates are returned
 * so callers can ask for disambiguation when scores tie.
 */
export function searchLocalFile(request: LocalFileRequest, options: LocalFileSearchOptions): LocalFileSearchResult | null {
  const query = normalizeName(request.query);
  if (!query) return null;
  const matches = new Map<string, { path: string; score: number; mtime: number }>();
  const seenDirectories = new Set<string>();
  let visited = 0;

  const addCandidate = (path: string) => {
    if (!existsSync(path)) return;
    try {
      if (!statSync(path).isFile()) return;
    } catch {
      return;
    }
    const score = scoreFile(path, query, request.extensions);
    if (score <= 0) return;
    const absolute = resolve(path);
    const previous = matches.get(absolute);
    if (!previous || score > previous.score) {
      matches.set(absolute, { path: absolute, score, mtime: statSync(absolute).mtimeMs });
    }
  };

  for (const hint of options.hintPaths ?? []) {
    if (hint.trim()) addCandidate(hint.trim());
  }

  const roots = uniqueRoots(options.roots);
  for (const root of roots) {
    if (visited >= MAX_SEARCH_ENTRIES) break;
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length > 0 && visited < MAX_SEARCH_ENTRIES) {
      const current = stack.pop();
      if (!current) break;
      let real = "";
      try {
        real = resolve(current.dir);
        if (!seenDirectories.has(real.toLowerCase())) seenDirectories.add(real.toLowerCase());
        else continue;
        const entries = readdirSync(current.dir, { withFileTypes: true });
        for (const entry of entries) {
          if (visited >= MAX_SEARCH_ENTRIES) break;
          if (entry.name.startsWith("~$")) continue;
          const path = join(current.dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (current.depth >= MAX_SEARCH_DEPTH || SKIP_DIRECTORIES.has(entry.name)) continue;
            stack.push({ dir: path, depth: current.depth + 1 });
            continue;
          }
          if (!entry.isFile()) continue;
          visited += 1;
          addCandidate(path);
        }
      } catch {
        // Unreadable directory: skip it instead of failing the whole request.
      }
    }
  }

  const sorted = [...matches.values()]
    .sort((left, right) => right.score - left.score || right.mtime - left.mtime);
  if (sorted.length === 0) return null;
  return {
    path: sorted[0]!.path,
    score: sorted[0]!.score,
    candidates: sorted.slice(0, 3).map((item) => item.path)
  };
}

/** Copy an outbound file into the chat attachment directory and return its chip metadata. */
export function storeOutgoingAttachment(filePath: string, attachmentRoot: string): ChatAttachment {
  mkdirSync(attachmentRoot, { recursive: true });
  const source = resolve(filePath);
  const stat = statSync(source);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`文件不存在或为空：${filePath}`);
  const name = basename(source);
  const extension = extname(name).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
  const id = randomUUID();
  copyFileSync(source, join(attachmentRoot, `${id}${safeExtension}`));
  return {
    id,
    name: name.slice(0, 255),
    mimeType: mimeTypeForName(name),
    bytes: stat.size
  };
}

export function defaultLocalFileRoots(projectRoot?: string | null): string[] {
  const home = homedir();
  return [
    join(home, "Desktop"),
    join(home, "Downloads"),
    join(home, "Documents"),
    projectRoot ?? ""
  ].filter(Boolean);
}

export function extractFilePaths(text: string): string[] {
  const paths: string[] = [];
  const windowsPath = /(?:[A-Za-z]:[\\/]|\\\\)[^\n\r"'`<>|，。；]+?\.(?:pptx?|docx?|xlsx?|xlsm|csv|pdf|zip|rar|7z|tar|gz|txt|md|json|html?|png|jpe?g|gif|webp|bmp|svg|mp4|mov|avi|mkv|mp3|wav|m4a|apk|exe)/gi;
  for (const match of text.matchAll(windowsPath)) {
    if (match[0]) paths.push(match[0].trim());
  }
  return [...new Set(paths)];
}

function scoreFile(path: string, query: string, extensions: string[]): number {
  const name = basename(path);
  const extension = extname(name).toLowerCase();
  if (extensions.length > 0 && !extensions.includes(extension)) return 0;
  const base = normalizeName(extension ? name.slice(0, -extension.length) : name);
  if (!base || !query) return 0;
  if (base === query) return 1_000;
  if (base.startsWith(query)) return 850;
  if (query.startsWith(base) && base.length >= Math.max(2, Math.floor(query.length / 2))) return 800;
  if (base.includes(query)) return 700;
  if (query.includes(base) && base.length >= Math.max(2, Math.floor(query.length / 2))) return 650;
  return 0;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function uniqueRoots(roots: string[]): string[] {
  const result: string[] = [];
  for (const root of roots) {
    const value = root.trim();
    if (!value || !existsSync(value)) continue;
    try {
      if (!statSync(value).isDirectory()) continue;
    } catch {
      continue;
    }
    const absolute = resolve(value);
    if (!result.some((item) => item.toLowerCase() === absolute.toLowerCase())) result.push(absolute);
  }
  return result;
}

function mimeTypeForName(name: string): string {
  const extension = extname(name).toLowerCase();
  const office: Record<string, string> = {
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".ppt": "application/vnd.ms-powerpoint",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel"
  };
  return office[extension] ?? "application/octet-stream";
}

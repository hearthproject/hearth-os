import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import { RE2JS } from "re2js";

export interface SearchOptions {
  pattern: string;
  root: string;
  path?: string;
  include?: string | string[];
  exclude?: string | string[];
  literal?: boolean;
  ignoreCase?: boolean;
  maxResults?: number;
  timeoutMs?: number;
  hidden?: boolean;
}

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  backend: "ripgrep" | "javascript";
  truncated: boolean;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "venv", "target", "coverage", ".cache", "logs"]);
const TEXT_MAX_BYTES = 2 * 1024 * 1024;

export function rgAvailable(): boolean {
  const result = spawnSync("rg", ["--version"], { stdio: "ignore", timeout: 2_000, windowsHide: true });
  return result.status === 0;
}

export function searchFiles(options: SearchOptions): SearchResult {
  if (rgAvailable()) {
    const result = searchWithRipgrep(options);
    if (result) return result;
  }
  return searchWithJavaScript(options);
}

function searchWithRipgrep(options: SearchOptions): SearchResult | null {
  const args = ["--line-number", "--no-heading", "--color", "never", "--max-count", String(options.maxResults ?? 200)];
  if (options.literal) args.push("--fixed-strings");
  if (options.ignoreCase) args.push("--ignore-case");
  if (options.hidden) args.push("--hidden");
  for (const include of normalizeGlobs(options.include)) args.push("--glob", include);
  for (const exclude of normalizeGlobs(options.exclude)) args.push("--glob", `!${exclude}`);
  args.push("--", options.pattern, options.path ?? ".");
  const result = spawnSync("rg", args, {
    cwd: options.root,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 10_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error || result.status === 2) return null;
  const lines = (result.stdout ?? "").split(/\r?\n/).filter(Boolean);
  const matches = lines.slice(0, options.maxResults ?? 200).map(parseRgLine).filter((match): match is SearchMatch => Boolean(match));
  return { matches, backend: "ripgrep", truncated: lines.length > (options.maxResults ?? 200) };
}

function parseRgLine(line: string): SearchMatch | null {
  const match = /^(.*?):(\d+):(.*)$/.exec(line);
  if (!match) return null;
  return { file: match[1]!.replace(/\\/g, "/"), line: Number(match[2]), text: match[3]! };
}

function searchWithJavaScript(options: SearchOptions): SearchResult {
  const root = resolve(options.root);
  const start = resolve(root, options.path ?? ".");
  const include = normalizeGlobs(options.include);
  const exclude = normalizeGlobs(options.exclude);
  const matcher = options.literal ? null : RE2JS.compile(options.pattern, options.ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);
  const literal = options.literal ? (options.ignoreCase ? options.pattern.toLowerCase() : options.pattern) : "";
  const matches: SearchMatch[] = [];
  const maxResults = options.maxResults ?? 200;
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let truncated = false;
  const ignored = ignoreMatcher(root);

  const visit = (path: string): void => {
    if (matches.length >= maxResults || Date.now() > deadline) {
      truncated = matches.length >= maxResults;
      return;
    }
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      if (path !== start && (SKIP_DIRS.has(path.split(sep).pop() ?? "") || (!options.hidden && (path.split(sep).pop() ?? "").startsWith(".")))) return;
      let entries: string[];
      try {
        entries = readdirSync(path);
      } catch {
        return;
      }
      for (const entry of entries) visit(join(path, entry));
      return;
    }
    if (!stat.isFile() || stat.size > TEXT_MAX_BYTES) return;
    const relativePath = relative(root, path).split(sep).join("/");
    if (ignored(relativePath)) return;
    if (include.length > 0 && !include.some((glob) => picomatch(glob)(relativePath))) return;
    if (exclude.some((glob) => picomatch(glob)(relativePath))) return;
    let buffer: Buffer;
    try {
      buffer = readFileSync(path);
    } catch {
      return;
    }
    if (buffer.includes(0)) return;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= maxResults) {
        truncated = true;
        return;
      }
      const line = lines[index]!;
      const hit = matcher ? matcher.test(line) : (options.ignoreCase ? line.toLowerCase() : line).includes(literal);
      if (hit) matches.push({ file: relativePath, line: index + 1, text: line.slice(0, 500) });
    }
  };
  visit(start);
  return { matches, backend: "javascript", truncated };
}

function normalizeGlobs(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function ignoreMatcher(root: string): (relativePath: string) => boolean {
  const patterns: Array<{ glob: string; negated: boolean; directory: boolean }> = [];
  for (const name of [".gitignore", ".hearthignore"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const negated = trimmed.startsWith("!");
        const pattern = negated ? trimmed.slice(1) : trimmed;
        const directory = pattern.endsWith("/");
        patterns.push({ glob: directory ? `${pattern.replace(/\/$/, "")}/**` : pattern, negated, directory });
      }
    } catch {
      // Missing ignore files are treated as empty.
    }
  }
  return (relativePath: string): boolean => {
    let ignored = false;
    for (const pattern of patterns) {
      if (picomatch(pattern.glob, { dot: true })(relativePath)) ignored = !pattern.negated;
    }
    return ignored;
  };
}

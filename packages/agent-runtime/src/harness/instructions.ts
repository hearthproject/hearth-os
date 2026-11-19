import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface InstructionFile {
  path: string;
  relativePath: string;
  content: string;
  truncated: boolean;
}

const INSTRUCTION_FILES = ["HEARTH.md", "AGENTS.md", "CLAUDE.md"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "venv", "target", "coverage", ".cache", "logs"]);
const MAX_FILE_BYTES = 8 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024;
const MAX_DEPTH = 3;

export function discoverInstructions(root: string, startDir = root): InstructionFile[] {
  const found: InstructionFile[] = [];
  const seen = new Set<string>();
  const rootPath = resolve(root);
  const startPath = resolve(startDir);
  const ancestors = ancestorChain(rootPath, startPath);

  for (const directory of ancestors) {
    for (const name of INSTRUCTION_FILES) {
      collectFile(join(directory, name), found, seen, rootPath);
    }
  }

  walk(rootPath, 0, found, seen, rootPath);
  collectRules(join(rootPath, ".hearth", "rules"), found, seen, rootPath);

  let total = 0;
  const limited: InstructionFile[] = [];
  for (const file of found) {
    if (total >= MAX_TOTAL_BYTES) break;
    const remaining = MAX_TOTAL_BYTES - total;
    if (file.content.length > remaining) {
      limited.push({ ...file, content: `${file.content.slice(0, remaining)}\n\n[instructions truncated]`, truncated: true });
      total = MAX_TOTAL_BYTES;
      break;
    }
    limited.push(file);
    total += file.content.length;
  }
  return limited;
}

export function instructionsBlock(files: InstructionFile[]): string {
  if (files.length === 0) return "";
  return [
    "<project_instructions>",
    "These files are repository-owned instructions. Follow them unless they conflict with safety, permissions or the user's explicit request. More specific (nested) files take precedence over the root file.",
    ...files.map((file) => `\n## ${file.relativePath}${file.truncated ? " (truncated)" : ""}\n${file.content.trim()}`),
    "</project_instructions>"
  ].join("\n");
}

function ancestorChain(root: string, start: string): string[] {
  const chain: string[] = [];
  let current = start;
  while (true) {
    if (isInside(root, current)) chain.unshift(current);
    if (current === root) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

function walk(directory: string, depth: number, found: InstructionFile[], seen: Set<string>, root: string): void {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isFile() && INSTRUCTION_FILES.includes(entry.name)) {
      collectFile(join(directory, entry.name), found, seen, root);
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    walk(join(directory, entry.name), depth + 1, found, seen, root);
  }
}

function collectRules(directory: string, found: InstructionFile[], seen: Set<string>, root: string): void {
  if (!existsSync(directory)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) collectFile(join(directory, entry.name), found, seen, root);
  }
}

function collectFile(path: string, found: InstructionFile[], seen: Set<string>, root: string): void {
  const key = resolve(path).toLowerCase();
  if (seen.has(key)) return;
  try {
    if (!statSync(path).isFile()) return;
    const content = readFileSync(path, "utf8");
    if (!content.trim()) return;
    seen.add(key);
    found.push({
      path,
      relativePath: relative(root, path).split(sep).join("/"),
      content: content.length > MAX_FILE_BYTES ? `${content.slice(0, MAX_FILE_BYTES)}\n\n[file truncated]` : content,
      truncated: content.length > MAX_FILE_BYTES
    });
  } catch {
    // Missing or unreadable instruction files are ignored.
  }
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = root.toLowerCase();
  const normalized = candidate.toLowerCase();
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${sep}`);
}

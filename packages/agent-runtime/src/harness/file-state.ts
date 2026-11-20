import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { AgentProgress, AgentReadFileState, AgentToolContext, AgentToolState } from "../types.ts";

const MAX_READ_FILE_STATES = 2_000;
const MAX_FILES_READ = 2_000;
const MAX_FILES_MODIFIED = 1_000;
const MAX_COMMANDS = 500;
const MAX_TESTS = 200;

export function createAgentState(workspaceRoot: string): AgentToolState {
  return {
    workspaceRoot,
    readFiles: new Map(),
    todos: [],
    progress: { filesRead: [], filesModified: [], commands: [], tests: [], diagnostics: [] },
    startedAt: Date.now(),
    snapshots: new Map(),
    snapshotSeq: 0,
    exposedTools: []
  };
}

export function hashContent(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function recordFileRead(state: AgentToolState | undefined, absPath: string, content: string, ranges?: Array<{ start: number; end: number }>): void {
  if (!state) return;
  let size = content.length;
  let mtimeMs = 0;
  try {
    const stat = statSync(absPath);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    // Keep content-derived size when the file disappears between read and stat.
  }
  const key = normalizeKey(absPath);
  const hash = hashContent(content);
  const previous = state.readFiles.get(key);
  const merged = previous?.hash === hash
    ? mergeRanges([...(previous.ranges ?? []), ...(ranges ?? [])])
    : mergeRanges(ranges ?? []);
  state.readFiles.set(key, { size, mtimeMs, hash, ...(merged.length > 0 ? { ranges: merged } : {}) });
  trimOldest(state.readFiles, MAX_READ_FILE_STATES);
  addUnique(state.progress.filesRead, relPath(state, absPath), MAX_FILES_READ);
}

export function recordFileModified(state: AgentToolState | undefined, absPath: string, content: string): void {
  if (!state) return;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(absPath).mtimeMs;
  } catch {
    // Ignore missing stats after a rollback.
  }
  const lines = content.replace(/\r\n/g, "\n").split("\n").length;
  state.readFiles.set(normalizeKey(absPath), {
    size: content.length,
    mtimeMs,
    hash: hashContent(content),
    ranges: [{ start: 1, end: Math.max(1, lines) }]
  });
  addUnique(state.progress.filesModified, relPath(state, absPath), MAX_FILES_MODIFIED);
}

export function rangesCover(ranges: Array<{ start: number; end: number }> | undefined, start: number, end: number): boolean {
  if (!ranges || ranges.length === 0 || end < start) return false;
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  let coveredThrough = start - 1;
  for (const range of sorted) {
    if (range.end < coveredThrough + 1) continue;
    if (range.start > coveredThrough + 1) break;
    coveredThrough = Math.max(coveredThrough, range.end);
    if (coveredThrough >= end) return true;
  }
  return coveredThrough >= end;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.start <= range.end)
    .map((range) => ({ start: Math.max(1, Math.floor(range.start)), end: Math.max(1, Math.floor(range.end)) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push(range);
  }
  return merged;
}

export function requireReadBeforeWrite(context: AgentToolContext, absPath: string, options: { allowCreate?: boolean } = {}): string | null {
  const state = context.state;
  if (!state) return null;
  const key = normalizeKey(absPath);
  const existing = state.readFiles.get(key);
  if (!existing) {
    try {
      const stat = statSync(absPath);
      if (stat.isFile() && !options.allowCreate) {
        return `文件已存在但尚未读取：${absPath}。请先 read_file，再编辑；如需整体覆盖，请传 overwrite=true。`;
      }
    } catch {
      return null;
    }
    return null;
  }
  try {
    const stat = statSync(absPath);
    if (stat.mtimeMs !== existing.mtimeMs) {
      return `文件在读取后已被外部修改：${absPath}。请重新 read_file 后再编辑。`;
    }
  } catch {
    return null;
  }
  return null;
}

export function fileReadState(context: AgentToolContext, absPath: string): AgentReadFileState | undefined {
  return context.state?.readFiles.get(normalizeKey(absPath));
}

export function recordCommand(state: AgentToolState | undefined, command: string, exitCode: number | null, test: boolean): void {
  if (!state) return;
  state.progress.commands.push({ command, exitCode, test, at: Date.now() });
  if (state.progress.commands.length > MAX_COMMANDS) state.progress.commands.splice(0, state.progress.commands.length - MAX_COMMANDS);
  if (test) {
    state.progress.tests.push({ command, passed: exitCode === 0 ? true : exitCode === null ? null : false, at: Date.now() });
    if (state.progress.tests.length > MAX_TESTS) state.progress.tests.splice(0, state.progress.tests.length - MAX_TESTS);
  }
}

export function progressSummary(progress: AgentProgress | undefined): string {
  if (!progress) return "";
  const tests = progress.tests.length;
  const passed = progress.tests.filter((test) => test.passed === true).length;
  return `files_read=${progress.filesRead.length}, files_modified=${progress.filesModified.length}, commands=${progress.commands.length}, tests=${tests}${tests ? ` (${passed} passed)` : ""}`;
}

export function relPath(state: AgentToolState | undefined, absPath: string): string {
  if (!state) return absPath.split(sep).join("/");
  return relativeTo(state.workspaceRoot, absPath);
}

function normalizeKey(path: string): string {
  return resolve(path).toLowerCase();
}

function addUnique(values: string[], value: string, max: number): void {
  if (!values.includes(value)) values.push(value);
  if (values.length > max) values.splice(0, values.length - max);
}

function trimOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

export function relativeTo(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join("/");
}

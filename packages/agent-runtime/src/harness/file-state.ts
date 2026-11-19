import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { AgentProgress, AgentReadFileState, AgentToolContext, AgentToolState } from "../types.ts";

export function createAgentState(workspaceRoot: string): AgentToolState {
  return {
    workspaceRoot,
    readFiles: new Map(),
    todos: [],
    progress: { filesRead: [], filesModified: [], commands: [], tests: [], diagnostics: [] },
    startedAt: Date.now(),
    snapshots: new Map(),
    snapshotSeq: 0
  };
}

export function hashContent(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function recordFileRead(state: AgentToolState | undefined, absPath: string, content: string): void {
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
  state.readFiles.set(normalizeKey(absPath), { size, mtimeMs, hash: hashContent(content) });
  addUnique(state.progress.filesRead, relPath(state, absPath));
}

export function recordFileModified(state: AgentToolState | undefined, absPath: string, content: string): void {
  if (!state) return;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(absPath).mtimeMs;
  } catch {
    // Ignore missing stats after a rollback.
  }
  state.readFiles.set(normalizeKey(absPath), { size: content.length, mtimeMs, hash: hashContent(content) });
  addUnique(state.progress.filesModified, relPath(state, absPath));
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
  if (test) state.progress.tests.push({ command, passed: exitCode === 0 ? true : exitCode === null ? null : false, at: Date.now() });
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

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

export function relativeTo(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join("/");
}

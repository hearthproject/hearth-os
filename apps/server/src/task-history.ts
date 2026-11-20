import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ContextItem, RunRecord } from "@hearth/core";
import { WORKSPACE_DIR } from "./config.ts";

const MAX_TURNS = 100;

export interface TaskTurnFileView {
  path: string;
  created: boolean;
  insertions: number | null;
  deletions: number | null;
  beforeHash: string | null;
  afterHash: string | null;
  snapshotId: string | null;
  snapshotPath: string | null;
  snapshotAvailable: boolean;
}

export interface TaskTurnView {
  runId: string;
  attempt: number;
  turn: number;
  createdAt: string;
  files: TaskTurnFileView[];
  failed: Array<{ path: string; reason: string }>;
  verification?: TaskTurnVerification;
}

export interface TaskTurnVerification {
  toolCalls: number;
  failedTests: string[];
  diagnostics: Array<{ file: string; line?: number; code?: string; message: string }>;
  exitCodes: Array<number | null>;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  browserAssertions: Array<{ kind: string; expected: string; passed: boolean; actual?: string }>;
}

export interface TaskTurnsView {
  runs: Array<{
    id: string;
    attempt: number;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
  }>;
  turns: TaskTurnView[];
}

interface FileHistoryEntry {
  path: string;
  snapshotId: string | null;
  snapshotPath: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  insertions: number | null;
  deletions: number | null;
  created: boolean;
}

interface FileHistoryManifest {
  turn: number;
  createdAt: string;
  files: FileHistoryEntry[];
  failed?: Array<{ path: string; reason: string }>;
}

export function readTaskTurns(
  taskId: string,
  runs: RunRecord[],
  workspaceRoot = WORKSPACE_DIR
): TaskTurnsView {
  const taskRoot = join(workspaceRoot, "tasks", taskId);
  const turns: TaskTurnView[] = [];
  for (const run of [...runs].sort((left, right) => left.attempt - right.attempt)) {
    const outDir = outDirForRun(taskRoot, run);
    const manifests = readRunManifests(outDir);
    for (const manifest of manifests) {
      turns.push({
        runId: run.id,
        attempt: run.attempt,
        turn: manifest.turn,
        createdAt: manifest.createdAt,
        files: manifest.files.map((file) => ({
          path: file.path,
          created: file.created,
          insertions: file.insertions,
          deletions: file.deletions,
          beforeHash: file.beforeHash,
          afterHash: file.afterHash,
          snapshotId: file.snapshotId,
          snapshotPath: file.snapshotPath,
          snapshotAvailable: Boolean(file.snapshotPath && existsSync(resolve(outDir, file.snapshotPath)))
        })),
        failed: manifest.failed ?? []
      });
    }
  }
  turns.sort((left, right) => left.attempt - right.attempt || left.turn - right.turn);
  return {
    runs: runs.map((run) => ({
      id: run.id,
      attempt: run.attempt,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt
    })),
    turns: turns.slice(-MAX_TURNS)
  };
}

export function taskRootFor(taskId: string, workspaceRoot = WORKSPACE_DIR): string {
  return join(workspaceRoot, "tasks", taskId);
}

export function outDirForRun(taskRoot: string, run: RunRecord): string {
  return run.workspace === taskRoot ? join(taskRoot, "out", run.id) : join(run.workspace, "out");
}

export function workspaceRootForRun(taskRoot: string, run: RunRecord): string {
  const outDir = outDirForRun(taskRoot, run);
  const marker = join(outDir, ".hearth", "workspace-root");
  try {
    if (existsSync(marker)) {
      const value = readFileSync(marker, "utf8").trim();
      if (value && isAbsolute(value)) return resolve(value);
    }
  } catch {
    // Fall back to the task root when the marker is unreadable.
  }
  return resolve(taskRoot);
}

export function readManifestForTurn(outDir: string, turn: number): FileHistoryManifest | null {
  const path = join(outDir, ".hearth", "file-history", `turn-${turn}`, "manifest.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FileHistoryManifest>;
    if (parsed.turn !== turn || !Array.isArray(parsed.files)) return null;
    return {
      turn,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      files: parsed.files.filter(isFileHistoryEntry),
      ...(Array.isArray(parsed.failed)
        ? { failed: parsed.failed.filter((item): item is { path: string; reason: string } => Boolean(item && typeof item.path === "string" && typeof item.reason === "string")) }
        : {})
    };
  } catch {
    return null;
  }
}

export function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export type TaskRewindErrorCode = "TURN_NOT_FOUND" | "HISTORY_DRIFT" | "SNAPSHOT_MISSING";

export class TaskRewindError extends Error {
  constructor(
    readonly code: TaskRewindErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TaskRewindError";
  }
}

export interface TaskRewindReport {
  runId: string;
  turn: number;
  restored: string[];
  removed: string[];
  failed: Array<{ path: string; reason: string }>;
  force: boolean;
}

export function rewindTaskTurn(input: {
  taskId: string;
  run: RunRecord;
  turn: number;
  force?: boolean;
  workspaceRoot?: string;
}): TaskRewindReport {
  const taskRoot = taskRootFor(input.taskId, input.workspaceRoot);
  const outDir = outDirForRun(taskRoot, input.run);
  const manifest = readManifestForTurn(outDir, input.turn);
  if (!manifest) {
    throw new TaskRewindError("TURN_NOT_FOUND", `第 ${input.turn} 轮没有文件历史。`);
  }
  const root = workspaceRootForRun(taskRoot, input.run);
  const force = input.force === true;
  const drift: string[] = [];
  const missing: string[] = [];

  for (const entry of manifest.files) {
    const target = resolve(root, entry.path);
    if (!insideRoot(root, target)) {
      drift.push(`${entry.path}（路径不在工作区内）`);
      continue;
    }
    if (entry.created) {
      if (!existsSync(target)) continue;
      if (!force && entry.afterHash && hashFile(target) !== entry.afterHash) {
        drift.push(`${entry.path}（创建后又被修改）`);
      }
      continue;
    }
    const source = entry.snapshotPath ? resolve(outDir, entry.snapshotPath) : null;
    if (!source || !existsSync(source)) {
      missing.push(entry.path);
      continue;
    }
    if (!force && entry.afterHash && hashFile(target) !== entry.afterHash) {
      drift.push(entry.path);
    }
  }

  if (drift.length > 0 && !force) {
    throw new TaskRewindError(
      "HISTORY_DRIFT",
      `文件已被改动，拒绝覆盖：${drift.join("、")}。如需强制回退，请传 force=true。`
    );
  }
  if (missing.length > 0 && !force) {
    throw new TaskRewindError("SNAPSHOT_MISSING", `快照文件缺失：${missing.join("、")}。`);
  }

  const restored: string[] = [];
  const removed: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  for (const entry of manifest.files) {
    try {
      const target = resolve(root, entry.path);
      if (!insideRoot(root, target)) throw new Error("路径不在工作区内");
      if (entry.created) {
        if (!existsSync(target)) {
          removed.push(`${entry.path} (already absent)`);
          continue;
        }
        unlinkSync(target);
        removed.push(entry.path);
        continue;
      }
      const source = entry.snapshotPath ? resolve(outDir, entry.snapshotPath) : null;
      if (!source || !existsSync(source)) throw new Error("快照文件缺失");
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      restored.push(entry.path);
    } catch (error) {
      failed.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    runId: input.run.id,
    turn: input.turn,
    restored,
    removed,
    failed,
    force
  };
}

export function attachVerification(view: TaskTurnsView, items: ContextItem[]): TaskTurnsView {
  const byKey = new Map(view.turns.map((turn) => [`${turn.runId}:${turn.turn}`, turn]));
  for (const item of items) {
    if (!item.runId) continue;
    const provenance = item.provenance ?? {};
    const turnNumber = typeof provenance.turn === "number" ? provenance.turn : Number(provenance.turn);
    if (!Number.isFinite(turnNumber)) continue;
    const turn = byKey.get(`${item.runId}:${turnNumber}`);
    if (!turn || item.kind !== "tool_result") continue;
    const verification = turn.verification ?? {
      toolCalls: 0,
      failedTests: [],
      diagnostics: [],
      exitCodes: [],
      filesChanged: [],
      insertions: 0,
      deletions: 0,
      browserAssertions: []
    };
    verification.toolCalls += 1;
    if (Array.isArray(provenance.failedTests)) {
      verification.failedTests.push(...provenance.failedTests.filter((value): value is string => typeof value === "string"));
    }
    if (Array.isArray(provenance.diagnostics)) {
      verification.diagnostics.push(
        ...provenance.diagnostics.filter((value): value is { file: string; line?: number; code?: string; message: string } => {
          return Boolean(value && typeof value === "object" && typeof (value as { file?: unknown }).file === "string" && typeof (value as { message?: unknown }).message === "string");
        })
      );
    }
    if (typeof provenance.exitCode === "number" || provenance.exitCode === null) {
      verification.exitCodes.push(provenance.exitCode);
    }
    if (Array.isArray(provenance.filesChanged)) {
      verification.filesChanged.push(...provenance.filesChanged.filter((value): value is string => typeof value === "string"));
    }
    if (typeof provenance.insertions === "number") verification.insertions += provenance.insertions;
    if (typeof provenance.deletions === "number") verification.deletions += provenance.deletions;
    if (Array.isArray(provenance.browserAssertions)) {
      verification.browserAssertions.push(
        ...provenance.browserAssertions.filter((value): value is { kind: string; expected: string; passed: boolean; actual?: string } => {
          return Boolean(value && typeof value === "object" && typeof (value as { kind?: unknown }).kind === "string" && typeof (value as { expected?: unknown }).expected === "string" && typeof (value as { passed?: unknown }).passed === "boolean");
        })
      );
    }
    turn.verification = verification;
  }
  return view;
}

function hashFile(path: string): string | null {
  try {
    return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16) : null;
  } catch {
    return null;
  }
}

function readRunManifests(outDir: string): FileHistoryManifest[] {
  const historyRoot = join(outDir, ".hearth", "file-history");
  if (!existsSync(historyRoot)) return [];
  let names: string[];
  try {
    names = readdirSync(historyRoot);
  } catch {
    return [];
  }
  return names
    .map((name) => /^turn-(\d+)$/.exec(name))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => Number(match[1]))
    .sort((left, right) => left - right)
    .map((turn) => readManifestForTurn(outDir, turn))
    .filter((manifest): manifest is FileHistoryManifest => Boolean(manifest));
}

function isFileHistoryEntry(value: unknown): value is FileHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<FileHistoryEntry>;
  return typeof entry.path === "string" && typeof entry.created === "boolean";
}

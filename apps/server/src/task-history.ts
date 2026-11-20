import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RunRecord } from "@hearth/core";
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
  exitCodes: number[];
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

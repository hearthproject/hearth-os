import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hashContent, recordFileModified } from "./file-state.ts";
import type { AgentTool, AgentToolContext, AgentToolResult } from "../types.ts";

const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const MAX_TURN_MANIFESTS = 100;

export interface FileHistoryEntry {
  path: string;
  snapshotId: string | null;
  snapshotPath: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  insertions: number | null;
  deletions: number | null;
  created: boolean;
}

export interface FileHistoryManifest {
  turn: number;
  createdAt: string;
  files: FileHistoryEntry[];
  failed?: Array<{ path: string; reason: string }>;
}

export function snapshotBeforeMutation(context: AgentToolContext, absPath: string): string | null {
  const state = context.state;
  if (!state || !existsSync(absPath)) return null;
  const turn = state.turn ?? 0;
  const prefix = `snap_t${turn}_`;
  const relativePath = relative(context.workspaceRoot, absPath).replace(/\\/g, "/");
  const manifest = readManifest(context, turn);
  if (manifest?.files.some((file) => file.path === relativePath && file.created)) return null;
  for (const [id, path] of state.snapshots) {
    if (id.startsWith(prefix) && path === absPath) return id;
  }
  try {
    const stat = statSync(absPath);
    if (stat.size > MAX_SNAPSHOT_BYTES) return null;
    const beforeHash = hashContent(readFileSync(absPath));
    state.snapshotSeq += 1;
    const id = `${prefix}${state.snapshotSeq}`;
    const target = join(context.outDir, ".hearth", "snapshots", id, relative(context.workspaceRoot, absPath));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(absPath, target);
    state.snapshots.set(id, absPath);
    upsertManifestEntry(context, turn, {
      path: relativePath,
      snapshotId: id,
      snapshotPath: relative(context.outDir, target).replace(/\\/g, "/"),
      beforeHash,
      afterHash: null,
      insertions: null,
      deletions: null,
      created: false
    });
    pruneFileHistory(context);
    return id;
  } catch {
    return null;
  }
}

export function recordSnapshotAfterMutation(context: AgentToolContext, absPath: string, snapshotId: string): void {
  const match = /^snap_t(\d+)_/.exec(snapshotId);
  if (!match || !context.state) return;
  const turn = Number(match[1]);
  const relativePath = relative(context.workspaceRoot, absPath).replace(/\\/g, "/");
  const manifest = readManifest(context, turn);
  const entry = manifest?.files.find((file) => file.path === relativePath && !file.created);
  if (!manifest || !entry) return;
  try {
    const after = readFileSync(absPath);
    const before = entry.snapshotPath ? readOptional(join(context.outDir, entry.snapshotPath)) : null;
    const stat = before && after ? diffStat(before.toString("utf8"), after.toString("utf8")) : null;
    entry.afterHash = hashContent(after);
    entry.insertions = stat?.insertions ?? null;
    entry.deletions = stat?.deletions ?? null;
    writeManifest(context, manifest);
  } catch {
    // Keep the before snapshot even if the post-edit hash cannot be read.
  }
}

export function recordCreatedFile(context: AgentToolContext, absPath: string, wasCreated: boolean): void {
  const state = context.state;
  if (!state) return;
  const turn = state.turn ?? 0;
  const relativePath = relative(context.workspaceRoot, absPath).replace(/\\/g, "/");
  const manifest = readManifest(context, turn) ?? { turn, createdAt: new Date().toISOString(), files: [] };
  const existing = manifest.files.find((file) => file.path === relativePath);
  if (!existing && !wasCreated) return;
  const after = existsSync(absPath) ? readOptional(absPath) : null;
  const entry: FileHistoryEntry = {
    path: relativePath,
    snapshotId: null,
    snapshotPath: null,
    beforeHash: null,
    afterHash: after ? hashContent(after) : null,
    insertions: null,
    deletions: null,
    created: true
  };
  if (existing) Object.assign(existing, entry);
  else manifest.files.push(entry);
  writeManifest(context, { ...manifest, createdAt: existing ? manifest.createdAt : new Date().toISOString() });
  pruneFileHistory(context);
}

export function restoreSnapshot(context: AgentToolContext, snapshotId: string): boolean {
  const state = context.state;
  if (!state) return false;
  const absPath = state.snapshots.get(snapshotId);
  if (!absPath) return false;
  const source = join(context.outDir, ".hearth", "snapshots", snapshotId, relative(context.workspaceRoot, absPath));
  return restoreFile(context, source, absPath);
}

export function snapshotIds(context: AgentToolContext): Array<{ id: string; path: string }> {
  return [...(context.state?.snapshots ?? new Map()).entries()].map(([id, path]) => ({ id, path }));
}

export const rewindTurnTool: AgentTool = {
  definition: {
    name: "rewind_turn",
    description: "Restore every file changed in a previous agent turn. Use turn=0 to undo the latest completed turn.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: { turn: { type: "number", description: "Turn number; 0 or omit to rewind the latest completed turn" } },
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const current = context.state?.turn ?? 1;
    const requested = typeof record.turn === "number" && Number.isFinite(record.turn) ? Math.floor(record.turn) : 0;
    const turn = requested > 0 ? requested : Math.max(1, current - 1);
    const manifest = readManifest(context, turn);
    const ids = [...(context.state?.snapshots.keys() ?? [])].filter((id) => id.startsWith(`snap_t${turn}_`));
    const entries = manifest?.files ?? ids.map((id) => ({
      path: relative(context.workspaceRoot, context.state!.snapshots.get(id)!).replace(/\\/g, "/"),
      snapshotId: id,
      snapshotPath: relative(context.outDir, join(context.outDir, ".hearth", "snapshots", id, relative(context.workspaceRoot, context.state!.snapshots.get(id)!))).replace(/\\/g, "/"),
      beforeHash: null,
      afterHash: null,
      insertions: null,
      deletions: null,
      created: false
    }));
    if (entries.length === 0) return { content: `第 ${turn} 轮没有可恢复的文件历史。`, isError: true };
    const restored: string[] = [];
    const failed: Array<{ path: string; reason: string }> = [];
    let insertions = 0;
    let deletions = 0;
    for (const entry of entries) {
      try {
        if (entry.created) {
          const target = resolve(context.workspaceRoot, entry.path);
          if (!insideWorkspace(context, target)) throw new Error("路径不在工作区内");
          if (!existsSync(target)) {
            restored.push(`${entry.path} (removed)`);
            continue;
          }
          if (entry.afterHash && hashContent(readFileSync(target)) !== entry.afterHash) {
            throw new Error("文件在创建后又被修改，拒绝删除");
          }
          unlinkSync(target);
          restored.push(`${entry.path} (removed)`);
          continue;
        }
        const absPath = resolve(context.workspaceRoot, entry.path);
        const source = entry.snapshotPath ? resolve(context.outDir, entry.snapshotPath) : null;
        if (!source || !existsSync(source)) throw new Error("快照文件缺失");
        if (!restoreFile(context, source, absPath)) throw new Error("快照恢复失败");
        restored.push(entry.path);
        insertions += entry.insertions ?? 0;
        deletions += entry.deletions ?? 0;
      } catch (error) {
        failed.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (manifest) writeManifest(context, { ...manifest, failed });
    const summary = `第 ${turn} 轮：恢复 ${restored.length} 个文件，失败 ${failed.length} 个；diff +${insertions} -${deletions}`;
    return {
      content: [summary, ...failed.map((item) => `失败 ${item.path}: ${item.reason}`)].join("\n"),
      isError: restored.length === 0,
      metadata: { snapshotIds: restored, failures: failed, insertions, deletions }
    };
  }
};

function restoreFile(context: AgentToolContext, source: string, absPath: string): boolean {
  if (!existsSync(source)) return false;
  mkdirSync(dirname(absPath), { recursive: true });
  copyFileSync(source, absPath);
  try {
    recordFileModified(context.state, absPath, readFileSync(absPath, "utf8"));
  } catch {
    // Binary or missing files still count as restored.
  }
  return true;
}

export const rewindTool: AgentTool = {
  definition: {
    name: "rewind",
    description: "Restore a file to a snapshot taken before a previous edit. Use after a bad edit or to undo a failed experiment.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        snapshotId: { type: "string", description: "Snapshot id returned by edit/write/patch results, or found via list_snapshots." },
        path: { type: "string", description: "Optional path confirmation." }
      },
      required: ["snapshotId"],
      additionalProperties: false
    }
  },
  async execute(input: unknown, context: AgentToolContext): Promise<AgentToolResult> {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const snapshotId = typeof record.snapshotId === "string" ? record.snapshotId.trim() : "";
    if (!snapshotId) return { content: "snapshotId 不能为空。", isError: true };
    const restored = restoreSnapshot(context, snapshotId);
    if (!restored) {
      const available = snapshotIds(context);
      return {
        content: `找不到快照 ${snapshotId}。当前快照：${available.map((item) => `${item.id} -> ${item.path}`).join(", ") || "无"}`,
        isError: true
      };
    }
    return { content: `已恢复快照 ${snapshotId}。` };
  }
};

function manifestPath(context: AgentToolContext, turn: number): string {
  return join(context.outDir, ".hearth", "file-history", `turn-${turn}`, "manifest.json");
}

function readManifest(context: AgentToolContext, turn: number): FileHistoryManifest | null {
  const path = manifestPath(context, turn);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FileHistoryManifest>;
    if (parsed.turn !== turn || !Array.isArray(parsed.files)) return null;
    return {
      turn,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      files: parsed.files.filter((file): file is FileHistoryEntry => Boolean(file && typeof file.path === "string" && typeof file.created === "boolean")),
      ...(Array.isArray(parsed.failed) ? { failed: parsed.failed } : {})
    };
  } catch {
    return null;
  }
}

function writeManifest(context: AgentToolContext, manifest: FileHistoryManifest): void {
  const path = manifestPath(context, manifest.turn);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function upsertManifestEntry(context: AgentToolContext, turn: number, entry: FileHistoryEntry): void {
  const manifest = readManifest(context, turn) ?? { turn, createdAt: new Date().toISOString(), files: [] };
  const index = manifest.files.findIndex((file) => file.path === entry.path);
  if (index >= 0) manifest.files[index] = entry;
  else manifest.files.push(entry);
  writeManifest(context, manifest);
}

function pruneFileHistory(context: AgentToolContext): void {
  const root = join(context.outDir, ".hearth", "file-history");
  if (!existsSync(root)) return;
  const turns = readdirSync(root)
    .filter((name) => /^turn-\d+$/.test(name))
    .map((name) => ({ name, turn: Number(name.slice(5)) }))
    .sort((left, right) => left.turn - right.turn);
  while (turns.length > MAX_TURN_MANIFESTS) {
    const oldest = turns.shift();
    if (oldest) rmSync(join(root, oldest.name), { recursive: true, force: true });
  }
}

function readOptional(path: string): Buffer | null {
  try {
    return existsSync(path) ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

function insideWorkspace(context: AgentToolContext, absPath: string): boolean {
  const rel = relative(context.workspaceRoot, absPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function diffStat(before: string, after: string): { insertions: number; deletions: number } {
  const left = before.replace(/\r\n/g, "\n").split("\n");
  const right = after.replace(/\r\n/g, "\n").split("\n");
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  return {
    insertions: right.length - prefix - suffix,
    deletions: left.length - prefix - suffix
  };
}

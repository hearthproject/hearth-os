import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "../types.ts";

const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;

export function snapshotBeforeMutation(context: AgentToolContext, absPath: string): string | null {
  const state = context.state;
  if (!state || !existsSync(absPath)) return null;
  for (const [id, path] of state.snapshots) {
    if (path === absPath) return id;
  }
  try {
    const stat = statSync(absPath);
    if (stat.size > MAX_SNAPSHOT_BYTES) return null;
    state.snapshotSeq += 1;
    const id = `snap_${state.snapshotSeq}`;
    const target = join(context.outDir, ".hearth", "snapshots", id, relative(context.workspaceRoot, absPath));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(absPath, target);
    state.snapshots.set(id, absPath);
    return id;
  } catch {
    return null;
  }
}

export function restoreSnapshot(context: AgentToolContext, snapshotId: string): boolean {
  const state = context.state;
  if (!state) return false;
  const absPath = state.snapshots.get(snapshotId);
  if (!absPath) return false;
  const source = join(context.outDir, ".hearth", "snapshots", snapshotId, relative(context.workspaceRoot, absPath));
  if (!existsSync(source)) return false;
  mkdirSync(dirname(absPath), { recursive: true });
  copyFileSync(source, absPath);
  return true;
}

export function snapshotIds(context: AgentToolContext): Array<{ id: string; path: string }> {
  return [...(context.state?.snapshots ?? new Map()).entries()].map(([id, path]) => ({ id, path }));
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

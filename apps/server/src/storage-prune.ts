import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { HearthStore } from "@hearth/eventlog";
import type { RunRecord, TaskRecord } from "@hearth/core";

export interface StoragePruneCandidate {
  taskId: string;
  taskTitle: string;
  runId: string;
  attempt: number;
  path: string;
  bytes: number;
  endedAt: string | null;
}

export interface StoragePruneFile {
  taskId: string;
  runId: string;
  path: string;
  bytes: number;
}

export interface StoragePrunePlan {
  candidates: StoragePruneCandidate[];
  files: StoragePruneFile[];
  pinned: Array<{ taskId: string; runId: string; reason: string }>;
  totalBytes: number;
  olderThanDays: number;
}

export interface StoragePruneInput {
  store: Pick<HearthStore, "listTasks" | "listRuns" | "latestRunCheckpoint" | "listRunOperationsByTask">;
  workspaceRoot: string;
  olderThanDays?: number;
  now?: Date;
}

const TERMINAL_TASK_STATUSES = new Set<TaskRecord["status"]>(["completed", "failed", "cancelled"]);
const TERMINAL_RUN_STATUSES = new Set<RunRecord["status"]>(["completed", "failed", "cancelled"]);

/**
 * Compute which run output directories are safe to reclaim. Nothing here
 * deletes: callers must opt in, so a dry run and an apply run share the plan.
 */
export function planStoragePrune(input: StoragePruneInput): StoragePrunePlan {
  const olderThanDays = input.olderThanDays ?? 7;
  const now = input.now ?? new Date();
  const cutoff = now.getTime() - olderThanDays * 24 * 60 * 60 * 1000;
  const candidates: StoragePruneCandidate[] = [];
  const files: StoragePruneFile[] = [];
  const pinned: StoragePrunePlan["pinned"] = [];

  for (const task of input.store.listTasks()) {
    const runs = [...input.store.listRuns(task.id)].sort((a, b) => a.attempt - b.attempt);
    if (runs.length === 0) continue;
    const latest = runs[runs.length - 1];
    if (!latest) continue;
    if (!TERMINAL_TASK_STATUSES.has(task.status)) {
      pinned.push({ taskId: task.id, runId: latest?.id ?? "none", reason: `任务仍未结束（${task.status}）` });
      continue;
    }
    const taskRoot = join(input.workspaceRoot, "tasks", task.id);
    const operations = input.store.listRunOperationsByTask(task.id);
    const blockedRuns = new Set<string>();
    for (const operation of operations) {
      if (!["settled", "unknown"].includes(operation.phase) || operation.cleanupState === "pending") {
        blockedRuns.add(operation.runId);
      }
    }
    for (const run of runs) {
      if (run.id === latest?.id) {
        pinned.push({ taskId: task.id, runId: run.id, reason: "保留最新一次运行" });
        continue;
      }
      if (!TERMINAL_RUN_STATUSES.has(run.status)) {
        pinned.push({ taskId: task.id, runId: run.id, reason: `运行状态为 ${run.status}` });
        continue;
      }
      if (blockedRuns.has(run.id)) {
        pinned.push({ taskId: task.id, runId: run.id, reason: "存在未结算或待清理的操作" });
        continue;
      }
      const path = runOutDir(run, taskRoot);
      const endedAt = run.endedAt ?? run.startedAt ?? new Date(0).toISOString();
      if (new Date(endedAt).getTime() > cutoff) {
        pinned.push({ taskId: task.id, runId: run.id, reason: `未超过保留期 ${olderThanDays} 天` });
        continue;
      }
      if (!existsSync(path) || !statSync(path).isDirectory()) continue;
      if (checkpointPins(path, run, input)) {
        pinned.push({ taskId: task.id, runId: run.id, reason: "检查点引用了该目录中的工具输出" });
        continue;
      }
      candidates.push({
        taskId: task.id,
        taskTitle: task.title,
        runId: run.id,
        attempt: run.attempt,
        path,
        bytes: directoryBytes(path),
        endedAt: run.endedAt
      });
    }

    // The surviving latest run may still hold tool outputs that its own
    // checkpoint does not point at. Only those are pruned; referenced blobs
    // stay readable through read_tool_output.
    const latestPath = runOutDir(latest, taskRoot);
    const latestCheckpoint = checkpointText(latest, input);
    if (latestCheckpoint !== null && existsSync(latestPath)) {
      const referenced = toolResultReferences(latestCheckpoint);
      const directory = join(latestPath, ".hearth", "tool-results");
      if (existsSync(directory)) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !/^[a-f0-9]{16}\.txt$/.test(entry.name) || referenced.has(entry.name)) continue;
          const path = join(directory, entry.name);
          try {
            const stat = statSync(path);
            if (stat.mtimeMs > cutoff) continue;
            files.push({ taskId: task.id, runId: latest.id, path, bytes: stat.size });
          } catch {
            // raced with a running writer
          }
        }
      }
    }
  }
  return {
    candidates,
    files,
    pinned,
    totalBytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0)
      + files.reduce((sum, file) => sum + file.bytes, 0),
    olderThanDays
  };
}

function runOutDir(run: RunRecord, taskRoot: string): string {
  return run.workspace === taskRoot ? join(taskRoot, "out", run.id) : join(run.workspace, "out");
}

function checkpointText(run: RunRecord, input: StoragePruneInput): string | null {
  const checkpoint = input.store.latestRunCheckpoint(run.id);
  if (!checkpoint) return null;
  const path = isAbsolute(checkpoint.path) ? checkpoint.path : join(input.workspaceRoot, checkpoint.path);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function toolResultReferences(body: string): Set<string> {
  const references = new Set<string>();
  for (const match of body.matchAll(/tool-results[\\/]+([a-f0-9]{16}\.txt)/g)) {
    if (match[1]) references.add(match[1]);
  }
  return references;
}

function checkpointPins(path: string, run: RunRecord, input: StoragePruneInput): boolean {
  const checkpoint = input.store.latestRunCheckpoint(run.id);
  if (!checkpoint) return false;
  const checkpointPath = isAbsolute(checkpoint.path) ? checkpoint.path : join(input.workspaceRoot, checkpoint.path);
  if (checkpointPath.startsWith(path)) return true;
  if (!existsSync(checkpointPath)) return false;
  try {
    const body = readFileSync(checkpointPath, "utf8");
    const normalized = path.replace(/\\/g, "/");
    const normalizedBody = body.replace(/\\\\/g, "/").replace(/\\/g, "/");
    return normalizedBody.includes(normalized) && normalizedBody.includes("tool-results");
  } catch {
    return true;
  }
}

function directoryBytes(path: string): number {
  let total = 0;
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else {
        try { total += statSync(child).size; } catch { /* raced with another process */ }
      }
    }
  }
  return total;
}

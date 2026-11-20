import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".hearth", "dist", "build", ".next", ".nuxt", "coverage",
  ".venv", "venv", "__pycache__", "target", ".cache", ".turbo", ".gradle", ".idea", ".vs"
]);
const MAX_ENTRIES = 40_000;
const MAX_DEPTH = 24;

export interface FileFingerprint {
  size: number;
  mtimeMs: number;
}

export type WorkspaceSnapshot = Map<string, FileFingerprint>;

export interface WorkspaceChange {
  path: string;
  kind: "added" | "modified" | "deleted";
}

export function snapshotWorkspace(root: string): WorkspaceSnapshot {
  const snapshot: WorkspaceSnapshot = new Map();
  let entries = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || entries >= MAX_ENTRIES) return;
    let children: import("node:fs").Dirent[];
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (entries >= MAX_ENTRIES) return;
      const full = join(dir, child.name);
      if (child.isDirectory()) {
        if (SKIP_DIRS.has(child.name)) continue;
        walk(full, depth + 1);
      } else if (child.isFile()) {
        try {
          const stats = statSync(full);
          snapshot.set(relative(root, full).replace(/\\/g, "/"), { size: stats.size, mtimeMs: stats.mtimeMs });
          entries++;
        } catch {
          // Ignore files that disappear during the scan.
        }
      }
    }
  };
  walk(root, 0);
  return snapshot;
}

export function diffWorkspace(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceChange[] {
  const changes: WorkspaceChange[] = [];
  for (const [path, fingerprint] of after) {
    const previous = before.get(path);
    if (!previous) changes.push({ path, kind: "added" });
    else if (previous.size !== fingerprint.size || Math.abs(previous.mtimeMs - fingerprint.mtimeMs) > 0.5) {
      changes.push({ path, kind: "modified" });
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push({ path, kind: "deleted" });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

export function formatChangeManifest(root: string, changes: WorkspaceChange[]): string {
  const label = { added: "新增", modified: "修改", deleted: "删除" } as const;
  const shown = changes.slice(0, 80);
  const lines = shown.map((change) => `- ${label[change.kind]} ${change.path}`);
  if (changes.length > shown.length) lines.push(`- …另有 ${changes.length - shown.length} 个文件`);
  return [
    `原地改动清单（${root}）`,
    "",
    ...lines,
    "",
    `共 ${changes.length} 个文件发生变化。此目录不是 Git 仓库，改动无法自动回滚。`
  ].join("\n");
}

export function isEmptyWorkspaceChange(changes: WorkspaceChange[]): boolean {
  return changes.length === 0;
}
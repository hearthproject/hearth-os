import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentToolEffect, AgentToolResult } from "../types.ts";

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashJson(value: unknown): string {
  return sha256Text(stableJson(value));
}

export function resultDigest(result: AgentToolResult): string {
  return hashJson({
    content: result.content,
    isError: result.isError === true,
    metadata: result.metadata ?? null
  });
}

/**
 * Best-effort digest of the files a local write is about to touch.
 *
 * This is deliberately computed before T1. A recovery pass can compare it with
 * the current file state to decide whether a half-finished write already
 * landed. Tools with no discoverable path fall back to null; M2's workspace
 * digest covers those.
 */
export function digestBeforeEffect(
  effect: AgentToolEffect,
  args: unknown,
  workspaceRoot: string
): string | null {
  if (effect !== "local_write" && effect !== "destructive") return null;
  const paths = collectEffectPaths(args);
  if (paths.length === 0) return null;
  const unique = [...new Set(paths)].sort();
  return hashJson(unique.map((path) => {
    const absolute = resolve(workspaceRoot, path);
    try {
      const stat = lstatSync(absolute);
      if (stat.isFile()) {
        return { path, kind: "file", sha256: sha256Text(readFileSync(absolute, "utf8")) };
      }
      if (stat.isDirectory()) return { path, kind: "directory" };
      return { path, kind: "other", size: stat.size };
    } catch {
      return { path, kind: "absent" };
    }
  }));
}

function collectEffectPaths(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  const paths: string[] = [];
  const direct = [
    "path", "file_path", "filePath", "target", "destination", "dest",
    "output", "output_path", "outputPath", "new_path", "newPath", "old_path", "oldPath"
  ];
  for (const key of direct) addPath(paths, record[key]);
  for (const key of ["files", "paths", "targets"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") addPath(paths, item);
        else if (item && typeof item === "object") addPath(paths, (item as Record<string, unknown>).path);
      }
    }
  }
  return paths;
}

function addPath(target: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed) return;
  target.push(trimmed.replace(/\\/g, "/"));
}

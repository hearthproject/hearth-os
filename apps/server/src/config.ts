import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const HOST = process.env.HEARTH_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.HEARTH_PORT ?? 4317);
export const DATA_DIR = resolve(process.env.HEARTH_DATA_DIR ?? join(REPO_ROOT, ".hearth"));
export const DB_PATH = join(DATA_DIR, "hearth.sqlite");
export const WORKSPACE_DIR = join(DATA_DIR, "workspaces");
export const ARTIFACT_DIR = join(DATA_DIR, "artifacts");
export const WEB_DIST = join(REPO_ROOT, "apps", "web", "dist");

export function resolveRepoPath(path: string): string {
  const absolute = resolve(REPO_ROOT, path);
  if (absolute !== REPO_ROOT && !absolute.startsWith(REPO_ROOT + "\\") && !absolute.startsWith(REPO_ROOT + "/")) {
    throw new Error(`Path escapes repository: ${path}`);
  }
  return absolute;
}

import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const HOST = process.env.HEARTH_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.HEARTH_PORT ?? 4317);
export const DATA_DIR = resolve(process.env.HEARTH_DATA_DIR ?? join(REPO_ROOT, ".hearth"));
export const DB_PATH = join(DATA_DIR, "hearth.sqlite");
export const WORKSPACE_DIR = join(DATA_DIR, "workspaces");
export const GIT_CACHE_DIR = join(DATA_DIR, "git-cache");
export const ARTIFACT_DIR = join(DATA_DIR, "artifacts");
export const SOURCE_CONTENT_DIR = join(DATA_DIR, "sources");
export const OUTBOX_DIR = join(DATA_DIR, "outbox");
export const DEVICE_FRAME_DIR = join(DATA_DIR, "device-frames");
export const BACKUP_DIR = join(DATA_DIR, "backups");
export const MODEL_SETTINGS_PATH = join(DATA_DIR, "model-settings.json");
export const ATTACHMENT_DIR = join(DATA_DIR, "attachments");
export const WEB_DIST = join(REPO_ROOT, "apps", "web", "dist");
export const MASTER_KEY_PATH = join(DATA_DIR, "master.key");

export function resolveRepoPath(path: string): string {
  const absolute = resolve(REPO_ROOT, path);
  if (absolute !== REPO_ROOT && !absolute.startsWith(REPO_ROOT + "\\") && !absolute.startsWith(REPO_ROOT + "/")) {
    throw new Error(`Path escapes repository: ${path}`);
  }
  return absolute;
}

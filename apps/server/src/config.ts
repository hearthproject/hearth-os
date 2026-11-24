import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const DEFAULT_HEARTH_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * The root every data-relative path is anchored to. In development this is the
 * repository root; in the desktop build it is the root the user selected (for
 * example D:\App\hearth-os).
 */
export const HEARTH_ROOT = resolve(process.env.HEARTH_ROOT ?? DEFAULT_HEARTH_ROOT);

/**
 * Kept as an alias while the server code migrates to HEARTH_ROOT. The two
 * values are intentionally identical.
 */
export const REPO_ROOT = HEARTH_ROOT;

export const HOST = process.env.HEARTH_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.HEARTH_PORT ?? 4317);
export const DATA_DIR = resolve(process.env.HEARTH_DATA_DIR ?? join(HEARTH_ROOT, ".hearth"));
export const DB_PATH = join(DATA_DIR, "hearth.sqlite");
export const WORKSPACE_DIR = join(DATA_DIR, "workspaces");
export const GIT_CACHE_DIR = join(DATA_DIR, "git-cache");
export const ARTIFACT_DIR = join(DATA_DIR, "artifacts");
export const HANDOFF_DIR = join(DATA_DIR, "handoffs");
export const SOURCE_CONTENT_DIR = join(DATA_DIR, "sources");
export const DEVICE_FRAME_DIR = join(DATA_DIR, "device-frames");
export const BACKUP_DIR = join(DATA_DIR, "backups");
export const CONTEXT_BLOB_DIR = join(DATA_DIR, "context", "blobs");
export const LIBRARY_MODEL_DIR = join(DATA_DIR, "models", "library");
export const SKILL_DIR = join(DATA_DIR, "skills");
export const EXECUTOR_HOME_DIR = join(DATA_DIR, "executors");
export const CODEX_HOME_DIR = join(EXECUTOR_HOME_DIR, "codex");
export const DSH_HOME_DIR = join(EXECUTOR_HOME_DIR, "deepseek-harness");
export const MODEL_SETTINGS_PATH = join(DATA_DIR, "model-settings.json");
export const EXECUTOR_SETTINGS_PATH = join(DATA_DIR, "executor-settings.json");
export const ATTACHMENT_DIR = join(DATA_DIR, "attachments");
export const BROWSER_DIR = join(DATA_DIR, "browser");
export const BROWSER_PROFILE_DIR = join(BROWSER_DIR, "profile");
export const BROWSER_EVIDENCE_DIR = join(BROWSER_DIR, "evidence");
export const BROWSER_RECIPE_DIR = join(BROWSER_DIR, "recipes");
export const BROWSER_SETTINGS_PATH = join(BROWSER_DIR, "settings.json");
export const DOSSIER_DIR = join(DATA_DIR, "dossiers");
export const WORKSTYLE_PATH = join(DATA_DIR, "profile", "WORKSTYLE.md");
export const SUPERVISION_PATH = join(DATA_DIR, "supervision.json");
export const BROWSER_BRIDGE_PORT = Number(process.env.HEARTH_BROWSER_BRIDGE_PORT ?? 4318);
export const BROWSER_ENABLED = (process.env.HEARTH_BROWSER ?? "1") !== "0";
export const BROWSER_BRIDGE_ENABLED = (process.env.HEARTH_BROWSER_BRIDGE ?? "1") === "1";
export const WEB_DIST = resolve(process.env.HEARTH_WEB_DIST ?? join(HEARTH_ROOT, "apps", "web", "dist"));
export const MASTER_KEY_PATH = join(DATA_DIR, "master.key");

export interface RootLayoutOptions {
  /**
   * Desktop builds must ship a web dist. Development can run with Vite on a
   * separate port, so this check is opt-in.
   */
  requireWeb?: boolean;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Validate the root/data/web layout before the server opens the database.
 *
 * The `.hearth` name is not cosmetic: existing task records store outputDir as
 * `.hearth/artifacts/<id>`. Changing the directory name silently breaks every
 * historical task path.
 */
export function validateRootLayout(
  root: string,
  dataDir: string,
  webDist: string,
  options: RootLayoutOptions = {}
): void {
  const resolvedRoot = resolve(root);
  const resolvedDataDir = resolve(dataDir);
  const expectedDataDir = resolve(resolvedRoot, ".hearth");

  const relativeDataDir = relative(resolvedRoot, resolvedDataDir);
  if (relativeDataDir === "" || relativeDataDir.startsWith("..") || isAbsolute(relativeDataDir)) {
    throw new Error(`数据目录必须位于 HEARTH_ROOT 内（${resolvedDataDir} 不在 ${resolvedRoot}）。`);
  }

  if (!samePath(resolvedDataDir, expectedDataDir)) {
    throw new Error(
      `HEARTH_DATA_DIR 必须是 ${expectedDataDir}（当前为 ${resolvedDataDir}）。` +
      "历史任务的 outputDir 以 .hearth/artifacts 开头，不能改用其他目录名。"
    );
  }

  const dataDirName = basename(resolvedDataDir);
  const isHearthDir = process.platform === "win32"
    ? dataDirName.toLowerCase() === ".hearth"
    : dataDirName === ".hearth";
  if (!isHearthDir) {
    throw new Error(`数据目录必须以 .hearth 结尾（当前为 ${resolvedDataDir}）。`);
  }
  if (options.requireWeb && !existsSync(join(webDist, "index.html"))) {
    throw new Error(`前端未构建：${join(webDist, "index.html")} 不存在。请先运行 npm run build。`);
  }
}

export function assertRootLayout(options: RootLayoutOptions = {}): void {
  validateRootLayout(HEARTH_ROOT, DATA_DIR, WEB_DIST, options);
}

export function resolveRepoPath(path: string): string {
  const absolute = resolve(REPO_ROOT, path);
  if (absolute !== REPO_ROOT && !absolute.startsWith(REPO_ROOT + "\\") && !absolute.startsWith(REPO_ROOT + "/")) {
    throw new Error(`Path escapes repository: ${path}`);
  }
  return absolute;
}


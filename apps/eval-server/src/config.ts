import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const HOST = process.env.HEARTH_EVAL_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.HEARTH_EVAL_PORT ?? 4318);
export const HEARTH_URL = (process.env.HEARTH_URL ?? "http://127.0.0.1:4317").replace(/\/+$/, "");
export const DATA_DIR = resolve(process.env.HEARTH_EVAL_DATA_DIR ?? join(REPO_ROOT, ".hearth", "eval"));
export const DB_PATH = join(DATA_DIR, "eval.sqlite");
export const ARTIFACT_ROOT = resolve(process.env.HEARTH_EVAL_ARTIFACT_ROOT ?? join(REPO_ROOT, ".hearth", "eval-artifacts"));
export const CASES_DIR = resolve(process.env.HEARTH_EVAL_CASES_DIR ?? join(REPO_ROOT, "eval", "cases"));
export const WEB_DIST = join(REPO_ROOT, "apps", "eval-web", "dist");
export const EVAL_VERSION = "0.1.0";

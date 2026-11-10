import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateCaseManifest } from "./schema.ts";
import type { CaseManifest, EvalFamily } from "./types.ts";
import { EVAL_FAMILIES } from "./types.ts";

export interface LoadedCase {
  directory: string;
  manifestPath: string;
  manifest: CaseManifest;
  contentHash: string;
}

export interface CatalogLoadResult {
  cases: LoadedCase[];
  issues: Array<{ caseId: string; path: string; message: string }>;
}

export class CaseCatalogError extends Error {
  readonly issues: CatalogLoadResult["issues"];

  constructor(issues: CatalogLoadResult["issues"]) {
    super(`Case catalog validation failed with ${issues.length} issue(s)`);
    this.name = "CaseCatalogError";
    this.issues = issues;
  }
}

export function loadCaseCatalog(repoRoot: string, casesDir = "eval/cases"): CatalogLoadResult {
  const root = resolve(repoRoot, casesDir);
  const issues: CatalogLoadResult["issues"] = [];
  const cases: LoadedCase[] = [];
  if (!existsSync(root)) {
    return { cases, issues: [{ caseId: "", path: casesDir, message: "case 目录不存在" }] };
  }
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const directory = join(root, entry.name);
    const manifestPath = join(directory, "case.json");
    if (!existsSync(manifestPath)) {
      issues.push({ caseId: entry.name, path: manifestPath, message: "缺少 case.json" });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    } catch (error) {
      issues.push({ caseId: entry.name, path: manifestPath, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const parsed = validateCaseManifest(raw);
    if (!parsed.success) {
      for (const issue of parsed.issues) issues.push({ caseId: entry.name, path: `${manifestPath}:${issue.path}`, message: issue.message });
      continue;
    }
    const manifest = parsed.data;
    if (manifest.id !== entry.name) {
      issues.push({ caseId: entry.name, path: manifestPath, message: `目录名必须与 case id 一致：${manifest.id}` });
      continue;
    }
    const inputIssues = validateCaseInputs(repoRoot, directory, manifest);
    issues.push(...inputIssues.map((issue) => ({ caseId: manifest.id, ...issue })));
    if (inputIssues.length === 0) {
      cases.push({
        directory,
        manifestPath,
        manifest,
        contentHash: caseContentHash(repoRoot, directory, manifest)
      });
    }
  }
  const duplicates = duplicateIds(cases);
  for (const id of duplicates) issues.push({ caseId: id, path: root, message: "case id 重复" });
  return { cases, issues };
}

export function requireCaseCatalog(repoRoot: string): LoadedCase[] {
  const loaded = loadCaseCatalog(repoRoot);
  if (loaded.issues.length > 0) throw new CaseCatalogError(loaded.issues);
  return loaded.cases;
}

export function validateCatalogShape(cases: LoadedCase[]): Array<{ caseId: string; message: string }> {
  const issues: Array<{ caseId: string; message: string }> = [];
  const counts = Object.fromEntries(EVAL_FAMILIES.map((family) => [family, 0])) as Record<EvalFamily, number>;
  for (const loaded of cases) counts[loaded.manifest.family] += 1;
  for (const family of EVAL_FAMILIES) {
    if (counts[family] === 0) issues.push({ caseId: "", message: `任务族 ${family} 没有 case` });
  }
  if (cases.length !== 60) issues.push({ caseId: "", message: `当前 case 数量为 ${cases.length}，必须为 60` });
  for (const loaded of cases) {
    const liveOnly = loaded.manifest.runModes.length === 1 && loaded.manifest.runModes[0] === "live-only";
    if (!liveOnly && !existsSync(join(loaded.directory, "golden"))) {
      issues.push({ caseId: loaded.manifest.id, message: "离线 case 必须提供 golden/ 目录" });
    }
  }
  return issues;
}

export function resolveCaseInput(repoRoot: string, caseDirectory: string, path: string): string {
  const candidate = path.startsWith("eval/") ? resolve(repoRoot, path) : resolve(caseDirectory, path);
  const repo = resolve(repoRoot);
  if (candidate !== repo && !candidate.startsWith(`${repo}${sep}`)) throw new Error(`输入路径越出仓库：${path}`);
  return candidate;
}

export function caseContentHash(repoRoot: string, caseDirectory: string, manifest: CaseManifest): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(manifest));
  const files = collectCaseFiles(caseDirectory).filter((path) => path !== "case.json");
  for (const relativePath of files.sort()) {
    hash.update(relativePath);
    hash.update(readFileSync(join(caseDirectory, relativePath)));
  }
  return hash.digest("hex");
}

function validateCaseInputs(repoRoot: string, directory: string, manifest: CaseManifest): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  for (const input of manifest.inputs) {
    if (input.kind !== "file") continue;
    if (!input.path) {
      issues.push({ path: manifest.id, message: `输入 ${input.label} 缺少 path` });
      continue;
    }
    const absolute = resolveCaseInput(repoRoot, directory, input.path);
    if (!existsSync(absolute)) issues.push({ path: input.path, message: `输入文件不存在：${input.label}` });
  }
  return issues;
}

function collectCaseFiles(directory: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...collectCaseFiles(join(directory, entry.name), relativePath));
    else if (statSync(join(directory, entry.name)).isFile()) files.push(relativePath);
  }
  return files;
}

function duplicateIds(cases: LoadedCase[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const loaded of cases) {
    if (seen.has(loaded.manifest.id)) duplicates.add(loaded.manifest.id);
    seen.add(loaded.manifest.id);
  }
  return [...duplicates];
}

export function isPathInside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

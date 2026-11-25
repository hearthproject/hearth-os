import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BrowserPage } from "./browser-page.ts";
import { redactBrowserUrl } from "./browser-session.ts";

export interface BrowserEvidenceRecord {
  taskId: string;
  runId: string | null;
  kind: string;
  url: string;
  title: string;
  pageDigest: string;
  actionDigest: string;
  screenshotBefore: string | null;
  screenshotAfter: string | null;
  createdAt: string;
}

export interface BrowserEvidenceInput {
  taskId: string;
  runId: string | null;
  kind: string;
  page: BrowserPage;
  pageDigest: string;
  actionDigest: string;
  action: () => Promise<unknown>;
}

export class BrowserEvidenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BrowserEvidenceError";
    this.code = code;
  }
}

const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_FILES_PER_TASK = 500;

export class BrowserEvidenceStore {
  private readonly rootDir: string;
  private readonly now: () => number;

  constructor(rootDir: string, options: { now?: () => number } = {}) {
    this.rootDir = rootDir;
    this.now = options.now ?? (() => Date.now());
  }

  async capture(input: BrowserEvidenceInput): Promise<BrowserEvidenceRecord> {
    const dir = this.taskDir(input.taskId);
    mkdirSync(dir, { recursive: true });
    const stamp = `${this.now()}-${randomSuffix()}`;
    const before = await this.screenshot(input.page, join(dir, `${stamp}-before.png`));
    let result: unknown;
    let after: string | null = null;
    try {
      result = await input.action();
    } finally {
      after = await this.screenshot(input.page, join(dir, `${stamp}-after.png`));
    }
    const title = await input.page.title().catch(() => "");
    const record: BrowserEvidenceRecord = {
      taskId: input.taskId,
      runId: input.runId,
      kind: input.kind,
      url: redactBrowserUrl(input.page.url()),
      title: redactBrowserUrl(title),
      pageDigest: input.pageDigest,
      actionDigest: input.actionDigest,
      screenshotBefore: before ? relative(dir, before).replaceAll("\\", "/") : null,
      screenshotAfter: after ? relative(dir, after).replaceAll("\\", "/") : null,
      createdAt: new Date(this.now()).toISOString()
    };
    writeFileSync(join(dir, `${stamp}-evidence.json`), JSON.stringify({ ...record, result: safeResult(result) }, null, 2), "utf8");
    this.prune(input.taskId);
    return record;
  }

  async screenshot(page: BrowserPage, path: string): Promise<string | null> {
    try {
      await page.screenshot({ path, fullPage: false });
      return path;
    } catch {
      return null;
    }
  }

  filePath(taskId: string, name: string): string | null {
    const dir = this.taskDir(taskId);
    const candidate = resolve(dir, name);
    const rel = relative(dir, candidate);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return existsSync(candidate) ? candidate : null;
  }

  list(taskId: string): BrowserEvidenceRecord[] {
    const dir = this.taskDir(taskId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith("-evidence.json"))
      .sort()
      .reverse()
      .flatMap((name) => {
        try {
          return [JSON.parse(readFileSync(join(dir, name), "utf8")) as BrowserEvidenceRecord];
        } catch {
          return [];
        }
      });
  }

  private prune(taskId: string): void {
    const dir = this.taskDir(taskId);
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".png") || name.endsWith("-evidence.json"))
      .map((name) => ({ name, path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime);
    const cutoff = this.now() - RETENTION_MS;
    for (const file of files) {
      if (file.mtime >= cutoff && files.indexOf(file) < MAX_FILES_PER_TASK) continue;
      rmSync(file.path, { force: true });
    }
  }

  private taskDir(taskId: string): string {
    const safe = taskId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return join(this.rootDir, safe);
  }
}

function safeResult(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function randomSuffix(): string {
  return createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 8);
}

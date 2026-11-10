import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { ArtifactRecord, ExecutorId, RunRecord, RunUsage, TaskRecord } from "@hearth/core";
import { sha256File, type PreparedInput, resolveInside } from "./workspace.ts";

const MAX_FILES = 1_000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export interface PublishArtifactsOptions {
  task: TaskRecord;
  run: RunRecord;
  outDir: string;
  artifactBase: string;
  expectedOutputs: string[];
  inputs: PreparedInput[];
  excludeRelativePaths?: string[];
  executor?: {
    id: ExecutorId;
    threadId: string | null;
    label: string;
    usage: RunUsage | null;
  };
  codex?: {
    threadId: string | null;
    profileLabel: string;
    usage: RunUsage | null;
  };
  generatedAt?: string;
}

interface WalkedFile {
  relativePath: string;
  absolutePath: string;
  bytes: number;
}

export interface FileArtifactOptions {
  task: TaskRecord;
  run: RunRecord;
  absolutePath: string;
  relativePath: string;
  createdAt?: string;
}

export function createFileArtifact(options: FileArtifactOptions): ArtifactRecord {
  const stat = statSync(options.absolutePath);
  if (!stat.isFile() || stat.size === 0) throw new Error(`产物文件不存在或为空：${options.absolutePath}`);
  return {
    id: randomUUID(),
    taskId: options.task.id,
    runId: options.run.id,
    relativePath: options.relativePath.replace(/\\/g, "/"),
    absolutePath: options.absolutePath,
    mimeType: mimeType(options.relativePath),
    sha256: sha256File(options.absolutePath),
    bytes: stat.size,
    createdAt: options.createdAt ?? new Date().toISOString()
  };
}

export function publishArtifacts(options: PublishArtifactsOptions): ArtifactRecord[] {
  const now = options.generatedAt ?? new Date().toISOString();
  validateExpectedOutputs(options.outDir, options.expectedOutputs);
  const excluded = new Set((options.excludeRelativePaths ?? []).map((path) => path.replace(/\\/g, "/")));
  const files = walkFiles(options.outDir).filter((file) => !excluded.has(file.relativePath));
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (files.length > MAX_FILES) throw new Error(`产物文件过多：${files.length} > ${MAX_FILES}`);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`产物总大小超限：${totalBytes} bytes`);

  const publishedRoot = resolveInside(options.artifactBase, options.task.outputDir);
  if (isManagedOutputDir(options.task.outputDir)) {
    rmSync(publishedRoot, { recursive: true, force: true });
  }
  mkdirSync(publishedRoot, { recursive: true });
  const records: ArtifactRecord[] = [];
  for (const file of files) {
    const target = resolveInside(publishedRoot, file.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.absolutePath, target);
    records.push(artifactRecord(options, file.relativePath, target, now));
  }

  const manifest = {
    schemaVersion: 1,
    taskId: options.task.id,
    templateId: options.task.templateId,
    title: options.task.title,
    runId: options.run.id,
    attempt: options.run.attempt,
    generatedAt: now,
    inputs: options.inputs.map((input) => ({
      label: input.label,
      kind: input.kind,
      source: input.source,
      sha256: input.sha256,
      ...(input.metadata ? { metadata: input.metadata } : {})
    })),
    expectedOutputs: options.expectedOutputs,
    executor: options.executor ?? {
      id: "codex",
      threadId: options.codex?.threadId ?? null,
      label: options.codex?.profileLabel ?? "Codex",
      usage: options.codex?.usage ?? null
    },
    ...(options.codex ? { codex: options.codex } : {}),
    artifacts: records.map((record) => ({
      path: record.relativePath,
      sha256: record.sha256,
      bytes: record.bytes
    }))
  };
  const manifestPath = resolveInside(publishedRoot, "run-manifest.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  records.push(artifactRecord(options, "run-manifest.json", manifestPath, now));
  return records;
}

function isManagedOutputDir(outputDir: string): boolean {
  const normalized = outputDir.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.startsWith("eval/runs/")
    || normalized.startsWith(".hearth/artifacts/")
    || normalized.startsWith(".hearth/eval-artifacts/");
}

export function validateExpectedOutputs(outDir: string, expectedOutputs: string[]): void {
  if (!expectedOutputs.length) throw new Error("任务没有声明期望产物");
  for (const expected of expectedOutputs) {
    const relativePath = expected.replace(/[\\/]+$/, "");
    if (!relativePath) throw new Error(`无效的期望产物路径：${expected}`);
    const target = resolveInside(outDir, relativePath);
    if (!existsSync(target)) throw new Error(`缺少期望产物：${expected}`);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`产物不能是符号链接：${expected}`);
    if (expected.endsWith("/") || expected.endsWith("\\")) {
      if (!stat.isDirectory()) throw new Error(`期望目录但实际不是目录：${expected}`);
      if (walkFiles(target).length === 0) throw new Error(`期望目录为空：${expected}`);
    } else if (!stat.isFile() || stat.size === 0) {
      throw new Error(`期望文件不存在或为空：${expected}`);
    }
  }
}

export function missingExpectedOutputs(outDir: string, expectedOutputs: string[]): string[] {
  const missing: string[] = [];
  for (const expected of expectedOutputs) {
    try {
      validateExpectedOutputs(outDir, [expected]);
    } catch (error) {
      missing.push(error instanceof Error ? error.message : String(error));
    }
  }
  return missing;
}

function walkFiles(root: string): WalkedFile[] {
  const result: WalkedFile[] = [];
  walkDirectory(root, root, result);
  return result;
}

function walkDirectory(root: string, directory: string, result: WalkedFile[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`产物目录不允许符号链接：${absolutePath}`);
    if (entry.isDirectory()) {
      walkDirectory(root, absolutePath, result);
    } else if (entry.isFile()) {
      const stat = statSync(absolutePath);
      if (stat.size > 0) {
        const relativePath = absolutePath.slice(root.length + 1).replace(/\\/g, "/");
        result.push({ relativePath, absolutePath, bytes: stat.size });
      }
    } else {
      throw new Error(`产物包含不支持的条目：${absolutePath}`);
    }
  }
}

function artifactRecord(
  options: PublishArtifactsOptions,
  relativePath: string,
  absolutePath: string,
  createdAt: string
): ArtifactRecord {
  const stat = statSync(absolutePath);
  return {
    id: randomUUID(),
    taskId: options.task.id,
    runId: options.run.id,
    relativePath,
    absolutePath,
    mimeType: mimeType(relativePath),
    sha256: sha256File(absolutePath),
    bytes: stat.size,
    createdAt
  };
}

function mimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".md" || extension === ".markdown") return "text/markdown; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".csv") return "text/csv; charset=utf-8";
  if (extension === ".html" || extension === ".htm") return "text/html; charset=utf-8";
  if (extension === ".txt") return "text/plain; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

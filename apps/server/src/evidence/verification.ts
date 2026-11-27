// Declarative verification executed identically in production and evaluation.
//
// One spec language, one executor: the scheduler uses the production aggregate
// for completion gates, while Hearth Eval compiles the same spec into its
// per-unit scores. Units never invent evidence: when a check cannot run the
// result is `inconclusive`, not `pass`.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Ajv } from "ajv";
import type { ErrorObject } from "ajv";
import type { RuntimeExchange } from "@hearth/agent-runtime";
import { digestOf } from "./contracts.ts";

export type VerificationUnitType =
  | "file_exists"
  | "text_contains"
  | "json"
  | "csv"
  | "schema"
  | "command"
  | "artifact"
  | "trace"
  | "judge"
  | "human";

export interface VerificationUnitBase {
  id?: string;
  type: VerificationUnitType;
  /** Units may be marked advisory; advisory failures downgrade to warnings. */
  optional?: boolean;
  timeoutMs?: number;
}

export interface FileExistsUnit extends VerificationUnitBase {
  type: "file_exists";
  path: string;
  minBytes?: number;
}

export interface TextContainsUnit extends VerificationUnitBase {
  type: "text_contains";
  path?: string;
  contains?: string[];
  pattern?: string;
  flags?: string;
  /** Also search published artifacts when no path is given. */
  scope?: "workspace" | "artifacts";
}

export interface JsonUnit extends VerificationUnitBase {
  type: "json";
  path: string;
  pointer?: string;
  equals?: unknown;
  requiredKeys?: string[];
  minArrayLength?: number;
}

export interface CsvUnit extends VerificationUnitBase {
  type: "csv";
  path: string;
  columns?: string[];
  minRows?: number;
  maxRows?: number;
  columnTypes?: Record<string, "number" | "string" | "boolean">;
  unique?: string[];
}

export interface SchemaUnit extends VerificationUnitBase {
  type: "schema";
  path: string;
  jsonSchema: Record<string, unknown>;
}

export interface CommandUnit extends VerificationUnitBase {
  type: "command";
  command: string;
  cwd?: string;
  expectExitCode?: number;
  expectStdout?: string;
  expectStderr?: string;
}

export interface ArtifactUnit extends VerificationUnitBase {
  type: "artifact";
  relativePath: string;
  sha256?: string;
  mimeType?: string;
  minBytes?: number;
}

export interface TraceUnit extends VerificationUnitBase {
  type: "trace";
  invariant:
    | "no_unapproved_side_effect"
    | "approval_before_effect"
    | "no_skipped_verification"
    | "max_model_requests"
    | "termination_reason";
  limit?: number;
  value?: string;
}

export interface JudgeUnit extends VerificationUnitBase {
  type: "judge";
  rubric: string;
  model?: string;
  promptHash?: string;
  /** Judge output must itself carry a calibration version. */
  calibrationVersion?: string;
}

export interface HumanUnit extends VerificationUnitBase {
  type: "human";
  prompt: string;
  approvalId?: string;
}

export type VerificationUnit =
  | FileExistsUnit
  | TextContainsUnit
  | JsonUnit
  | CsvUnit
  | SchemaUnit
  | CommandUnit
  | ArtifactUnit
  | TraceUnit
  | JudgeUnit
  | HumanUnit;

export interface VerificationSpec {
  schemaVersion: 1;
  id: string;
  title?: string;
  mode: "production" | "eval";
  units: VerificationUnit[];
  aggregate: { mode: "all" | "any" | "threshold"; minPass?: number };
}

export type UnitStatus = "pass" | "fail" | "inconclusive" | "skipped";

export interface UnitResult {
  id: string;
  type: VerificationUnitType;
  status: UnitStatus;
  reason: string;
  evidence: Record<string, unknown>;
  durationMs: number;
  optional: boolean;
}

export interface VerificationResult {
  schemaVersion: 1;
  specId: string;
  mode: VerificationSpec["mode"];
  verdict: "pass" | "fail" | "inconclusive";
  aggregate: VerificationSpec["aggregate"];
  counts: { pass: number; fail: number; inconclusive: number; skipped: number; total: number };
  units: UnitResult[];
  missingArtifacts: string[];
  startedAt: string;
  finishedAt: string;
  /** Eval-facing normalized score in [0,1]; `null` when nothing was decidable. */
  score: number | null;
  success: boolean;
}

export interface ArtifactLike {
  relativePath: string;
  absolutePath: string;
  sha256: string;
  bytes: number;
  mimeType: string;
}

export interface VerificationContext {
  workspaceRoot: string;
  outDir?: string;
  artifacts?: ArtifactLike[];
  exchanges?: RuntimeExchange[];
  termination?: Record<string, unknown> | null;
  runCommand?: CommandUnitRunner;
  judge?: JudgeRunner;
  human?: HumanRunner;
  now?: () => Date;
}

export interface CommandRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
}

export type CommandUnitRunner = (unit: CommandUnit, context: VerificationContext) => Promise<CommandRunResult>;
export type JudgeRunner = (unit: JudgeUnit, context: VerificationContext) => Promise<{ pass: boolean; reason: string; score?: number }>;
export type HumanRunner = (unit: HumanUnit, context: VerificationContext) => Promise<{ pass: boolean; reason: string }>;

export function defaultCommandRunner(unit: CommandUnit, context: VerificationContext): Promise<CommandRunResult> {
  const cwd = unit.cwd ? resolve(context.workspaceRoot, unit.cwd) : context.workspaceRoot;
  const timeoutMs = Math.max(1_000, Math.min(600_000, unit.timeoutMs ?? 120_000));
  return new Promise((resolveRun) => {
    execFile(
      process.platform === "win32" ? "powershell.exe" : "/bin/sh",
      process.platform === "win32" ? ["-NoProfile", "-Command", unit.command] : ["-c", unit.command],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const rawCode = (error as NodeJS.ErrnoException & { code?: unknown } | null)?.code;
        const code = typeof rawCode === "number" ? rawCode : error ? 1 : 0;
        const timedOut = Boolean(error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed);
        resolveRun({
          exitCode: code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut,
          error: error ? error.message : null
        });
      }
    );
  });
}

function resolvePath(context: VerificationContext, path: string): string {
  if (isAbsolute(path)) return path;
  return resolve(context.workspaceRoot, path);
}

function relPath(context: VerificationContext, absolute: string, relativeHint?: string): string {
  if (relativeHint) return relativeHint.replaceAll("\\", "/");
  const root = resolve(context.workspaceRoot);
  const value = resolve(absolute).replaceAll("\\", "/");
  return value.startsWith(root.replaceAll("\\", "/")) ? value.slice(root.length + 1) : value;
}

function artifactFor(context: VerificationContext, path: string): ArtifactLike | null {
  const absolute = resolvePath(context, path).replaceAll("\\", "/");
  return (context.artifacts ?? []).find((artifact) => artifact.absolutePath.replaceAll("\\", "/") === absolute) ?? null;
}

function validateUnit(unit: VerificationUnit): string | null {
  const id = unit.id ?? unit.type;
  switch (unit.type) {
    case "file_exists":
      return unit.path ? null : `${id}: 缺少 path`;
    case "text_contains":
      return unit.contains?.length || unit.pattern ? null : `${id}: 需要 contains 或 pattern`;
    case "json":
      return unit.path ? null : `${id}: 缺少 path`;
    case "csv":
      return unit.path ? null : `${id}: 缺少 path`;
    case "schema":
      return unit.path && unit.jsonSchema ? null : `${id}: 需要 path 与 jsonSchema`;
    case "command":
      return unit.command ? null : `${id}: 缺少 command`;
    case "artifact":
      return unit.relativePath ? null : `${id}: 缺少 relativePath`;
    case "trace":
      return null;
    case "judge":
      return unit.rubric ? null : `${id}: 缺少 rubric`;
    case "human":
      return unit.prompt ? null : `${id}: 缺少 prompt`;
    default:
      return `${id}: 未知检查类型`;
  }
}

function evaluateJsonPointer(root: unknown, pointer: string): { found: boolean; value: unknown } {
  if (!pointer || pointer === "/") return { found: true, value: root };
  const parts = pointer.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false, value: null };
      current = current[index];
      continue;
    }
    if (current && typeof current === "object") {
      const record = current as Record<string, unknown>;
      if (!(part in record)) return { found: false, value: null };
      current = record[part];
      continue;
    }
    return { found: false, value: null };
  }
  return { found: true, value: current };
}

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; } else { quoted = false; }
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(field); field = ""; continue; }
    if (char === "\n") { row.push(field); field = ""; records.push(row); row = []; continue; }
    if (char === "\r") continue;
    field += char;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); records.push(row); }
  const nonEmpty = records.filter((record) => record.some((cell) => cell.trim() !== ""));
  const header = (nonEmpty[0] ?? []).map((cell) => cell.trim());
  return { header, rows: nonEmpty.slice(1) };
}

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ");
}

function effectOf(exchange: RuntimeExchange): string | null {
  const receipt = exchange.sideEffectReceipt as Record<string, unknown> | null;
  if (receipt && typeof receipt.effect === "string") return receipt.effect;
  const output = exchange.output as unknown as Record<string, unknown> | null;
  if (output && typeof output.effect === "string") return output.effect;
  if (output && typeof output.status === "string" && output.status === "dispatched") {
    const effect = output.effect;
    if (typeof effect === "string") return effect;
  }
  return null;
}

/** Run a single shared verification unit. Goal Review and Eval adapters call this. */
export async function runVerificationUnit(unit: VerificationUnit, context: VerificationContext): Promise<UnitResult> {
  return runUnit(unit, context);
}

async function runUnit(unit: VerificationUnit, context: VerificationContext): Promise<UnitResult> {  const started = Date.now();
  const id = unit.id ?? `${unit.type}:${context.artifacts?.length ?? 0}`;
  const optional = unit.optional === true;
  const result = (status: UnitStatus, reason: string, evidence: Record<string, unknown> = {}): UnitResult => ({
    id, type: unit.type, status, reason, evidence, durationMs: Date.now() - started, optional
  });
  const invalid = validateUnit(unit);
  if (invalid) return result("inconclusive", invalid);

  switch (unit.type) {
    case "file_exists": {
      const absolute = resolvePath(context, unit.path);
      if (!existsSync(absolute)) {
        const artifact = artifactFor(context, unit.path);
        if (!artifact) return result("fail", `文件不存在：${unit.path}`);
      }
      const size = existsSync(absolute) ? statSync(absolute).size : artifactFor(context, unit.path)?.bytes ?? 0;
      if (unit.minBytes !== undefined && size < unit.minBytes) {
        return result("fail", `文件小于 ${unit.minBytes} 字节（${size}）`, { path: relPath(context, absolute, unit.path), bytes: size });
      }
      return result("pass", `文件存在（${size} 字节）`, { path: relPath(context, absolute, unit.path), bytes: size });
    }
    case "text_contains": {
      const files: string[] = [];
      if (unit.path) files.push(unit.path);
      else if (unit.scope === "artifacts") files.push(...(context.artifacts ?? []).map((artifact) => artifact.relativePath));
      else {
        // Default: the first published text artifact, else result.md.
        const textArtifact = (context.artifacts ?? []).find((artifact) => /\.(md|txt|json|csv|html|log)$/i.test(artifact.relativePath));
        files.push(textArtifact?.relativePath ?? "result.md");
      }
      const contents: string[] = [];
      for (const file of files) {
        const absolute = resolvePath(context, file);
        if (!existsSync(absolute)) continue;
        contents.push(readFileSync(absolute, "utf8"));
      }
      if (contents.length === 0) return result("inconclusive", "没有可读取的文本产物", { files });
      const haystack = contents.join("\n");
      const missing = (unit.contains ?? []).filter((needle) => !haystack.includes(needle));
      if (missing.length > 0) return result("fail", `缺少必需文本：${missing.join(" | ")}`, { files, missing });
      if (unit.pattern) {
        let regex: RegExp;
        try {
          regex = new RegExp(unit.pattern, unit.flags ?? "m");
        } catch (error) {
          return result("inconclusive", `正则无效：${error instanceof Error ? error.message : String(error)}`);
        }
        if (!regex.test(haystack)) return result("fail", `文本未匹配模式：${unit.pattern}`, { files, pattern: unit.pattern });
      }
      return result("pass", "文本检查通过", { files });
    }
    case "json": {
      const absolute = resolvePath(context, unit.path);
      if (!existsSync(absolute)) return result("fail", `JSON 文件不存在：${unit.path}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(absolute, "utf8"));
      } catch (error) {
        return result("fail", `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
      }
      const pointer = evaluateJsonPointer(parsed, unit.pointer ?? "/");
      if (!pointer.found) return result("fail", `JSON pointer 不存在：${unit.pointer ?? "/"}`, { path: unit.path });
      if (unit.equals !== undefined) {
        const actual = JSON.stringify(pointer.value);
        const expected = JSON.stringify(unit.equals);
        if (actual !== expected) return result("fail", `值不匹配：期望 ${expected}，实际 ${actual}`, { path: unit.path, pointer: unit.pointer ?? "/", actual: pointer.value });
      }
      if (unit.requiredKeys?.length) {
        const target = pointer.value;
        if (!target || typeof target !== "object" || Array.isArray(target)) {
          return result("fail", `目标不是对象，无法检查 requiredKeys`, { pointer: unit.pointer ?? "/" });
        }
        const missingKeys = unit.requiredKeys.filter((key) => !(key in (target as Record<string, unknown>)));
        if (missingKeys.length > 0) return result("fail", `缺少字段：${missingKeys.join(", ")}`, { missingKeys });
      }
      if (unit.minArrayLength !== undefined) {
        if (!Array.isArray(pointer.value) || pointer.value.length < unit.minArrayLength) {
          return result("fail", `数组长度不足 ${unit.minArrayLength}`, { actual: Array.isArray(pointer.value) ? pointer.value.length : null });
        }
      }
      return result("pass", "JSON 检查通过", { path: unit.path, pointer: unit.pointer ?? "/" });
    }
    case "csv": {
      const absolute = resolvePath(context, unit.path);
      if (!existsSync(absolute)) return result("fail", `CSV 文件不存在：${unit.path}`);
      const { header, rows } = parseCsv(readFileSync(absolute, "utf8"));
      if (unit.columns?.length) {
        const missing = unit.columns.filter((column) => !header.includes(column));
        if (missing.length > 0) return result("fail", `缺少列：${missing.join(", ")}`, { header, missing });
      }
      if (unit.minRows !== undefined && rows.length < unit.minRows) {
        return result("fail", `行数不足：${rows.length} < ${unit.minRows}`, { rows: rows.length });
      }
      if (unit.maxRows !== undefined && rows.length > unit.maxRows) {
        return result("fail", `行数超限：${rows.length} > ${unit.maxRows}`, { rows: rows.length });
      }
      if (unit.columnTypes) {
        for (const [column, type] of Object.entries(unit.columnTypes)) {
          const index = header.indexOf(column);
          if (index < 0) return result("fail", `类型检查列不存在：${column}`);
          const invalidRows = rows.filter((row) => {
            const cell = (row[index] ?? "").trim();
            if (cell === "") return false;
            if (type === "number") return !Number.isFinite(Number(cell));
            if (type === "boolean") return !/^(true|false)$/i.test(cell);
            return false;
          });
          if (invalidRows.length > 0) return result("fail", `列 ${column} 存在非 ${type} 值`, { column, invalidRows: invalidRows.length });
        }
      }
      if (unit.unique?.length) {
        for (const column of unit.unique) {
          const index = header.indexOf(column);
          if (index < 0) return result("fail", `唯一性检查列不存在：${column}`);
          const values = rows.map((row) => (row[index] ?? "").trim()).filter(Boolean);
          const duplicates = values.filter((value, position) => values.indexOf(value) !== position);
          if (duplicates.length > 0) return result("fail", `列 ${column} 存在重复值`, { column, duplicates: [...new Set(duplicates)].slice(0, 10) });
        }
      }
      return result("pass", "CSV 检查通过", { rows: rows.length, columns: header.length });
    }
    case "schema": {
      const absolute = resolvePath(context, unit.path);
      if (!existsSync(absolute)) return result("fail", `文件不存在：${unit.path}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(absolute, "utf8"));
      } catch (error) {
        return result("fail", `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
      }
      const validate = ajv.compile(unit.jsonSchema);
      if (!validate(parsed)) {
        return result("fail", `Schema 校验失败：${formatAjvErrors(validate.errors)}`, { errors: validate.errors ?? [] });
      }
      return result("pass", "Schema 校验通过", { path: unit.path });
    }
    case "command": {
      if (!context.runCommand) return result("inconclusive", "未提供命令执行器");
      const outcome = await context.runCommand(unit, context);
      const expectedCode = unit.expectExitCode ?? 0;
      if (outcome.exitCode !== expectedCode) {
        return result("fail", outcome.timedOut ? "命令超时" : `退出码 ${outcome.exitCode}，期望 ${expectedCode}`, {
          stdout: outcome.stdout.slice(-4000), stderr: outcome.stderr.slice(-4000), exitCode: outcome.exitCode
        });
      }
      if (unit.expectStdout && !outcome.stdout.includes(unit.expectStdout)) {
        return result("fail", `stdout 缺少 ${unit.expectStdout}`, { stdout: outcome.stdout.slice(-4000) });
      }
      if (unit.expectStderr && !outcome.stderr.includes(unit.expectStderr)) {
        return result("fail", `stderr 缺少 ${unit.expectStderr}`, { stderr: outcome.stderr.slice(-4000) });
      }
      return result("pass", "命令检查通过", { exitCode: outcome.exitCode });
    }
    case "artifact": {
      const artifact = (context.artifacts ?? []).find((item) => item.relativePath === unit.relativePath);
      if (!artifact) {
        if (context.workspaceRoot) {
          const disk = checkArtifactOnDisk(context.workspaceRoot, unit.relativePath);
          if (!disk.ok) return result("fail", disk.message, { relativePath: unit.relativePath });
          if (unit.minBytes !== undefined && disk.bytes < unit.minBytes) {
            return result("fail", `产物过小：${disk.bytes}`, { relativePath: unit.relativePath, bytes: disk.bytes });
          }
          return result("pass", "产物检查通过（磁盘）", { relativePath: unit.relativePath, bytes: disk.bytes });
        }
        return result("fail", `未找到已发布产物：${unit.relativePath}`, { relativePath: unit.relativePath });
      }
      if (unit.sha256 && artifact.sha256 !== unit.sha256) {
        return result("fail", `产物哈希不匹配：${artifact.sha256}`, { relativePath: unit.relativePath });
      }
      if (unit.mimeType && artifact.mimeType !== unit.mimeType) {
        return result("fail", `产物类型不匹配：${artifact.mimeType}`, { relativePath: unit.relativePath });
      }
      if (unit.minBytes !== undefined && artifact.bytes < unit.minBytes) {
        return result("fail", `产物过小：${artifact.bytes}`, { relativePath: unit.relativePath });
      }
      return result("pass", "产物检查通过", { relativePath: unit.relativePath, sha256: artifact.sha256, bytes: artifact.bytes });
    }
    case "trace": {
      const exchanges = context.exchanges ?? [];
      if (exchanges.length === 0) {
        return result("inconclusive", "没有可用的轨迹证据（cassette 未录制或未加载）");
      }
      const toolCalls = exchanges.filter((exchange) => exchange.kind === "tool.call");
      const approvals = exchanges.filter((exchange) => exchange.kind === "approval.decision");
      const modelRequests = exchanges.filter((exchange) => exchange.kind === "model.request");
      if (unit.invariant === "max_model_requests") {
        const limit = unit.limit ?? 0;
        return modelRequests.length <= limit
          ? result("pass", `模型请求 ${modelRequests.length} <= ${limit}`, { modelRequests: modelRequests.length })
          : result("fail", `模型请求 ${modelRequests.length} > ${limit}`, { modelRequests: modelRequests.length });
      }
      if (unit.invariant === "no_unapproved_side_effect") {
        if (exchanges.length === 0) return result("inconclusive", "没有运行时交换记录，无法证明副作用已获审批");
        const externalCalls = toolCalls.filter((exchange) => {
          const effect = effectOf(exchange);
          return effect === "external" || effect === "write" || effect === "send";
        });
        const approved = approvals.filter((exchange) => (exchange.output as unknown as Record<string, unknown> | null)?.decision === "approved").length;
        if (externalCalls.length > approved) {
          return result("fail", `存在未审批外部副作用：${externalCalls.length} 次调用 / ${approved} 次审批`, { externalCalls: externalCalls.length, approved });
        }
        return result("pass", "外部副作用均有审批记录", { externalCalls: externalCalls.length, approved });
      }
      if (unit.invariant === "approval_before_effect") {
        if (toolCalls.length === 0) return result("inconclusive", "没有工具调用记录");
        const firstEffect = toolCalls.find((exchange) => {
          const effect = effectOf(exchange);
          return effect === "external" || effect === "write" || effect === "send";
        });
        if (!firstEffect) return result("pass", "没有外部副作用", { toolCalls: toolCalls.length });
        const firstApproval = approvals[0];
        if (!firstApproval || firstApproval.sequence > firstEffect.sequence) {
          return result("fail", "副作用发生在审批之前", { effectSequence: firstEffect.sequence, approvalSequence: firstApproval?.sequence ?? null });
        }
        return result("pass", "审批先于副作用", { effectSequence: firstEffect.sequence, approvalSequence: firstApproval.sequence });
      }
      if (unit.invariant === "no_skipped_verification") {
        if (context.termination?.reason !== "completed" && context.termination?.status !== "completed") {
          return result("pass", `非完成终止：${String(context.termination?.reason ?? context.termination?.status ?? "unknown")}`);
        }
        const verification = context.termination?.verification;
        if (!verification || typeof verification !== "object") {
          return result("inconclusive", "完成路径没有验证记录");
        }
        return result("pass", "完成路径包含验证记录", { verification });
      }
      if (unit.invariant === "termination_reason") {
        const reason = context.termination?.reason ?? context.termination?.status ?? null;
        if (reason === null) return result("inconclusive", "没有终止记录");
        return reason === unit.value
          ? result("pass", `终止原因 ${String(reason)}`)
          : result("fail", `终止原因 ${String(reason)} != ${unit.value}`);
      }
      return result("inconclusive", `未知 trace invariant：${String((unit as TraceUnit).invariant)}`);
    }
    case "judge": {
      if (!context.judge) {
        return result("inconclusive", "未配置 Judge 执行器，禁止用默认分数冒充通过");
      }
      const judged = await context.judge(unit, context);
      return result(judged.pass ? "pass" : "fail", judged.reason, {
        score: judged.score ?? null,
        model: unit.model ?? null,
        calibrationVersion: unit.calibrationVersion ?? null,
        promptHash: unit.promptHash ?? null
      });
    }
    case "human": {
      if (!context.human) return result("inconclusive", "等待人工确认");
      const decided = await context.human(unit, context);
      return result(decided.pass ? "pass" : "fail", decided.reason, { approvalId: unit.approvalId ?? null });
    }
    default:
      return result("inconclusive", "未知检查类型");
  }
}

export function aggregateVerdict(spec: VerificationSpec, units: UnitResult[]): {
  verdict: VerificationResult["verdict"];
  counts: VerificationResult["counts"];
  score: number | null;
  success: boolean;
} {
  const counts = {
    pass: units.filter((unit) => unit.status === "pass").length,
    fail: units.filter((unit) => unit.status === "fail").length,
    inconclusive: units.filter((unit) => unit.status === "inconclusive").length,
    skipped: units.filter((unit) => unit.status === "skipped").length,
    total: units.length
  };
  const mandatory = units.filter((unit) => !unit.optional);
  const failingMandatory = mandatory.filter((unit) => unit.status === "fail").length;
  const undecidedMandatory = mandatory.filter((unit) => unit.status === "inconclusive").length;
  const passedMandatory = mandatory.filter((unit) => unit.status === "pass").length;
  let verdict: VerificationResult["verdict"];
  switch (spec.aggregate.mode) {
    case "any":
      verdict = passedMandatory > 0 ? "pass" : failingMandatory > 0 ? "fail" : "inconclusive";
      break;
    case "threshold": {
      const minPass = spec.aggregate.minPass ?? Math.ceil(mandatory.length / 2);
      verdict = failingMandatory > 0 && passedMandatory < minPass
        ? "fail"
        : passedMandatory >= minPass
          ? "pass"
          : "inconclusive";
      break;
    }
    default:
      verdict = failingMandatory > 0 ? "fail" : undecidedMandatory > 0 ? "inconclusive" : "pass";
  }
  const score = counts.total > 0 ? Number((counts.pass / counts.total).toFixed(4)) : null;
  return { verdict, counts, score, success: verdict === "pass" };
}

export async function runVerificationSpec(spec: VerificationSpec, context: VerificationContext): Promise<VerificationResult> {
  const now = context.now ?? (() => new Date());
  const startedAt = now().toISOString();
  if (spec.schemaVersion !== 1) {
    throw new Error(`未知验证 spec 版本：${String(spec.schemaVersion)}`);
  }
  const unitResults: UnitResult[] = [];
  for (const unit of spec.units) {
    if (unit.optional && unit.type === "human" && !context.human) {
      unitResults.push({
        id: unit.id ?? "human", type: "human", status: "skipped", reason: "可选人工确认未提供",
        evidence: {}, durationMs: 0, optional: true
      });
      continue;
    }
    try {
      unitResults.push(await runUnit(unit, context));
    } catch (error) {
      unitResults.push({
        id: unit.id ?? `${unit.type}:error`,
        type: unit.type,
        status: "inconclusive",
        reason: `检查执行异常：${error instanceof Error ? error.message : String(error)}`,
        evidence: {},
        durationMs: 0,
        optional: unit.optional === true
      });
    }
  }
  const aggregate = aggregateVerdict(spec, unitResults);
  const artifacts = context.artifacts ?? [];
  const missingArtifacts = spec.units
    .filter((unit): unit is ArtifactUnit => unit.type === "artifact")
    .filter((unit) => !artifacts.some((artifact) => artifact.relativePath === unit.relativePath))
    .map((unit) => unit.relativePath);
  return {
    schemaVersion: 1,
    specId: spec.id,
    mode: spec.mode,
    verdict: aggregate.verdict,
    aggregate: spec.aggregate,
    counts: aggregate.counts,
    units: unitResults,
    missingArtifacts,
    startedAt,
    finishedAt: now().toISOString(),
    score: aggregate.score,
    success: aggregate.success
  };
}

/** Production adapter: a formal-ish completion gate is only green on `pass`. */
export function productionGate(result: VerificationResult): { allowed: boolean; reason: string; needsReview: boolean } {
  if (result.verdict === "pass") return { allowed: true, reason: "verified", needsReview: false };
  if (result.verdict === "fail") {
    const failed = result.units.filter((unit) => unit.status === "fail" && !unit.optional).map((unit) => `${unit.id}: ${unit.reason}`);
    return { allowed: false, reason: failed.join("; ") || "verification_failed", needsReview: false };
  }
  return { allowed: false, reason: "verification_inconclusive", needsReview: true };
}

/** Eval adapter: exposes per-unit outcomes plus a normalized score. */
export function evalAdapter(result: VerificationResult): {
  success: boolean;
  score: number | null;
  perUnit: Array<{ id: string; type: string; status: UnitStatus; reason: string }>;
  inconclusive: string[];
} {
  return {
    success: result.verdict === "pass",
    score: result.score,
    perUnit: result.units.map((unit) => ({ id: unit.id, type: unit.type, status: unit.status, reason: unit.reason })),
    inconclusive: result.units.filter((unit) => unit.status === "inconclusive").map((unit) => unit.id)
  };
}

/** Structural validation used by both HTTP handlers and eval ingestion. */
export interface ArtifactDiskCheck {
  ok: boolean;
  message: string;
  bytes: number;
}

/**
 * The single on-disk artifact rule shared by the production completion gate
 * (`validateExpectedOutputs`) and verification specs. A path is accepted only
 * when it exists inside the workspace, is not a symlink, and is a non-empty
 * file (or a non-empty directory when the path ends with a separator).
 */
export function checkArtifactOnDisk(workspaceRoot: string, relativePath: string): ArtifactDiskCheck {
  const expectsDirectory = relativePath.endsWith("/") || relativePath.endsWith("\\");
  const normalized = relativePath.replace(/[\\/]+$/, "");
  if (!normalized) return { ok: false, message: `无效的产物路径：${relativePath}`, bytes: 0 };
  const target = resolve(workspaceRoot, normalized);
  const rel = relative(workspaceRoot, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, message: `产物路径越出工作区：${relativePath}`, bytes: 0 };
  }
  if (!existsSync(target)) return { ok: false, message: `缺少产物：${relativePath}`, bytes: 0 };
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) return { ok: false, message: `产物不能是符号链接：${relativePath}`, bytes: 0 };
  if (expectsDirectory) {
    if (!stat.isDirectory()) return { ok: false, message: `期望目录但实际不是目录：${relativePath}`, bytes: 0 };
    if (readdirSync(target).length === 0) return { ok: false, message: `期望目录为空：${relativePath}`, bytes: 0 };
    return { ok: true, message: "目录检查通过", bytes: stat.size };
  }
  if (!stat.isFile() || stat.size === 0) return { ok: false, message: `产物不存在或为空：${relativePath}`, bytes: stat.size };
  return { ok: true, message: "产物检查通过", bytes: stat.size };
}

export function validateVerificationSpec(value: unknown): { ok: true; spec: VerificationSpec } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return { ok: false, errors: ["spec 必须是对象"] };
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  if (typeof record.id !== "string" || !record.id) errors.push("id 必填");
  if (record.mode !== "production" && record.mode !== "eval") errors.push("mode 必须为 production 或 eval");
  if (!Array.isArray(record.units) || record.units.length === 0) errors.push("units 不能为空");
  const aggregate = record.aggregate as Record<string, unknown> | undefined;
  if (!aggregate || !["all", "any", "threshold"].includes(String(aggregate.mode))) errors.push("aggregate.mode 无效");
  if (aggregate?.mode === "threshold" && typeof aggregate.minPass !== "number") errors.push("threshold 模式需要 minPass");
  if (Array.isArray(record.units)) {
    for (const [index, unit] of record.units.entries()) {
      if (!unit || typeof unit !== "object") { errors.push(`units[${index}] 不是对象`); continue; }
      const unitError = validateUnit(unit as VerificationUnit);
      if (unitError) errors.push(unitError);
    }
  }
  return errors.length === 0
    ? { ok: true, spec: record as unknown as VerificationSpec }
    : { ok: false, errors };
}

export function specDigest(spec: VerificationSpec): string {
  return digestOf(spec);
}

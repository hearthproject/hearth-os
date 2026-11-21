import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, dirname, join, relative, resolve, sep } from "node:path";
import { SANDBOX_MODES, type SandboxMode, type TaskPermissions } from "@hearth/core";

export type ConfinedSandboxMode = Exclude<SandboxMode, "danger-full-access">;
export type SandboxEnforcement = "full" | "partial" | "none";
export type NetworkEnforcement = "full" | "proxy-partial" | "none";

/**
 * File-effect policy resolved for one native run. The root is always carried so
 * callers can decide the enforcement path before spawning.
 */
export interface SandboxPolicy {
  mode: ConfinedSandboxMode;
  workspaceRoot: string;
  writableRoots: readonly string[];
  readRoots: readonly string[];
  networkHosts: readonly string[];
  tempRoot: string;
  sessionId: string;
  env: Readonly<Record<string, string>>;
}

export interface SandboxResolveInput {
  permissions: Pick<TaskPermissions, "readRoots" | "writeRoots" | "networkHosts" | "sandboxMode">;
  workspaceRoot: string;
  outDir: string;
  sessionId: string;
  defaultMode?: SandboxMode;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface SandboxSelection {
  mode: SandboxMode;
  policy: SandboxPolicy | null;
  warnings: string[];
}

export interface SandboxRequest {
  argv: readonly string[];
  cwd: string;
  policy: SandboxPolicy;
  signal?: AbortSignal;
  /** Allocate a ConPTY-backed console for the child instead of plain pipes. */
  pty?: { cols: number; rows: number };
}

export interface RunnerFailureRule {
  allowedExitCodes?: readonly number[];
  fatalSignatures: readonly string[];
  informationalLines?: readonly string[];
}

export interface ConfinedCommand {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  backend: "windows-acl" | "bwrap" | "landlock" | "seatbelt" | "docker" | "none";
  enforcement: SandboxEnforcement;
  networkEnforcement: NetworkEnforcement;
  denialSignatures: readonly string[];
  runnerFailureRules: readonly RunnerFailureRule[];
}

export interface SandboxProvider {
  readonly id: string;
  confine(request: SandboxRequest): Promise<ConfinedCommand>;
}

export interface SandboxRuntime {
  provider: SandboxProvider;
  policy: SandboxPolicy;
}

export class SandboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
  }
}

export class SandboxUnavailableError extends SandboxError {
  constructor(message = "沙箱后端不可用") {
    super("SANDBOX_UNAVAILABLE", message);
    this.name = "SandboxUnavailableError";
  }
}

export class SandboxDeniedError extends SandboxError {
  readonly path: string | null;

  constructor(message: string, path: string | null = null) {
    super("SANDBOX_DENIED", message);
    this.name = "SandboxDeniedError";
    this.path = path;
  }
}

export class SandboxUnsupportedPolicyError extends SandboxError {
  constructor(message: string) {
    super("SANDBOX_UNSUPPORTED_POLICY", message);
    this.name = "SandboxUnsupportedPolicyError";
  }
}

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && (SANDBOX_MODES as readonly string[]).includes(value);
}

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function comparisonPath(path: string): string {
  const canonical = canonicalPath(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function pathWithin(parent: string, child: string): boolean {
  const parentPath = comparisonPath(parent);
  const childPath = comparisonPath(child);
  const rel = relative(parentPath, childPath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function samePath(left: string, right: string): boolean {
  return comparisonPath(left) === comparisonPath(right);
}

export function commonAncestor(left: string, right: string): string | null {
  let candidate = canonicalPath(left);
  const target = canonicalPath(right);
  while (true) {
    if (pathWithin(candidate, target)) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

export function isFilesystemRoot(path: string): boolean {
  return dirname(canonicalPath(path)) === canonicalPath(path);
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (!path) continue;
    const canonical = canonicalPath(path);
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(canonical);
  }
  return result;
}

function safeSessionSegment(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "session";
}

export function sandboxTempBase(): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "Temp");
  }
  return tmpdir();
}

export function resolveSandboxPolicy(input: SandboxResolveInput): SandboxSelection {
  const mode = input.permissions.sandboxMode ?? input.defaultMode ?? "workspace-write";
  if (!isSandboxMode(mode)) throw new SandboxUnsupportedPolicyError(`未知沙箱模式：${String(mode)}`);
  const warnings: string[] = [];
  if (mode === "danger-full-access") {
    warnings.push("danger-full-access：native shell 未隔离，仅允许 operator 显式配置时使用");
    return { mode, policy: null, warnings };
  }

  const workspaceRoot = canonicalPath(input.workspaceRoot);
  if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) {
    throw new SandboxUnsupportedPolicyError(`工作区根目录不存在或不是目录：${workspaceRoot}`);
  }

  const writableRoots = uniquePaths([workspaceRoot, input.outDir, ...input.permissions.writeRoots]);
  const acceptedRoots: string[] = [];
  for (const root of writableRoots) {
    if (pathWithin(workspaceRoot, root)) {
      acceptedRoots.push(root);
      continue;
    }
    warnings.push(`工作区外的可写根不会暴露给 shell：${root}`);
  }

  const tempRoot = join(sandboxTempBase(), "hearth-sandbox", safeSessionSegment(input.sessionId));
  if (pathWithin(workspaceRoot, tempRoot)) {
    throw new SandboxUnsupportedPolicyError(`沙箱 temp 目录不能位于工作区内：${tempRoot}`);
  }

  const env = buildChildEnv({
    base: input.baseEnv ?? process.env,
    tempRoot,
    workspaceRoot
  });

  return {
    mode,
    policy: {
      mode,
      workspaceRoot,
      writableRoots: acceptedRoots,
      readRoots: uniquePaths(input.permissions.readRoots),
      networkHosts: [...input.permissions.networkHosts],
      tempRoot,
      sessionId: input.sessionId,
      env
    },
    warnings
  };
}

const ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "SYSTEMDRIVE",
  "SystemDrive",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "PSModulePath",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "USERDOMAIN",
  "LOGONSERVER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SHELL",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "OS"
];

const SECRET_ENV = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|SESSION|COOKIE|BEARER|AUTH)/i;
const UNSAFE_ENV = new Set([
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "GIT_SSH_COMMAND",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "SHELLOPTS",
  "PS4"
]);

function isAllowedEnvKey(key: string): boolean {
  if (key.startsWith("HEARTH_")) return false;
  if (UNSAFE_ENV.has(key.toUpperCase())) return false;
  if (SECRET_ENV.test(key)) return false;
  return true;
}

const EXTRA_ENV_BLOCKED = new Set(
  ENV_ALLOWLIST.map((key) => key.toLowerCase())
);

function isAllowedExtraEnvKey(key: string): boolean {
  if (!isAllowedEnvKey(key)) return false;
  if (EXTRA_ENV_BLOCKED.has(key.toLowerCase())) return false;
  return true;
}

function copyAllowedValue(target: Record<string, string>, key: string, value: string | undefined): void {
  if (value === undefined) return;
  target[key] = value;
}

export function buildChildEnv(input: {
  base?: NodeJS.ProcessEnv;
  extra?: Record<string, string> | undefined;
  tempRoot: string;
  workspaceRoot: string;
}): Record<string, string> {
  const base = input.base ?? process.env;
  const result: Record<string, string> = {};
  const allowedLower = new Set(ENV_ALLOWLIST.map((key) => key.toLowerCase()));

  for (const [key, value] of Object.entries(base)) {
    if (!isAllowedEnvKey(key)) continue;
    if (!allowedLower.has(key.toLowerCase())) continue;
    copyAllowedValue(result, key, value);
  }

  if (!result.PATH && !result.Path) {
    const fallback = process.platform === "win32"
      ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32"), process.env.SystemRoot ?? "C:\\Windows"]
      : ["/usr/local/bin", "/usr/bin", "/bin"];
    result.PATH = fallback.join(process.platform === "win32" ? ";" : ":");
  }

  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const required = [
      join(systemRoot, "System32"),
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
      systemRoot
    ];
    const segments = (result.PATH ?? result.Path ?? "").split(";").filter(Boolean);
    for (const entry of required) {
      if (!segments.some((segment) => segment.toLowerCase() === entry.toLowerCase())) segments.push(entry);
    }
    result.PATH = segments.join(";");
    delete result.Path;
  }

  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (!isAllowedExtraEnvKey(key)) continue;
    copyAllowedValue(result, key, value);
  }

  result.TMP = input.tempRoot;
  result.TEMP = input.tempRoot;
  const cacheRoot = join(input.workspaceRoot, ".hearth", "sandbox", "cache");
  result.npm_config_cache = join(cacheRoot, "npm");
  result.YARN_CACHE_FOLDER = join(cacheRoot, "yarn");
  result.PIP_CACHE_DIR = join(cacheRoot, "pip");
  result.CARGO_HOME = join(cacheRoot, "cargo");
  result.GOMODCACHE = join(cacheRoot, "go-mod");
  return result;
}

export function ensureSandboxTemp(policy: SandboxPolicy): void {
  mkdirSync(policy.tempRoot, { recursive: true });
  mkdirSync(join(policy.workspaceRoot, ".hearth", "sandbox", "cache"), { recursive: true });
}

export function runnerFailed(
  stderr: string,
  exitCode: number | null,
  rules: readonly RunnerFailureRule[]
): boolean {
  const lines = stderr.split(/\r?\n/);
  for (const rule of rules) {
    if (rule.allowedExitCodes && exitCode !== null && !rule.allowedExitCodes.includes(exitCode)) continue;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if ((rule.informationalLines ?? []).some((item) => item.toLowerCase() === trimmed.toLowerCase())) continue;
      if (rule.fatalSignatures.some((signature) => trimmed.toLowerCase().includes(signature.toLowerCase()))) {
        return true;
      }
    }
  }
  return false;
}

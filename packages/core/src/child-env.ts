import { join } from "node:path";

export const EXECUTOR_SYSTEM_ENV_ALLOWLIST = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "SystemDrive", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "ProgramW6432", "CommonProgramFiles", "PSModulePath", "HOME", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "LOGONSERVER", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS"] as const;
const SECRET_ENV = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|SESSION|COOKIE|BEARER|AUTH)/i;
const EXECUTOR_UNSAFE_ENV = new Set(["NODE_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "GIT_SSH_COMMAND", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "BASH_ENV", "ENV", "PROMPT_COMMAND", "SHELLOPTS", "PS4"]);
const SYSTEM_ENV_KEYS = new Set(EXECUTOR_SYSTEM_ENV_ALLOWLIST.map((key) => key.toLowerCase()));
const PROTECTED_OVERRIDES = new Set([...EXECUTOR_SYSTEM_ENV_ALLOWLIST.map((key) => key.toLowerCase()), "npm_config_cache", "yarn_cache_folder", "pip_cache_dir", "cargo_home", "gomodcache"]);

export function isExecutorUnsafeEnvKey(key: string): boolean {
  return EXECUTOR_UNSAFE_ENV.has(key.toUpperCase());
}

function safeHostVariable(key: string): boolean {
  if (key.startsWith("HEARTH_")) return false;
  if (isExecutorUnsafeEnvKey(key)) return false;
  return !SECRET_ENV.test(key);
}

function executorFallbackPath(): string {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    return [join(root, "System32"), root].join(";");
  }
  return "/usr/local/bin:/usr/bin:/bin";
}

export function buildExecutorEnv(input: { base?: NodeJS.ProcessEnv; trusted?: Record<string, string | null | undefined> } = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.base ?? process.env)) {
    if (typeof value === "string" && SYSTEM_ENV_KEYS.has(key.toLowerCase()) && safeHostVariable(key)) result[key] = value;
  }
  if (!result.PATH && !result.Path) result.PATH = executorFallbackPath();
  if (process.platform === "win32") {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    const pathKey = result.PATH ? "PATH" : result.Path ? "Path" : null;
    const segments = (pathKey ? result[pathKey] ?? "" : "").split(";").filter(Boolean);
    const normalized = (value: string): string => value.replace(/[\\/]+$/, "").toLowerCase();
    const system32 = normalized(join(root, "System32"));
    // A PATH that already reaches System32 is usable as-is. Only repair a
    // stripped PATH, and keep the repair idempotent.
    if (!segments.some((segment) => normalized(segment) === system32)) {
      for (const entry of [join(root, "System32"), join(root, "System32", "WindowsPowerShell", "v1.0"), root]) {
        if (!segments.some((segment) => normalized(segment) === normalized(entry))) segments.push(entry);
      }
      result.PATH = segments.join(";");
      delete result.Path;
    }
  }
  for (const [key, value] of Object.entries(input.trusted ?? {})) {
    if (isExecutorUnsafeEnvKey(key)) continue;
    if (value !== undefined && value !== null && key && !PROTECTED_OVERRIDES.has(key.toLowerCase())) result[key] = value;
  }
  return result;
}

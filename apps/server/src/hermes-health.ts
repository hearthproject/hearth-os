import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HermesHealth } from "@hearth/core";

interface CacheEntry {
  at: number;
  value: HermesHealth;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 30_000;

export function hermesHealth(command: string, maxAgeMs = TTL_MS): HermesHealth {
  const cached = cache.get(command);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.value;
  let value: HermesHealth;
  try {
    const output = execFileSync(command, ["--version"], {
      timeout: 4_000,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const version = output.trim().split(/\r?\n/)[0] ?? null;
    const configPath = findHermesConfig();
    value = {
      canRun: Boolean(configPath),
      command,
      version: version || null,
      issues: configPath ? [] : ["Hermes 已安装，但还没有完成登录或 provider 配置"],
      configured: Boolean(configPath),
      configPath
    };
  } catch (error) {
    value = {
      canRun: false,
      command,
      version: null,
      issues: [`无法运行“${command} --version”：${error instanceof Error ? error.message : String(error)}`],
      configured: false,
      configPath: null
    };
  }
  cache.set(command, { at: Date.now(), value });
  return value;
}

export function clearHermesHealthCache(command?: string): void {
  if (command) cache.delete(command);
  else cache.clear();
}

function findHermesConfig(): string | null {
  const candidates = [
    process.env.HERMES_HOME,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "hermes") : null,
    process.env.APPDATA ? join(process.env.APPDATA, "hermes") : null,
    join(homedir(), ".hermes"),
    join(homedir(), ".config", "hermes")
  ].filter((value): value is string => Boolean(value));
  for (const directory of candidates) {
    for (const file of ["config.yaml", "config.yml", "auth.json"]) {
      const path = join(directory, file);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

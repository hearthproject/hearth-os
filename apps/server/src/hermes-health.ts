import { execFileSync } from "node:child_process";
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
    value = { canRun: true, command, version: version || null, issues: [] };
  } catch (error) {
    value = {
      canRun: false,
      command,
      version: null,
      issues: [`无法运行“${command} --version”：${error instanceof Error ? error.message : String(error)}`]
    };
  }
  cache.set(command, { at: Date.now(), value });
  return value;
}

export function clearHermesHealthCache(command?: string): void {
  if (command) cache.delete(command);
  else cache.clear();
}

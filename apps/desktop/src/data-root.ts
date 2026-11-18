import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DESKTOP_APP_DIR = "Hearth";
export const EXISTING_DATA_ROOT = process.env.HEARTH_EXISTING_ROOT ?? "D:\\App\\hearth-os";

export interface DesktopConfig {
  version: 1;
  root: string;
  dataDir: string;
  lastLaunchAt: string;
}

export interface DataRootCandidate {
  root: string;
  dataDir: string;
  databasePath: string;
  hasDatabase: boolean;
}

export function resolveDesktopBaseDir(localAppData = process.env.LOCALAPPDATA): string {
  const base = localAppData && localAppData.trim()
    ? localAppData
    : join(process.env.USERPROFILE ?? ".", "AppData", "Local");
  return join(base, DESKTOP_APP_DIR);
}

export function resolveDesktopConfigPath(localAppData = process.env.LOCALAPPDATA): string {
  return join(resolveDesktopBaseDir(localAppData), "desktop.json");
}

export function candidateFor(root: string): DataRootCandidate {
  const resolvedRoot = resolve(root);
  const dataDir = join(resolvedRoot, ".hearth");
  const databasePath = join(dataDir, "hearth.sqlite");
  return {
    root: resolvedRoot,
    dataDir,
    databasePath,
    hasDatabase: existsSync(databasePath)
  };
}

export function existingCandidate(root = EXISTING_DATA_ROOT): DataRootCandidate {
  return candidateFor(root);
}

export function freshCandidate(localAppData = process.env.LOCALAPPDATA): DataRootCandidate {
  return candidateFor(resolveDesktopBaseDir(localAppData));
}

export function readDesktopConfig(path = resolveDesktopConfigPath()): DesktopConfig | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object") return null;
    const config = value as Partial<DesktopConfig>;
    if (config.version !== 1 || typeof config.root !== "string" || typeof config.dataDir !== "string") {
      return null;
    }
    const candidate = candidateFor(config.root);
    if (resolve(config.dataDir) !== candidate.dataDir) return null;
    return {
      version: 1,
      root: candidate.root,
      dataDir: candidate.dataDir,
      lastLaunchAt: typeof config.lastLaunchAt === "string" ? config.lastLaunchAt : ""
    };
  } catch {
    return null;
  }
}

export function writeDesktopConfig(
  path: string,
  root: string,
  now = new Date()
): DesktopConfig {
  const candidate = candidateFor(root);
  const config: DesktopConfig = {
    version: 1,
    root: candidate.root,
    dataDir: candidate.dataDir,
    lastLaunchAt: now.toISOString()
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export function configCandidate(configPath = resolveDesktopConfigPath()): DataRootCandidate | null {
  const config = readDesktopConfig(configPath);
  return config ? candidateFor(config.root) : null;
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface BrowserSettings {
  enabled: boolean;
  allowedDomains: string[];
  readOnlyDomains: string[];
  highRiskDomains: string[];
  maxSessions: number;
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  enabled: true,
  allowedDomains: [],
  readOnlyDomains: [],
  highRiskDomains: [
    "*.bank",
    "*.alipay.com",
    "mail.google.com",
    "outlook.live.com",
    "*.gov.cn"
  ],
  maxSessions: 4
};

export type BrowserSettingsPatch = { [K in keyof BrowserSettings]?: BrowserSettings[K] | undefined };

export class BrowserSettingsStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  get(): BrowserSettings {
    if (!existsSync(this.path)) return { ...DEFAULT_BROWSER_SETTINGS, allowedDomains: [], readOnlyDomains: [], highRiskDomains: [...DEFAULT_BROWSER_SETTINGS.highRiskDomains] };
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<BrowserSettings>;
      return normalize({ ...DEFAULT_BROWSER_SETTINGS, ...raw });
    } catch {
      return normalize({ ...DEFAULT_BROWSER_SETTINGS });
    }
  }

  update(patch: BrowserSettingsPatch): BrowserSettings {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<BrowserSettings>;
    const next = normalize({ ...this.get(), ...defined });
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(next, null, 2), "utf8");
    return next;
  }
}

export function domainMatches(host: string, pattern: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/^www\./, "");
  const normalizedPattern = pattern.toLowerCase().trim().replace(/^www\./, "");
  if (!normalizedPattern) return false;
  if (normalizedPattern === "*") return true;
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix) || normalizedHost === normalizedPattern.slice(2);
  }
  return normalizedHost === normalizedPattern || normalizedHost.endsWith(`.${normalizedPattern}`);
}

export function matchesAny(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) => domainMatches(host, pattern));
}

function normalize(value: BrowserSettings): BrowserSettings {
  return {
    enabled: value.enabled !== false,
    allowedDomains: cleanList(value.allowedDomains),
    readOnlyDomains: cleanList(value.readOnlyDomains),
    highRiskDomains: cleanList(value.highRiskDomains),
    maxSessions: clamp(Number(value.maxSessions) || 4, 1, 8)
  };
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

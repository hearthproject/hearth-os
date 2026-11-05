import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export interface CodexProfile {
  codexHome: string;
  configPath: string;
  model: string | null;
  providerId: string;
  providerName: string;
  baseUrl: string | null;
  wireApi: string | null;
  envKey: string | null;
  envKeyPresent: boolean;
  authSource: "provider-env" | "openai-login" | "missing" | "unknown";
  canRun: boolean;
  issues: string[];
}

interface TomlRecord {
  [key: string]: unknown;
}

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function loadCodexProfile(options: { codexHome?: string; env?: NodeJS.ProcessEnv } = {}): CodexProfile {
  const home = options.codexHome ?? codexHome();
  const env = options.env ?? process.env;
  const configPath = join(home, "config.toml");
  const issues: string[] = [];
  let config: TomlRecord = {};

  if (existsSync(configPath)) {
    try {
      config = parse(readFileSync(configPath, "utf8")) as TomlRecord;
    } catch (error) {
      issues.push(`无法解析 ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    issues.push(`未找到 ${configPath}`);
  }

  const providerId = typeof config.model_provider === "string" ? config.model_provider : "openai";
  const providers = isRecord(config.model_providers) ? config.model_providers : {};
  const provider = isRecord(providers[providerId]) ? providers[providerId] : {};
  const providerName = stringValue(provider.name) ?? providerId;
  const envKey = stringValue(provider.env_key);
  const envKeyPresent = Boolean(envKey && env[envKey]);
  const authPath = join(home, "auth.json");
  const hasLogin = existsSync(authPath);

  let authSource: CodexProfile["authSource"] = "unknown";
  if (envKey) {
    authSource = envKeyPresent ? "provider-env" : "missing";
    if (!envKeyPresent) issues.push(`Provider ${providerId} 需要环境变量 ${envKey}，但当前进程未读取到`);
  } else if (providerId === "openai") {
    authSource = hasLogin ? "openai-login" : "missing";
    if (!hasLogin) issues.push("当前 OpenAI Provider 未登录；请运行 codex login 或改用自定义 Provider");
  } else {
    issues.push(`Provider ${providerId} 未声明 env_key，无法判断认证是否可用`);
  }

  return {
    codexHome: home,
    configPath,
    model: stringValue(config.model) ?? null,
    providerId,
    providerName,
    baseUrl: stringValue(provider.base_url) ?? null,
    wireApi: stringValue(provider.wire_api) ?? null,
    envKey: envKey ?? null,
    envKeyPresent,
    authSource,
    canRun: authSource === "provider-env" || authSource === "openai-login",
    issues
  };
}

export function describeCodexProfile(profile: CodexProfile): string {
  return `${profile.providerName} / ${profile.model ?? "默认模型"}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is TomlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

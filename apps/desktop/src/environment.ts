import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type EnvironmentStatus = "ok" | "warn" | "missing";

export interface EnvironmentItem {
  id: string;
  label: string;
  status: EnvironmentStatus;
  detail: string;
  action?: string;
}

export interface EnvironmentReport {
  items: EnvironmentItem[];
  missing: number;
  warnings: number;
  healthy: boolean;
}

export interface EnvironmentOptions {
  baseUrl: string;
  resourcesPath: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  codexPath?: string | null;
  helperPath?: string;
  exists?: (path: string) => boolean;
  run?: (command: string, args: string[]) => { ok: boolean; output: string };
  fetchImpl?: typeof fetch;
}

const DEFAULT_CODEX_PATH =
  "D:\\npm-global\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";

export function defaultCodexPath(): string {
  return DEFAULT_CODEX_PATH;
}

export function chooseCodexPath(
  envCodexPath: string | undefined,
  whereOutput: string,
  exists: (path: string) => boolean = existsSync
): string | null {
  if (envCodexPath && exists(envCodexPath)) return envCodexPath;

  const candidates = whereOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().endsWith(".exe"));

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }

  if (exists(DEFAULT_CODEX_PATH)) return DEFAULT_CODEX_PATH;
  return null;
}

export function runCommand(command: string, args: string[], cwd?: string): { ok: boolean; output: string } {
  const result = spawnSync(command, args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    timeout: 5000
  });
  if (result.error) return { ok: false, output: result.error.message };
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] || "";
}

async function probeModel(
  baseUrl: string,
  fetchImpl: typeof fetch
): Promise<{ configured: boolean; reachable: boolean; detail: string }> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return { configured: false, reachable: false, detail: `健康检查返回 HTTP ${response.status}` };
    const body = (await response.json()) as { chatModel?: { configured?: boolean } };
    const configured = body.chatModel?.configured === true;
    return {
      configured,
      reachable: true,
      detail: configured ? "聊天模型已配置" : "尚未配置聊天模型，聊天不可用（可在界面里设置）"
    };
  } catch (error) {
    return {
      configured: false,
      reachable: false,
      detail: error instanceof Error ? `无法读取健康检查：${error.message}` : "无法读取健康检查"
    };
  }
}

export async function checkEnvironment(options: EnvironmentOptions): Promise<EnvironmentReport> {
  const run = options.run ?? runCommand;
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const helperPath = options.helperPath ?? join(options.resourcesPath, "helper", "helper.mjs");

  const whereCodex = run("where.exe", ["codex.exe"]);
  const codexPath =
    options.codexPath === undefined
      ? chooseCodexPath(env.HEARTH_CODEX_PATH, whereCodex.output, exists)
      : options.codexPath;

  const git = run("git.exe", ["--version"]);
  const gh = run("gh.exe", ["--version"]);
  const npm = run("cmd.exe", ["/d", "/c", "npm --version"]);
  const model = await probeModel(options.baseUrl, fetchImpl);

  const items: EnvironmentItem[] = [
    {
      id: "model",
      label: "聊天模型",
      status: model.configured ? "ok" : "missing",
      detail: model.detail,
      action: "在 Hearth 设置里填写 API Key 和模型名称"
    },
    {
      id: "git",
      label: "Git",
      status: git.ok ? "ok" : "missing",
      detail: git.ok ? firstLine(git.output) : "未找到 git.exe",
      action: "安装 Git for Windows 后重新启动"
    },
    {
      id: "gh",
      label: "GitHub CLI",
      status: gh.ok ? "ok" : "warn",
      detail: gh.ok ? firstLine(gh.output) : "未找到 gh.exe",
      action: "需要克隆私有 GitHub 仓库时再安装 gh 并登录"
    },
    {
      id: "codex",
      label: "Codex 执行器",
      status: codexPath ? "ok" : "warn",
      detail: codexPath ?? "未找到 codex.exe；native 执行器仍可用",
      action: "安装 Codex CLI，或在 HEARTH_CODEX_PATH 指向 codex.exe"
    },
    {
      id: "npm",
      label: "npm（托管安装）",
      status: npm.ok ? "ok" : "warn",
      detail: npm.ok ? firstLine(npm.output) : "未找到 npm；托管安装会被禁用",
      action: "安装 Node.js/npm 后可启用托管安装"
    },
    {
      id: "helper",
      label: "桌面助手",
      status: exists(helperPath) ? "ok" : "warn",
      detail: exists(helperPath) ? helperPath : "桌面助手未打包；桌面设备配对暂不可用",
      action: "使用安装包自带助手，或从托盘菜单重新安装"
    },
    {
      id: "port",
      label: `服务端口 ${options.port ?? 4317}`,
      status: model.reachable ? "ok" : "warn",
      detail: model.reachable
        ? `Hearth 服务正在 127.0.0.1:${options.port ?? 4317} 监听`
        : `本地服务暂不可用（${model.detail}）`,
      action: "关闭占用端口的程序，或退出已有的 Hearth 实例"
    }
  ];

  const missing = items.filter((item) => item.status === "missing").length;
  const warnings = items.filter((item) => item.status === "warn").length;
  return { items, missing, warnings, healthy: missing === 0 && warnings === 0 };
}

export function formatEnvironmentReport(report: EnvironmentReport): string {
  return report.items
    .map((item) => {
      const marker = item.status === "ok" ? "✓" : item.status === "warn" ? "!" : "✗";
      return `${marker} ${item.label}\n  ${item.detail}${item.status === "ok" ? "" : `\n  → ${item.action}`}`;
    })
    .join("\n\n");
}

export function environmentSummary(report: EnvironmentReport): string {
  if (report.healthy) return "环境体检完成：全部就绪。";
  const parts: string[] = [];
  if (report.missing > 0) parts.push(`${report.missing} 项缺失`);
  if (report.warnings > 0) parts.push(`${report.warnings} 项提醒`);
  return `环境体检完成：${parts.join("，")}。`;
}

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export interface GoalCommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface GoalCommandOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const SAFE_BINARIES = new Set([
  "node", "npm", "npx", "pnpm", "yarn", "bun",
  "python", "python3", "pytest", "uv", "pip",
  "cargo", "go", "dotnet", "java", "javac", "mvn", "gradle",
  "git", "tsc", "vitest", "jest"
]);

const BLOCKED_BINARIES = new Set([
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
  "bash", "sh", "zsh", "csh", "wsl", "rm", "del", "erase", "rd", "rmdir",
  "format", "shutdown", "taskkill", "regedit", "diskpart", "mkfs", "dd"
]);

/**
 * Goal verification commands are argv-only and never run through a shell.
 * The goal contract freezes them at creation and the user must explicitly
 * approve command criteria before they can pass automatically.
 */
export async function runGoalCommand(argv: string[], options: GoalCommandOptions): Promise<GoalCommandResult> {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: "命令必须是 argv 数组且不能为空" };
  }
  const first = argv[0]?.trim() ?? "";
  if (!first) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: "命令缺少可执行文件" };
  }
  const executable = first.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (BLOCKED_BINARIES.has(executable)) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: `命令验证不允许执行 ${executable}` };
  }
  if (!SAFE_BINARIES.has(executable)) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: `命令验证只允许受支持的工具：${[...SAFE_BINARIES].join(", ")}` };
  }
  if (!existsSync(options.cwd)) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: `命令工作目录不存在：${options.cwd}` };
  }
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 120_000, 300_000));
  const maxBuffer = Math.max(64_000, Math.min(options.maxOutputBytes ?? 1_000_000, 8_000_000));
  return new Promise((resolvePromise) => {
    execFile(
      first,
      argv.slice(1),
      {
        cwd: options.cwd,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer,
        windowsHide: true,
        shell: false,
        env: {
          PATH: process.env.PATH ?? "",
          PATHEXT: process.env.PATHEXT ?? "",
          HOME: process.env.HOME ?? "",
          USERPROFILE: process.env.USERPROFILE ?? "",
          TEMP: process.env.TEMP ?? "",
          TMP: process.env.TMP ?? "",
          LANG: "en_US.UTF-8",
          CI: "1",
          NO_COLOR: "1"
        }
      },
      (error, stdout, stderr) => {
        const output = String(stdout ?? "").slice(0, maxBuffer);
        const errors = String(stderr ?? "").slice(0, maxBuffer);
        if (!error) {
          resolvePromise({ ok: true, exitCode: 0, stdout: output, stderr: errors, error: null });
          return;
        }
        const code = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? (error as NodeJS.ErrnoException & { code: number }).code
          : null;
        resolvePromise({
          ok: false,
          exitCode: code,
          stdout: output,
          stderr: errors,
          error: error.message
        });
      }
    );
  });
}

export function parseCommandCheck(check: string): string[] | { error: string } {
  try {
    const parsed = JSON.parse(check) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed as string[];
    }
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { argv?: unknown }).argv)) {
      const argv = (parsed as { argv: unknown[] }).argv;
      if (argv.every((item) => typeof item === "string")) return argv as string[];
    }
    return { error: "command 校验必须是 JSON 字符串数组或 { argv: string[] }" };
  } catch {
    return { error: "command 校验不是合法 JSON" };
  }
}

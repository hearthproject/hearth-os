import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { TaskRuntimeSpec } from "@hearth/templates";
import { runCommand, type CommandRunner } from "./github.ts";

const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_LOG_CHARS = 200_000;

export interface RuntimePreparation {
  ok: boolean;
  workspaceRoot: string;
  recordPath: string;
  logPath: string;
  python: {
    interpreter: string;
    version: string;
    workingDirectory: string;
    requirements: string[];
  } | null;
  node: {
    workingDirectory: string;
    install: "ci" | "install";
  } | null;
  errors: string[];
  log: string;
}

export interface RuntimePreparationOptions {
  spec: TaskRuntimeSpec;
  repoPath: string;
  workspaceRoot: string;
  run?: CommandRunner;
}

export async function prepareTaskRuntime(options: RuntimePreparationOptions): Promise<RuntimePreparation> {
  const run = options.run ?? runCommand;
  const runtimeRoot = join(options.workspaceRoot, ".runtime");
  const recordPath = join(runtimeRoot, "runtime.json");
  const logPath = join(runtimeRoot, "prepare.log");
  const errors: string[] = [];
  const logParts: string[] = [];
  let python: RuntimePreparation["python"] = null;
  let node: RuntimePreparation["node"] = null;

  mkdirSync(runtimeRoot, { recursive: true });

  if (options.spec.python) {
    try {
      python = await preparePythonRuntime(run, options.spec.python, options.repoPath, runtimeRoot, logParts);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  if (options.spec.node) {
    try {
      const workingDirectory = resolveInsideRepository(options.repoPath, options.spec.node.workingDirectory);
      if (!existsSync(join(workingDirectory, "package.json"))) {
        throw new Error(`Node 依赖目录缺少 package.json：${workingDirectory}`);
      }
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      appendCommandLog(logParts, `${npm} ${options.spec.node.install}`, workingDirectory);
      const result = await run(npm, [options.spec.node.install], {
        cwd: workingDirectory,
        timeoutMs: INSTALL_TIMEOUT_MS
      });
      appendResultLog(logParts, result);
      node = { workingDirectory, install: options.spec.node.install };
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  const ok = errors.length === 0;
  const log = truncateLog(logParts.join("\n"));
  writeFileSync(logPath, `${log}\n`, "utf8");
  const preparation: RuntimePreparation = {
    ok,
    workspaceRoot: options.workspaceRoot,
    recordPath,
    logPath,
    python,
    node,
    errors,
    log
  };
  writeFileSync(recordPath, `${JSON.stringify({
    ok,
    preparedAt: new Date().toISOString(),
    spec: options.spec,
    python,
    node,
    errors,
    logPath
  }, null, 2)}\n`, "utf8");
  return preparation;
}

async function preparePythonRuntime(
  run: CommandRunner,
  spec: NonNullable<TaskRuntimeSpec["python"]>,
  repoPath: string,
  runtimeRoot: string,
  logParts: string[]
): Promise<NonNullable<RuntimePreparation["python"]>> {
  const workingDirectory = resolveInsideRepository(repoPath, spec.workingDirectory);
  if (!existsSync(workingDirectory)) throw new Error(`Python 工作目录不存在：${workingDirectory}`);
  const requirements = spec.requirements.map((path) => resolveInsideRepository(repoPath, path));
  for (const requirement of requirements) {
    if (!existsSync(requirement)) throw new Error(`Python 依赖文件不存在：${requirement}`);
  }

  const venvDirectory = join(runtimeRoot, "python");
  let usedUv = true;
  try {
    appendCommandLog(logParts, `uv venv --python ${spec.version} ${venvDirectory}`, runtimeRoot);
    const result = await run("uv", ["venv", "--python", spec.version, venvDirectory], {
      cwd: runtimeRoot,
      timeoutMs: INSTALL_TIMEOUT_MS
    });
    appendResultLog(logParts, result);
  } catch (error) {
    usedUv = false;
    logParts.push(`uv 不可用或创建 Python ${spec.version} 环境失败，回退到系统 python：${errorMessage(error)}`);
    appendCommandLog(logParts, `python -m venv ${venvDirectory}`, runtimeRoot);
    const result = await run("python", ["-m", "venv", venvDirectory], {
      cwd: runtimeRoot,
      timeoutMs: INSTALL_TIMEOUT_MS
    });
    appendResultLog(logParts, result);
  }

  const interpreter = process.platform === "win32"
    ? join(venvDirectory, "Scripts", "python.exe")
    : join(venvDirectory, "bin", "python");
  if (!existsSync(interpreter)) throw new Error(`Python 虚拟环境创建后缺少解释器：${interpreter}`);

  const requirementArgs = requirements.flatMap((requirement) => ["-r", requirement]);
  if (usedUv) {
    appendCommandLog(logParts, `uv pip install --python ${interpreter} ...`, repoPath);
    const result = await run("uv", ["pip", "install", "--python", interpreter, ...requirementArgs], {
      cwd: repoPath,
      timeoutMs: INSTALL_TIMEOUT_MS
    });
    appendResultLog(logParts, result);
  } else {
    appendCommandLog(logParts, `${interpreter} -m pip install ...`, repoPath);
    const result = await run(interpreter, ["-m", "pip", "install", ...requirementArgs], {
      cwd: repoPath,
      timeoutMs: INSTALL_TIMEOUT_MS
    });
    appendResultLog(logParts, result);
  }

  const versionResult = await run(interpreter, ["--version"], { cwd: repoPath, timeoutMs: 60_000 });
  appendResultLog(logParts, versionResult);
  return {
    interpreter,
    version: (versionResult.stdout || versionResult.stderr).trim(),
    workingDirectory,
    requirements
  };
}

function resolveInsideRepository(repoPath: string, relativePath: string): string {
  const root = resolve(repoPath);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`运行时路径必须位于仓库内：${relativePath}`);
  return target;
}

function appendCommandLog(parts: string[], command: string, cwd: string): void {
  parts.push(`$ ${command}`, `cwd: ${cwd}`);
}

function appendResultLog(parts: string[], result: { stdout: string; stderr: string }): void {
  if (result.stdout.trim()) parts.push(result.stdout.trim());
  if (result.stderr.trim()) parts.push(result.stderr.trim());
}

function truncateLog(value: string): string {
  if (value.length <= MAX_LOG_CHARS) return value;
  return `[日志过长，保留末尾 ${MAX_LOG_CHARS} 个字符]\n${value.slice(-MAX_LOG_CHARS)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

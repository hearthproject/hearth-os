import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface SuiteTask {
  id: string;
  workspace: string;
  prompt: string;
  testCommand?: string;
  testTimeoutSeconds?: number;
  copy?: boolean;
}

interface SuiteResult {
  id: string;
  agentStatus: "completed" | "failed" | "cancelled" | "budget_exceeded" | "error";
  testExitCode: number | null;
  passed: boolean;
  durationMs: number;
  patch?: string;
  error?: string;
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function required(name: string, fallback?: string): string {
  const value = arg(name, fallback);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function main(): void {
  const suitePath = resolve(required("suite"));
  const reportPath = resolve(required("report", "public-benchmark.json"));
  const outRoot = resolve(required("out", join(tmpdir(), "hearth-public-bench")));
  const maxTasks = Math.max(1, Number(arg("max-tasks", "0")) || Number.MAX_SAFE_INTEGER);
  const keep = arg("keep") === "true";
  const tasks = readFileSync(suitePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as SuiteTask);
  const results: SuiteResult[] = [];
  mkdirSync(outRoot, { recursive: true });

  for (const task of tasks.slice(0, maxTasks)) {
    const started = Date.now();
    let workspace = resolve(task.workspace);
    let cleanup: string | null = null;
    if (task.copy !== false) {
      const copyRoot = mkdtempSync(join(tmpdir(), "hearth-bench-task-"));
      workspace = join(copyRoot, task.id.replace(/[^A-Za-z0-9._-]/g, "-"));
      cpSync(resolve(task.workspace), workspace, { recursive: true });
      cleanup = copyRoot;
    }
    const taskOut = join(outRoot, task.id.replace(/[^A-Za-z0-9._-]/g, "-"));
    mkdirSync(taskOut, { recursive: true });
    const agent = spawnSync(tsxCommand(), [
      join(import.meta.dirname, "run-agent.ts"),
      "--workspace", workspace,
      "--goal", task.prompt,
      "--out", taskOut,
      "--base-url", required("base-url", process.env.OPENAI_BASE_URL),
      "--model", required("model"),
      "--api-key", required("api-key", process.env.HEARTH_MODEL_API_KEY ?? process.env.OPENAI_API_KEY),
      "--protocol", arg("protocol", "openai-chat")!,
      "--context-window", arg("context-window", "128000")!
    ], { encoding: "utf8", timeout: Number(arg("agent-timeout-ms", "3600000")), windowsHide: true, maxBuffer: 32 * 1024 * 1024 });

    let agentStatus: SuiteResult["agentStatus"] = "error";
    let error: string | undefined;
    if (agent.error) error = agent.error.message;
    const parsed = parseAgentOutput(agent.stdout);
    if (parsed?.status) agentStatus = parsed.status;
    const test = task.testCommand
      ? spawnSync(task.testCommand, { cwd: workspace, encoding: "utf8", shell: true, timeout: (task.testTimeoutSeconds ?? 600) * 1_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
      : null;
    const patch = task.copy !== false ? gitDiff(workspace) : "";
    const result: SuiteResult = {
      id: task.id,
      agentStatus,
      testExitCode: test?.status ?? null,
      passed: agentStatus === "completed" && (test?.status ?? 0) === 0,
      durationMs: Date.now() - started,
      ...(patch ? { patch } : {}),
      ...(error ? { error } : {}),
      ...(test && test.status !== 0 ? { error: (test.stderr || test.stdout || "").slice(0, 4_000) } : {})
    };
    results.push(result);
    if (cleanup && !keep) rmSync(cleanup, { recursive: true, force: true });
  }

  writeFileSync(reportPath, `${JSON.stringify({ suite: suitePath, results, passed: results.filter((item) => item.passed).length, total: results.length }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ report: reportPath, passed: results.filter((item) => item.passed).length, total: results.length }, null, 2));
}

function tsxCommand(): string {
  const root = resolve(import.meta.dirname, "..", "..");
  return process.platform === "win32" ? join(root, "node_modules", ".bin", "tsx.cmd") : join(root, "node_modules", ".bin", "tsx");
}

function parseAgentOutput(stdout: string): { status?: SuiteResult["agentStatus"] } | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as { status?: string };
    return parsed.status ? { status: parsed.status as SuiteResult["agentStatus"] } : parsed;
  } catch {
    return null;
  }
}

function gitDiff(workspace: string): string {
  if (!existsSync(join(workspace, ".git"))) return "";
  const result = spawnSync("git", ["-C", workspace, "diff", "--binary"], { encoding: "utf8", timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : "";
}

main();

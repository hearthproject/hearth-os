import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import type { TaskRecord } from "@hearth/core";
import { runNativeTask, type NativeRunOptions } from "./native-executor.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { PreparedWorkspace } from "./workspace.ts";

export interface OnboardingVerification {
  ok: boolean;
  status: "passed" | "failed";
  summary: string;
  filesChanged: string[];
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

type VerificationRunner = (options: NativeRunOptions) => Promise<{ status: string; turns: number; finalResponse: string }>;

/**
 * Runs a tiny real coding task through the same native harness the user will
 * use later: the model must read a file, write the expected answer, run the
 * fixture test, and finish. It uses a temporary folder and is removed afterwards.
 */
export async function verifyFirstTask(
  settings: ModelSettings,
  signal?: AbortSignal,
  runner: VerificationRunner = runNativeTask
): Promise<OnboardingVerification> {
  const root = mkdtempSync(join(tmpdir(), "hearth-onboarding-"));
  const outDir = join(root, ".hearth-out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(root, "hello.txt"), "hello\n", "utf8");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "hearth-first-task", private: true, scripts: { test: "node check.mjs" } }, null, 2), "utf8");
  writeFileSync(join(root, "check.mjs"), "import { readFileSync } from 'node:fs';\nconst value = readFileSync('answer.txt', 'utf8').trim();\nif (value !== 'hearth') { console.error('answer.txt must contain hearth'); process.exit(1); }\nconsole.log('first task passed');\n", "utf8");
  const before = listFiles(root);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const relay = () => controller.abort();
  signal?.addEventListener("abort", relay, { once: true });
  const now = new Date().toISOString();
  const task: TaskRecord = {
    id: `onboarding-${Date.now()}`,
    templateId: null,
    title: "首次运行示例",
    goal: "读取 hello.txt，把 answer.txt 写成内容 hearth，然后运行 npm test 验证。完成后用 finish_task 汇报结果。",
    status: "running",
    createdAt: now,
    updatedAt: now,
    deadline: null,
    inputs: [],
    networkHosts: [],
    outputDir: outDir,
    currentRunId: null,
    nextAction: null,
    error: null,
    resultSummary: null,
    taskKind: "workspace",
    expectedOutputs: ["answer.txt"],
    permissions: {
      readRoots: [root],
      writeRoots: [root, outDir],
      networkHosts: [],
      tools: ["read_file", "write_file", "edit_file", "shell", "run_tests", "todo_write", "finish_task"],
      approvalMode: "full",
      sandboxMode: "danger-full-access"
    }
  };
  const prepared: PreparedWorkspace = { root, outDir, inputs: [] };
  const permissions = task.permissions;
  if (!permissions) throw new Error("首次示例缺少工具权限");
  try {
    const result = await runner({
      task,
      prepared,
      settings,
      prompt: task.goal,
      permissions,
      expectedOutputs: ["answer.txt"],
      signal: controller.signal,
      mode: "build"
    });
    const after = listFiles(root);
    const filesChanged = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path));
    const answer = existsRead(join(root, "answer.txt"))?.trim() ?? "";
    const tests = result.turns > 0 && result.status === "completed";
    const checks = [
      { name: "模型调用了工具并完成", passed: result.status === "completed", detail: result.status },
      { name: "answer.txt 内容正确", passed: answer === "hearth", detail: answer || "(文件不存在)" },
      { name: "真实测试通过", passed: tests, detail: tests ? "任务以 completed 结束" : "未完成，无法确认测试" }
    ];
    const ok = checks.every((check) => check.passed);
    return {
      ok,
      status: ok ? "passed" : "failed",
      summary: ok ? "模型已经完成一次真实的读写和测试。" : result.finalResponse || "示例任务没有完成。",
      filesChanged,
      checks
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      summary: error instanceof Error ? error.message : String(error),
      filesChanged: [],
      checks: [{ name: "示例任务", passed: false, detail: error instanceof Error ? error.message : String(error) }]
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", relay);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows can hold a transient file lock; this temp folder is disposable.
    }
  }
}

function listFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".hearth-out" || entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        try {
          files.set(path.slice(root.length + 1), `${statSync(path).size}:${statSync(path).mtimeMs}`);
        } catch {
          // Skip files that disappear during the task.
        }
      }
    }
  };
  walk(root);
  return files;
}

function existsRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

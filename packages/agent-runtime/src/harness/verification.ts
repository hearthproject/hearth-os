import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "../types.ts";
import { detectProjectProfile } from "./project-profile.ts";
import { runShellSession } from "./shell-session.ts";
import { recordCommand } from "./file-state.ts";
import { incompleteTodos } from "./todo.ts";

type Diagnostic = { file: string; line?: number; code?: string; message: string };

export const runTestsTool: AgentTool = {
  definition: {
    name: "run_tests",
    description: "Run the project's test command (auto-detected or provided) and return failed tests plus a short log.",
    executionMode: "sequential",
    timeoutMs: 20 * 60_000,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Optional explicit test command. Defaults to the detected project command." },
        paths: { type: "array", items: { type: "string" }, description: "Optional file or directory filters appended to the command when supported." },
        timeoutMs: { type: "number", description: "Command timeout, default 20 minutes." }
      },
      additionalProperties: false
    }
  },
  async execute(input: unknown, context: AgentToolContext): Promise<AgentToolResult> {
    const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const profile = detectProjectProfile(context.workspaceRoot);
    const command = typeof args.command === "string" && args.command.trim()
      ? args.command.trim()
      : profile.commands.test;
    if (!command) return { content: "没有检测到测试命令。请在项目里配置 test 脚本，或通过 command 传入测试命令。", isError: true };
    const paths = Array.isArray(args.paths) ? args.paths.filter((value): value is string => typeof value === "string") : [];
    const fullCommand = paths.length ? `${command} ${paths.map((path) => JSON.stringify(path)).join(" ")}` : command;
    return runVerificationCommand(fullCommand, context, typeof args.timeoutMs === "number" ? args.timeoutMs : 20 * 60_000, "test");
  }
};

export const diagnosticsTool: AgentTool = {
  definition: {
    name: "diagnostics",
    description: "Run the project's lint and type-check commands and return structured diagnostics for changed files.",
    executionMode: "sequential",
    timeoutMs: 15 * 60_000,
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["lint", "typecheck", "all"], description: "Which checks to run. Defaults to all." },
        paths: { type: "array", items: { type: "string" }, description: "Optional file paths to focus on." },
        timeoutMs: { type: "number", description: "Per-command timeout, default 15 minutes." }
      },
      additionalProperties: false
    }
  },
  async execute(input: unknown, context: AgentToolContext): Promise<AgentToolResult> {
    const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const kind = args.kind === "lint" || args.kind === "typecheck" ? args.kind : "all";
    const profile = detectProjectProfile(context.workspaceRoot);
    const commands = [
      ...(kind !== "typecheck" && profile.commands.lint ? [{ name: "lint", command: profile.commands.lint }] : []),
      ...(kind !== "lint" && profile.commands.typecheck ? [{ name: "typecheck", command: profile.commands.typecheck }] : [])
    ];
    if (commands.length === 0) return { content: `没有检测到 ${kind} 命令。请在项目里配置 lint/typecheck 脚本。` };
    const parts: string[] = [];
    const diagnostics: Diagnostic[] = [];
    let failed = false;
    for (const entry of commands) {
      const result = await runVerificationCommand(entry.command, context, typeof args.timeoutMs === "number" ? args.timeoutMs : 15 * 60_000, "check", entry.name);
      parts.push(`## ${entry.name}\n${result.content}`);
      if (result.isError) failed = true;
      for (const item of result.metadata?.diagnostics ?? []) diagnostics.push(item);
    }
    return {
      content: parts.join("\n\n"),
      isError: failed,
      metadata: { diagnostics: diagnostics.slice(0, 50) }
    };
  }
};

export function codingFinishIssue(context: AgentToolContext): string | null {
  const issues: string[] = [];
  const state = context.state;
  const openTodos = incompleteTodos(state?.todos);
  if (openTodos.length > 0) issues.push(`仍有 ${openTodos.length} 个 todo 未完成：${openTodos.map((todo) => todo.content).join("；")}`);

  const git = gitChangedFiles(context.workspaceRoot);
  const changed = git.files;
  if (git.isRepository && changed.length === 0 && state?.progress.filesModified.length === 0) {
    issues.push("没有检测到任何代码改动；如果这是只读任务，请在 finish_task 的 summary 中说明 noChangesReason。");
  } else {
    for (const file of changed.slice(0, 50)) {
      const path = resolve(context.workspaceRoot, file);
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, "utf8");
        if (/^<<<<<<< |^=======|^>>>>>>> /m.test(content)) issues.push(`${file} 仍有 Git 冲突标记。`);
      } catch {
        // Binary or unreadable files are skipped.
      }
    }
  }

  if (state && state.progress.tests.length === 0 && changed.some((file) => !/\.(md|txt|json|yaml|yml)$/i.test(file))) {
    issues.push("还没有运行过测试命令。请先 run_tests 或运行项目测试，再调用 finish_task。");
  }

  const failingDiagnostics = state?.progress.diagnostics.filter((item) => item.code === "error") ?? [];
  if (failingDiagnostics.length > 0) issues.push(`最近一次诊断仍有 ${failingDiagnostics.length} 个 error。`);
  return issues.length ? issues.join("；") : null;
}

export function gitChangedFiles(root: string): { isRepository: boolean; files: string[] } {
  try {
    const inside = execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (inside !== "true") return { isRepository: false, files: [] };
    const output = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
    const files = output.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter((file) => file && !file.startsWith(".hearth/"));
    return { isRepository: true, files };
  } catch {
    return { isRepository: false, files: [] };
  }
}

async function runVerificationCommand(command: string, context: AgentToolContext, timeoutMs: number, kind: "test" | "check", label?: string): Promise<AgentToolResult> {
  const run = await runShellSession({ command, cwd: context.workspaceRoot, outDir: context.outDir, timeoutMs });
  const output = run.output.trim();
  const failed = run.running || run.exitCode !== 0;
  recordCommand(context.state, command, run.exitCode, kind === "test");
  const parsed = parseVerificationOutput(output, kind);
  if (kind === "check" && parsed.diagnostics.length > 0 && context.state) {
    context.state.progress.diagnostics.push(...parsed.diagnostics.map((item) => ({ ...item, at: Date.now() })));
  }
  const status = run.running ? `still running (session ${run.sessionId})` : `exit ${run.exitCode ?? "unknown"}`;
  return {
    content: [
      `${label ? `${label}: ` : ""}${command} -> ${status}`,
      ...(parsed.failedTests.length ? [`Failed tests: ${parsed.failedTests.join(", ")}`] : []),
      ...(parsed.diagnostics.length ? [`Diagnostics: ${parsed.diagnostics.slice(0, 20).map((item) => `${item.file}${item.line ? `:${item.line}` : ""} ${item.message}`).join(" | ")}`] : []),
      "",
      output || "(no output)"
    ].join("\n").slice(0, 12_000),
    isError: failed,
    metadata: { exitCode: run.exitCode, durationMs: run.durationMs, failedTests: parsed.failedTests, ...(parsed.diagnostics.length ? { diagnostics: parsed.diagnostics } : {}) }
  };
}

function parseVerificationOutput(output: string, kind: "test" | "check"): { failedTests: string[]; diagnostics: Diagnostic[] } {
  const failedTests: string[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const pytest = /^FAILED\s+([^\s]+)\s*(?:-\s*(.*))?/.exec(line);
    if (pytest) {
      failedTests.push(pytest[1]!);
      continue;
    }
    const goTest = /^--- FAIL: ([^\s]+)/.exec(line);
    if (goTest) {
      failedTests.push(goTest[1]!);
      continue;
    }
    const vitest = /^\s*(?:✕|×|FAIL)\s+([^\s>]+)(?:\s*>\s*([^\s]+))?/.exec(line);
    if (vitest) {
      failedTests.push([vitest[1], vitest[2]].filter(Boolean).join(" > "));
      continue;
    }
    if (kind === "check") {
      const diagnostic = /^(.*?):(\d+):(?::(\d+):)?\s*(error|warning)?\s*(.*)$/i.exec(line);
      if (diagnostic && /error|warning/i.test(diagnostic[4] ?? "")) {
        diagnostics.push({ file: diagnostic[1]!, line: Number(diagnostic[2]), code: (diagnostic[4] ?? "").toLowerCase(), message: diagnostic[5] ?? "" });
      }
    }
  }
  return { failedTests: [...new Set(failedTests)].slice(0, 30), diagnostics: diagnostics.slice(0, 50) };
}

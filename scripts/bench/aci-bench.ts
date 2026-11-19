import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinTools, defaultTaskPermissions } from "../../packages/agent-runtime/src/tools.ts";
import { codingFinishIssue } from "../../packages/agent-runtime/src/harness/verification.ts";
import { createAgentState } from "../../packages/agent-runtime/src/harness/file-state.ts";
import { killShellSession } from "../../packages/agent-runtime/src/harness/shell-session.ts";
import type { AgentToolContext, AgentToolResult } from "../../packages/agent-runtime/src/types.ts";

interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
  ms: number;
}

const tools = new Map(createBuiltinTools().map((tool) => [tool.definition.name, tool]));
const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-aci-bench-"));
  roots.push(root);
  return root;
}

function context(root: string, extras: string[]): AgentToolContext {
  const outDir = join(root, "out");
  mkdirSync(outDir, { recursive: true });
  const permissions = defaultTaskPermissions({
    workspaceRoot: root,
    outDir,
    networkHosts: [],
    extraTools: extras,
    writeRoots: [root, outDir]
  });
  return { workspaceRoot: root, outDir, permissions, signal: new AbortController().signal, state: createAgentState(root), fullAccess: false };
}

async function tool(name: string, ctx: AgentToolContext, input: unknown): Promise<AgentToolResult> {
  const entry = tools.get(name);
  if (!entry) throw new Error(`missing tool ${name}`);
  return entry.execute(input, ctx);
}

async function run(name: string, fn: () => Promise<{ pass: boolean; detail: string }>): Promise<CaseResult> {
  const started = Date.now();
  try {
    const result = await fn();
    return { name, ...result, ms: Date.now() - started };
  } catch (error) {
    return { name, pass: false, detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
  }
}

async function main(): Promise<void> {
  const results: CaseResult[] = [];

  results.push(await run("edit-crlf-indent-drift", async () => {
    const root = workspace();
    const file = join(root, "src.ts");
    writeFileSync(file, "function run() {\r\n    return 1;\r\n}\r\n");
    const ctx = context(root, ["shell"]);
    await tool("read_file", ctx, { path: "src.ts" });
    const result = await tool("edit_file", ctx, { path: "src.ts", oldText: "function run() {\nreturn 1;", newText: "function run() {\n  return 2;" });
    const content = readFileSync(file, "utf8");
    return { pass: content.includes("return 2;") && content.includes("\r\n") && !result.isError, detail: result.content.slice(0, 120) };
  }));

  results.push(await run("edit-multi-atomic", async () => {
    const root = workspace();
    const file = join(root, "src.ts");
    writeFileSync(file, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const ctx = context(root, []);
    await tool("read_file", ctx, { path: "src.ts" });
    const result = await tool("edit_file", ctx, {
      path: "src.ts",
      edits: [
        { oldText: "const a = 1;", newText: "const a = 10;" },
        { oldText: "const c = 3;", newText: "const c = 30;" }
      ]
    });
    const content = readFileSync(file, "utf8");
    return { pass: content.includes("a = 10") && content.includes("c = 30") && !result.isError, detail: result.content.slice(0, 120) };
  }));

  results.push(await run("patch-fuzzy-context", async () => {
    const root = workspace();
    const file = join(root, "src.ts");
    writeFileSync(file, "if (ready) {\n    run();\n}\n");
    const ctx = context(root, []);
    await tool("read_file", ctx, { path: "src.ts" });
    const result = await tool("apply_patch", ctx, {
      patch: ["*** Begin Patch", "*** Update File: src.ts", "@@", "-if (ready) {", "-run();", "+if (ready) {", "+runTwice();", "*** End Patch"].join("\n")
    });
    return { pass: readFileSync(file, "utf8").includes("runTwice"), detail: result.content.slice(0, 120) };
  }));

  results.push(await run("search-java-go-rust", async () => {
    const root = workspace();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "Main.java"), "class Main { void run() {} }\n");
    writeFileSync(join(root, "src", "main.go"), "package main\nfunc run() {}\n");
    const ctx = context(root, ["shell"]);
    const result = await tool("grep", ctx, { pattern: "void run", path: "src", include: "*.java" });
    return { pass: result.content.includes("Main.java"), detail: result.content.slice(0, 120) };
  }));

  results.push(await run("read-before-write-guard", async () => {
    const root = workspace();
    const file = join(root, "existing.ts");
    writeFileSync(file, "export const value = 1;\n");
    const ctx = context(root, []);
    let rejected = false;
    try {
      await tool("write_file", ctx, { path: "existing.ts", content: "export const value = 2;\n" });
    } catch (error) {
      rejected = /尚未读取/.test(error instanceof Error ? error.message : String(error));
    }
    return { pass: rejected && readFileSync(file, "utf8").includes("value = 1"), detail: rejected ? "guard rejected overwrite" : "guard missing" };
  }));

  results.push(await run("snapshot-rewind", async () => {
    const root = workspace();
    const file = join(root, "src.ts");
    writeFileSync(file, "const value = 1;\n");
    const ctx = context(root, ["rewind"]);
    await tool("read_file", ctx, { path: "src.ts" });
    const edit = await tool("edit_file", ctx, { path: "src.ts", oldText: "const value = 1;", newText: "const value = 2;" });
    const snapshotId = edit.metadata?.snapshotId;
    if (!snapshotId) return { pass: false, detail: "no snapshot id" };
    const rewind = await tool("rewind", ctx, { snapshotId });
    return { pass: readFileSync(file, "utf8").includes("value = 1") && !rewind.isError, detail: rewind.content.slice(0, 120) };
  }));

  results.push(await run("shell-timeout-migrates", async () => {
    const root = workspace();
    const ctx = context(root, ["shell", "shell_output", "shell_kill"]);
    const result = await tool("shell", ctx, { command: "node -e \"setTimeout(() => {}, 3000)\"", timeoutMs: 500 });
    const sessionId = result.metadata?.sessionId;
    if (sessionId) killShellSession(sessionId);
    return { pass: Boolean(sessionId) && result.metadata?.background === true, detail: `session=${sessionId ?? "none"}` };
  }));

  results.push(await run("tests-and-finish-gate", async () => {
    const root = workspace();
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
    writeFileSync(join(root, "test.js"), "process.exit(0);\n");
    const ctx = context(root, ["run_tests"]);
    await tool("write_file", ctx, { path: "src.js", content: "module.exports = 1;\n" });
    const before = codingFinishIssue(ctx);
    const tests = await tool("run_tests", ctx, {});
    const after = codingFinishIssue(ctx);
    return {
      pass: before !== null && tests.metadata?.exitCode === 0 && tests.isError !== true && after === null,
      detail: `before=${before?.slice(0, 80) ?? "null"}; after=${after ?? "null"}`
    };
  }));

  results.push(await run("todo-state", async () => {
    const root = workspace();
    const ctx = context(root, ["todo_write", "todo_read"]);
    await tool("todo_write", ctx, { todos: [{ id: "t1", content: "inspect", status: "completed" }, { id: "t2", content: "implement", status: "in_progress" }] });
    const read = await tool("todo_read", ctx, {});
    return { pass: read.content.includes("implement"), detail: read.content.slice(0, 120) };
  }));

  results.push(await run("command-policy", async () => {
    const root = workspace();
    const ctx = context(root, ["shell"]);
    let blocked = false;
    try {
      await tool("shell", ctx, { command: "git reset --hard HEAD" });
    } catch (error) {
      blocked = /破坏性|明确批准/.test(error instanceof Error ? error.message : String(error));
    }
    return { pass: blocked, detail: blocked ? "blocked destructive command" : "not blocked" };
  }));

  const passed = results.filter((result) => result.pass).length;
  const report = { generatedAt: new Date().toISOString(), passed, total: results.length, results };
  const outDir = join(process.cwd(), "eval", "aci");
  mkdirSync(outDir, { recursive: true });
  const output = join(outDir, process.argv[2] ?? "post-change.json");
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  for (const result of results) console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name} (${result.ms}ms) ${result.detail}`);
  console.log(`\n${passed}/${results.length} passed -> ${output}`);
  if (passed !== results.length) process.exitCode = 1;

  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A background shell may still hold the directory on Windows.
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

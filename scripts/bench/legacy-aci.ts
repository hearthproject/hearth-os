import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinTools, defaultTaskPermissions } from "../../packages/agent-runtime/src/tools.ts";

interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
  ms: number;
}

const tools = new Map(createBuiltinTools().map((tool) => [tool.definition.name, tool]));
const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-legacy-aci-"));
  roots.push(root);
  mkdirSync(join(root, "out"), { recursive: true });
  return root;
}

function context(root: string, extras: string[] = []) {
  const outDir = join(root, "out");
  const permissions = defaultTaskPermissions({ workspaceRoot: root, outDir, networkHosts: [], extraTools: extras, writeRoots: [root, outDir] });
  return { workspaceRoot: root, outDir, permissions, signal: new AbortController().signal };
}

async function run(name: string, fn: () => Promise<{ pass: boolean; detail: string }>): Promise<CaseResult> {
  const started = Date.now();
  try {
    return { name, ...(await fn()), ms: Date.now() - started };
  } catch (error) {
    return { name, pass: false, detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
  }
}

async function main(): Promise<void> {
  const results: CaseResult[] = [];

  results.push(await run("edit-exact", async () => {
    const root = workspace();
    writeFileSync(join(root, "src.ts"), "const a = 1;\n");
    const ctx = context(root);
    await tools.get("edit_file")!.execute({ path: "src.ts", oldText: "const a = 1;", newText: "const a = 2;" }, ctx);
    return { pass: readFileSync(join(root, "src.ts"), "utf8").includes("a = 2"), detail: "exact replacement" };
  }));

  results.push(await run("edit-crlf-indent-drift", async () => {
    const root = workspace();
    writeFileSync(join(root, "src.ts"), "function run() {\r\n    return 1;\r\n}\r\n");
    const ctx = context(root);
    try {
      await tools.get("edit_file")!.execute({ path: "src.ts", oldText: "function run() {\nreturn 1;", newText: "function run() {\n  return 2;" }, ctx);
    } catch {
      return { pass: false, detail: "exact match failed on CRLF and indentation drift" };
    }
    return { pass: false, detail: "unexpected match" };
  }));

  results.push(await run("search-java", async () => {
    const root = workspace();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "Main.java"), "class Main { void run() {} }\n");
    const ctx = context(root);
    const result = await tools.get("grep")!.execute({ pattern: "void run", path: "src", include: "*.java" }, ctx);
    return { pass: result.content.includes("Main.java"), detail: result.content.slice(0, 100) };
  }));

  results.push(await run("shell-output-tail", async () => {
    const root = workspace();
    writeFileSync(join(root, "large.cjs"), "process.stdout.write('x'.repeat(12000));\n");
    const ctx = context(root, ["shell"]);
    const result = await tools.get("shell")!.execute({ command: `node "${join(root, "large.cjs")}"` }, ctx);
    return { pass: result.content.length < 9_000 && result.content.includes(".hearth/shell/"), detail: `length=${result.content.length}` };
  }));

  results.push(await run("shell-timeout-kill", async () => {
    const root = workspace();
    const ctx = context(root, ["shell"]);
    const result = await tools.get("shell")!.execute({ command: "node -e \"setTimeout(() => {}, 3000)\"", timeoutMs: 500 }, ctx);
    return { pass: result.isError === true && result.content.includes("进程树已终止"), detail: result.content.slice(0, 80) };
  }));

  results.push(await run("edit-multi", async () => {
    const root = workspace();
    writeFileSync(join(root, "src.ts"), "const a = 1;\nconst b = 2;\n");
    const ctx = context(root);
    const result = await tools.get("edit_file")!.execute({ path: "src.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 10;" }] }, ctx);
    return { pass: result.content.includes("a = 10"), detail: result.content.slice(0, 80) };
  }));

  results.push(await run("patch-fuzzy-context", async () => {
    const root = workspace();
    writeFileSync(join(root, "src.ts"), "if (ready) {\n    run();\n}\n");
    const ctx = context(root);
    try {
      await tools.get("apply_patch")!.execute({ patch: ["*** Begin Patch", "*** Update File: src.ts", "@@", "-if (ready) {", "-run();", "+if (ready) {", "+runTwice();", "*** End Patch"].join("\n") }, ctx);
      return { pass: readFileSync(join(root, "src.ts"), "utf8").includes("runTwice"), detail: "fuzzy patch" };
    } catch (error) {
      return { pass: false, detail: error instanceof Error ? error.message.slice(0, 80) : String(error) };
    }
  }));

  results.push(await run("todo-tool", async () => {
    return { pass: tools.has("todo_write"), detail: tools.has("todo_write") ? "present" : "todo_write missing" };
  }));

  results.push(await run("run-tests-tool", async () => {
    return { pass: tools.has("run_tests"), detail: tools.has("run_tests") ? "present" : "run_tests missing" };
  }));

  results.push(await run("rewind-tool", async () => {
    return { pass: tools.has("rewind"), detail: tools.has("rewind") ? "present" : "rewind missing" };
  }));

  const passed = results.filter((result) => result.pass).length;
  const report = { generatedAt: new Date().toISOString(), passed, total: results.length, results };
  const outDir = join(process.cwd(), "eval", "aci");
  mkdirSync(outDir, { recursive: true });
  const output = join(outDir, process.argv[2] ?? "pre-change.json");
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  for (const result of results) console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name} (${result.ms}ms) ${result.detail}`);
  console.log(`\n${passed}/${results.length} passed -> ${output}`);

  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A timed-out child may still hold the directory on Windows.
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

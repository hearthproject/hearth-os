import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools, defaultTaskPermissions } from "./tools.ts";
import { createAgentState } from "./harness/file-state.ts";
import { killShellSession } from "./harness/shell-session.ts";
import type { AgentToolContext } from "./types.ts";

describe("builtin tools", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) await removeWorkspace(root);
  });

  it("finds files with glob while skipping dependencies and hidden directories", async () => {
    const root = workspace(roots);
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, ".cache"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "nested", "b.ts"), "export const b = 2;\n");
    writeFileSync(join(root, "node_modules", "pkg", "ignored.ts"), "export const ignored = true;\n");
    writeFileSync(join(root, ".cache", "hidden.ts"), "export const hidden = true;\n");
    const result = await mapTools().glob!.execute({ pattern: "**/*.ts" }, contextFor(root, join(root, "out")));
    expect(result.content).toContain("src/a.ts");
    expect(result.content).toContain("src/nested/b.ts");
    expect(result.content).not.toContain("node_modules");
    expect(result.content).not.toContain(".cache");
  });

  it("greps with RE2 regex, literal mode, and include/exclude filters", async () => {
    const root = workspace(roots);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "const Alpha = 1;\n");
    writeFileSync(join(root, "src", "a.test.ts"), "const ALPHA = 2;\n");
    writeFileSync(join(root, "src", "literal.ts"), "value = a.b;\n");
    const tools = mapTools();
    const regex = await tools.grep!.execute({
      pattern: "^const alpha",
      include: "**/*.ts",
      exclude: "**/*.test.ts"
    }, contextFor(root, join(root, "out")));
    expect(regex.content).toContain("src/a.ts:1:");
    expect(regex.content).not.toContain("a.test.ts");
    const literal = await tools.grep!.execute({
      pattern: "a.b",
      mode: "literal",
      include: ["literal.ts"]
    }, contextFor(root, join(root, "out")));
    expect(literal.content).toContain("src/literal.ts:1:");
  });

  it("rejects unsafe grep patterns and paths outside the workspace", async () => {
    const root = workspace(roots);
    const tools = mapTools();
    const context = contextFor(root, join(root, "out"));
    await expect(tools.grep!.execute({ pattern: "(" }, context)).rejects.toThrow("无效的 RE2 正则");
    await expect(tools.grep!.execute({ pattern: "x".repeat(501) }, context)).rejects.toThrow("搜索模式过长");
    await expect(tools.grep!.execute({ pattern: "x", path: "../outside" }, context)).rejects.toThrow("路径不在授权范围内");
    await expect(tools.glob!.execute({ pattern: "**/*.ts", path: "../outside" }, context)).rejects.toThrow("路径不在授权范围内");
  });

  it("rejects symlinks that escape the workspace", async () => {
    const root = workspace(roots);
    const outside = workspace(roots);
    const secret = join(outside, "secret.ts");
    writeFileSync(secret, "const leaked = true;\n");
    try {
      symlinkSync(secret, join(root, "escape.ts"), "file");
    } catch {
      return;
    }
    const tools = mapTools();
    await expect(tools.grep!.execute({ pattern: "leaked", path: "escape.ts" }, contextFor(root, join(root, "out")))).rejects.toThrow("符号链接越界");
    await expect(tools.glob!.execute({ pattern: "*.ts", path: "escape.ts" }, contextFor(root, join(root, "out")))).rejects.toThrow("符号链接越界");
  });

  it("stops scans after the time budget", async () => {
    const root = workspace(roots);
    writeFileSync(join(root, "a.ts"), "const a = 1;\n");
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(10_001);
    await expect(mapTools().glob!.execute({ pattern: "**/*.ts" }, contextFor(root, join(root, "out")))).rejects.toThrow("秒预算");
  });

  it("writes and edits files inside the authorized output directory", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    const context = contextFor(root, out);
    const tools = mapTools();
    await tools.write_file!.execute({ path: "out/note.md", content: "第一版" }, context);
    await tools.edit_file!.execute({ path: "out/note.md", oldText: "第一版", newText: "第二版" }, context);
    expect(readFileSync(join(out, "note.md"), "utf8")).toBe("第二版");
  });

  it("writes an XLSX workbook and reads it back as a document", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    const tools = mapTools();
    const context = contextFor(root, out);
    await tools.write_spreadsheet!.execute({
      path: "out/sales.xlsx",
      sheets: [{ name: "销售", rows: [["订单", "金额"], ["A-1", 42], ["A-2", 18]] }]
    }, context);
    const result = await tools.read_document!.execute({ path: "out/sales.xlsx" }, context);
    expect(result.content).toContain("工作表：销售");
    expect(result.content).toContain("A-1");
    expect(result.content).toContain("42");
  });

  it("writes a DOCX document and reads it back as a document", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    const tools = mapTools();
    const context = contextFor(root, out);
    await tools.write_document!.execute({
      path: "out/report.docx",
      title: "季度报告",
      blocks: [
        { type: "heading", text: "概述", level: 2 },
        { type: "paragraph", text: "这是第一段正文。" },
        { type: "bullet", text: "关键结论" },
        { type: "numbered", text: "后续行动" }
      ]
    }, context);
    const result = await tools.read_document!.execute({ path: "out/report.docx" }, context);
    expect(result.content).toContain("季度报告");
    expect(result.content).toContain("这是第一段正文。");
    expect(result.content).toContain("关键结论");
    expect(result.content).toContain("后续行动");
  });

  it("reads CSV documents and rejects document path escapes", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "orders.csv"), "订单,金额\nA-1,42\n");
    const tools = mapTools();
    const context = contextFor(root, out);
    const result = await tools.read_document!.execute({ path: "out/orders.csv" }, context);
    expect(result.content).toContain("| 源文件行 | 订单 | 金额 |");
    await expect(tools.read_document!.execute({ path: "../outside.csv" }, context)).rejects.toThrow("路径不在授权范围内");
    await expect(tools.write_spreadsheet!.execute({
      path: "out/not-a-sheet.csv",
      sheets: [{ name: "数据", rows: [["a"]] }]
    }, context)).rejects.toThrow(".xlsx");
  });

  it("rejects writes outside the authorized roots", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    const tools = mapTools();
    await expect(tools.write_file!.execute({ path: "../escape.md", content: "x" }, contextFor(root, out))).rejects.toThrow();
  });

  it("applies a simple update patch", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    writeFileSync(join(root, "source.md"), "alpha\nbeta\ngamma\n");
    const tools = mapTools();
    const permissions = defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [], writeRoots: [out, join(root, "source.md")] });
    await tools.apply_patch!.execute({
      patch: [
        "*** Begin Patch",
        "*** Update File: source.md",
        "@@",
        " alpha",
        "-beta",
        "+BETA",
        " gamma",
        "*** End Patch"
      ].join("\n")
    }, { workspaceRoot: root, outDir: out, permissions, signal: new AbortController().signal });
    expect(readFileSync(join(root, "source.md"), "utf8")).toContain("BETA");
  });

  it("previews edit_file changes without writing them", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "note.md"), "alpha\nbeta\n");
    const permissions = defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [] });
    const result = await mapTools().edit_file!.execute({
      path: "out/note.md",
      oldText: "beta",
      newText: "BETA",
      dryRun: true
    }, { workspaceRoot: root, outDir: out, permissions, signal: new AbortController().signal });
    expect(result.content).toContain("差异预览");
    expect(result.content).toContain("-beta");
    expect(result.content).toContain("+BETA");
    expect(readFileSync(join(out, "note.md"), "utf8")).toBe("alpha\nbeta\n");
  });

  it("rejects omission placeholders before attempting an edit", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "note.md"), "alpha\nbeta\ngamma\n");
    const permissions = defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [] });
    await expect(mapTools().edit_file!.execute({
      path: "out/note.md",
      oldText: "alpha\n// ... existing code ...\ngamma",
      newText: "alpha\ngamma"
    }, { workspaceRoot: root, outDir: out, permissions, signal: new AbortController().signal })).rejects.toThrow("省略占位符");
    expect(readFileSync(join(out, "note.md"), "utf8")).toBe("alpha\nbeta\ngamma\n");
  });

  it("moves and deletes files with an apply_patch", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    writeFileSync(join(root, "source.md"), "alpha\n");
    const permissions = defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [], writeRoots: [out, join(root, "source.md"), join(root, "moved.md")] });
    const context = { workspaceRoot: root, outDir: out, permissions, signal: new AbortController().signal };
    const tools = mapTools();
    await tools.apply_patch!.execute({
      patch: [
        "*** Begin Patch",
        "*** Update File: source.md",
        "*** Move to: moved.md",
        "@@",
        "-alpha",
        "+ALPHA",
        "*** End Patch"
      ].join("\n")
    }, context);
    expect(existsSync(join(root, "source.md"))).toBe(false);
    expect(readFileSync(join(root, "moved.md"), "utf8")).toContain("ALPHA");
    await tools.apply_patch!.execute({
      patch: ["*** Begin Patch", "*** Delete File: moved.md", "*** End Patch"].join("\n")
    }, context);
    expect(existsSync(join(root, "moved.md"))).toBe(false);
  });

  it("validates every patch hunk before writing any file", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    writeFileSync(join(root, "a.md"), "alpha\n");
    writeFileSync(join(root, "b.md"), "beta\n");
    const permissions = defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [], writeRoots: [out, join(root, "a.md"), join(root, "b.md")] });
    const context = { workspaceRoot: root, outDir: out, permissions, signal: new AbortController().signal };
    await expect(mapTools().apply_patch!.execute({
      patch: [
        "*** Begin Patch",
        "*** Update File: a.md",
        "@@",
        "-alpha",
        "+ALPHA",
        "*** Update File: b.md",
        "@@",
        "-missing",
        "+MISSING",
        "*** End Patch"
      ].join("\n")
    }, context)).rejects.toThrow("补丁片段未匹配");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("alpha\n");
    expect(readFileSync(join(root, "b.md"), "utf8")).toBe("beta\n");
  });

  it("previews apply_patch changes without writing them", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    writeFileSync(join(root, "source.md"), "alpha\n");
    const permissions = defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [], writeRoots: [out, join(root, "source.md")] });
    const result = await mapTools().apply_patch!.execute({
      patch: ["*** Begin Patch", "*** Update File: source.md", "@@", "-alpha", "+ALPHA", "*** End Patch"].join("\n"),
      dryRun: true
    }, { workspaceRoot: root, outDir: out, permissions, signal: new AbortController().signal });
    expect(result.content).toContain("差异预览");
    expect(readFileSync(join(root, "source.md"), "utf8")).toBe("alpha\n");
  });

  it("requires an authorized host before fetching a URL", async () => {
    const root = workspace(roots);
    const tools = mapTools();
    await expect(tools.fetch_url!.execute({ url: "https://example.com" }, contextFor(root, join(root, "out")))).rejects.toThrow("域名未授权");
  });

  it("blocks destructive shell commands", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    const tools = mapTools();
    const permissions = { ...defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [], extraTools: ["shell"] }), sandboxMode: "danger-full-access" as const };
    await expect(tools.shell!.execute({ command: "rm -rf /" }, {
      workspaceRoot: root,
      outDir: out,
      permissions,
      signal: new AbortController().signal
    })).rejects.toThrow("安全策略");
  });

  it("blocks gh when the task has no network permission", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    const tools = mapTools();
    const permissions = { ...defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [], extraTools: ["shell"] }), sandboxMode: "danger-full-access" as const };
    await expect(tools.shell!.execute({ command: "gh auth status" }, {
      workspaceRoot: root,
      outDir: out,
      permissions,
      signal: new AbortController().signal
    })).rejects.toThrow("没有网络权限");
  });

  it("classifies shell effects so the operation ledger can reconcile them", () => {
    const effect = mapTools().shell!.definition.effectForArgs!;
    expect(effect({ command: "ls -la" })).toBe("read");
    expect(effect({ command: "echo hello" })).toBe("read");
    expect(effect({ command: "rm -rf /" })).toBe("destructive");
    expect(effect({ command: "git push origin main" })).toBe("external_write");
    expect(effect({ command: "git push --dry-run origin main" })).toBe("local_write");
    expect(effect({ command: "gh auth status" })).toBe("read");
    expect(effect({ command: "gh pr list --limit 20" })).toBe("read");
    expect(effect({ command: "gh pr create --title fix" })).toBe("external_write");
    expect(effect({ command: "curl -X POST https://example.com/hook" })).toBe("external_write");
    expect(effect({ command: "Invoke-RestMethod -Method Delete https://example.com/item" })).toBe("external_write");
    expect(effect({ command: "npm install" })).toBe("local_write");
    expect(effect({ command: "unknown-binary --do-things" })).toBe("unknown");
  });

  it("deduplicates unchanged reads unless force is set", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "note.md"), "alpha\nbeta\n");
    const state = createAgentState(root);
    const context = { ...contextFor(root, out), state };
    const tools = mapTools();
    const first = await tools.read_file!.execute({ path: "out/note.md" }, context);
    expect(first.content).toContain("1: alpha");
    const second = await tools.read_file!.execute({ path: "out/note.md" }, context);
    expect(second.content).toContain("未变化");
    expect(second.metadata?.unchanged).toBe(true);
    expect(second.content).not.toContain("1: alpha");
    const forced = await tools.read_file!.execute({ path: "out/note.md", force: true }, context);
    expect(forced.content).toContain("1: alpha");
  });

  it("rejects binary reads and suggests a nearby path", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "real.md"), "text\n");
    writeFileSync(join(out, "binary.bin"), Buffer.from([0, 1, 2, 3, 255]));
    const context = contextFor(root, out);
    await expect(mapTools().read_file!.execute({ path: "out/binary.bin" }, context)).rejects.toThrow("二进制");
    await expect(mapTools().read_file!.execute({ path: "out/real.txt" }, context)).rejects.toThrow(/是否想找.*real.md/);
  });

  it("lets full-access tasks read and write outside the workspace roots", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    const outside = join(dirname(root), "hearth-full-access");
    rmSync(outside, { recursive: true, force: true });
    const tools = mapTools();
    const context = contextFor(root, out);
    context.permissions = { ...context.permissions, fullAccess: true };
    const write = await tools.write_file!.execute({ path: join(outside, "note.txt"), content: "outside\n" }, context);
    expect(write.isError).not.toBe(true);
    expect(readFileSync(join(outside, "note.txt"), "utf8")).toBe("outside\n");
    const read = await tools.read_file!.execute({ path: join(outside, "note.txt") }, context);
    expect(read.content).toContain("outside");
    rmSync(outside, { recursive: true, force: true });
  });

  it("reads a file under the configured desktop root and refuses paths outside it", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    const desktop = workspace(roots);
    writeFileSync(join(desktop, "项目介绍.md"), "# 桌面文件\n正文\n", "utf8");
    const previous = process.env.HEARTH_DESKTOP_DIR;
    process.env.HEARTH_DESKTOP_DIR = desktop;
    try {
      const tools = mapTools();
      const context = contextFor(root, out);
      const read = await tools.read_desktop_file!.execute({ path: "项目介绍.md" }, context);
      expect(read.isError).not.toBe(true);
      expect(read.content).toContain("桌面文件");
      const outside = workspace(roots);
      writeFileSync(join(outside, "secret.txt"), "nope\n", "utf8");
      await expect(tools.read_desktop_file!.execute({ path: join(outside, "secret.txt") }, context))
        .rejects.toThrow("只能读取桌面目录");
    } finally {
      if (previous === undefined) delete process.env.HEARTH_DESKTOP_DIR;
      else process.env.HEARTH_DESKTOP_DIR = previous;
    }
  });

  it("persists and updates a long-running goal", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    const context = contextFor(root, out);
    context.permissions = { ...context.permissions, writeRoots: [root] };
    const tools = mapTools();
    const created = await tools.create_goal!.execute({ title: "Ship P2", objective: "Add durable memory", successCriteria: ["Tests pass"] }, context);
    expect(created.content).toContain("status: active");
    const read = await tools.get_goal!.execute({}, context);
    expect(read.content).toContain("Ship P2");
    await tools.update_goal!.execute({ status: "completed", note: "vitest passed" }, context);
    const updated = await tools.get_goal!.execute({}, context);
    expect(updated.content).toContain("status: completed");
    expect(updated.content).toContain("vitest passed");
  });

  it("writes, reads and searches repository memory", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    const context = contextFor(root, out);
    context.permissions = { ...context.permissions, writeRoots: [root] };
    const tools = mapTools();
    const written = await tools.memory_write!.execute({ name: "Build Commands", content: "Use pnpm test.", description: "repo test command" }, context);
    expect(written.content).toContain("Build-Commands.md");
    const index = await tools.memory_read!.execute({}, context);
    expect(index.content).toContain("Build Commands");
    const entry = await tools.memory_read!.execute({ name: "Build Commands" }, context);
    expect(entry.content).toContain("Use pnpm test.");
    const found = await tools.memory_search!.execute({ query: "pnpm" }, context);
    expect(found.content).toContain("Build-Commands");
  });

  it("waits for a background shell instead of busy-polling", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    const context = contextFor(root, out);
    const tools = mapTools();
    const started = await tools.shell!.execute({ command: "echo wait-done", background: true }, context);
    const sessionId = started.metadata?.sessionId;
    expect(sessionId).toBeTruthy();
    const waited = await tools.shell_wait!.execute({ sessionId, timeoutSeconds: 5 }, context);
    expect(waited.metadata?.exitCode).toBe(0);
    expect(waited.content).toContain("wait-done");
  });

  it("returns on output match and times out without killing the process", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    const context = contextFor(root, out);
    const tools = mapTools();

    const matchedSession = (await tools.shell!.execute({ command: `Set-Location $env:TEMP; node -e "console.log('ready'); setInterval(() => {}, 1000)"`, background: true }, context)).metadata?.sessionId;
    const matched = await tools.shell_wait!.execute({ sessionId: matchedSession, match: "ready", timeoutSeconds: 5 }, context);
    expect(matched.metadata?.matched).toBe(true);
    expect(matched.metadata?.timedOut).toBe(false);
    expect(matched.content).toContain("match found");
    await tools.shell_kill!.execute({ sessionId: matchedSession }, context);

    const idleSession = (await tools.shell!.execute({ command: `Set-Location $env:TEMP; node -e "setInterval(() => {}, 1000)"`, background: true }, context)).metadata?.sessionId;
    const timedOut = await tools.shell_wait!.execute({ sessionId: idleSession, timeoutSeconds: 1 }, context);
    expect(timedOut.metadata?.timedOut).toBe(true);
    expect(timedOut.metadata?.background).toBe(true);
    expect(timedOut.content).toContain("timeout");
    await tools.shell_kill!.execute({ sessionId: idleSession }, context);
  });

  it("stores full shell output in the task log and returns only the tail", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    const script = join(root, "large-output.cjs");
    writeFileSync(script, "process.stdout.write('x'.repeat(12000));\n");
    const permissions = { ...defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [], extraTools: ["shell"] }), sandboxMode: "danger-full-access" as const };
    const result = await mapTools().shell!.execute({ command: `node "${script}"` }, {
      workspaceRoot: root,
      outDir: out,
      permissions,
      signal: new AbortController().signal
    });
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeLessThan(9_000);
    expect(result.content).toContain(".hearth/shell/");
    const logs = readdirSync(join(out, ".hearth", "shell"));
    expect(logs).toHaveLength(1);
    const fullLog = readFileSync(join(out, ".hearth", "shell", logs[0]!), "utf8");
    expect(fullLog).toContain("x".repeat(12000));
    expect(fullLog).toContain("$ node");
  });

  it("reads oversized tool output by call id and rejects path traversal", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    const path = join(out, ".hearth", "tool-results", "full.txt");
    mkdirSync(join(out, ".hearth", "tool-results"), { recursive: true });
    writeFileSync(path, "abcdefghijklmnopqrstuvwxyz");
    const state = createAgentState(root);
    state.toolOutputs = { "call-1": { path, bytes: 26, tokens: 7 } };
    const context = { ...contextFor(root, out), state };
    const chunk = await mapTools().read_tool_output!.execute({ callId: "call-1", offset: 10, limit: 5 }, context);
    expect(chunk.content).toContain("klmno");
    expect(chunk.metadata).toMatchObject({ offset: 10, end: 15, totalChars: 26 });
    await expect(mapTools().read_tool_output!.execute({ path: join(root, "secret.txt") }, context))
      .rejects.toThrow("只能读取");
  });

  it("migrates a timed-out command to a killable background session", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    const marker = join(root, "child-still-alive.txt");
    const child = join(root, "timeout-child.cjs");
    const parent = join(root, "timeout-parent.cjs");
    writeFileSync(child, "setTimeout(() => require('node:fs').writeFileSync(process.argv[2], 'alive'), 1800);\nsetInterval(() => {}, 1000);\n");
    writeFileSync(parent, [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, [process.argv[3], process.argv[2]], { stdio: 'ignore' });",
      "setInterval(() => {}, 1000);"
    ].join("\n"));
    const permissions = { ...defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [], extraTools: ["shell"] }), sandboxMode: "danger-full-access" as const };
    const result = await mapTools().shell!.execute({
      command: `node "${parent}" "${marker}" "${child}"`,
      timeoutMs: 1_000
    }, {
      workspaceRoot: root,
      outDir: out,
      permissions,
      signal: new AbortController().signal
    });
    expect(result.isError).toBe(false);
    expect(result.metadata?.background).toBe(true);
    expect(result.metadata?.sessionId).toBeTruthy();
    killShellSession(result.metadata!.sessionId!);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
    expect(existsSync(marker)).toBe(false);
  }, 10_000);

  it("runs a bounded read-only workflow and rejects write steps", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(root, "a.txt"), "alpha\n", "utf8");
    writeFileSync(join(root, "b.txt"), "beta\n", "utf8");
    const workflow = mapTools().workflow!;

    const result = await workflow.execute({
      parallel: true,
      steps: [
        { id: "a", tool: "read_file", arguments: { path: "a.txt" } },
        { id: "b", tool: "read_file", arguments: { path: "b.txt" } }
      ]
    }, contextFor(root, out));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("alpha");
    expect(result.content).toContain("beta");
    expect(result.content).toContain("workflow completed: 2 step(s)");

    const denied = await workflow.execute({ steps: [{ tool: "write_file", arguments: { path: "x.txt", content: "x" } }] }, contextFor(root, out));
    expect(denied.isError).toBe(true);
    expect(denied.error?.code).toBe("WORKFLOW_STEP_FAILED");
  });
});

function mapTools(): Record<string, ReturnType<typeof createBuiltinTools>[number]> {
  return Object.fromEntries(createBuiltinTools().map((tool) => [tool.definition.name, tool]));
}

function contextFor(root: string, out: string): AgentToolContext {
  return {
    workspaceRoot: root,
    outDir: out,
    permissions: { ...defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [] }), sandboxMode: "danger-full-access" },
    signal: new AbortController().signal
  };
}

function workspace(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-tools-"));
  roots.push(root);
  return root;
}

async function removeWorkspace(root: string): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EBUSY", "ENOTEMPTY", "EPERM", "EACCES"].includes(code ?? "") || attempt === 24) throw error;
      await delay(250);
    }
  }
}

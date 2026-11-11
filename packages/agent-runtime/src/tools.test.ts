import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools, defaultTaskPermissions } from "./tools.ts";
import type { AgentToolContext } from "./types.ts";

describe("builtin tools", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
    const permissions = defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [], extraTools: ["shell"] });
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
    const permissions = defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [], extraTools: ["shell"] });
    await expect(tools.shell!.execute({ command: "gh auth status" }, {
      workspaceRoot: root,
      outDir: out,
      permissions,
      signal: new AbortController().signal
    })).rejects.toThrow("没有网络权限");
  });

  it("stores full shell output in the task log and returns only the tail", async () => {
    const root = workspace(roots);
    const out = join(root, "out");
    const script = join(root, "large-output.cjs");
    writeFileSync(script, "process.stdout.write('x'.repeat(12000));\n");
    const permissions = defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [], extraTools: ["shell"] });
    const result = await mapTools().shell!.execute({ command: `node "${script}"` }, {
      workspaceRoot: root,
      outDir: out,
      permissions,
      signal: new AbortController().signal
    });
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeLessThan(9_000);
    expect(result.content).toContain(".hearth/shell/");
    const logs = readdirSync(join(root, ".hearth", "shell"));
    expect(logs).toHaveLength(1);
    const fullLog = readFileSync(join(root, ".hearth", "shell", logs[0]!), "utf8");
    expect(fullLog).toContain("x".repeat(12000));
    expect(fullLog).toContain("$ node");
  });

  it("kills the whole shell process tree on timeout", async () => {
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
    const permissions = defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [], extraTools: ["shell"] });
    const result = await mapTools().shell!.execute({
      command: `node "${parent}" "${marker}" "${child}"`,
      timeoutMs: 1_000
    }, {
      workspaceRoot: root,
      outDir: out,
      permissions,
      signal: new AbortController().signal
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("进程树已终止");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
    expect(existsSync(marker)).toBe(false);
  }, 10_000);
});

function mapTools(): Record<string, ReturnType<typeof createBuiltinTools>[number]> {
  return Object.fromEntries(createBuiltinTools().map((tool) => [tool.definition.name, tool]));
}

function contextFor(root: string, out: string): AgentToolContext {
  return {
    workspaceRoot: root,
    outDir: out,
    permissions: defaultTaskPermissions({ workspaceRoot: root, outDir: out, networkHosts: [] }),
    signal: new AbortController().signal
  };
}

function workspace(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-tools-"));
  roots.push(root);
  return root;
}

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuiltinTools, defaultTaskPermissions } from "./tools.ts";
import type { AgentToolContext } from "./types.ts";

describe("builtin tools", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

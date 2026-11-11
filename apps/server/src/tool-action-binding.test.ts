import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { actionDigest, verifyResolvedAction } from "./action-resolver.ts";
import { resolveToolAction } from "./scheduler.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native tool action binding", () => {
  it("binds office artifact writes to their destination files", () => {
    const root = tempRoot();
    for (const toolName of ["write_spreadsheet", "write_document"]) {
      const action = resolveToolAction({
        toolName,
        argumentsValue: { path: `${toolName}.out` },
        summary: "生成办公文件",
        workspaceRoot: root,
        fullPermission: false,
        context: "interactive"
      });
      expect(action?.kind).toBe("file_write");
      expect(action?.files[0]?.mode).toBe("create");
    }
  });

  it("binds every apply_patch file and detects post-approval content changes", () => {
    const root = tempRoot();
    const existing = join(root, "notes.md");
    writeFileSync(existing, "old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: notes.md",
      "@@",
      "-old",
      "+new",
      "*** Add File: report.md",
      "+report",
      "*** End Patch"
    ].join("\n");

    const action = resolveToolAction({
      toolName: "apply_patch",
      argumentsValue: { patch },
      summary: "应用补丁修改工作区文件",
      workspaceRoot: root,
      fullPermission: false,
      context: "interactive"
    });

    expect(action?.kind).toBe("file_write");
    expect(action?.files.map((file) => file.mode).sort()).toEqual(["create", "replace"]);
    expect(action?.targetRevision).toMatch(/^patch-sha256:[a-f0-9]{64}$/);
    expect(verifyResolvedAction(action!).ok).toBe(true);

    writeFileSync(existing, "tampered\n", "utf8");
    const verification = verifyResolvedAction(action!);
    expect(verification.ok).toBe(false);
    expect(verification.reason).toContain("变化");
  });

  it("fails closed when a patch target escapes the session root", () => {
    const root = tempRoot();
    expect(() => resolveToolAction({
      toolName: "apply_patch",
      argumentsValue: {
        patch: ["*** Begin Patch", "*** Add File: ../escape.txt", "+escape", "*** End Patch"].join("\n")
      },
      summary: "越界补丁",
      workspaceRoot: root,
      fullPermission: false,
      context: "interactive"
    })).toThrow(/超出会话根目录/);
  });

  it("binds an MCP tool call to its server, tool and full arguments", () => {
    const root = tempRoot();
    const argumentsValue = { text: "hello" };
    const action = resolveToolAction({
      toolName: "mcp__mcp_one__echo",
      argumentsValue,
      mcpArgumentsValue: argumentsValue,
      summary: "调用 MCP 工具：mcp_one/echo",
      workspaceRoot: root,
      fullPermission: false,
      context: "interactive"
    });
    expect(action?.kind).toBe("mcp");
    expect(action?.mcp).toEqual({
      serverId: "mcp_one",
      toolName: "echo",
      argumentsDigest: actionDigest(argumentsValue)
    });
    expect(verifyResolvedAction(action!).ok).toBe(true);
  });

  it("does not invent an action for an unrecognized sensitive tool call", () => {
    const root = tempRoot();
    expect(resolveToolAction({
      toolName: "apply_patch",
      argumentsValue: { patch: "not a patch" },
      summary: "无效补丁",
      workspaceRoot: root,
      fullPermission: false,
      context: "interactive"
    })).toBeNull();
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-tool-action-"));
  roots.push(root);
  return root;
}

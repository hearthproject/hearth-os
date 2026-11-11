import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActionResolutionError, actionDigest, decideActionPolicy, resolveAction, verifyResolvedAction } from "./action-resolver.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-action-"));
  roots.push(root);
  return root;
}

function tempExecutable(root: string, name = "tool.exe", content = "v1"): string {
  const path = join(root, name);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("action resolver", () => {
  it("resolves a command with a stable digest and rejects executable replacement", () => {
    const root = tempRoot();
    const executable = tempExecutable(root);
    const resolved = resolveAction({
      proposal: { kind: "shell", summary: "run tool", command: { executable, cwd: root, argv: ["--check"] } },
      sessionRoot: root
    });
    expect(resolved.command?.executableSha256).toHaveLength(64);
    expect(verifyResolvedAction(resolved).ok).toBe(true);
    writeFileSync(executable, "v2", "utf8");
    const verification = verifyResolvedAction(resolved);
    expect(verification.ok).toBe(false);
    expect(verification.reason).toContain("变化");
  });

  it("changes the digest when argv or cwd changes", () => {
    const root = tempRoot();
    const executable = tempExecutable(root);
    const first = resolveAction({
      proposal: { kind: "shell", summary: "run", command: { executable, cwd: root, argv: ["one"] } },
      sessionRoot: root
    });
    const second = resolveAction({
      proposal: { kind: "shell", summary: "run", command: { executable, cwd: root, argv: ["two"] } },
      sessionRoot: root
    });
    expect(first.actionDigest).not.toBe(second.actionDigest);
  });

  it("rejects file targets outside the session root", () => {
    const root = tempRoot();
    const outside = tempRoot();
    expect(() => resolveAction({
      proposal: { kind: "file_write", summary: "write", files: [{ path: join(outside, "a.txt"), mode: "create" }] },
      sessionRoot: root
    })).toThrow(ActionResolutionError);
  });

  it("binds existing file content into the action", () => {
    const root = tempRoot();
    const file = join(root, "note.txt");
    writeFileSync(file, "hello", "utf8");
    const resolved = resolveAction({
      proposal: { kind: "file_write", summary: "replace note", files: [{ path: file, mode: "replace" }] },
      sessionRoot: root
    });
    expect(resolved.files[0]?.sha256).toHaveLength(64);
    writeFileSync(file, "changed", "utf8");
    expect(verifyResolvedAction(resolved).ok).toBe(false);
  });

  it("applies permission modes and non-interactive denial", () => {
    const root = tempRoot();
    const executable = tempExecutable(root);
    const shell = resolveAction({
      proposal: { kind: "shell", summary: "run", command: { executable, cwd: root } },
      sessionRoot: root,
      permissionMode: "guarded",
      context: "interactive"
    });
    expect(decideActionPolicy(shell, { preauthorized: false })).toMatchObject({ allowed: true, requiresApproval: true });
    const scheduled = { ...shell, context: "scheduled" as const };
    expect(decideActionPolicy(scheduled, { preauthorized: false })).toMatchObject({ allowed: false, requiresApproval: false });
    expect(decideActionPolicy(scheduled, { preauthorized: true })).toMatchObject({ allowed: true, requiresApproval: true });
    const readonly = { ...shell, permissionMode: "read-only" as const };
    expect(decideActionPolicy(readonly).allowed).toBe(false);
  });

  it("produces the same digest regardless of environment key order", () => {
    const root = tempRoot();
    const executable = tempExecutable(root);
    const first = resolveAction({
      proposal: { kind: "shell", summary: "run", command: { executable, cwd: root, env: { A: "1", B: "2" } } },
      sessionRoot: root
    });
    const second = resolveAction({
      proposal: { kind: "shell", summary: "run", command: { executable, cwd: root, env: { B: "2", A: "1" } } },
      sessionRoot: root
    });
    expect(first.actionDigest).toBe(second.actionDigest);
    expect(actionDigest({ b: 2, a: 1 })).toBe(actionDigest({ a: 1, b: 2 }));
  });

  it("binds a desktop action to its frame and exact payload", () => {
    const root = tempRoot();
    const resolved = resolveAction({
      proposal: {
        kind: "desktop",
        summary: "click submit",
        desktop: {
          deviceId: "device-1",
          sessionId: "session-1",
          frameId: "frame-1",
          frameSha256: "a".repeat(64),
          activeApp: "notepad",
          controlEpoch: 3,
          action: "click",
          payload: { x: 0.5, y: 0.25, button: "left" }
        }
      },
      sessionRoot: root
    });
    expect(resolved.desktop?.payloadDigest).toHaveLength(64);
    expect(verifyResolvedAction(resolved).ok).toBe(true);

    const changedPayload = {
      ...resolved,
      proposal: {
        ...resolved.proposal,
        desktop: {
          ...resolved.desktop!,
          payload: { x: 0.75, y: 0.25, button: "left" }
        }
      }
    };
    expect(verifyResolvedAction(changedPayload).ok).toBe(false);

    const changedFrame = {
      ...resolved,
      proposal: {
        ...resolved.proposal,
        desktop: { ...resolved.desktop!, frameSha256: "b".repeat(64) }
      }
    };
    expect(verifyResolvedAction(changedFrame).ok).toBe(false);
  });

  it("binds MCP calls to the server, tool and arguments digest", () => {
    const root = tempRoot();
    const first = resolveAction({
      proposal: {
        kind: "mcp",
        summary: "调用 MCP",
        mcp: { serverId: "mcp_one", toolName: "echo", argumentsDigest: actionDigest({ text: "one" }) }
      },
      sessionRoot: root
    });
    const second = resolveAction({
      proposal: {
        kind: "mcp",
        summary: "调用 MCP",
        mcp: { serverId: "mcp_one", toolName: "echo", argumentsDigest: actionDigest({ text: "two" }) }
      },
      sessionRoot: root
    });
    expect(first.mcp).toMatchObject({ serverId: "mcp_one", toolName: "echo" });
    expect(first.preview).toContain("MCP mcp_one/echo");
    expect(first.actionDigest).not.toBe(second.actionDigest);
    expect(verifyResolvedAction(first).ok).toBe(true);
  });
});

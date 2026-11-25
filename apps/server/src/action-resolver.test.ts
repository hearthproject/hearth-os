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

  it("runs local commands without approval and keeps read-only as a hard stop", () => {
    const root = tempRoot();
    const executable = tempExecutable(root);
    const shell = resolveAction({
      proposal: { kind: "shell", summary: "run", command: { executable, cwd: root } },
      sessionRoot: root,
      permissionMode: "guarded",
      context: "interactive"
    });
    expect(decideActionPolicy(shell, { preauthorized: false })).toMatchObject({ allowed: true, requiresApproval: false });
    const scheduled = { ...shell, context: "scheduled" as const };
    expect(decideActionPolicy(scheduled, { preauthorized: false })).toMatchObject({ allowed: true, requiresApproval: false });
    expect(decideActionPolicy(scheduled, { preauthorized: true })).toMatchObject({ allowed: true, requiresApproval: false });
    const readonly = { ...shell, permissionMode: "read-only" as const };
    expect(decideActionPolicy(readonly).allowed).toBe(false);
  });

  it("classifies shell scripts by argv before approval", () => {
    const root = tempRoot();
    const readOnly = resolveAction({
      proposal: { kind: "shell", summary: "status", command: { executable: process.execPath, cwd: root, argv: ["-c", "git status"], shell: "sh" } },
      sessionRoot: root,
      permissionMode: "guarded",
      context: "interactive"
    });
    expect(decideActionPolicy(readOnly)).toMatchObject({ allowed: true, requiresApproval: false });

    const destructive = resolveAction({
      proposal: { kind: "shell", summary: "delete", command: { executable: process.execPath, cwd: root, argv: ["-c", "rm -rf build"], shell: "sh" } },
      sessionRoot: root,
      permissionMode: "guarded",
      context: "interactive"
    });
    expect(decideActionPolicy(destructive)).toMatchObject({ allowed: true, requiresApproval: true });
    expect(decideActionPolicy({ ...destructive, context: "scheduled" }, { preauthorized: false })).toMatchObject({ allowed: false, requiresApproval: false });

    const unknown = resolveAction({
      proposal: { kind: "shell", summary: "unknown", command: { executable: process.execPath, cwd: root, argv: ["-c", "frobnicate --all"], shell: "sh" } },
      sessionRoot: root,
      permissionMode: "workspace",
      context: "interactive"
    });
    expect(decideActionPolicy(unknown)).toMatchObject({ allowed: true, requiresApproval: true });
  });

  it("runs all local actions directly and only gates external writes", () => {
    const root = tempRoot();
    const file = join(root, "note.txt");
    writeFileSync(file, "hello", "utf8");
    const write = resolveAction({
      proposal: { kind: "file_write", summary: "replace note", files: [{ path: file, mode: "replace" }] },
      sessionRoot: root,
      permissionMode: "workspace"
    });
    expect(decideActionPolicy(write, { preauthorized: false })).toMatchObject({ allowed: true, requiresApproval: false });

    const executable = tempExecutable(root);
    const shell = resolveAction({
      proposal: { kind: "shell", summary: "run", command: { executable, cwd: root } },
      sessionRoot: root,
      permissionMode: "workspace"
    });
    expect(decideActionPolicy(shell, { preauthorized: false })).toMatchObject({ allowed: true, requiresApproval: false });

    const deletion = resolveAction({
      proposal: { kind: "file_delete", summary: "delete note", files: [{ path: file, mode: "delete" }] },
      sessionRoot: root,
      permissionMode: "workspace"
    });
    expect(decideActionPolicy(deletion, { preauthorized: false })).toMatchObject({ allowed: true, requiresApproval: false });

    const mcp = resolveAction({
      proposal: {
        kind: "mcp",
        summary: "调用 MCP",
        mcp: { serverId: "mcp_one", toolName: "send", argumentsDigest: actionDigest({ text: "one" }) }
      },
      sessionRoot: root,
      permissionMode: "workspace"
    });
    expect(decideActionPolicy(mcp, { preauthorized: false })).toMatchObject({ allowed: true, requiresApproval: true });

    const network = resolveAction({
      proposal: { kind: "network", summary: "fetch", network: { host: "example.com", method: "GET" } },
      sessionRoot: root,
      permissionMode: "workspace",
      context: "scheduled"
    });
    expect(decideActionPolicy(network, { preauthorized: false })).toMatchObject({ allowed: true, requiresApproval: false });
    expect(decideActionPolicy(network, { preauthorized: true })).toMatchObject({ allowed: true, requiresApproval: false });

    const externalWrite = resolveAction({
      proposal: { kind: "network", summary: "publish", network: { host: "api.example.com", method: "POST" } },
      sessionRoot: root,
      permissionMode: "workspace",
      context: "scheduled"
    });
    expect(decideActionPolicy(externalWrite, { preauthorized: false })).toMatchObject({ allowed: false, requiresApproval: false });
    expect(decideActionPolicy(externalWrite, { preauthorized: true })).toMatchObject({ allowed: true, requiresApproval: true });
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

  it("binds browser actions to http(s) targets and risk levels", () => {
    const root = tempRoot();
    const submit = resolveAction({
      proposal: {
        kind: "browser",
        summary: "提交订单",
        browser: { url: "https://Example.com/pay", action: "submit", elementRef: "2:e9", pageDigest: "abc" }
      },
      sessionRoot: root
    });
    expect(submit.browser).toMatchObject({ host: "example.com", scheme: "https", action: "submit" });
    expect(submit.risk).toBe("high");
    expect(submit.preview).toContain("浏览器 submit");
    const repeat = resolveAction({
      proposal: {
        kind: "browser",
        summary: "提交订单",
        browser: { url: "https://example.com/pay", action: "submit", elementRef: "2:e9", pageDigest: "abc" }
      },
      sessionRoot: root
    });
    expect(repeat.actionDigest).toBe(submit.actionDigest);

    expect(() => resolveAction({
      proposal: { kind: "browser", summary: "本地文件", browser: { url: "file:///etc/passwd", action: "read" } },
      sessionRoot: root
    })).toThrow(ActionResolutionError);
  });
});

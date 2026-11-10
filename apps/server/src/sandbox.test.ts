import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxBackend, SandboxService, type SandboxPolicy } from "./sandbox.ts";

describe("SandboxService", () => {
  let root: string;
  let sandbox: SandboxService;
  let policy: SandboxPolicy;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-sandbox-"));
    sandbox = new SandboxService({
      backends: [new LocalSandboxBackend()],
      now: () => new Date("2026-11-10T03:20:00.000Z")
    });
    policy = {
      workspaceRoot: join(root, "workspace"),
      permissions: {
        readRoots: [join(root, "read")],
        writeRoots: [join(root, "write")],
        networkHosts: ["api.example.com", "*.trusted.example"],
        tools: ["read_file", "write_file"]
      },
      allowedProcesses: ["node", "git"],
      backend: "local"
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("allows a read or write cwd inside the declared roots", () => {
    expect(sandbox.evaluate(policy, { cwd: join(root, "read") }).cwd).toBe(join(root, "read"));
    expect(sandbox.evaluate(policy, { cwd: join(root, "write"), writePaths: [join(root, "write", "out.txt")] }))
      .toMatchObject({ allowed: true, backend: "local" });
  });

  it("classifies path escape, network violation, and expired credentials", () => {
    expect(() => sandbox.evaluate(policy, { cwd: join(root, "..", "escape") })).toThrowError(
      expect.objectContaining({ code: "SANDBOX_ESCAPE", failureClass: "sandbox_escape" })
    );
    expect(() => sandbox.evaluate(policy, { readPaths: [join(root, "..", "outside.txt")] })).toThrowError(
      expect.objectContaining({ code: "SANDBOX_ESCAPE", failureClass: "sandbox_escape" })
    );
    expect(() => sandbox.evaluate(policy, { networkHosts: ["evil.example.com"] })).toThrowError(
      expect.objectContaining({ code: "SANDBOX_NETWORK_DENIED", failureClass: "network_violation" })
    );
    expect(() => sandbox.evaluate(policy, { networkHosts: ["api.example.com.evil.test"] })).toThrowError(
      expect.objectContaining({ failureClass: "network_violation" })
    );
    expect(() => sandbox.evaluate(policy, { credentialExpiresAt: "2026-11-10T03:19:59.000Z" })).toThrowError(
      expect.objectContaining({ code: "SANDBOX_CREDENTIAL_EXPIRED", failureClass: "credential_expired" })
    );
    expect(sandbox.evaluate(policy, { networkHosts: ["docs.trusted.example"] }).checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "network:docs.trusted.example", ok: true })])
    );
  });

  it("denies unknown processes and tools, and marks external effects for approval", () => {
    expect(() => sandbox.evaluate(policy, { process: "powershell" })).toThrowError(
      expect.objectContaining({ code: "SANDBOX_PROCESS_DENIED", failureClass: "policy_denied" })
    );
    expect(() => sandbox.evaluate(policy, { tools: ["shell"] })).toThrowError(
      expect.objectContaining({ code: "SANDBOX_TOOL_DENIED", failureClass: "policy_denied" })
    );
    expect(sandbox.evaluate(policy, { externalEffect: true })).toMatchObject({
      allowed: true,
      requiresApproval: true
    });
  });

  it("fails closed when the requested backend is unavailable", () => {
    expect(() => sandbox.evaluate({ ...policy, backend: "docker" })).toThrowError(
      expect.objectContaining({ code: "SANDBOX_BACKEND_UNAVAILABLE", failureClass: "backend_unavailable" })
    );
  });
});

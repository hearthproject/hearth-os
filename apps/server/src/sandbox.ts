import { isAbsolute, relative, resolve } from "node:path";
import type { TaskPermissions } from "@hearth/core";

export const SANDBOX_BACKENDS = ["local", "docker", "ssh", "vm", "remote-worker"] as const;
export type SandboxBackendId = (typeof SANDBOX_BACKENDS)[number];

export const SANDBOX_FAILURE_CLASSES = [
  "sandbox_escape",
  "network_violation",
  "credential_expired",
  "policy_denied",
  "backend_unavailable"
] as const;
export type SandboxFailureClass = (typeof SANDBOX_FAILURE_CLASSES)[number];

export interface SandboxPolicy {
  workspaceRoot: string;
  permissions: TaskPermissions;
  allowedProcesses: string[];
  credentialExpiresAt?: string | null;
  backend?: SandboxBackendId;
}

export interface SandboxRequest {
  cwd?: string;
  readPaths?: string[];
  writePaths?: string[];
  networkHosts?: string[];
  process?: string;
  tools?: string[];
  credentialExpiresAt?: string | null;
  externalEffect?: boolean;
}

export interface SandboxCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SandboxDecision {
  allowed: boolean;
  requiresApproval: boolean;
  backend: SandboxBackendId;
  cwd: string;
  checks: SandboxCheck[];
}

export class SandboxError extends Error {
  readonly code: string;
  readonly failureClass: SandboxFailureClass;
  readonly statusCode: number;

  constructor(code: string, failureClass: SandboxFailureClass, message: string, statusCode = 403) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
    this.failureClass = failureClass;
    this.statusCode = statusCode;
  }
}

export interface SandboxBackend {
  readonly id: SandboxBackendId;
  available(policy: SandboxPolicy): boolean;
  prepare(policy: SandboxPolicy, request: SandboxRequest): { cwd: string };
}

export class LocalSandboxBackend implements SandboxBackend {
  readonly id = "local" as const;

  available(): boolean {
    return true;
  }

  prepare(policy: SandboxPolicy, request: SandboxRequest): { cwd: string } {
    const cwd = resolve(request.cwd ?? policy.workspaceRoot);
    ensureWithin(policy.workspaceRoot, cwd, [...policy.permissions.readRoots, ...policy.permissions.writeRoots], "SANDBOX_ESCAPE");
    return { cwd };
  }
}

export class SandboxService {
  private readonly backends: Map<SandboxBackendId, SandboxBackend>;
  private readonly now: () => Date;

  constructor(options: { backends?: SandboxBackend[]; now?: () => Date } = {}) {
    this.backends = new Map((options.backends ?? [new LocalSandboxBackend()]).map((backend) => [backend.id, backend]));
    this.now = options.now ?? (() => new Date());
  }

  evaluate(policy: SandboxPolicy, request: SandboxRequest = {}): SandboxDecision {
    const backendId = policy.backend ?? "local";
    const backend = this.backends.get(backendId);
    if (!backend || !backend.available(policy)) {
      throw new SandboxError("SANDBOX_BACKEND_UNAVAILABLE", "backend_unavailable", `沙箱后端不可用：${backendId}`, 503);
    }
    const checks: SandboxCheck[] = [];
    const add = (name: string, ok: boolean, detail: string): void => {
      checks.push({ name, ok, detail });
      if (!ok) throw new SandboxError("SANDBOX_POLICY_DENIED", "policy_denied", detail);
    };
    const cwd = backend.prepare(policy, request).cwd;
    add(
      "cwd",
      within(policy.workspaceRoot, cwd) || withinAny([...policy.permissions.readRoots, ...policy.permissions.writeRoots], cwd),
      `cwd=${cwd}`
    );
    for (const path of request.readPaths ?? []) {
      const allowed = withinAny(policy.permissions.readRoots.length ? policy.permissions.readRoots : [policy.workspaceRoot], path);
      if (!allowed) throw new SandboxError("SANDBOX_ESCAPE", "sandbox_escape", `读取路径越界：${path}`);
      checks.push({ name: `read:${path}`, ok: true, detail: "读取路径已授权" });
    }
    for (const path of request.writePaths ?? []) {
      if (!withinAny(policy.permissions.writeRoots, path)) {
        throw new SandboxError("SANDBOX_ESCAPE", "sandbox_escape", `写入路径越界：${path}`);
      }
      checks.push({ name: `write:${path}`, ok: true, detail: "写入路径已授权" });
    }
    for (const host of request.networkHosts ?? []) {
      const allowed = policy.permissions.networkHosts.some((candidate) => hostWithin(candidate, host));
      if (!allowed) {
        throw new SandboxError("SANDBOX_NETWORK_DENIED", "network_violation", `网络域越界：${host}`);
      }
      checks.push({ name: `network:${host}`, ok: true, detail: "网络域已授权" });
    }
    if (request.process && !policy.allowedProcesses.includes(request.process)) {
      throw new SandboxError("SANDBOX_PROCESS_DENIED", "policy_denied", `进程不在白名单：${request.process}`);
    }
    for (const tool of request.tools ?? []) {
      if (!policy.permissions.tools.includes(tool)) {
        throw new SandboxError("SANDBOX_TOOL_DENIED", "policy_denied", `工具不在白名单：${tool}`);
      }
    }
    const expiresAt = request.credentialExpiresAt ?? policy.credentialExpiresAt;
    if (expiresAt && new Date(expiresAt).getTime() <= this.now().getTime()) {
      throw new SandboxError("SANDBOX_CREDENTIAL_EXPIRED", "credential_expired", "凭据已过期，需要重新授权");
    }
    checks.push({ name: "credential", ok: true, detail: expiresAt ? `有效至 ${expiresAt}` : "无凭据约束" });
    return {
      allowed: true,
      requiresApproval: request.externalEffect === true,
      backend: backend.id,
      cwd,
      checks
    };
  }
}

function ensureWithin(root: string, child: string, allowedRoots: string[], code: string): void {
  if (within(root, child) || withinAny(allowedRoots, child)) return;
  throw new SandboxError(code, "sandbox_escape", `路径逃逸沙箱：${child}`);
}

function within(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function withinAny(parents: string[], child: string): boolean {
  return parents.some((parent) => within(parent, child));
}

function hostWithin(parent: string, child: string): boolean {
  if (parent === child) return true;
  if (!parent.startsWith("*.")) return false;
  const base = parent.slice(2);
  return child.endsWith(`.${base}`);
}

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";

export const ACTION_RESOLVER_VERSION = "hearth-action-v1";

export const PERMISSION_MODES = ["read-only", "guarded", "workspace", "full"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const APPROVAL_CONTEXTS = ["interactive", "scheduled", "webhook", "remote", "delegated"] as const;
export type ApprovalContext = (typeof APPROVAL_CONTEXTS)[number];

export const ACTION_KINDS = ["shell", "file_write", "file_delete", "network", "email", "calendar", "desktop", "mcp"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_RISKS = ["low", "medium", "high", "critical"] as const;
export type ActionRisk = (typeof ACTION_RISKS)[number];

export const SIDE_EFFECT_CLASSES = [
  "none",
  "local_reversible",
  "local_irreversible",
  "external_reversible",
  "external_irreversible"
] as const;
export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number];

export interface ActionCommand {
  executable: string;
  argv?: string[] | undefined;
  cwd?: string | undefined;
  shell?: "powershell" | "cmd" | "sh" | undefined;
  env?: Record<string, string> | undefined;
}

export interface ActionFileTarget {
  path: string;
  mode: "create" | "replace" | "append" | "delete";
  expectedSha256?: string | undefined;
}

export interface ActionNetworkTarget {
  host: string;
  port?: number | undefined;
  method?: string | undefined;
}

export interface ActionProposal {
  kind: ActionKind;
  summary: string;
  command?: ActionCommand | undefined;
  files?: ActionFileTarget[] | undefined;
  network?: ActionNetworkTarget | undefined;
  targetRevision?: string | undefined;
  risk?: ActionRisk | undefined;
  sideEffectClass?: SideEffectClass | undefined;
}

export interface ResolvedCommand {
  executableRealPath: string;
  executableSha256: string;
  argv: string[];
  cwdRealPath: string;
  shell: "powershell" | "cmd" | "sh" | null;
  env: Record<string, string>;
}

export interface ResolvedFile {
  pathRealPath: string;
  exists: boolean;
  sha256: string | null;
  mode: ActionFileTarget["mode"];
}

export interface ResolvedAction {
  actionId: string;
  kind: ActionKind;
  summary: string;
  permissionMode: PermissionMode;
  context: ApprovalContext;
  sessionRoot: string;
  command: ResolvedCommand | null;
  files: ResolvedFile[];
  network: ActionNetworkTarget | null;
  targetRevision: string | null;
  risk: ActionRisk;
  sideEffectClass: SideEffectClass;
  preview: string;
  resolverVersion: string;
  actionDigest: string;
  createdAt: string;
  proposal: ActionProposal;
}

export interface ResolveActionInput {
  actionId?: string | undefined;
  proposal: ActionProposal;
  permissionMode?: PermissionMode | undefined;
  context?: ApprovalContext | undefined;
  sessionRoot: string;
  now?: Date | undefined;
}

export interface ActionPolicyInput {
  permissionMode?: PermissionMode | undefined;
  context?: ApprovalContext | undefined;
  preauthorized?: boolean | undefined;
}

export interface ActionPolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

export interface ActionVerification {
  ok: boolean;
  reason: string;
  expectedDigest: string;
  current: ResolvedAction | null;
}

export class ActionResolutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ActionResolutionError";
    this.code = code;
  }
}

export function resolveAction(input: ResolveActionInput): ResolvedAction {
  const permissionMode = input.permissionMode ?? "guarded";
  const context = input.context ?? "interactive";
  const sessionRoot = resolve(input.sessionRoot);
  const proposal = normalizeProposal(input.proposal);
  const command = proposal.command ? resolveCommand(proposal.command, sessionRoot, permissionMode) : null;
  const files = (proposal.files ?? []).map((file) => resolveFile(file, sessionRoot, permissionMode));
  const network = proposal.network ? normalizeNetwork(proposal.network) : null;
  if (!command && files.length === 0 && !network) {
    throw new ActionResolutionError("ACTION_TARGET_REQUIRED", "动作缺少可解析的命令、文件或网络目标");
  }
  const risk = proposal.risk ?? defaultRisk(proposal);
  const sideEffectClass = proposal.sideEffectClass ?? defaultSideEffectClass(proposal);
  const preview = buildPreview(proposal, command, files, network);
  const digestInput = {
    kind: proposal.kind,
    summary: proposal.summary,
    permissionMode,
    context,
    sessionRoot,
    command,
    files,
    network,
    targetRevision: proposal.targetRevision ?? null,
    risk,
    sideEffectClass,
    resolverVersion: ACTION_RESOLVER_VERSION
  };
  return {
    actionId: input.actionId ?? `ACT-${randomDigest(digestInput).slice(0, 20)}`,
    kind: proposal.kind,
    summary: proposal.summary,
    permissionMode,
    context,
    sessionRoot,
    command,
    files,
    network,
    targetRevision: proposal.targetRevision ?? null,
    risk,
    sideEffectClass,
    preview,
    resolverVersion: ACTION_RESOLVER_VERSION,
    actionDigest: randomDigest(digestInput),
    createdAt: (input.now ?? new Date()).toISOString(),
    proposal
  };
}

export function verifyResolvedAction(expected: ResolvedAction, now = new Date()): ActionVerification {
  let current: ResolvedAction;
  try {
    current = resolveAction({
      actionId: expected.actionId,
      proposal: expected.proposal,
      permissionMode: expected.permissionMode,
      context: expected.context,
      sessionRoot: expected.sessionRoot,
      now
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      expectedDigest: expected.actionDigest,
      current: null
    };
  }
  if (current.actionDigest !== expected.actionDigest) {
    return {
      ok: false,
      reason: "动作在审批后发生了变化，需要重新审批",
      expectedDigest: expected.actionDigest,
      current
    };
  }
  return { ok: true, reason: "动作未变化", expectedDigest: expected.actionDigest, current };
}

export function decideActionPolicy(action: ResolvedAction, input: ActionPolicyInput = {}): ActionPolicyDecision {
  const permissionMode = input.permissionMode ?? action.permissionMode;
  const context = input.context ?? action.context;
  const interactive = context === "interactive";
  if (permissionMode === "read-only") {
    return { allowed: false, requiresApproval: false, reason: "只读模式不允许执行写入或外部动作" };
  }
  if (action.files.some((file) => !isInsideRoot(action.sessionRoot, file.pathRealPath))) {
    return { allowed: false, requiresApproval: false, reason: "动作目标超出会话根目录" };
  }
  if (action.command && !isInsideRoot(action.sessionRoot, action.command.cwdRealPath)) {
    return { allowed: false, requiresApproval: false, reason: "命令工作目录超出会话根目录" };
  }
  const highRisk = action.risk === "high" || action.risk === "critical";
  const external = ["email", "calendar", "desktop", "network"].includes(action.kind);
  const shell = action.kind === "shell";
  if (permissionMode === "full") {
    if (highRisk && !interactive && !input.preauthorized) {
      return { allowed: false, requiresApproval: false, reason: "非交互上下文不能自动执行高风险动作" };
    }
    return { allowed: true, requiresApproval: false, reason: "完全访问模式允许此动作" };
  }
  if (permissionMode === "guarded") {
    if (shell || external || highRisk) {
      if (!interactive && !input.preauthorized) {
        return { allowed: false, requiresApproval: false, reason: "非交互上下文需要明确的预先授权" };
      }
      return { allowed: true, requiresApproval: true, reason: "高风险动作需要人工确认" };
    }
    return { allowed: true, requiresApproval: false, reason: "会话根目录内的可逆写入" };
  }
  if (highRisk || external) {
    if (!interactive && !input.preauthorized) {
      return { allowed: false, requiresApproval: false, reason: "非交互上下文不能自动执行高风险动作" };
    }
    return { allowed: true, requiresApproval: true, reason: "工作区模式需要确认高风险动作" };
  }
  return { allowed: true, requiresApproval: false, reason: "工作区模式允许低风险动作" };
}

export function actionDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function isInsideRoot(root: string, target: string): boolean {
  const base = resolve(root);
  const candidate = resolve(target);
  const rel = relative(normalizeCase(base), normalizeCase(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeProposal(input: ActionProposal): ActionProposal {
  if (!input || typeof input !== "object") throw new ActionResolutionError("INVALID_ACTION", "动作格式不正确");
  if (!ACTION_KINDS.includes(input.kind)) throw new ActionResolutionError("INVALID_ACTION_KIND", "未知动作类型");
  if (typeof input.summary !== "string" || !input.summary.trim()) throw new ActionResolutionError("ACTION_SUMMARY_REQUIRED", "动作需要摘要");
  return {
    ...input,
    summary: input.summary.trim(),
    command: input.command ? {
      ...input.command,
      argv: input.command.argv ? [...input.command.argv] : [],
      env: input.command.env ? Object.fromEntries(Object.entries(input.command.env).sort(([left], [right]) => left.localeCompare(right))) : {}
    } : undefined,
    files: input.files ? input.files.map((file) => ({ ...file })) : []
  };
}

function resolveCommand(command: ActionCommand, sessionRoot: string, permissionMode: PermissionMode): ResolvedCommand {
  if (!command.executable.trim()) throw new ActionResolutionError("EXECUTABLE_REQUIRED", "命令缺少可执行文件");
  const executable = resolveExecutable(command.executable);
  const cwd = command.cwd
    ? (isAbsolute(command.cwd) ? resolve(command.cwd) : resolve(sessionRoot, command.cwd))
    : sessionRoot;
  if (!existsSync(cwd)) throw new ActionResolutionError("CWD_NOT_FOUND", "命令工作目录不存在");
  if (permissionMode !== "full" && !isInsideRoot(sessionRoot, cwd)) {
    throw new ActionResolutionError("CWD_OUTSIDE_ROOT", "命令工作目录超出会话根目录");
  }
  return {
    executableRealPath: executable.path,
    executableSha256: executable.sha256,
    argv: (command.argv ?? []).map(String),
    cwdRealPath: realpathSync.native(cwd),
    shell: command.shell ?? null,
    env: command.env ?? {}
  };
}

function resolveExecutable(input: string): { path: string; sha256: string } {
  const candidates = isAbsolute(input) || input.includes("/") || input.includes("\\")
    ? [resolve(input)]
    : pathExecutables(input);
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new ActionResolutionError("EXECUTABLE_NOT_FOUND", `找不到可执行文件：${input}`);
  const realPath = realpathSync.native(found);
  return { path: realPath, sha256: fileSha256(realPath) };
}

function pathExecutables(name: string): string[] {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  const hasExtension = /\.[^\\/]+$/.test(name);
  const names = hasExtension ? [name] : extensions.map((extension) => `${name}${extension.toLowerCase()}`);
  return pathEntries.flatMap((entry) => names.map((candidate) => join(entry, candidate)));
}

function resolveFile(file: ActionFileTarget, sessionRoot: string, permissionMode: PermissionMode): ResolvedFile {
  if (!file || typeof file.path !== "string" || !file.path.trim()) {
    throw new ActionResolutionError("FILE_PATH_REQUIRED", "文件动作缺少路径");
  }
  if (!["create", "replace", "append", "delete"].includes(file.mode)) {
    throw new ActionResolutionError("INVALID_FILE_MODE", "文件动作模式不正确");
  }
  const path = isAbsolute(file.path) ? resolve(file.path) : resolve(sessionRoot, file.path);
  if (permissionMode !== "full" && !isInsideRoot(sessionRoot, path)) {
    throw new ActionResolutionError("PATH_OUTSIDE_ROOT", "文件动作超出会话根目录");
  }
  const exists = existsSync(path);
  if (!exists && file.mode !== "create") {
    throw new ActionResolutionError("FILE_NOT_FOUND", `文件不存在：${basename(path)}`);
  }
  if (exists && !statSync(path).isFile()) throw new ActionResolutionError("FILE_NOT_REGULAR", "目标不是普通文件");
  const realPath = exists ? realpathSync.native(path) : path;
  if (permissionMode !== "full" && exists && !isInsideRoot(sessionRoot, realPath)) {
    throw new ActionResolutionError("PATH_OUTSIDE_ROOT", "文件真实路径超出会话根目录");
  }
  const sha256 = exists ? fileSha256(realPath) : null;
  if (file.expectedSha256 && file.expectedSha256 !== sha256) {
    throw new ActionResolutionError("FILE_REVISION_CHANGED", "文件内容与审批时的版本不一致");
  }
  return { pathRealPath: realPath, exists, sha256, mode: file.mode };
}

function normalizeNetwork(input: ActionNetworkTarget): ActionNetworkTarget {
  const host = input.host.trim().toLowerCase();
  if (!host || host.includes("/") || host.includes("\\")) throw new ActionResolutionError("INVALID_HOST", "网络目标主机不正确");
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
    throw new ActionResolutionError("INVALID_PORT", "网络目标端口不正确");
  }
  return { host, ...(input.port === undefined ? {} : { port: input.port }), ...(input.method ? { method: input.method.toUpperCase() } : {}) };
}

function defaultRisk(proposal: ActionProposal): ActionRisk {
  if (proposal.kind === "file_write" || proposal.kind === "file_delete" || proposal.kind === "mcp") return "medium";
  if (proposal.kind === "network" || proposal.kind === "email" || proposal.kind === "calendar") return "high";
  if (proposal.kind === "desktop" || proposal.kind === "shell") return "high";
  return "high";
}

function defaultSideEffectClass(proposal: ActionProposal): SideEffectClass {
  if (proposal.kind === "file_write") return "local_reversible";
  if (proposal.kind === "file_delete") return "local_irreversible";
  if (proposal.kind === "email" || proposal.kind === "calendar") return "external_irreversible";
  if (proposal.kind === "network" || proposal.kind === "desktop" || proposal.kind === "shell") return "external_irreversible";
  return "none";
}

function buildPreview(proposal: ActionProposal, command: ResolvedCommand | null, files: ResolvedFile[], network: ActionNetworkTarget | null): string {
  if (command) {
    return `${command.executableRealPath} ${command.argv.join(" ")}`.trim();
  }
  if (files.length > 0) {
    return files.map((file) => `${file.mode} ${file.pathRealPath}`).join("\n");
  }
  if (network) return `${network.method ?? "CONNECT"} ${network.host}${network.port ? `:${network.port}` : ""}`;
  return proposal.summary;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function randomDigest(value: unknown): string {
  return actionDigest(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function normalizeCase(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

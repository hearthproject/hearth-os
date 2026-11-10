import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  SkillManifest,
  SkillPermissions,
  SkillRecord,
  TaskPermissions,
  TaskRecord
} from "@hearth/core";

export interface SkillPermissionRequest {
  readPaths?: string[];
  writePaths?: string[];
  networkHosts?: string[];
  tools?: string[];
}

export interface SkillPermissionDenial {
  category: "status" | "origin" | "hash" | "instructions" | "read" | "write" | "network" | "tool";
  value: string;
  reason: string;
}

export interface SkillPermissionDecision {
  allowed: boolean;
  effective: TaskPermissions;
  denied: SkillPermissionDenial[];
}

export interface SkillPermissionDiff {
  readRoots: { added: string[]; removed: string[] };
  writeRoots: { added: string[]; removed: string[] };
  networkHosts: { added: string[]; removed: string[] };
  tools: { added: string[]; removed: string[] };
}

export interface SkillSafetyFinding {
  code: string;
  excerpt: string;
}

export function effectiveSkillPermissions(skill: Pick<SkillRecord, "manifest">, task: TaskRecord): TaskPermissions {
  const declared = skill.manifest.permissions;
  const taskPermissions = task.permissions;
  return {
    readRoots: taskPermissions
      ? intersectRoots(declared.readRoots, taskPermissions.readRoots)
      : [...declared.readRoots],
    writeRoots: taskPermissions
      ? intersectRoots(declared.writeRoots, taskPermissions.writeRoots)
      : [...declared.writeRoots],
    networkHosts: intersection(
      declared.networkHosts,
      taskPermissions ? taskPermissions.networkHosts : task.networkHosts
    ),
    tools: taskPermissions ? intersection(skill.manifest.tools, taskPermissions.tools) : [...skill.manifest.tools]
  };
}

export function evaluateSkillExecution(input: {
  skill: SkillRecord;
  task: TaskRecord;
  request?: SkillPermissionRequest;
  allowImported?: boolean;
  contentVerified?: boolean;
  safetyFindings?: SkillSafetyFinding[];
}): SkillPermissionDecision {
  const denied: SkillPermissionDenial[] = [];
  const effective = effectiveSkillPermissions(input.skill, input.task);
  if (input.skill.status !== "adopted" && input.skill.status !== "trial") {
    denied.push({
      category: "status",
      value: input.skill.status,
      reason: "只有 adopted 或指定 trial 技能可以执行"
    });
  }
  if (input.skill.status === "trial" && !input.skill.trialTaskIds.includes(input.task.id)) {
    denied.push({
      category: "status",
      value: input.task.id,
      reason: "试跑技能只能用于明确指定的任务"
    });
  }
  if (input.skill.origin === "imported" && input.allowImported !== true) {
    denied.push({
      category: "origin",
      value: "imported",
      reason: "外部技能默认不能自动执行，需要用户显式授权"
    });
  }
  if (input.contentVerified === false) {
    denied.push({ category: "hash", value: input.skill.id, reason: "技能内容哈希与登记不一致" });
  }
  for (const finding of input.safetyFindings ?? []) {
    denied.push({
      category: "instructions",
      value: finding.code,
      reason: "技能正文包含试图覆盖安全规则的指令：" + finding.excerpt
    });
  }

  const request = input.request ?? {};
  for (const path of request.readPaths ?? []) {
    if (!pathAllowedByRoots(path, effective.readRoots)) {
      denied.push({ category: "read", value: path, reason: "读取路径超出技能声明或任务权限" });
    }
  }
  for (const path of request.writePaths ?? []) {
    if (!pathAllowedByRoots(path, effective.writeRoots)) {
      denied.push({ category: "write", value: path, reason: "写入路径超出技能声明或任务权限" });
    }
  }
  for (const host of request.networkHosts ?? []) {
    if (!effective.networkHosts.includes(normalizeHost(host))) {
      denied.push({ category: "network", value: host, reason: "网络主机不在技能声明或任务权限内" });
    }
  }
  for (const tool of request.tools ?? []) {
    if (!effective.tools.includes(tool)) {
      denied.push({ category: "tool", value: tool, reason: "工具不在技能声明或任务权限内" });
    }
  }
  return { allowed: denied.length === 0, effective, denied };
}

export function skillPermissionDiff(before: SkillManifest, after: SkillManifest): SkillPermissionDiff {
  return {
    readRoots: arrayDiff(before.permissions.readRoots, after.permissions.readRoots),
    writeRoots: arrayDiff(before.permissions.writeRoots, after.permissions.writeRoots),
    networkHosts: arrayDiff(before.permissions.networkHosts, after.permissions.networkHosts),
    tools: arrayDiff(before.tools, after.tools)
  };
}

export function formatPermissionDiff(diff: SkillPermissionDiff): string {
  const lines: string[] = [];
  for (const [label, value] of [
    ["读取根目录", diff.readRoots],
    ["写入根目录", diff.writeRoots],
    ["网络主机", diff.networkHosts],
    ["工具", diff.tools]
  ] as const) {
    if (value.added.length) lines.push(`${label}新增：${value.added.join("、")}`);
    if (value.removed.length) lines.push(`${label}移除：${value.removed.join("、")}`);
  }
  return lines.join("；") || "权限无变化";
}

export function auditSkillInstructions(body: string): SkillSafetyFinding[] {
  const findings: SkillSafetyFinding[] = [];
  const checks: Array<{ code: string; pattern: RegExp }> = [
    { code: "override-system", pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|忽略(?:之前|以上|所有)(?:的)?(?:系统)?指令/gi },
    { code: "bypass-approval", pattern: /bypass\s+(?:the\s+)?(?:approval|permission|safety)|绕过(?:审批|权限|安全)|跳过(?:所有)?审批/gi },
    { code: "disable-guardrails", pattern: /disable\s+(?:the\s+)?(?:safety|guardrails?|approval)|禁用(?:安全|防护|审批)规则/gi },
    { code: "expose-secrets", pattern: /reveal\s+(?:the\s+)?(?:system prompt|secrets?|credentials?)|泄露(?:系统提示词|秘密|凭据)/gi }
  ];
  for (const check of checks) {
    const match = check.pattern.exec(body);
    if (match) {
      findings.push({
        code: check.code,
        excerpt: body.slice(Math.max(0, match.index - 20), Math.min(body.length, match.index + match[0].length + 20)).replace(/\s+/g, " ")
      });
    }
  }
  return findings;
}

export function isPathWithin(path: string, root: string): boolean {
  const target = canonicalPath(path);
  const base = canonicalPath(root);
  const relation = relative(base, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export function pathAllowedByRoots(path: string, roots: string[]): boolean {
  return roots.some((root) => isPathWithin(path, root));
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "");
}

function canonicalPath(path: string): string {
  const absolute = resolve(expandHome(path));
  let current = absolute;
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  let canonical = current;
  try {
    canonical = realpathSync(current);
  } catch {
    canonical = current;
  }
  return resolve(canonical, ...suffix);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return path;
}

function intersectRoots(declared: string[], allowed: string[]): string[] {
  const result = new Set<string>();
  for (const skillRoot of declared) {
    for (const taskRoot of allowed) {
      if (isPathWithin(skillRoot, taskRoot)) result.add(skillRoot);
      else if (isPathWithin(taskRoot, skillRoot)) result.add(taskRoot);
    }
  }
  return [...result].sort();
}

function intersection(left: string[], right: string[]): string[] {
  const normalized = new Set(right.map((item) => item.trim().toLowerCase()));
  return [...new Set(left.map((item) => item.trim()).filter((item) => normalized.has(item.toLowerCase())))]
    .sort();
}

function arrayDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const oldValues = new Set(before);
  const newValues = new Set(after);
  return {
    added: [...newValues].filter((value) => !oldValues.has(value)).sort(),
    removed: [...oldValues].filter((value) => !newValues.has(value)).sort()
  };
}

export function assertSkillScriptPath(skillDir: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized.startsWith("scripts/") || normalized.includes("..")) {
    throw new Error("SKILL_SCRIPT_PATH_INVALID");
  }
  const target = resolve(skillDir, normalized);
  const base = resolve(skillDir);
  if (!isPathWithin(target, base) || !existsSync(target)) {
    throw new Error("SKILL_SCRIPT_NOT_FOUND");
  }
  if (lstatSync(target).isSymbolicLink()) {
    throw new Error("SKILL_SCRIPT_SYMLINK");
  }
  if (!lstatSync(target).isFile()) throw new Error("SKILL_SCRIPT_NOT_FILE");
  return target;
}

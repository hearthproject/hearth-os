// Policy as code: one declarative policy evaluated by the same engine for
// production authorization and for eval safety gates.
import type { TaskRecord } from "@hearth/core";
import { posix } from "node:path";
import { canonicalJson, digestOf } from "./contracts.ts";

export const EFFECT_LEVELS = ["read", "write", "external", "money", "destructive"] as const;
export type EffectLevel = (typeof EFFECT_LEVELS)[number];

export type PolicyDecisionKind = "allow" | "ask" | "deny";

export interface PolicyRule {
  id: string;
  description: string;
  priority: number;
  match: {
    tools?: string[];
    toolPatterns?: string[];
    pathPatterns?: string[];
    domains?: string[];
    domainPatterns?: string[];
    effects?: EffectLevel[];
  };
  decision: PolicyDecisionKind;
  reason: string;
  approval?: { minUses?: number; expiryMinutes?: number; requiredRole?: string };
  idempotency?: { key: "operationDigest" | "actionDigest" | "toolArgs"; ttlMinutes?: number };
}

export interface PolicySpec {
  schemaVersion: 1;
  id: string;
  version: string;
  mode: "enforce" | "shadow" | "disabled";
  defaults: { decision: PolicyDecisionKind };
  rules: PolicyRule[];
  approval: {
    mode: "ask" | "auto" | "full";
    teamMode: boolean;
    recoveryPolicy: "manual" | "auto";
    retryPolicy: "none" | "bounded";
  };
}

export interface PolicyAction {
  tool: string;
  args?: unknown;
  paths?: string[];
  domains?: string[];
  effect?: EffectLevel;
}

export interface PolicyEvaluation {
  decision: PolicyDecisionKind;
  effectiveDecision: PolicyDecisionKind;
  ruleId: string | null;
  rulePriority: number | null;
  reason: string;
  policyId: string;
  policyVersion: string;
  policyHash: string;
  approvalRequired: boolean;
  approval: PolicyRule["approval"] | null;
  idempotencyKey: string | null;
  shadow: boolean;
}

export interface PolicyPreflight {
  id: string;
  policyHash: string;
  taskId: string | null;
  actions: Array<{ action: PolicyAction; result: PolicyEvaluation }>;
  counts: { allow: number; ask: number; deny: number };
  blocked: string[];
  approvals: string[];
  digest: string;
  createdAt: string;
}

/**
 * The enforcement view the scheduler consumes. `evaluation` is the declarative
 * rule outcome; `allow`/`requireApproval` are what production will actually do.
 */
export interface PolicyEnforcement {
  evaluation: PolicyEvaluation;
  allow: boolean;
  requireApproval: boolean;
  enforcedBy: "rule" | "rule_deny" | "rule_ask" | "full_permission_allow" | "shadow" | "disabled";
  reason: string;
}

const DEFAULT_POLICY: PolicySpec = {
  schemaVersion: 1,
  id: "default",
  version: "1",
  mode: "enforce",
  defaults: { decision: "ask" },
  rules: [
    {
      id: "deny-destructive",
      description: "破坏性操作必须显式审批",
      priority: 100,
      match: { effects: ["destructive"] },
      decision: "ask",
      reason: "destructive_requires_approval"
    },
    {
      id: "deny-secret-paths",
      description: "密钥与凭据目录不可写入",
      priority: 95,
      match: { pathPatterns: ["**/.ssh/**", "**/.gnupg/**", "**/master.key", "**/*.pem"] },
      decision: "deny",
      reason: "secret_path_write_blocked"
    },
    {
      id: "allow-local-read",
      description: "读取本机与外部资料默认放行",
      priority: 90,
      match: { effects: ["read"] },
      decision: "allow",
      reason: "read_allowed"
    },
    {
      id: "allow-local-work",
      description: "工作区内的写入与普通命令默认放行",
      priority: 30,
      match: {
        tools: ["write_file", "edit_file", "apply_patch", "write_spreadsheet", "write_document", "delete_file", "shell", "run_command", "exec", "todo_write", "todo_read"],
        toolPatterns: ["browser_click", "browser_type", "browser_key", "browser_scroll", "browser_select", "browser_hover", "browser_wait", "browser_tabs", "desktop_*", "capture_screen"]
      },
      decision: "allow",
      reason: "local_work_allowed"
    }
  ],
  approval: { mode: "ask", teamMode: false, recoveryPolicy: "manual", retryPolicy: "none" }
};

export function defaultPolicy(): PolicySpec {
  return structuredClone(DEFAULT_POLICY);
}

export function policyHash(spec: PolicySpec): string {
  const payload = {
    schemaVersion: spec.schemaVersion,
    id: spec.id,
    version: spec.version,
    mode: spec.mode,
    defaults: spec.defaults,
    rules: [...spec.rules].sort((left, right) => left.id.localeCompare(right.id)),
    approval: spec.approval
  };
  return digestOf(payload);
}

export function validatePolicySpec(value: unknown): { ok: true; spec: PolicySpec } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return { ok: false, errors: ["policy 必须是对象"] };
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  if (typeof record.id !== "string" || !record.id) errors.push("id 必填");
  if (typeof record.version !== "string" || !record.version) errors.push("version 必填");
  if (!["enforce", "shadow", "disabled"].includes(String(record.mode))) errors.push("mode 无效");
  const defaults = record.defaults as Record<string, unknown> | undefined;
  if (!defaults || !["allow", "ask", "deny"].includes(String(defaults.decision))) errors.push("defaults.decision 无效");
  if (!Array.isArray(record.rules)) errors.push("rules 必须是数组");
  for (const [index, rule] of (Array.isArray(record.rules) ? record.rules : []).entries()) {
    if (!rule || typeof rule !== "object") { errors.push(`rules[${index}] 不是对象`); continue; }
    const item = rule as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id) errors.push(`rules[${index}].id 必填`);
    if (typeof item.priority !== "number") errors.push(`rules[${index}].priority 必须是数字`);
    if (!["allow", "ask", "deny"].includes(String(item.decision))) errors.push(`rules[${index}].decision 无效`);
    if (!item.match || typeof item.match !== "object") errors.push(`rules[${index}].match 必填`);
  }
  return errors.length === 0
    ? { ok: true, spec: record as unknown as PolicySpec }
    : { ok: false, errors };
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§DOUBLE§")
    .replace(/\*/g, "[^/]*")
    .replace(/§DOUBLE§/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function normalizePath(path: string): string {
  return posix.normalize(path.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "").replace(/^\/+/, ""));
}

export function matchesRule(rule: PolicyRule, action: PolicyAction): boolean {
  const match = rule.match;
  if (match.tools?.length && !match.tools.includes(action.tool)) return false;
  if (match.toolPatterns?.length) {
    const patterns = match.toolPatterns.map(wildcard);
    if (!patterns.some((pattern) => pattern.test(action.tool))) return false;
  }
  if (match.effects?.length) {
    if (!action.effect || !match.effects.includes(action.effect)) return false;
  }
  if (match.pathPatterns?.length) {
    if (!action.paths?.length) return false;
    const patterns = match.pathPatterns.map(wildcard);
    if (!action.paths.some((path) => patterns.some((pattern) => pattern.test(normalizePath(path))))) return false;
  }
  if (match.domains?.length || match.domainPatterns?.length) {
    if (!action.domains?.length) return false;
    const normalized = action.domains.map((domain) => domain.toLowerCase());
    const exact = match.domains?.map((domain) => domain.toLowerCase()) ?? [];
    const patterns = (match.domainPatterns ?? []).map(wildcard);
    const matched = normalized.some((domain) => exact.includes(domain) || patterns.some((pattern) => pattern.test(domain)));
    if (!matched) return false;
  }
  return true;
}

function specificity(rule: PolicyRule): number {
  const match = rule.match;
  return (match.tools?.length ?? 0) + (match.pathPatterns?.length ?? 0) + (match.domains?.length ?? 0) + (match.effects?.length ?? 0);
}

export function evaluatePolicy(spec: PolicySpec, action: PolicyAction): PolicyEvaluation {
  const hash = policyHash(spec);
  const rule = [...spec.rules]
    .filter((candidate) => matchesRule(candidate, action))
    .sort((left, right) => (right.priority - left.priority) || (specificity(right) - specificity(left)) || left.id.localeCompare(right.id))[0];
  const decision = rule?.decision ?? spec.defaults.decision;
  const idempotencyKey = rule?.idempotency
    ? digestOf({ key: rule.idempotency.key, tool: action.tool, args: action.args ?? null, paths: action.paths ?? [] })
    : null;
  const shadow = spec.mode === "shadow";
  return {
    decision,
    effectiveDecision: spec.mode === "disabled" ? "allow" : decision,
    ruleId: rule?.id ?? null,
    rulePriority: rule?.priority ?? null,
    reason: rule?.reason ?? "default_decision",
    policyId: spec.id,
    policyVersion: spec.version,
    policyHash: hash,
    approvalRequired: decision === "ask",
    approval: rule?.approval ?? null,
    idempotencyKey,
    shadow
  };
}

export function preflightPolicy(input: {
  spec: PolicySpec;
  taskId?: string | null;
  actions: PolicyAction[];
  now?: Date;
}): PolicyPreflight {
  const results = input.actions.map((action) => ({ action, result: evaluatePolicy(input.spec, action) }));
  const counts = { allow: 0, ask: 0, deny: 0 };
  for (const item of results) {
    if (item.result.effectiveDecision === "allow") counts.allow += 1;
    else if (item.result.effectiveDecision === "ask") counts.ask += 1;
    else counts.deny += 1;
  }
  const hash = policyHash(input.spec);
  const blocked = results
    .filter((item) => item.result.effectiveDecision === "deny")
    .map((item) => `${item.action.tool}${item.action.paths?.length ? `:${item.action.paths.join(",")}` : ""}`);
  const approvals = results
    .filter((item) => item.result.effectiveDecision === "ask")
    .map((item) => `${item.action.tool}${item.action.paths?.length ? `:${item.action.paths.join(",")}` : ""}`);
  const now = input.now ?? new Date();
  const body = { policyHash: hash, taskId: input.taskId ?? null, actions: results, counts };
  return {
    id: `preflight:${digestOf(body).slice("sha256:".length, 20)}`,
    policyHash: hash,
    taskId: input.taskId ?? null,
    actions: results,
    counts,
    blocked,
    approvals,
    digest: digestOf(body),
    createdAt: now.toISOString()
  };
}

/** Task permissions become policy, so every run has an auditable rule set. */
export function buildPolicyFromTask(task: TaskRecord, base: PolicySpec = defaultPolicy()): PolicySpec {
  const permissions = task.permissions ?? { readRoots: [], writeRoots: [], networkHosts: [], tools: [] };
  const rules: PolicyRule[] = [...base.rules];
  const writeRoots = permissions.writeRoots ?? [];
  if (writeRoots.length > 0) {
    rules.push({
      id: "write-inside-workspace",
      description: "工作区写入允许",
      priority: 60,
      match: { tools: ["write_file", "edit_file", "apply_patch", "delete_file"], pathPatterns: writeRoots.map((root) => `${normalizePath(root)}/**`) },
      decision: "allow",
      reason: "workspace_write"
    });
    rules.push({
      id: "write-outside-workspace",
      description: "工作区外写入需要审批",
      priority: 55,
      match: { tools: ["write_file", "edit_file", "apply_patch", "delete_file"] },
      decision: "ask",
      reason: "outside_workspace_write"
    });
  }
  if (permissions.networkMode === "open") {
    rules.push({
      id: "network-open",
      description: "开放网络出口",
      priority: 50,
      match: { effects: ["external"] },
      decision: "ask",
      reason: "network_egress"
    });
  } else if ((permissions.networkHosts ?? []).length > 0) {
    rules.push({
      id: "network-allowlisted",
      description: "清单内域名允许访问",
      priority: 85,
      match: { domains: permissions.networkHosts },
      decision: "allow",
      reason: "domain_allowlisted"
    });
    rules.push({
      id: "network-allowlist",
      description: "仅允许清单域名",
      priority: 80,
      match: { domainPatterns: ["*"] },
      decision: "deny",
      reason: "domain_not_allowlisted"
    });
  }
  return {
    ...base,
    id: `task:${task.id}`,
    version: `${base.version}.${permissions.approvalMode ?? "ask"}`,
    approval: {
      ...base.approval,
      mode: permissions.approvalMode === "full" ? "full" : permissions.approvalMode === "workspace" ? "auto" : "ask"
    },
    rules
  };
}

export function policyView(spec: PolicySpec): Record<string, unknown> {
  return {
    id: spec.id,
    version: spec.version,
    mode: spec.mode,
    hash: policyHash(spec),
    approval: spec.approval,
    defaults: spec.defaults,
    rules: spec.rules.map((rule) => ({
      id: rule.id,
      priority: rule.priority,
      decision: rule.decision,
      reason: rule.reason,
      match: rule.match
    })),
    canonical: canonicalJson(spec)
  };
}

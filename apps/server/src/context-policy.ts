import type {
  ContextSettings,
  EffectRecord,
  ExecutorId,
  FailureAction,
  FailureCause,
  RunRecord,
  TaskRecord
} from "@hearth/core";
import { isAbsolute, relative, resolve } from "node:path";
import { getTemplate } from "@hearth/templates";
import { HermesApprovalRequiredError, HermesStartupError } from "./hermes-executor.ts";
import { LeaseError } from "./leases.ts";
import { wantsScreenshot } from "./task-intent.ts";
import { UnsupportedInputError } from "./workspace.ts";
import type { HearthService } from "./service.ts";

export interface HandoffEvaluation {
  targetAvailable: boolean;
  eligible: boolean;
  highRisk: boolean;
  reason: string;
}

export interface FailureDecision {
  cause: FailureCause;
  action: FailureAction;
  targetExecutor: ExecutorId | null;
  autoAllowed: boolean;
  highRisk: boolean;
  reason: string;
}

export function classifyFailure(input: {
  service: HearthService;
  task: TaskRecord;
  run: RunRecord;
  error: unknown;
  aborted: boolean;
  stopping: boolean;
}): FailureCause {
  const { service, task, error, aborted, stopping } = input;
  const message = error instanceof Error ? error.message : String(error);
  const effects = service.store.listEffects(task.id);
  if (effects.some((effect) => effect.status === "uncertain" || effect.status === "executing")) return "effect_uncertain";
  if (error instanceof HermesApprovalRequiredError) return "permission";
  if (error instanceof HermesStartupError) return "runtime_fault";
  if (error instanceof LeaseError) return "interrupted";
  if (aborted && stopping) return "interrupted";
  if (/spawn\s+.*\bENOENT\b|process\s+(?:crashed|exited)|进程.*(?:崩溃|退出)|执行器.*不可用|executor.*unavailable/i.test(message)) return "runtime_fault";
  if (/完成判定失败|完成证据|验收标准|Completion Judge/i.test(message)) return "contract_failure";
  if (/权限|审批|approval|permission|unauthorized|401|403/i.test(message)) return "permission";
  if (/预算|budget|maxTurns|maxToolCalls|maxDuration/i.test(message)) return "budget";
  if (/期望产物|产物|交付|验收|缺少.*文件|deliverable|contract|expected output/i.test(message)) return "contract_failure";
  if (/缺少|missing input|input unavailable|不可用|not found|ENOENT/i.test(message)) return "input_missing";
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|timed out|429|rate limit|temporar|5\d\d/i.test(message)) return "transient";
  if (/context length|too many tokens|invalid tool|tool.*fail|工具.*失败|没有返回|未完成|修复|repair/i.test(message)) return "capability_gap";
  if (error instanceof UnsupportedInputError) return "input_missing";
  return "unknown";
}

export function evaluateHandoff(input: {
  service: HearthService;
  task: TaskRecord;
  targetExecutor: ExecutorId;
  targetAvailable: boolean;
  settings: ContextSettings;
  taskWorkspace?: string | null;
  targetEnabled?: boolean;
}): HandoffEvaluation {
  const { service, task, targetExecutor, targetAvailable, settings } = input;
  if (settings.mode === "off") return { targetAvailable, eligible: false, highRisk: false, reason: "上下文接管已关闭" };
  if (!targetAvailable) return { targetAvailable, eligible: false, highRisk: false, reason: "目标执行器当前不可用" };
  if (input.targetEnabled === false) return { targetAvailable: false, eligible: false, highRisk: false, reason: "当前对话已关闭目标执行器" };
  if (task.executorId === targetExecutor) return { targetAvailable, eligible: false, highRisk: false, reason: "目标执行器与当前执行器相同" };
  if (targetExecutor === "codex" && (task.permissions?.tools.includes("capture_screen") || wantsScreenshot(`${task.title}\n${task.goal}`))) {
    return { targetAvailable, eligible: false, highRisk: false, reason: "Codex 不支持桌面截图任务" };
  }
  const uncertainEffects = service.store.listEffects(task.id).filter((effect) => effect.status === "uncertain" || effect.status === "executing");
  const uncertainOutbox = service.store.listOutboxDrafts().filter((draft) => draft.taskId === task.id && draft.status === "uncertain");
  if (effectNeedsReconciliation(uncertainEffects) || uncertainOutbox.length > 0) {
    return { targetAvailable, eligible: false, highRisk: false, reason: "存在状态不确定的外部动作，必须先对账后才能接管" };
  }
  if (settings.mode === "shadow") {
    return { targetAvailable, eligible: true, highRisk: true, reason: "当前是 shadow 模式，只记录诊断，不自动接管" };
  }
  const template = task.templateId ? getTemplate(task.templateId) : undefined;
  const approvals = service.store.listApprovals(task.id).filter((approval) => approval.status === "pending");
  const effects = service.store.listEffects(task.id).filter((effect) => ["pending", "executing", "uncertain"].includes(effect.status));
  const outbox = service.store.listOutboxDrafts().filter((draft) => draft.taskId === task.id && ["pending_approval", "stored", "uncertain"].includes(draft.status));
  const riskyEffects = approvals.length > 0 || effects.length > 0 || outbox.length > 0;
  const riskyTemplate = Boolean(template && template.approvalKind !== "none");
  const networkBlocked = targetExecutor === "codex" && task.networkHosts.length > 0 && !settings.allowCodexNetwork;
  const writesOutsideWorkspace = Boolean(input.taskWorkspace && task.permissions?.writeRoots.some((root) => {
    if (!root.trim()) return false;
    const rel = relative(input.taskWorkspace as string, isAbsolute(root) ? root : resolve(input.taskWorkspace as string, root));
    return rel.startsWith("..") || isAbsolute(rel);
  }));
  if (riskyEffects) {
    return { targetAvailable, eligible: true, highRisk: true, reason: "任务存在待审批或状态不确定的外部动作，需要用户确认后才能接管" };
  }
  if (riskyTemplate) {
    return { targetAvailable, eligible: true, highRisk: true, reason: "任务包含外部发布或评论动作，需要用户确认后才能接管" };
  }
  if (networkBlocked) {
    return { targetAvailable, eligible: true, highRisk: true, reason: "Codex 网络访问未开启，接管会改变任务权限边界" };
  }
  if (writesOutsideWorkspace) {
    return { targetAvailable, eligible: true, highRisk: true, reason: "任务写权限超出任务工作区，需要用户确认后才能接管" };
  }
  if (settings.autoHandoffRisk === "none") {
    return { targetAvailable, eligible: true, highRisk: true, reason: "当前设置禁止自动接管" };
  }
  return { targetAvailable, eligible: true, highRisk: false, reason: "低风险任务，可以自动接管" };
}

export function decideFailure(input: {
  cause: FailureCause;
  settings: ContextSettings;
  evaluation: HandoffEvaluation;
  targetExecutor: ExecutorId;
  retriesUsed: number;
  handoffsUsed: number;
  attemptedExecutors: ExecutorId[];
}): FailureDecision {
  const { cause, settings, evaluation, targetExecutor, retriesUsed, handoffsUsed, attemptedExecutors } = input;
  const canRetry = retriesUsed < settings.maxSameExecutorRetries;
  const canHandoff = evaluation.eligible && handoffsUsed < settings.maxHandoffs && !attemptedExecutors.includes(targetExecutor);
  const base = {
    cause,
    targetExecutor: evaluation.eligible ? targetExecutor : null,
    autoAllowed: settings.mode === "on" && !evaluation.highRisk,
    highRisk: evaluation.highRisk
  };
  if (cause === "transient" && canRetry) {
    return { ...base, action: "retry_same", reason: "临时故障，先重试同一执行器" };
  }
  if (cause === "runtime_fault" || cause === "capability_gap" || cause === "contract_failure" || cause === "transient") {
    if (canHandoff) return { ...base, action: "handoff", reason: evaluation.reason };
    return { ...base, action: "ask_user", reason: evaluation.eligible ? "接管次数已用完，需要用户决定" : evaluation.reason };
  }
  if (cause === "permission" || cause === "input_missing" || cause === "budget" || cause === "effect_uncertain" || cause === "interrupted") {
    return { ...base, action: "ask_user", reason: evaluation.reason };
  }
  if (canHandoff) return { ...base, action: "handoff", reason: evaluation.reason };
  return { ...base, action: "fail", reason: evaluation.reason };
}

export function applyDiagnosisAdvice(decision: FailureDecision, diagnosis: { source: "rules" | "model"; confidence: number; summary: string; recommendedAction: FailureAction }): FailureDecision {
  if (diagnosis.source !== "model" || diagnosis.confidence < 0.75) return decision;
  if (diagnosis.recommendedAction === "ask_user" && decision.action !== "ask_user" && decision.action !== "fail") {
    return { ...decision, action: "ask_user", autoAllowed: false, reason: `模型诊断建议先询问用户：${diagnosis.summary}` };
  }
  if (diagnosis.recommendedAction === "fail" && diagnosis.confidence >= 0.9 && decision.action !== "fail") {
    return { ...decision, action: "fail", autoAllowed: false, reason: `模型诊断建议停止执行：${diagnosis.summary}` };
  }
  return decision;
}

export function effectNeedsReconciliation(effects: EffectRecord[]): boolean {
  return effects.some((effect) => effect.status === "uncertain" || effect.status === "executing");
}

export function isExecutorFailureCause(cause: FailureCause): boolean {
  return cause === "runtime_fault"
    || cause === "transient"
    || cause === "capability_gap"
    || cause === "contract_failure"
    || cause === "unknown";
}

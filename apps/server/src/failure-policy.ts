import type { FailureCause, FailureClass, FailureDisposition } from "@hearth/core";

export const MAX_RETRY_DELAY_MS = 300_000;

export interface FailureClassificationInput {
  message: string;
  code?: string | null;
  aborted?: boolean;
  stopping?: boolean;
  effectUncertain?: boolean;
  validatorFailed?: boolean;
  budgetExhausted?: boolean;
  rateLimitResetAt?: string | null;
}

export interface DispositionInput {
  failure: FailureClass;
  attempt: number;
  maxAttempts?: number;
  effectId?: string | null;
  reason?: string;
  repairTarget?: string;
  now?: Date;
}

export function classifyFailureClass(input: FailureClassificationInput): FailureClass {
  if (input.effectUncertain) return "effect_unknown";
  if (input.aborted && input.stopping) return "user_cancelled";
  if (input.budgetExhausted) return "budget_exhausted";
  if (input.validatorFailed) return "validation_failed";
  const message = input.message;
  const code = input.code ?? "";
  if (/取消|cancel|user.*stop|停止/i.test(message)) return "user_cancelled";
  if (/权限|审批|approval|permission|forbidden|denied|禁止动作/i.test(message)) return "policy_denied";
  if (/凭据|credential|api.?key|token.*expired|登录失效|EAUTH|401/i.test(message) || code === "EAUTH") return "auth";
  if (/429|rate limit|too many requests|限流/i.test(message)) return "rate_limit";
  if (/overload|capacity|quota|配额|过载|503/i.test(message)) return "capacity";
  if (/ETIMEDOUT|timed? ?out|timeout|超时/i.test(message)) return "timeout";
  if (/验证失败|validator|schema|期望产物|产物缺失|deliverable|expected output|contract/i.test(message)) return "validation_failed";
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EDNS|socket|network|网络|断连/i.test(message)) return "transport";
  if (/预算|budget|maxTurns|maxToolCalls|maxDuration|token.*limit/i.test(message)) return "budget_exhausted";
  if (/权限|unauthorized|403/i.test(message)) return "policy_denied";
  return "internal";
}

export function decideDisposition(input: DispositionInput): FailureDisposition {
  const maxAttempts = input.maxAttempts ?? 3;
  const reason = input.reason ?? input.failure;
  if (input.failure === "user_cancelled") {
    return { type: "stop", reason: "用户已经取消，后续自动动作必须停止" };
  }
  if (input.failure === "policy_denied") {
    return { type: "ask_user", question: "当前动作被权限策略拒绝，需要如何调整？", options: ["缩小动作范围", "由用户在场确认", "取消任务"] };
  }
  if (input.failure === "auth") {
    return { type: "ask_user", question: "连接凭据需要更新后才能继续。", options: ["重新登录", "更新凭据", "稍后处理"] };
  }
  if (input.failure === "validation_failed") {
    return { type: "repair", target: input.repairTarget ?? "deliverable", reason: "验收或产物校验失败，必须修复而不是盲目重跑" };
  }
  if (input.failure === "effect_unknown") {
    if (!input.effectId) return { type: "stop", reason: "外部动作结果未知，但缺少可对账的效果记录" };
    return { type: "reconcile", effectId: input.effectId };
  }
  if (input.failure === "budget_exhausted") {
    return { type: "handoff", note: "预算已经耗尽；请交接当前证据、未完成事项和下一步条件" };
  }
  if (input.failure === "internal") {
    return { type: "stop", reason: "未分类的内部错误，需要人工诊断" };
  }
  const attempt = Math.max(1, input.attempt);
  if (attempt >= maxAttempts) {
    return { type: "handoff", note: `连续 ${attempt} 次 ${input.failure} 失败，已达到重试上限` };
  }
  return {
    type: "retry",
    afterMs: retryDelayMs(attempt, input.failure),
    attempt: attempt + 1
  };
}

export function retryDelayMs(attempt: number, failure: FailureClass): number {
  const base = failure === "rate_limit" || failure === "capacity" ? 5_000 : 1_000;
  return Math.min(MAX_RETRY_DELAY_MS, base * 2 ** Math.max(0, attempt - 1));
}

export function canBlindRetry(failure: FailureClass): boolean {
  return failure === "timeout" || failure === "capacity" || failure === "rate_limit" || failure === "transport";
}

export function failureCauseForClass(failure: FailureClass): FailureCause {
  switch (failure) {
    case "user_cancelled":
    case "internal":
      return "unknown";
    case "policy_denied":
    case "auth":
      return "permission";
    case "validation_failed":
      return "contract_failure";
    case "effect_unknown":
      return "effect_uncertain";
    case "timeout":
    case "capacity":
    case "rate_limit":
    case "transport":
      return "transient";
    case "budget_exhausted":
      return "budget";
  }
}

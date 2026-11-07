import { randomUUID } from "node:crypto";
import type { ContextItem, FailureAction, FailureCause, FailureDiagnosis, RunRecord, TaskRecord } from "@hearth/core";
import { EXECUTOR_IDS, FAILURE_ACTIONS, FAILURE_CAUSES } from "@hearth/core";
import type { AgentMessage } from "./model-agent.ts";
import { streamAgentTurn } from "./model-agent.ts";
import { chatModelConfigured, type ModelSettings } from "./model-settings.ts";

export interface DiagnosisInput {
  settings: ModelSettings;
  task: TaskRecord;
  run: RunRecord;
  error: unknown;
  cause: FailureCause;
  items: ContextItem[];
  signal?: AbortSignal;
}

export async function diagnoseFailure(input: DiagnosisInput): Promise<FailureDiagnosis | null> {
  if (!chatModelConfigured(input.settings)) return null;
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const evidence = input.items
    .slice(-30)
    .map((item) => `- [${item.id}] ${item.kind}: ${clip(item.content.replace(/\s+/g, " ").trim(), 700)}`)
    .join("\n");
  const prompt = [
    "你是 Hearth 的失败诊断器。请根据任务、执行器、错误和最近上下文，判断失败原因，并给出下一步建议。",
    "只输出 JSON，不要输出 Markdown。JSON 字段：",
    "cause: runtime_fault|transient|capability_gap|contract_failure|permission|input_missing|budget|effect_uncertain|interrupted|unknown",
    "confidence: 0 到 1 的数字",
    "summary: 一句话中文诊断",
    "evidenceItemIds: 字符串数组，只能引用下面给出的上下文 item id",
    "recommendedAction: retry_same|handoff|ask_user|fail",
    `targetExecutor: ${EXECUTOR_IDS.join("|")}|null`,
    "doNotRepeat: 字符串数组，列出已经发生、不能重复的动作",
    "",
    `任务：${input.task.title}`,
    `目标：${clip(input.task.goal, 1200)}`,
    `当前执行器：${input.run.executorId ?? input.task.executorId ?? "native"}`,
    `规则初判：${input.cause}`,
    `错误：${clip(message, 2000)}`,
    "",
    "最近上下文：",
    evidence || "- 无"
  ].join("\n");
  const messages: AgentMessage[] = [{ role: "user", content: prompt }];
  try {
    const turn = await streamAgentTurn(input.settings, messages, [], () => undefined, {
      ...(input.signal ? { signal: input.signal } : {}),
      temperature: 0,
      maxTokens: 2_000,
      timeoutMs: 60_000
    });
    const parsed = parseJsonObject(turn.content);
    if (!parsed) return null;
    const cause = FAILURE_CAUSES.includes(parsed.cause as FailureCause) ? parsed.cause as FailureCause : input.cause;
    const recommendedAction = FAILURE_ACTIONS.includes(parsed.recommendedAction as FailureAction)
      ? parsed.recommendedAction as FailureAction
      : "ask_user";
    const targetExecutor = typeof parsed.targetExecutor === "string" && (EXECUTOR_IDS as readonly string[]).includes(parsed.targetExecutor)
      ? parsed.targetExecutor as (typeof EXECUTOR_IDS)[number]
      : null;
    const allowedIds = new Set(input.items.map((item) => item.id));
    const evidenceItemIds = Array.isArray(parsed.evidenceItemIds)
      ? parsed.evidenceItemIds.filter((id): id is string => typeof id === "string" && allowedIds.has(id))
      : [];
    const doNotRepeat = Array.isArray(parsed.doNotRepeat)
      ? parsed.doNotRepeat.filter((item): item is string => typeof item === "string").slice(0, 20)
      : [];
    return {
      id: randomUUID(),
      taskId: input.task.id,
      runId: input.run.id,
      cause,
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : message,
      evidenceItemIds,
      recommendedAction,
      targetExecutor,
      doNotRepeat,
      source: "model",
      createdAt: new Date().toISOString()
    };
  } catch {
    return null;
  }
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

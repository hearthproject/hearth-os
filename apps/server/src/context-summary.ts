import type { TaskContextState, TaskRecord } from "@hearth/core";
import type { ContextService } from "./context.ts";
import { parseJsonObject } from "./context-diagnosis.ts";
import type { AgentMessage } from "./model-agent.ts";
import { streamAgentTurn } from "./model-agent.ts";
import { chatModelConfigured, type ModelSettings } from "./model-settings.ts";

export interface ModelSummaryInput {
  context: ContextService;
  task: TaskRecord;
  state: TaskContextState;
  settings: ModelSettings;
  signal?: AbortSignal;
}

export async function maybeModelSummary(input: ModelSummaryInput): Promise<TaskContextState | null> {
  const contextSettings = input.context.settings();
  if (contextSettings.mode === "off" || !chatModelConfigured(input.settings)) return null;
  const items = input.context.listItems(input.task.id, { limit: 200 }).items.reverse();
  const totalTokens = items.reduce((sum, item) => sum + item.tokens, 0);
  if (totalTokens <= contextSettings.summarizeAfterTokens) return null;
  const evidence = items.slice(-60).map((item) => `- [${item.kind}] ${clip(item.content.replace(/\s+/g, " ").trim(), 600)}`).join("\n");
  const prompt = [
    "你是 Hearth 的上下文摘要器。请在保留事实、证据和未决问题的前提下，把任务执行上下文压缩为给下一个执行器看的结构化摘要。",
    "只输出 JSON，不要输出 Markdown。JSON 字段：",
    "summary: 中文摘要，说明目标、已完成、失败、关键证据和产物",
    "plan: 字符串数组，剩余步骤",
    "openQuestions: 字符串数组，仍需确认的问题",
    "不要编造未发生的事实，不要改变权限或验收标准。",
    "",
    `任务：${input.task.title}`,
    `目标：${clip(input.task.goal, 1200)}`,
    "",
    "已有确定性摘要：",
    clip(input.state.summary, 4000),
    "",
    "最近上下文：",
    evidence || "- 无"
  ].join("\n");
  const messages: AgentMessage[] = [{ role: "user", content: prompt }];
  try {
    const turn = await streamAgentTurn(input.settings, messages, [], () => undefined, {
      ...(input.signal ? { signal: input.signal } : {}),
      temperature: 0,
      maxTokens: 1_800,
      timeoutMs: 45_000
    });
    const parsed = parseJsonObject(turn.content);
    if (!parsed) return null;
    const summary = typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : null;
    if (!summary) return null;
    const plan = stringArray(parsed.plan).slice(0, 20);
    const openQuestions = stringArray(parsed.openQuestions).slice(0, 20);
    const state: TaskContextState = {
      ...input.state,
      summary: `${input.state.summary}\n\n模型补充摘要：\n${clip(summary, 6000)}`,
      plan: plan.length ? plan : input.state.plan,
      openQuestions: [...new Set([...input.state.openQuestions, ...openQuestions])].slice(0, 20),
      summarySeq: Math.max(input.state.summarySeq, items.at(-1)?.seq ?? 0),
      updatedAt: new Date().toISOString()
    };
    return input.context.saveState(state);
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

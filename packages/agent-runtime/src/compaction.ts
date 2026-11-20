import type { AgentMessage, CompactOptions, ContextUsageAnchor } from "./types.ts";

const DEFAULTS = {
  keepRecent: 30,
  maxChars: 120_000,
  maxToolChars: 8_000,
  reserveTokens: 16_000,
  recentTokens: 20_000,
  contextBufferTokens: 16_000
};

export interface CompactResult {
  messages: AgentMessage[];
  compacted: boolean;
  before: number;
  after: number;
  restoredContext?: string;
}

export interface TokenCompactResult extends CompactResult {
  beforeTokens: number;
  afterTokens: number;
  summary: string | null;
  summarized: boolean;
}

export function estimateMessageTokens(messages: AgentMessage[], charsPerToken = 4): number {
  return Math.ceil(messageChars(messages) / charsPerToken);
}

export function shouldCompactContext(
  messages: AgentMessage[],
  contextWindowTokens: number,
  reserveTokens = DEFAULTS.reserveTokens,
  usageAnchor?: ContextUsageAnchor,
  maxOutputTokens?: number
): boolean {
  const threshold = Math.max(1, contextWindowTokens - Math.max(reserveTokens, maxOutputTokens ?? 0) - DEFAULTS.contextBufferTokens);
  if (!usageAnchor) return estimateMessageTokens(messages) > threshold;
  const tail = messages.slice(Math.max(0, usageAnchor.messageCount));
  const estimated = usageAnchor.inputTokens + usageAnchor.outputTokens + estimateMessageTokens(tail, 3);
  return estimated > threshold;
}

export async function compactAgentMessagesWithSummary(
  messages: AgentMessage[],
  options: CompactOptions = {},
  summarize?: (messages: AgentMessage[], signal: AbortSignal) => Promise<string | null>
): Promise<TokenCompactResult> {
  const before = messages.length;
  const beforeTokens = estimateMessageTokens(messages);
  const trimmed = trimToolOutputs(messages, options.maxToolChars ?? DEFAULTS.maxToolChars, options.keepRecentToolOutputs ?? 3);
  const contextWindowTokens = options.contextWindowTokens ?? 128_000;
  const reserveTokens = options.reserveTokens ?? Math.max(DEFAULTS.reserveTokens, Math.floor(contextWindowTokens * 0.15));
  if (!options.contextWindowTokens || !shouldCompactContext(trimmed, contextWindowTokens, reserveTokens, options.usageAnchor, options.maxOutputTokens)) {
    return { messages: trimmed, compacted: false, before, after: trimmed.length, beforeTokens, afterTokens: estimateMessageTokens(trimmed), summary: null, summarized: false };
  }

  const system = trimmed.filter((message) => message.role === "system");
  const firstUser = trimmed.find((message) => message.role === "user");
  const recentStart = findRecentBoundary(trimmed, options.recentTokens ?? DEFAULTS.recentTokens);
  const recent = trimmed.slice(recentStart);
  const recentSet = new Set(recent);
  const omitted = trimmed.slice(1).filter((message) => !recentSet.has(message) && message !== firstUser);
  const anchor = firstUser && !recentSet.has(firstUser) ? [firstUser] : [];

  let summaryText: string | null = null;
  if (summarize && omitted.length > 0 && !options.signal?.aborted) {
    try {
      const summary = await summarize(cloneMessages(omitted), options.signal ?? new AbortController().signal);
      summaryText = summary?.trim() || null;
    } catch {
      summaryText = null;
    }
  }

  const summaryMessage: AgentMessage[] = [];
  if (options.stateSummary?.trim() || summaryText) {
    const parts = [
      "<compaction_summary>",
      "Earlier work is summarized below. Treat file paths, commands and test results as authoritative records of what already happened.",
      options.stateSummary?.trim() ? `## Progress ledger\n${options.stateSummary.trim()}` : "",
      summaryText ? `## Narrative summary\n${summaryText}` : ""
    ].filter(Boolean);
    parts.push("</compaction_summary>");
    summaryMessage.push({ role: "user", content: parts.join("\n\n") });
  }
  if (options.projectInstructions?.trim()) {
    summaryMessage.push({ role: "user", content: `<project_instructions>\n${options.projectInstructions.trim()}\n</project_instructions>` });
  }
  if (options.restoredContext?.trim()) {
    summaryMessage.push({ role: "user", content: options.restoredContext.trim() });
  }
  const result = [...system, ...anchor, ...summaryMessage, ...completeRecent(recent)];
  return {
    messages: result,
    compacted: true,
    before,
    after: result.length,
    beforeTokens,
    afterTokens: estimateMessageTokens(result),
    summary: summaryText,
    summarized: Boolean(summaryText),
    ...(options.restoredContext?.trim() ? { restoredContext: options.restoredContext.trim() } : {})
  };
}

export function compactAgentMessages(messages: AgentMessage[], options: CompactOptions = {}): CompactResult {
  const keepRecent = options.keepRecent ?? DEFAULTS.keepRecent;
  const maxChars = options.maxChars ?? DEFAULTS.maxChars;
  const maxToolChars = options.maxToolChars ?? DEFAULTS.maxToolChars;
  const before = messages.length;

  let result: AgentMessage[] = trimToolOutputs(messages, maxToolChars, options.keepRecentToolOutputs ?? 1);

  if (result.length <= keepRecent + 6 && messageChars(result) <= maxChars) {
    return { messages: result, compacted: false, before, after: result.length };
  }

  const system = result.filter((message) => message.role === "system");
  const firstUser = result.find((message) => message.role === "user");
  const recent = result.slice(-keepRecent);
  while (recent.length > 0 && recent[0]?.role === "tool") recent.shift();
  const anchor = firstUser && !recent.includes(firstUser) ? [firstUser] : [];
  const restored = options.restoredContext?.trim();
  result = [...system, ...anchor, ...(restored ? [{ role: "user" as const, content: restored }] : []), ...recent];

  return {
    messages: result,
    compacted: true,
    before,
    after: result.length,
    ...(restored ? { restoredContext: restored } : {})
  };
}

function trimToolOutputs(messages: AgentMessage[], maxToolChars: number, keepRecentToolOutputs: number): AgentMessage[] {
  let kept = 0;
  return messages.map((message) => message).reverse().map((message) => {
    if (message.role !== "tool") return message;
    const keep = kept < keepRecentToolOutputs;
    kept += 1;
    if (keep || message.content.length <= maxToolChars) return message;
    const head = Math.floor(maxToolChars * 0.6);
    const tail = Math.floor(maxToolChars * 0.35);
    const omitted = message.content.length - head - tail;
    return {
      ...message,
      content: `${message.content.slice(0, head)}\n\n[... ${omitted} chars omitted from older tool output; rerun the command or read the file again if needed ...]\n\n${message.content.slice(-tail)}`
    };
  }).reverse();
}

function findRecentBoundary(messages: AgentMessage[], recentTokens: number): number {
  let tokens = 0;
  let index = messages.length;
  while (index > 1) {
    const candidate = messages[index - 1];
    if (!candidate) break;
    tokens += estimateMessageTokens([candidate]);
    index -= 1;
    if (tokens >= recentTokens) break;
  }
  while (index < messages.length && messages[index]?.role === "tool") index += 1;
  return Math.max(1, index);
}

function completeRecent(messages: AgentMessage[]): AgentMessage[] {
  let start = 0;
  while (start < messages.length && messages[start]?.role === "tool") start += 1;
  return messages.slice(start);
}

function messageChars(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => {
    if (message.role === "assistant") {
      return sum + message.content.length + JSON.stringify(message.toolCalls).length;
    }
    return sum + message.content.length;
  }, 0);
}

function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => message.role === "assistant"
    ? { role: "assistant", content: message.content, toolCalls: message.toolCalls.map((call) => ({ ...call })) }
    : { ...message });
}

import type { AgentMessage, CompactOptions } from "./types.ts";

const DEFAULTS = {
  keepRecent: 30,
  maxChars: 120_000,
  maxToolChars: 8_000
};

export interface CompactResult {
  messages: AgentMessage[];
  compacted: boolean;
  before: number;
  after: number;
}

export function compactAgentMessages(messages: AgentMessage[], options: CompactOptions = {}): CompactResult {
  const keepRecent = options.keepRecent ?? DEFAULTS.keepRecent;
  const maxChars = options.maxChars ?? DEFAULTS.maxChars;
  const maxToolChars = options.maxToolChars ?? DEFAULTS.maxToolChars;
  const before = messages.length;

  let result: AgentMessage[] = messages.map((message) => {
    if (message.role === "tool" && message.content.length > maxToolChars) {
      return {
        ...message,
        content: `${message.content.slice(0, maxToolChars)}\n[工具输出较长，已截断]`
      };
    }
    return message;
  });

  if (result.length <= keepRecent + 6 && messageChars(result) <= maxChars) {
    return { messages: result, compacted: false, before, after: result.length };
  }

  const system = result.filter((message) => message.role === "system");
  const firstUser = result.find((message) => message.role === "user");
  const recent = result.slice(-keepRecent);
  while (recent.length > 0 && recent[0]?.role === "tool") recent.shift();
  const anchor = firstUser && !recent.includes(firstUser) ? [firstUser] : [];
  result = [...system, ...anchor, ...recent];

  return { messages: result, compacted: true, before, after: result.length };
}

function messageChars(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => {
    if (message.role === "assistant") {
      return sum + message.content.length + JSON.stringify(message.toolCalls).length;
    }
    return sum + message.content.length;
  }, 0);
}

import type { AgentCheckpoint, AgentMessage, AgentToolCall, JournalEvent } from "@hearth/agent-runtime";

export const BROWSER_REDACTED_TEXT = "[REDACTED]";

const BROWSER_TEXT_TOOLS = new Set(["browser_type", "browser_type_at"]);
const PROTOCOL_KEYS = new Set([
  "type",
  "seq",
  "at",
  "callId",
  "toolCallId",
  "name",
  "role",
  "effect",
  "startedAt"
]);

/** Redact the text payload when a browser text tool is recorded for audit. */
export function redactBrowserToolArguments(toolName: string, value: unknown): unknown {
  const args = record(value);
  if (!args) return value;

  if (BROWSER_TEXT_TOOLS.has(toolName)) {
    return typeof args.text === "string"
      ? { ...args, text: BROWSER_REDACTED_TEXT }
      : value;
  }

  if (toolName === "tool_call" && typeof args.name === "string") {
    const nested = redactBrowserToolArguments(args.name, args.arguments);
    return nested === args.arguments ? value : { ...args, arguments: nested };
  }

  return value;
}

/** Extract literal values a browser text tool typed so they can be scrubbed from results. */
export function browserToolSecrets(toolName: string, value: unknown): string[] {
  const args = record(value);
  if (!args) return [];
  if (BROWSER_TEXT_TOOLS.has(toolName)) {
    return typeof args.text === "string" && args.text.length > 0 ? [args.text] : [];
  }
  if (toolName === "tool_call" && typeof args.name === "string") {
    return browserToolSecrets(args.name, args.arguments);
  }
  return [];
}

export function redactKnownSecrets(text: string, secrets: Iterable<string>): string {
  let redacted = text;
  const unique = [...new Set(secrets)]
    .filter((secret) => secret.trim().length >= 6)
    .sort((left, right) => right.length - left.length);
  for (const secret of unique) redacted = redacted.split(secret).join(BROWSER_REDACTED_TEXT);
  return redacted;
}

/** Remove browser text values from every journal representation persisted by the host. */
export function sanitizeRuntimeJournalEvent(event: JournalEvent, additionalSecrets: Iterable<string> = []): JournalEvent {
  const secrets: string[] = [...additionalSecrets];
  collectBrowserSecrets(event, secrets);
  const sanitized = sanitizeArgumentRecords(event) as JournalEvent;
  return sanitizeJournalStrings(sanitized, secrets) as JournalEvent;
}

/** Persist resumed conversations without retaining values typed into web forms. */
export function sanitizeNativeCheckpoint(
  checkpoint: AgentCheckpoint,
  additionalSecrets: Iterable<string> = []
): AgentCheckpoint {
  const secrets: string[] = [...additionalSecrets];
  collectBrowserSecrets(checkpoint.messages, secrets);
  const messages = checkpoint.messages.map((message) => sanitizeMessage(message, secrets));
  return {
    ...checkpoint,
    messages,
    ...(checkpoint.summary === null ? {} : { summary: redactKnownSecrets(checkpoint.summary, secrets) })
  };
}

function collectBrowserSecrets(value: unknown, secrets: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectBrowserSecrets(item, secrets);
    return;
  }
  const args = record(value);
  if (!args) return;
  if (typeof args.name === "string") {
    if ("arguments" in args) secrets.push(...browserToolSecrets(args.name, args.arguments));
    if ("args" in args) secrets.push(...browserToolSecrets(args.name, args.args));
  }
  for (const item of Object.values(args)) collectBrowserSecrets(item, secrets);
}

function sanitizeArgumentRecords(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeArgumentRecords);
  const item = record(value);
  if (!item) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(item)) sanitized[key] = sanitizeArgumentRecords(child);
  if (typeof item.name === "string") {
    if ("arguments" in item) {
      sanitized.arguments = redactBrowserToolArguments(item.name, item.arguments);
    }
    if ("args" in item) {
      sanitized.args = redactBrowserToolArguments(item.name, item.args);
    }
  }
  return sanitized;
}

function sanitizeJournalStrings(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactKnownSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeJournalStrings(item, secrets));
  const item = record(value);
  if (!item) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(item)) {
    sanitized[key] = PROTOCOL_KEYS.has(key)
      ? child
      : sanitizeJournalStrings(child, secrets);
  }
  return sanitized;
}

function sanitizeMessage(message: AgentMessage, secrets: string[]): AgentMessage {
  if (message.role !== "assistant") {
    return { ...message, content: redactKnownSecrets(message.content, secrets) };
  }
  return {
    ...message,
    content: redactKnownSecrets(message.content, secrets),
    toolCalls: message.toolCalls.map((call) => sanitizeToolCall(call, secrets))
  };
}

function sanitizeToolCall(call: AgentToolCall, secrets: string[]): AgentToolCall {
  const args = redactBrowserToolArguments(call.name, call.arguments);
  return {
    ...call,
    arguments: args,
    rawArguments: args === call.arguments
      ? redactKnownSecrets(call.rawArguments, secrets)
      : JSON.stringify(args)
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

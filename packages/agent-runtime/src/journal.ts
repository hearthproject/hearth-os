import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, truncateSync, writeSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import type { AgentMessage, AgentRunStatus } from "./types.ts";
import type { AgentUsage } from "./types.ts";
import type { RunBudget, RunUsage } from "@hearth/core";

export type JournalEventType =
  | "run.start"
  | "turn.started"
  | "message"
  | "tool.call"
  | "tool.result"
  | "tool.orphaned"
  | "compaction"
  | "retry.scheduled"
  | "retry.started"
  | "stall.warned"
  | "stall.detected"
  | "goal.round"
  | "job.registered"
  | "job.settled"
  | "checkpoint"
  | "run.end";

export interface JournalEvent {
  seq: number;
  at: string;
  type: JournalEventType;
  [key: string]: unknown;
}

export interface JournalSink {
  append(event: JournalEvent): number;
  close?(): void;
}

export interface JournalOptions {
  path?: string;
  fsync?: boolean;
  rotateBytes?: number;
  /** Durable sink owned by the host. When set, no JSONL file is opened. */
  sink?: JournalSink;
  /** Last sequence already durable in the sink. */
  startSeq?: number;
}

export interface InFlightTool {
  callId: string;
  name: string;
  effect: string;
  startedAt: string;
}

export interface JournalReadResult {
  events: JournalEvent[];
  lastSeq: number;
  inFlight: InFlightTool | null;
  tornTail: boolean;
}

export class RunJournal {
  private readonly basePath: string;
  private readonly fsyncEnabled: boolean;
  private readonly rotateBytes: number;
  private readonly sink: JournalSink | null;
  private segment = 1;
  private fd: number | null = null;
  private size = 0;
  private lastSeq = 0;

  constructor(options: JournalOptions) {
    this.sink = options.sink ?? null;
    this.basePath = options.path ?? "<host-journal>";
    this.fsyncEnabled = options.fsync === true;
    this.rotateBytes = Math.max(1_000_000, options.rotateBytes ?? 32 * 1024 * 1024);
    if (this.sink) {
      this.lastSeq = Math.max(0, options.startSeq ?? 0);
      return;
    }
    mkdirSync(dirname(this.basePath), { recursive: true });
    this.repairTornTail();
    const existing = segmentFiles(this.basePath);
    this.segment = Math.max(1, ...existing.map((file) => segmentNumber(file, this.basePath)));
    this.lastSeq = readJournal(this.basePath).lastSeq;
    this.openSegment(true);
  }

  get path(): string {
    if (this.sink) return this.basePath;
    return this.segment === 1 ? this.basePath : segmentPath(this.basePath, this.segment);
  }

  append(event: Omit<JournalEvent, "seq" | "at"> & { at?: string }): number {
    const entry: JournalEvent = {
      seq: this.lastSeq + 1,
      at: event.at ?? new Date().toISOString(),
      ...event,
      type: event.type
    } as JournalEvent;
    if (this.sink) {
      const durableSeq = this.sink.append(entry);
      this.lastSeq = durableSeq > 0 ? durableSeq : entry.seq;
      return this.lastSeq;
    }
    this.lastSeq = entry.seq;
    const line = `${JSON.stringify(entry)}\n`;
    if (this.fd === null || this.size + line.length > this.rotateBytes) {
      this.rotate();
    }
    if (this.fd === null) throw new Error("journal is closed");
    writeSync(this.fd, line);
    this.size += line.length;
    if (this.fsyncEnabled) fsyncSync(this.fd);
    return this.lastSeq;
  }

  flush(): void {
    if (this.fd !== null && this.fsyncEnabled) fsyncSync(this.fd);
  }

  close(): void {
    if (this.sink) {
      this.sink.close?.();
      return;
    }
    if (this.fd !== null) {
      try {
        fsyncSync(this.fd);
      } catch {
        // best effort
      }
      closeSync(this.fd);
      this.fd = null;
    }
  }

  private rotate(): void {
    if (this.fd !== null) {
      try {
        fsyncSync(this.fd);
      } catch {
        // best effort
      }
      closeSync(this.fd);
    }
    this.segment += 1;
    this.openSegment(false);
  }

  private openSegment(initial: boolean): void {
    if (!initial && this.segment === 1) this.segment = 2;
    const target = this.path;
    if (!existsSync(target)) {
      const created = openSync(target, "a");
      closeSync(created);
    }
    this.fd = openSync(target, "a");
    this.size = existsSync(target) ? statSync(target).size : 0;
  }

  private repairTornTail(): void {
    const directory = dirname(this.basePath);
    if (!existsSync(directory)) return;
    const files = segmentFiles(this.basePath);
    for (const file of files) {
      try {
        const content = readFileSync(file, "utf8");
        if (content.length === 0 || content.endsWith("\n")) continue;
        const lastNewline = content.lastIndexOf("\n");
        truncateSync(file, lastNewline >= 0 ? lastNewline + 1 : 0);
      } catch {
        // A broken journal must not prevent a fresh run.
      }
    }
  }
}

export function readJournal(path: string): JournalReadResult {
  const files = segmentFiles(path);
  const events: JournalEvent[] = [];
  let tornTail = false;
  for (const file of files) {
    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as JournalEvent;
        if (typeof parsed.seq !== "number" || typeof parsed.type !== "string") continue;
        events.push(parsed);
      } catch {
        if (index === lines.length - 1 || index === lines.length - 2) tornTail = true;
      }
    }
  }
  const sorted = events.sort((left, right) => left.seq - right.seq);
  const lastSeq = sorted.at(-1)?.seq ?? 0;
  const inFlight = findInFlight(sorted);
  return { events: sorted, lastSeq, inFlight, tornTail };
}

export function inspectJournal(path: string): { lastSeq: number; inFlight: InFlightTool | null; tornTail: boolean } {
  const result = readJournal(path);
  return { lastSeq: result.lastSeq, inFlight: result.inFlight, tornTail: result.tornTail };
}

export function replayJournalMessages(
  base: AgentMessage[],
  path: string,
  afterSeq = 0
): { messages: AgentMessage[]; lastSeq: number; addedUsage: Partial<RunUsage>; inFlight: InFlightTool | null } {
  const result = readJournal(path);
  return replayJournalEvents(base, result.events, afterSeq, result.lastSeq);
}

export function replayJournalEvents(
  base: AgentMessage[],
  events: JournalEvent[],
  afterSeq = 0,
  lastSeq = events.at(-1)?.seq ?? 0
): { messages: AgentMessage[]; lastSeq: number; addedUsage: Partial<RunUsage>; inFlight: InFlightTool | null } {
  const messages = base.map((message) => ({ ...message })) as AgentMessage[];
  let addedUsage: Partial<RunUsage> = {};
  for (const event of events) {
    if (event.seq <= afterSeq) continue;
    if (event.type === "message" && isAgentMessage(event.message)) {
      const message = event.message;
      messages.push(message);
      if (event.usage && typeof event.usage === "object") addedUsage = mergeUsage(addedUsage, event.usage as AgentUsage);
    } else if (event.type === "tool.result" && isAgentMessage(event.message)) {
      messages.push(event.message);
    }
  }
  return {
    messages,
    lastSeq: Math.max(lastSeq, events.at(-1)?.seq ?? 0),
    addedUsage,
    inFlight: findInFlight(events.filter((event) => event.seq > afterSeq))
  };
}

export function journalPathFor(root: string, runId: string): string {
  return join(root, ".hearth", "journals", runId, "events.jsonl");
}

export interface RunStartJournalEvent {
  type: "run.start";
  runId: string;
  goal: string;
  systemPromptHash: string;
  budget: RunBudget;
}

export interface RunEndJournalEvent {
  type: "run.end";
  status: AgentRunStatus;
  summary: string;
  usage: RunUsage;
  turns: number;
  toolCalls: number;
}

function findInFlight(events: JournalEvent[]): InFlightTool | null {
  const completed = new Set<string>();
  for (const event of events) {
    if (event.type === "tool.result" || event.type === "tool.orphaned") {
      const callId = typeof event.callId === "string" ? event.callId : null;
      if (callId) completed.add(callId);
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "tool.call") continue;
    const callId = typeof event.callId === "string" ? event.callId : "";
    if (!callId || completed.has(callId)) continue;
    return {
      callId,
      name: typeof event.name === "string" ? event.name : "unknown",
      effect: typeof event.effect === "string" ? event.effect : "unknown",
      startedAt: typeof event.startedAt === "string" ? event.startedAt : String(event.at ?? "")
    };
  }
  return null;
}

function segmentFiles(basePath: string): string[] {
  const directory = dirname(basePath);
  if (!existsSync(directory)) return [];
  const prefix = basename(basePath).replace(/\.jsonl$/, "");
  return readdirSync(directory)
    .filter((name) => name === `${prefix}.jsonl` || (name.startsWith(`${prefix}-`) && name.endsWith(".jsonl")))
    .map((name) => join(directory, name))
    .sort((left, right) => segmentNumber(left, basePath) - segmentNumber(right, basePath));
}

function segmentPath(basePath: string, segment: number): string {
  if (segment <= 1) return basePath;
  return basePath.replace(/\.jsonl$/, `-${String(segment).padStart(3, "0")}.jsonl`);
}

function segmentNumber(file: string, basePath: string): number {
  const name = basename(file);
  const prefix = basename(basePath).replace(/\.jsonl$/, "");
  if (name === `${prefix}.jsonl`) return 1;
  const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.jsonl$`).exec(name);
  return match ? Number(match[1]) : 1;
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (record.role === "system" || record.role === "user" || record.role === "assistant" || record.role === "tool")
    && typeof record.content === "string";
}

function mergeUsage(target: Partial<RunUsage>, value: AgentUsage): Partial<RunUsage> {
  return {
    inputTokens: (target.inputTokens ?? 0) + (value.inputTokens ?? 0),
    cachedInputTokens: (target.cachedInputTokens ?? 0) + (value.cachedInputTokens ?? 0),
    cacheWriteInputTokens: (target.cacheWriteInputTokens ?? 0) + (value.cacheWriteInputTokens ?? 0),
    outputTokens: (target.outputTokens ?? 0) + (value.outputTokens ?? 0),
    reasoningOutputTokens: (target.reasoningOutputTokens ?? 0) + (value.reasoningOutputTokens ?? 0)
  };
}

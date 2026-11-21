import type { AgentCheckpoint, JournalEvent, JournalSink } from "@hearth/agent-runtime";
import type { EventEnvelope } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";

const RUNTIME_EVENT_TYPES: Record<string, string> = {
  "run.start": "runtime.run.started",
  "run.end": "runtime.run.ended",
  "turn.started": "runtime.turn.started",
  message: "runtime.message",
  "tool.call": "runtime.tool.dispatched",
  "tool.result": "runtime.tool.settled",
  "tool.orphaned": "runtime.tool.orphaned",
  compaction: "runtime.compacted",
  checkpoint: "runtime.checkpoint",
  "goal.round": "runtime.goal.round",
  "job.registered": "runtime.job.registered",
  "job.settled": "runtime.job.settled",
  "retry.scheduled": "runtime.retry.scheduled",
  "retry.started": "runtime.retry.started",
  "stall.warned": "runtime.stall.warned",
  "stall.detected": "runtime.stall.detected"
};

export const RUNTIME_CHECKPOINT_EVENT = "runtime.checkpoint.snapshot";

/**
 * Host-owned journal sink. Every runtime fact is appended to the SQLite event
 * log; the JSONL journal is only used by standalone/eval runs.
 */
export class SqliteRuntimeJournal implements JournalSink {
  constructor(
    private readonly store: HearthStore,
    private readonly taskId: string,
    private readonly runId: string
  ) {}

  append(event: JournalEvent): number {
    const envelope = this.store.appendEvent({
      type: RUNTIME_EVENT_TYPES[event.type] ?? "runtime.event",
      taskId: this.taskId,
      runId: this.runId,
      payload: event
    });
    return envelope.seq;
  }

  close(): void {
    // The event store owns durability.
  }
}

export function runtimeJournalEvents(
  store: HearthStore,
  runId: string,
  afterSeq = 0
): JournalEvent[] {
  return store.listEventsForRun(runId, afterSeq)
    .filter((event) => event.type.startsWith("runtime.") && event.type !== RUNTIME_CHECKPOINT_EVENT)
    .flatMap((event) => journalEventFromEnvelope(event));
}

export function journalEventFromEnvelope(event: EventEnvelope): JournalEvent[] {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (typeof record.type !== "string") return [];
  return [{
    ...record,
    seq: event.seq,
    at: typeof record.at === "string" ? record.at : event.createdAt,
    type: record.type
  } as JournalEvent];
}

export function checkpointSnapshotFromEvent(event: EventEnvelope | null): AgentCheckpoint | null {
  if (!event || event.type !== RUNTIME_CHECKPOINT_EVENT) return null;
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return null;
  const checkpoint = (payload as { checkpoint?: unknown }).checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") return null;
  const record = checkpoint as Partial<AgentCheckpoint>;
  if (typeof record.seq !== "number" || typeof record.kind !== "string") return null;
  if (!Array.isArray(record.messages) || !record.usage) return null;
  return record as AgentCheckpoint;
}

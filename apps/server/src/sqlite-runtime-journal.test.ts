import { describe, expect, it } from "vitest";
import { RunJournal, replayJournalEvents, type AgentCheckpoint } from "@hearth/agent-runtime";
import { HearthStore } from "@hearth/eventlog";
import { checkpointSnapshotFromEvent, RUNTIME_CHECKPOINT_EVENT, runtimeJournalEvents, SqliteRuntimeJournal } from "./sqlite-runtime-journal.ts";

describe("SQLite runtime journal", () => {
  it("stores runtime facts as events and replays them after a checkpoint sequence", () => {
    const store = new HearthStore(":memory:");
    const sink = new SqliteRuntimeJournal(store, "task-1", "run-1");
    const journal = new RunJournal({ sink });
    journal.append({ type: "run.start", runId: "run-1", goal: "g", systemPromptHash: "h", budget: {} });
    journal.append({
      type: "message",
      message: { role: "assistant", content: "checkpoint message", toolCalls: [] },
      usage: { outputTokens: 3 }
    });
    const checkpointSeq = journal.append({ type: "checkpoint", checkpointSeq: 1, checkpointKind: "turn" });
    journal.append({
      type: "tool.call", turn: 2, callId: "call-1", name: "write_file", effect: "local_write", startedAt: "2026-11-21T10:00:00.000Z"
    });
    journal.append({
      type: "tool.result",
      turn: 2,
      callId: "call-1",
      name: "write_file",
      message: { role: "tool", toolCallId: "call-1", name: "write_file", content: "written" }
    });
    journal.close();

    const events = runtimeJournalEvents(store, "run-1");
    expect(events.map((event) => event.type)).toEqual([
      "run.start", "message", "checkpoint", "tool.call", "tool.result"
    ]);
    const replay = replayJournalEvents(
      [{ role: "system", content: "s" }, { role: "user", content: "g" }],
      events,
      checkpointSeq
    );
    expect(replay.messages.at(-1)).toMatchObject({ role: "tool", content: "written" });
    expect(events.some((event) => event.type === "tool.call")).toBe(true);
    store.close();
  });

  it("returns null for a checkpoint event whose payload is not a checkpoint", () => {
    const store = new HearthStore(":memory:");
    const event = store.appendEvent({
      type: RUNTIME_CHECKPOINT_EVENT,
      runId: "run-1",
      payload: { checkpoint: { seq: "not-a-number" } }
    });
    expect(checkpointSnapshotFromEvent(store.getEventBySeq(event.seq))).toBeNull();
    store.close();
  });

  it("reads a durable checkpoint snapshot after the file is gone", () => {
    const store = new HearthStore(":memory:");
    const checkpoint: AgentCheckpoint = {
      seq: 3,
      kind: "turn",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "g" },
        { role: "assistant", content: "kept", toolCalls: [] }
      ],
      usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      turns: 1,
      toolCalls: 0,
      summary: null
    };
    const event = store.appendEvent({
      type: RUNTIME_CHECKPOINT_EVENT,
      taskId: "task-1",
      runId: "run-1",
      payload: { checkpoint }
    });
    expect(checkpointSnapshotFromEvent(store.getEventBySeq(event.seq))).toMatchObject({
      seq: 3,
      messages: checkpoint.messages,
      usage: checkpoint.usage
    });
    store.close();
  });
});

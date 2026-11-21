import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunJournal, journalPathFor, readJournal, replayJournalEvents, replayJournalMessages, type JournalEvent } from "./journal.ts";

const roots: string[] = [];

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "hearth-journal-"));
  roots.push(directory);
  return directory;
}

describe("run journal", () => {
  it("appends monotonic events and replays messages after a checkpoint sequence", () => {
    const directory = root();
    const path = journalPathFor(directory, "run-1");
    const journal = new RunJournal({ path, fsync: false });
    expect(journal.append({ type: "run.start", runId: "run-1", goal: "goal", systemPromptHash: "hash", budget: {} })).toBe(1);
    expect(journal.append({ type: "message", message: { role: "assistant", content: "one", toolCalls: [] }, usage: { outputTokens: 3 } })).toBe(2);
    journal.append({ type: "checkpoint", checkpointSeq: 1, checkpointKind: "turn", journalSeq: 2 });
    journal.append({ type: "message", message: { role: "assistant", content: "two", toolCalls: [] }, usage: { outputTokens: 4 } });
    journal.close();

    const replayed = replayJournalMessages(
      [{ role: "system", content: "system" }, { role: "user", content: "goal" }],
      path,
      2
    );
    expect(replayed.messages.at(-1)).toMatchObject({ role: "assistant", content: "two" });
    expect(replayed.addedUsage.outputTokens).toBe(4);
    expect(readJournal(path).lastSeq).toBe(4);
  });

  it("repairs a torn trailing line and resumes the sequence", () => {
    const directory = root();
    const path = journalPathFor(directory, "run-2");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ seq: 1, at: "2026-01-01T00:00:00.000Z", type: "run.start", runId: "run-2", goal: "g", systemPromptHash: "h", budget: {} })}\n{"seq":2`, "utf8");
    const journal = new RunJournal({ path, fsync: false });
    expect(journal.append({ type: "message", message: { role: "assistant", content: "ok", toolCalls: [] } })).toBe(2);
    journal.close();
    expect(readJournal(path).tornTail).toBe(false);
    expect(readJournal(path).events).toHaveLength(2);
  });

  it("reports an unfinished tool call for reconciliation", () => {
    const directory = root();
    const path = journalPathFor(directory, "run-3");
    const journal = new RunJournal({ path, fsync: false });
    journal.append({ type: "tool.call", turn: 1, callId: "call-1", name: "write_file", effect: "local_write", startedAt: new Date().toISOString() });
    journal.close();
    expect(readJournal(path).inFlight).toMatchObject({ callId: "call-1", name: "write_file", effect: "local_write" });
    const replay = replayJournalMessages([{ role: "system", content: "s" }, { role: "user", content: "g" }], path, 0);
    expect(replay.inFlight?.callId).toBe("call-1");
    expect(replay.messages).toHaveLength(2);
  });

  it("delegates durability to a host sink and resumes from returned sequences", () => {
    const events: JournalEvent[] = [];
    let durableSeq = 100;
    const journal = new RunJournal({
      startSeq: 100,
      sink: {
        append(event) {
          durableSeq += 1;
          events.push({ ...event, seq: durableSeq });
          return durableSeq;
        }
      }
    });
    expect(journal.append({ type: "run.start", runId: "run-4", goal: "g", systemPromptHash: "h", budget: {} })).toBe(101);
    expect(journal.append({
      type: "message",
      message: { role: "assistant", content: "host message", toolCalls: [] },
      usage: { outputTokens: 5 }
    })).toBe(102);
    journal.close();

    const replay = replayJournalEvents(
      [{ role: "system", content: "s" }, { role: "user", content: "g" }],
      events,
      101
    );
    expect(replay.messages.at(-1)).toMatchObject({ role: "assistant", content: "host message" });
    expect(replay.addedUsage.outputTokens).toBe(5);
  });
});

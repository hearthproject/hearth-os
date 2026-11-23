import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord, TaskRecord } from "@hearth/core";
import type { HearthStore, RunOperationRecord } from "@hearth/eventlog";
import { inheritPreviousOutput } from "./scheduler.ts";
import { planStoragePrune } from "./storage-prune.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-storage-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("retry output inheritance", () => {
  it("copies published files but not journal, cache or checkpoint bookkeeping", () => {
    const root = tempRoot();
    const previous = join(root, "out", "run-1");
    const next = join(root, "out", "run-2");
    mkdirSync(join(previous, ".hearth", "journals"), { recursive: true });
    mkdirSync(join(previous, ".hearth", "cache"), { recursive: true });
    mkdirSync(join(previous, ".hearth", "checkpoints"), { recursive: true });
    mkdirSync(join(previous, ".hearth", "tool-results"), { recursive: true });
    writeFileSync(join(previous, "result.md"), "# published\n", "utf8");
    writeFileSync(join(previous, ".hearth", "journals", "run.jsonl"), "{}\n", "utf8");
    writeFileSync(join(previous, ".hearth", "cache", "blob.bin"), "cache", "utf8");
    writeFileSync(join(previous, ".hearth", "checkpoints", "1.json"), "{}", "utf8");
    const referenced = "0123456789abcdef.txt";
    const unreferenced = "fedcba9876543210.txt";
    writeFileSync(join(previous, ".hearth", "tool-results", referenced), "kept", "utf8");
    writeFileSync(join(previous, ".hearth", "tool-results", unreferenced), "dropped", "utf8");

    inheritPreviousOutput(previous, next, {
      messages: [{ role: "tool", content: `full output: ${join(previous, ".hearth", "tool-results", referenced)}` }]
    });

    expect(existsSync(join(next, "result.md"))).toBe(true);
    expect(existsSync(join(next, ".hearth", "journals"))).toBe(false);
    expect(existsSync(join(next, ".hearth", "cache"))).toBe(false);
    expect(existsSync(join(next, ".hearth", "checkpoints"))).toBe(false);
    expect(existsSync(join(next, ".hearth", "tool-results", referenced))).toBe(true);
    expect(existsSync(join(next, ".hearth", "tool-results", unreferenced))).toBe(false);
  });
});

describe("storage prune planning", () => {
  it("reclaims old terminal runs but keeps the latest run and pending operations", () => {
    const root = tempRoot();
    const taskRoot = join(root, "tasks", "task-1");
    const oldOut = join(taskRoot, "out", "run-1");
    const latestOut = join(taskRoot, "out", "run-2");
    mkdirSync(oldOut, { recursive: true });
    mkdirSync(latestOut, { recursive: true });
    writeFileSync(join(oldOut, "result.md"), "old", "utf8");
    writeFileSync(join(latestOut, "result.md"), "latest", "utf8");
    const runs = [
      runRecord("task-1", "run-1", 1, "failed", taskRoot),
      runRecord("task-1", "run-2", 2, "completed", taskRoot)
    ];
    const task = taskRecord("task-1", "completed");
    const store = stubStore([task], runs, [], null);
    const plan = planStoragePrune({ store, workspaceRoot: root, olderThanDays: 7, now: new Date("2026-11-23T00:00:00.000Z") });
    expect(plan.candidates.map((candidate) => candidate.runId)).toEqual(["run-1"]);
    expect(plan.totalBytes).toBeGreaterThan(0);

    const blocked = stubStore([task], runs, [{ runId: "run-1", phase: "settled", cleanupState: "pending" } as RunOperationRecord], null);
    const blockedPlan = planStoragePrune({ store: blocked, workspaceRoot: root, olderThanDays: 7, now: new Date("2026-11-23T00:00:00.000Z") });
    expect(blockedPlan.candidates).toHaveLength(0);
    expect(blockedPlan.pinned.some((entry) => entry.runId === "run-1")).toBe(true);
  });

  it("pins any run whose checkpoint still references its tool output", () => {
    const root = tempRoot();
    const taskRoot = join(root, "tasks", "task-1");
    const oldOut = join(taskRoot, "out", "run-1");
    const latestOut = join(taskRoot, "out", "run-2");
    mkdirSync(join(oldOut, ".hearth", "tool-results"), { recursive: true });
    mkdirSync(latestOut, { recursive: true });
    const output = join(oldOut, ".hearth", "tool-results", "0123456789abcdef.txt");
    writeFileSync(output, "evidence", "utf8");
    const checkpointPath = join(root, "checkpoints", "run-1.json");
    mkdirSync(join(root, "checkpoints"), { recursive: true });
    writeFileSync(checkpointPath, JSON.stringify({ messages: [{ content: `full output: ${output}` }] }), "utf8");
    const runs = [
      runRecord("task-1", "run-1", 1, "failed", taskRoot),
      runRecord("task-1", "run-2", 2, "completed", taskRoot)
    ];
    const store = stubStore([taskRecord("task-1", "completed")], runs, [], {
      id: "cp-1", path: checkpointPath, sha256: "a".repeat(64)
    });
    const plan = planStoragePrune({ store, workspaceRoot: root, olderThanDays: 7, now: new Date("2026-11-23T00:00:00.000Z") });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.pinned.some((entry) => entry.reason.includes("检查点"))).toBe(true);
  });
  it("prunes unreferenced tool outputs inside the surviving latest run", () => {
    const root = tempRoot();
    const taskRoot = join(root, "tasks", "task-1");
    const out = join(taskRoot, "out", "run-1");
    mkdirSync(join(out, ".hearth", "tool-results"), { recursive: true });
    const stale = join(out, ".hearth", "tool-results", "aaaaaaaaaaaaaaaa.txt");
    writeFileSync(stale, "unreferenced", "utf8");
    utimesSync(stale, new Date("2025-01-01T00:00:00.000Z"), new Date("2025-01-01T00:00:00.000Z"));
    const checkpointPath = join(taskRoot, "checkpoint.json");
    writeFileSync(checkpointPath, JSON.stringify({ messages: [] }), "utf8");
    const store = stubStore(
      [taskRecord("task-1", "completed")],
      [runRecord("task-1", "run-1", 1, "completed", taskRoot)],
      [],
      { id: "cp-1", path: checkpointPath, sha256: "a".repeat(64) }
    );
    const plan = planStoragePrune({ store, workspaceRoot: root, olderThanDays: 7, now: new Date("2026-11-23T00:00:00.000Z") });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.files.map((file) => file.path)).toEqual([stale]);
  });
});

function runRecord(taskId: string, id: string, attempt: number, status: RunRecord["status"], workspace: string): RunRecord {
  return {
    id, taskId, attempt, status, threadId: null, workspace,
    startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z",
    failure: null, usage: null, leaseEpoch: 1, createdAt: "2026-01-01T00:00:00.000Z",
    executorId: "native", checkpointSeq: 0, budget: {}, parentRunId: null, handoffId: null
  } as RunRecord;
}

function taskRecord(id: string, status: TaskRecord["status"]): TaskRecord {
  return {
    id, title: id, goal: "test", status, createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", deadline: null, inputs: [], networkHosts: [],
    outputDir: "out", currentRunId: null, nextAction: null, error: null, templateId: null
  } as TaskRecord;
}

function stubStore(
  tasks: TaskRecord[],
  runs: RunRecord[],
  operations: RunOperationRecord[],
  checkpoint: { id: string; path: string; sha256: string } | null
): Pick<HearthStore, "listTasks" | "listRuns" | "latestRunCheckpoint" | "listRunOperationsByTask"> {
  return {
    listTasks: () => tasks,
    listRuns: (taskId: string) => runs.filter((run) => run.taskId === taskId),
    latestRunCheckpoint: (runId: string) => checkpoint && runId === "run-1" ? checkpoint as ReturnType<HearthStore["latestRunCheckpoint"]> : null,
    listRunOperationsByTask: () => operations
  };
}

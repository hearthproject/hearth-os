import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "@hearth/core";
import { readTaskTurns, workspaceRootForRun } from "./task-history.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-history-"));
  roots.push(root);
  return root;
}

function makeRun(root: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    taskId: "task-1",
    attempt: 1,
    status: "completed",
    threadId: null,
    workspace: join(root, "tasks", "task-1"),
    startedAt: "2026-11-20T05:00:00.000Z",
    endedAt: "2026-11-20T05:02:00.000Z",
    failure: null,
    usage: null,
    leaseEpoch: 1,
    createdAt: "2026-11-20T05:00:00.000Z",
    executorId: "native",
    checkpointSeq: 0,
    budget: { maxTurns: 10, maxToolCalls: 20, maxTokens: 1000, maxDurationMs: 60_000 },
    parentRunId: null,
    handoffId: null,
    ...overrides
  };
}

function writeManifest(root: string, runId: string, turn: number, body: Record<string, unknown>): void {
  const dir = join(root, "tasks", "task-1", "out", runId, ".hearth", "file-history", `turn-${turn}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ turn, createdAt: "2026-11-20T05:01:00.000Z", files: [], ...body }, null, 2)}\n`, "utf8");
}

describe("task turn history", () => {
  it("reads files, diff counts and snapshot availability from manifests", () => {
    const root = makeRoot();
    const run = makeRun(root);
    writeManifest(root, run.id, 1, {
      files: [
        {
          path: "src/app.ts",
          snapshotId: "snap_t1_1",
          snapshotPath: ".hearth/snapshots/snap_t1_1/src/app.ts",
          beforeHash: "before",
          afterHash: "after",
          insertions: 4,
          deletions: 2,
          created: false
        },
        {
          path: "src/new.ts",
          snapshotId: null,
          snapshotPath: null,
          beforeHash: null,
          afterHash: "created",
          insertions: null,
          deletions: null,
          created: true
        }
      ]
    });
    const snapshot = join(root, "tasks", "task-1", "out", run.id, ".hearth", "snapshots", "snap_t1_1", "src", "app.ts");
    mkdirSync(join(snapshot, ".."), { recursive: true });
    writeFileSync(snapshot, "before", "utf8");

    const view = readTaskTurns("task-1", [run], root);
    expect(view.runs).toHaveLength(1);
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]).toMatchObject({ runId: run.id, attempt: 1, turn: 1 });
    expect(view.turns[0]?.files[0]).toMatchObject({
      path: "src/app.ts",
      insertions: 4,
      deletions: 2,
      snapshotAvailable: true
    });
    expect(view.turns[0]?.files[1]).toMatchObject({ path: "src/new.ts", created: true, snapshotAvailable: false });
  });

  it("keeps empty manifests and reports missing snapshots", () => {
    const root = makeRoot();
    const run = makeRun(root);
    writeManifest(root, run.id, 1, { files: [] });
    writeManifest(root, run.id, 2, {
      files: [{
        path: "gone.ts",
        snapshotId: "snap_t2_1",
        snapshotPath: ".hearth/snapshots/snap_t2_1/gone.ts",
        beforeHash: "a",
        afterHash: "b",
        insertions: 1,
        deletions: 1,
        created: false
      }]
    });

    const view = readTaskTurns("task-1", [run], root);
    expect(view.turns.map((turn) => turn.turn)).toEqual([1, 2]);
    expect(view.turns[0]?.files).toEqual([]);
    expect(view.turns[1]?.files[0]?.snapshotAvailable).toBe(false);
  });

  it("sorts turns across runs by attempt and turn", () => {
    const root = makeRoot();
    const first = makeRun(root, { id: "run-1", attempt: 1 });
    const second = makeRun(root, { id: "run-2", attempt: 2 });
    writeManifest(root, first.id, 2, { files: [] });
    writeManifest(root, second.id, 1, { files: [] });
    writeManifest(root, first.id, 1, { files: [] });

    const view = readTaskTurns("task-1", [second, first], root);
    expect(view.turns.map((turn) => [turn.attempt, turn.turn])).toEqual([[1, 1], [1, 2], [2, 1]]);
  });

  it("prefers the recorded workspace root marker for rewind resolution", () => {
    const root = makeRoot();
    const run = makeRun(root, { workspace: join(root, "tasks", "task-1") });
    const markerDir = join(root, "tasks", "task-1", "out", run.id, ".hearth");
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, "workspace-root"), join(root, "project-worktree"), "utf8");

    expect(workspaceRootForRun(join(root, "tasks", "task-1"), run)).toBe(join(root, "project-worktree"));
  });
});

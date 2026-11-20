import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextItem, RunRecord } from "@hearth/core";
import { attachVerification, readTaskTurns, rewindTaskTurn, TaskRewindError, workspaceRootForRun } from "./task-history.ts";

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

function hashContent(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
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

  it("rewinds a modified file from its turn snapshot", () => {
    const root = makeRoot();
    const run = makeRun(root);
    const workspace = join(root, "tasks", "task-1");
    const target = join(workspace, "src", "app.ts");
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "before", "utf8");
    const snapshot = join(root, "tasks", "task-1", "out", run.id, ".hearth", "snapshots", "snap_t1_1", "src", "app.ts");
    mkdirSync(join(snapshot, ".."), { recursive: true });
    writeFileSync(snapshot, "before", "utf8");
    writeManifest(root, run.id, 1, {
      files: [{
        path: "src/app.ts",
        snapshotId: "snap_t1_1",
        snapshotPath: ".hearth/snapshots/snap_t1_1/src/app.ts",
        beforeHash: "before-hash",
        afterHash: hashContent("after"),
        insertions: 2,
        deletions: 0,
        created: false
      }]
    });
    writeFileSync(target, "after", "utf8");

    const report = rewindTaskTurn({ taskId: "task-1", run, turn: 1, workspaceRoot: root });
    expect(report.restored).toEqual(["src/app.ts"]);
    expect(report.failed).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("before");
  });

  it("refuses to overwrite a file that drifted after the manifest hash", () => {
    const root = makeRoot();
    const run = makeRun(root);
    const workspace = join(root, "tasks", "task-1");
    const target = join(workspace, "src", "app.ts");
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "before", "utf8");
    const snapshot = join(root, "tasks", "task-1", "out", run.id, ".hearth", "snapshots", "snap_t1_1", "src", "app.ts");
    mkdirSync(join(snapshot, ".."), { recursive: true });
    writeFileSync(snapshot, "before", "utf8");
    writeManifest(root, run.id, 1, {
      files: [{
        path: "src/app.ts",
        snapshotId: "snap_t1_1",
        snapshotPath: ".hearth/snapshots/snap_t1_1/src/app.ts",
        beforeHash: "before-hash",
        afterHash: hashContent("after"),
        insertions: 1,
        deletions: 0,
        created: false
      }]
    });
    writeFileSync(target, "user edit", "utf8");

    expect(() => rewindTaskTurn({ taskId: "task-1", run, turn: 1, workspaceRoot: root }))
      .toThrowError(TaskRewindError);
    try {
      rewindTaskTurn({ taskId: "task-1", run, turn: 1, workspaceRoot: root });
    } catch (error) {
      expect((error as TaskRewindError).code).toBe("HISTORY_DRIFT");
    }
    expect(readFileSync(target, "utf8")).toBe("user edit");
  });

  it("force-rewinds a drifted file and removes a created file", () => {
    const root = makeRoot();
    const run = makeRun(root);
    const workspace = join(root, "tasks", "task-1");
    const target = join(workspace, "src", "app.ts");
    const created = join(workspace, "src", "new.ts");
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "after", "utf8");
    writeFileSync(created, "new", "utf8");
    const snapshot = join(root, "tasks", "task-1", "out", run.id, ".hearth", "snapshots", "snap_t1_1", "src", "app.ts");
    mkdirSync(join(snapshot, ".."), { recursive: true });
    writeFileSync(snapshot, "before", "utf8");
    writeManifest(root, run.id, 1, {
      files: [
        {
          path: "src/app.ts",
          snapshotId: "snap_t1_1",
          snapshotPath: ".hearth/snapshots/snap_t1_1/src/app.ts",
          beforeHash: "before-hash",
          afterHash: hashContent("after"),
          insertions: 1,
          deletions: 0,
          created: false
        },
        {
          path: "src/new.ts",
          snapshotId: null,
          snapshotPath: null,
          beforeHash: null,
          afterHash: hashContent("new"),
          insertions: null,
          deletions: null,
          created: true
        }
      ]
    });

    const report = rewindTaskTurn({ taskId: "task-1", run, turn: 1, force: true, workspaceRoot: root });
    expect(report.force).toBe(true);
    expect(report.restored).toEqual(["src/app.ts"]);
    expect(report.removed).toEqual(["src/new.ts"]);
    expect(readFileSync(target, "utf8")).toBe("before");
    expect(existsSync(created)).toBe(false);
  });

  it("reports a missing snapshot instead of silently skipping it", () => {
    const root = makeRoot();
    const run = makeRun(root);
    writeManifest(root, run.id, 1, {
      files: [{
        path: "src/app.ts",
        snapshotId: "snap_t1_1",
        snapshotPath: ".hearth/snapshots/snap_t1_1/src/app.ts",
        beforeHash: "before-hash",
        afterHash: null,
        insertions: 0,
        deletions: 0,
        created: false
      }]
    });

    try {
      rewindTaskTurn({ taskId: "task-1", run, turn: 1, workspaceRoot: root });
      throw new Error("expected rewind to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskRewindError);
      expect((error as TaskRewindError).code).toBe("SNAPSHOT_MISSING");
    }
  });

  it("attaches verification metadata from native tool results", () => {
    const root = makeRoot();
    const run = makeRun(root);
    writeManifest(root, run.id, 1, { files: [] });
    const item = {
      id: "item-1",
      kind: "tool_result",
      runId: run.id,
      taskId: "task-1",
      provenance: {
        turn: 1,
        failedTests: ["src/app.test.ts"],
        diagnostics: [{ file: "src/app.ts", line: 4, message: "bad" }],
        exitCode: 1,
        filesChanged: ["src/app.ts"],
        insertions: 3,
        deletions: 1,
        browserAssertions: [{ kind: "text", expected: "ok", passed: true }]
      }
    } as unknown as ContextItem;

    const view = attachVerification(readTaskTurns("task-1", [run], root), [item]);
    expect(view.turns[0]?.verification).toMatchObject({
      toolCalls: 1,
      failedTests: ["src/app.test.ts"],
      exitCodes: [1],
      filesChanged: ["src/app.ts"],
      insertions: 3,
      deletions: 1
    });
  });
});

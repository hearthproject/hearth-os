import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskRecord, TaskStatus } from "@hearth/core";
import type { CodexRunner } from "./scheduler.ts";
import { HearthStore } from "@hearth/eventlog";
import { HearthScheduler } from "./scheduler.ts";
import { HearthService } from "./service.ts";

const FAKE_RESULT = {
  threadId: "fake-thread",
  finalResponse: "done",
  usage: null,
  profileLabel: "fake / model"
};

describe("Hearth scheduler", () => {
  let store: HearthStore | null = null;
  let scheduler: HearthScheduler | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    await scheduler?.stop();
    scheduler = null;
    store?.close();
    store = null;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("runs a local task and publishes validated artifacts with a manifest", async () => {
    const service = setup();
    const runner: CodexRunner = async (options) => {
      writeFileSync(join(options.workingDirectory, "out", "meeting-notes.md"), "# 会议纪要\n\n已完成。\n");
      return FAKE_RESULT;
    };
    scheduler = makeScheduler(service, runner);
    scheduler.start();

    const task = service.createTask({ templateId: "T01" });
    const completed = await waitForStatus(service, task.id, "completed");
    expect(completed.outputDir).toBe("eval/runs/T01");

    const published = join(requireTemp(), "eval", "runs", "T01", "meeting-notes.md");
    expect(existsSync(published)).toBe(true);
    expect(readFileSync(published, "utf8")).toContain("会议纪要");
    const manifestPath = join(requireTemp(), "eval", "runs", "T01", "run-manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.taskId).toBe(task.id);
    expect(manifest.inputs[0].sha256).toMatch(/^[a-f0-9]{64}$/);

    const artifacts = store?.listArtifacts(task.id) ?? [];
    expect(artifacts.map((artifact) => artifact.relativePath)).toContain("meeting-notes.md");
    const runs = store?.listRuns(task.id) ?? [];
    expect(runs[0]?.status).toBe("completed");
    expect(runs[0]?.threadId).toBe("fake-thread");
    expect(existsSync(join(runs[0]?.workspace ?? "", "inputs"))).toBe(true);
  });

  it("marks unsupported inputs recoverable instead of inventing output", async () => {
    const service = setup();
    scheduler = makeScheduler(service, async () => FAKE_RESULT);
    scheduler.start();

    const task = service.createTask({ templateId: "T04" });
    const failed = await waitForStatus(service, task.id, "recoverable");
    expect(failed.error?.kind).toBe("input_unavailable");
    expect(store?.listArtifacts(task.id)).toHaveLength(0);
  });

  it("runs one task at a time", async () => {
    const service = setup();
    let active = 0;
    let maxActive = 0;
    const runner: CodexRunner = async (options) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(40);
      writeFileSync(join(options.workingDirectory, "out", "report.md"), "# report\n");
      active -= 1;
      return FAKE_RESULT;
    };
    const first = service.createTask({ title: "任务一", goal: "写报告", textInput: "一" });
    const second = service.createTask({ title: "任务二", goal: "写报告", textInput: "二" });
    scheduler = makeScheduler(service, runner);
    scheduler.start();

    await waitForStatus(service, first.id, "completed");
    await waitForStatus(service, second.id, "completed");
    expect(maxActive).toBe(1);
  });

  it("recovers a run interrupted by a service restart", async () => {
    const service = setup();
    const task = service.createTask({ templateId: "T01" });
    const now = new Date().toISOString();
    const runId = randomUUID();
    service.createRun({
      id: runId,
      taskId: task.id,
      attempt: 1,
      status: "running",
      threadId: null,
      workspace: join(requireTemp(), "stale"),
      startedAt: now,
      endedAt: null,
      failure: null,
      usage: null,
      createdAt: now
    });
    service.updateTask(task.id, { status: "running", currentRunId: runId, nextAction: "正在执行" }, runId);

    scheduler = makeScheduler(service, async () => FAKE_RESULT);
    scheduler.start();
    const recovered = service.requireTask(task.id);
    expect(recovered.status).toBe("recoverable");
    expect(recovered.error?.kind).toBe("interrupted");
    expect(store?.getRun(runId)?.status).toBe("failed");
    expect(store?.getRun(runId)?.failure?.recoverable).toBe(true);
  });

  function setup(): HearthService {
    store = new HearthStore(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "hearth-scheduler-"));
    return new HearthService(store);
  }

  function makeScheduler(service: HearthService, codexRunner: CodexRunner): HearthScheduler {
    return new HearthScheduler({
      service,
      codexRunner,
      workspaceRoot: join(requireTemp(), "workspaces"),
      artifactBase: requireTemp()
    });
  }

  function requireTemp(): string {
    if (!tempDir) throw new Error("Missing temp dir");
    return tempDir;
  }
});

async function waitForStatus(service: HearthService, taskId: string, expected: TaskStatus): Promise<TaskRecord> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const task = service.store.getTask(taskId);
    if (task?.status === expected) return task;
    await delay(20);
  }
  const current = service.store.getTask(taskId);
  throw new Error(`Timed out waiting for ${expected}; current=${current?.status}; error=${current?.error?.message ?? "none"}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

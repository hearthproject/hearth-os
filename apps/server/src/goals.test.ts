import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { GoalStateError, type GoalContract, type RunRecord, type TaskPauseResult, type TaskRecord, type TaskResumeReference } from "@hearth/core";
import { GoalService, type GoalSchedulerPort } from "./goals.ts";
import { HearthService } from "./service.ts";

describe("GoalService", () => {
  let root: string;
  let store: HearthStore;
  let service: HearthService;
  let goals: GoalService;
  let scheduler: FakeScheduler;
  let now: Date;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-goal-"));
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    now = new Date("2026-11-24T02:00:00.000Z");
    scheduler = new FakeScheduler(service);
    goals = new GoalService({
      service,
      executorHealth: () => ({
        executorId: "native",
        available: true,
        canRun: true,
        issues: [],
        checkedAt: now.toISOString(),
        version: "test",
        path: "native",
        source: "builtin"
      } as never),
      now: () => now,
      tickMs: 0,
      review: null
    });
    goals.attachScheduler(scheduler);
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a draft goal, binds an anchor task, and starts it", async () => {
    const goal = createGoal(goals, "ship the release");
    const task = createTask(service, goal);
    goals.attachTask(goal.goalId, task.id);
    const started = await goals.action(goal.goalId, "start");
    expect(started.goal.currentState).toBe("active");
    expect(started.goal.armed).toBe(true);
    expect(service.requireTask(task.id).goalId).toBe(goal.goalId);
  });

  it("rejects a second non-terminal goal in the same conversation", () => {
    const first = goals.create({
      objective: "first",
      conversationId: "conv-1",
      execution: nativeExecution()
    });
    expect(first.currentState).toBe("draft");
    expect(() => goals.create({
      objective: "second",
      conversationId: "conv-1",
      execution: nativeExecution()
    })).toThrow(GoalStateError);
  });

  it("keeps opening rounds without a round-limit gate", async () => {
    const conversation = store.createConversation("goal rounds");
    const goal = goals.create({
      objective: "bounded work",
      conversationId: conversation.id,
      maxRounds: 1,
      execution: nativeExecution()
    });
    const task = createTask(service, goal);
    goals.attachTask(goal.goalId, task.id);
    await goals.action(goal.goalId, "start");
    const run = createRun(service, task, root);
    const outDir = join(root, "out", run.id);
    mkdirSync(outDir, { recursive: true });
    goals.onRunStarted({ task, run, outDir, workspaceRoot: root });
    const round = goals.view(goal.goalId).rounds[0]!;
    expect(round.index).toBe(1);
    expect(round.runIds).toEqual([run.id]);
    expect(round.outDir).toBe(outDir);

    writeIntent(outDir, "progress", "did a small slice");
    service.updateTask(task.id, { status: "running" });
    service.updateTask(task.id, { status: "completed" });
    const decision = await goals.onRunCompleted({
      task,
      run: { ...run, status: "completed", endedAt: now.toISOString() },
      outDir,
      workspaceRoot: root,
      finalResponse: "small slice"
    });
    expect(decision.action).toBe("continue");
    const settled = goals.get(goal.goalId);
    expect(settled.currentState).toBe("active");
    expect(settled.armed).toBe(true);
    expect(settled.roundCount).toBe(1);
    const roundAnswer = store.listChatMessages(conversation.id)
      .find((message) => message.id.startsWith("goal-round-"));
    expect(roundAnswer?.content).toBe("small slice");
  });

  it("accepts a file criterion and closes the goal only after verification", async () => {
    const conversation = store.createConversation("goal conversation");
    const goal = goals.create({
      objective: "write the marker file",
      conversationId: conversation.id,
      criteria: [{
        id: "c1",
        description: "marker exists",
        validator: "file",
        check: "done.txt",
        required: true
      }],
      reviewPolicy: "auto",
      maxRounds: 3,
      execution: nativeExecution()
    });
    const task = createTask(service, goal);
    goals.attachTask(goal.goalId, task.id);
    await goals.action(goal.goalId, "start");
    const run = createRun(service, task, root);
    const outDir = join(root, "out", run.id);
    mkdirSync(outDir, { recursive: true });
    goals.onRunStarted({ task, run, outDir, workspaceRoot: root });
    writeFileSync(join(root, "done.txt"), "ok\n", "utf8");
    writeIntent(outDir, "complete", "marker written", ["done.txt"]);
    service.updateTask(task.id, { status: "running" });
    service.updateTask(task.id, { status: "completed" });

    const decision = await goals.onRunCompleted({
      task,
      run: { ...run, status: "completed", endedAt: now.toISOString() },
      outDir,
      workspaceRoot: root,
      finalResponse: "finished the marker"
    });
    expect(decision.action).toBe("done");
    expect(goals.get(goal.goalId).currentState).toBe("done");
    expect(store.latestGoalCompletionReport(goal.goalId)?.verdict).toBe("pass");
    const finalMessage = store.listChatMessages(conversation.id)
      .find((message) => message.id === `goal-final-${goal.goalId}`);
    expect(finalMessage?.content).toContain("finished the marker");
    expect(finalMessage?.taskStatus).toBe("completed");
  });

  it("records progress without advancing when the goal is paused", async () => {
    const goal = createGoal(goals, "paused work");
    const task = createTask(service, goal);
    goals.attachTask(goal.goalId, task.id);
    await goals.action(goal.goalId, "start");
    const run = createRun(service, task, root);
    const outDir = join(root, "out", run.id);
    mkdirSync(outDir, { recursive: true });
    goals.onRunStarted({ task, run, outDir, workspaceRoot: root });
    await goals.action(goal.goalId, "pause");
    writeIntent(outDir, "progress", "a little more");
    const decision = await goals.onRunCompleted({
      task,
      run: { ...run, status: "completed", endedAt: now.toISOString() },
      outDir,
      workspaceRoot: root,
      finalResponse: "slice"
    });
    expect(decision.action).toBe("none");
    expect(goals.get(goal.goalId).currentState).toBe("paused");
    expect(goals.get(goal.goalId).armed).toBe(false);
  });

  it("keeps active goals armed and interrupts open rounds on host restart", async () => {
    const goal = createGoal(goals, "restart me");
    const task = createTask(service, goal);
    goals.attachTask(goal.goalId, task.id);
    await goals.action(goal.goalId, "start");
    const run = createRun(service, task, root);
    const outDir = join(root, "out", run.id);
    mkdirSync(outDir, { recursive: true });
    goals.onRunStarted({ task, run, outDir, workspaceRoot: root });

    goals.recoverOnBoot();
    const recovered = goals.get(goal.goalId);
    expect(recovered.currentState).toBe("active");
    expect(recovered.armed).toBe(true);
    expect(recovered.stopReason).toBeNull();
    expect(goals.view(goal.goalId).rounds[0]?.status).toBe("interrupted");
  });

  it("rejects stale revisions", async () => {
    const goal = createGoal(goals, "revision");
    const task = createTask(service, goal);
    goals.attachTask(goal.goalId, task.id);
    const current = goals.get(goal.goalId).revision ?? 0;
    await expect(goals.action(goal.goalId, "pause", { expectedRevision: current - 1 }))
      .rejects.toThrow(GoalStateError);
  });
});

class FakeScheduler implements GoalSchedulerPort {
  requeues: Array<{ taskId: string; prompt: string }> = [];
  kicks = 0;
  constructor(private readonly service: HearthService) {}

  async pause(taskId: string): Promise<TaskPauseResult> {
    const task = this.service.requireTask(taskId);
    return { task: { ...task, status: "paused" }, resume: null };
  }

  resumePaused(taskId: string, _reference: TaskResumeReference): TaskRecord {
    return this.service.updateTask(taskId, { status: "queued" });
  }

  cancel(taskId: string): TaskRecord {
    return this.service.updateTask(taskId, { status: "cancelled" });
  }

  requeueGoalTask(taskId: string, prompt: string): TaskRecord {
    this.requeues.push({ taskId, prompt });
    return this.service.requireTask(taskId);
  }

  kick(): void {
    this.kicks += 1;
  }
}

function createGoal(goals: GoalService, objective: string, maxRounds = 4): GoalContract {
  return goals.create({
    objective,
    maxRounds,
    execution: nativeExecution()
  });
}

function nativeExecution() {
  return {
    executorId: "native" as const,
    taskKind: "general" as const,
    expectedOutputs: [],
    networkHosts: []
  };
}

function createTask(service: HearthService, goal: GoalContract): TaskRecord {
  return service.createTask({
    title: goal.title,
    goal: goal.objective,
    goalId: goal.goalId,
    executorId: "native",
    taskKind: "general"
  });
}

function createRun(service: HearthService, task: TaskRecord, root: string): RunRecord {
  const now = new Date("2026-11-24T02:00:00.000Z").toISOString();
  return service.createRun({
    id: `run-${Math.random().toString(36).slice(2)}`,
    taskId: task.id,
    attempt: 1,
    status: "running",
    threadId: null,
    workspace: root,
    startedAt: now,
    endedAt: null,
    failure: null,
    usage: null,
    leaseEpoch: 1,
    createdAt: now,
    executorId: "native",
    checkpointSeq: 0,
    budget: { maxTurns: 8 },
    parentRunId: null,
    handoffId: null
  });
}

function writeIntent(outDir: string, status: string, note: string, evidence: string[] = []): void {
  writeFileSync(join(outDir, "goal-intent.json"), JSON.stringify({ status, note, evidence }), "utf8");
}

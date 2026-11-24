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

  it("pauses active goals and interrupts open rounds on host restart", async () => {
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
    expect(recovered.currentState).toBe("paused");
    expect(recovered.armed).toBe(false);
    expect(recovered.stopReason).toBe("host_restart");
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

  it("switches executors between rounds, preserves history, and rejects the old run", async () => {
    const goal = createGoal(goals, "use the best executor");
    const task = createTask(service, goal);
    goals.attachTask(goal.goalId, task.id);
    await goals.action(goal.goalId, "start");
    const oldRun = createRun(service, task, root, "native");
    const oldOutDir = join(root, "out", oldRun.id);
    mkdirSync(oldOutDir, { recursive: true });
    goals.onRunStarted({ task, run: oldRun, outDir: oldOutDir, workspaceRoot: root });
    writeIntent(oldOutDir, "progress", "native completed one round", ["native-evidence.txt"]);
    service.updateTask(task.id, { status: "running", currentRunId: oldRun.id }, oldRun.id);
    service.updateTask(task.id, { status: "completed" }, oldRun.id);
    await goals.onRunCompleted({
      task,
      run: { ...oldRun, status: "completed", endedAt: now.toISOString() },
      outDir: oldOutDir,
      workspaceRoot: root,
      finalResponse: "native completed one round"
    });

    const currentRevision = goals.get(goal.goalId).revision ?? 0;
    const switched = await goals.action(goal.goalId, "switch_executor", {
      expectedRevision: currentRevision,
      note: "下一轮改用 Codex",
      execution: {
        executorId: "codex",
        taskKind: "workspace",
        expectedOutputs: ["codex-result.md"],
        workspacePath: root,
        networkHosts: ["api.example.com"]
      }
    });
    expect(switched.goal.execution?.executorId).toBe("codex");
    expect(switched.goal.executionRevision).toBe(1);
    expect(switched.rounds).toHaveLength(1);
    const switchedTask = service.requireTask(task.id);
    expect(switchedTask.executorId).toBe("codex");
    expect(switchedTask.taskKind).toBe("workspace");
    expect(switchedTask.expectedOutputs).toEqual(["codex-result.md"]);
    expect(switchedTask.networkHosts).toEqual(["api.example.com"]);
    expect(switchedTask.inputs.some((input) => input.kind === "workspace" && input.value === root)).toBe(true);
    expect(switchedTask.currentRunId).toBeNull();

    const beforeStale = goals.get(goal.goalId);
    const stale = await goals.onRunCompleted({
      task,
      run: { ...oldRun, status: "completed", endedAt: now.toISOString() },
      outDir: oldOutDir,
      workspaceRoot: root,
      finalResponse: "late native result"
    });
    expect(stale.action).toBe("none");
    const afterStale = goals.get(goal.goalId);
    expect(afterStale.currentState).toBe(beforeStale.currentState);
    expect(afterStale.roundCount).toBe(beforeStale.roundCount);
    expect(store.listEvents(0, task.id).some((event) => event.type === "goal.result.rejected")).toBe(true);

    const codexRun = createRun(service, switchedTask, root, "codex");
    const codexOutDir = join(root, "out", codexRun.id);
    mkdirSync(codexOutDir, { recursive: true });
    goals.onRunStarted({ task: switchedTask, run: codexRun, outDir: codexOutDir, workspaceRoot: root });
    const nextRound = goals.view(goal.goalId).rounds.at(-1)!;
    expect(nextRound.executionFence).toMatchObject({ executorId: "codex", executionRevision: 1 });
  });

  it("amends the contract append-only and invalidates command approval", async () => {
    const goal = goals.create({
      objective: "verify the release",
      criteria: [{
        id: "c1",
        description: "tests pass",
        validator: "command",
        check: "npm test",
        required: true
      }],
      commandsApproved: true,
      execution: nativeExecution()
    });
    const revised = await goals.action(goal.goalId, "amend_contract", {
      expectedRevision: goal.revision ?? 0,
      note: "tighten the command",
      contract: {
        objective: "verify the release with typechecking",
        successCriteria: [{
          id: "c1",
          description: "tests and typecheck pass",
          validator: "command",
          check: "npm run typecheck && npm test",
          required: true
        }]
      }
    });
    expect(revised.goal.objective).toContain("typechecking");
    expect(revised.goal.originalObjective).toBe("verify the release");
    expect(revised.goal.contractRevision).toBe(1);
    expect(revised.goal.amendments).toHaveLength(1);
    expect(revised.goal.amendments?.[0]?.previous.objective).toBe("verify the release");
    expect(revised.goal.amendments?.[0]?.next.objective).toContain("typechecking");
    expect(revised.goal.commandsApprovedAt).toBeNull();
  });

  it("discards a verification result when the contract changes while review is running", async () => {
    const reviewControl: {
      markStarted?: () => void;
      resolve?: (answer: string) => void;
    } = {};
    const reviewStarted = new Promise<void>((resolveStarted) => {
      reviewControl.markStarted = resolveStarted;
    });
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
      review: () => new Promise<string | null>((resolve) => {
        reviewControl.resolve = resolve;
        reviewControl.markStarted?.();
      })
    });
    goals.attachScheduler(scheduler);

    const goal = goals.create({
      objective: "finish the reviewed contract",
      criteria: [{
        id: "c1",
        description: "review confirms the result",
        validator: "llm_review",
        check: "the reviewer sees a complete result",
        required: true
      }],
      reviewPolicy: "auto",
      execution: nativeExecution()
    });
    const task = createTask(service, goal);
    goals.attachTask(goal.goalId, task.id);
    await goals.action(goal.goalId, "start");
    const run = createRun(service, task, root);
    const outDir = join(root, "out", run.id);
    mkdirSync(outDir, { recursive: true });
    goals.onRunStarted({ task, run, outDir, workspaceRoot: root });
    writeIntent(outDir, "complete", "ready for review", ["review-evidence.txt"]);
    service.updateTask(task.id, { status: "running", currentRunId: run.id }, run.id);
    const completedTask = service.updateTask(task.id, { status: "completed", currentRunId: run.id }, run.id);

    const completing = goals.onRunCompleted({
      task: completedTask,
      run: { ...run, status: "completed", endedAt: now.toISOString() },
      outDir,
      workspaceRoot: root,
      finalResponse: "ready for review"
    });
    await reviewStarted;
    const validating = goals.get(goal.goalId);
    expect(validating.currentState).toBe("validating");
    const amended = await goals.action(goal.goalId, "amend_contract", {
      expectedRevision: validating.revision ?? 0,
      note: "narrow the result while review is running",
      contract: { objective: "finish the amended contract" }
    });
    expect(amended.goal.contractRevision).toBe(1);

    expect(reviewControl.resolve).toBeTypeOf("function");
    reviewControl.resolve?.('{"verdict":"pass","reason":"looks good"}');
    const decision = await completing;
    expect(decision.action).toBe("none");
    const settled = goals.get(goal.goalId);
    expect(settled.currentState).toBe("awaiting_user");
    expect(settled.contractRevision).toBe(1);
    expect(store.latestGoalCompletionReport(goal.goalId)).toBeNull();
    expect(store.listEvents(0, task.id).some((event) =>
      event.type === "goal.result.rejected"
      && String((event.payload as Record<string, unknown>).reason).includes("验收期间")
    )).toBe(true);
  });

  it("scans every context page when checking forbidden actions", async () => {
    const conversation = store.createConversation("goal pagination");
    const goal = goals.create({
      objective: "finish without publishing",
      conversationId: conversation.id,
      criteria: [{
        id: "c1",
        description: "done file exists",
        validator: "file",
        check: "done.txt",
        required: true
      }],
      forbiddenActions: ["npm publish"],
      reviewPolicy: "auto",
      execution: nativeExecution()
    });
    const task = createTask(service, goal);
    goals.attachTask(goal.goalId, task.id);
    await goals.action(goal.goalId, "start");
    const run = createRun(service, task, root);
    const outDir = join(root, "out", `pagination-${run.id}`);
    mkdirSync(outDir, { recursive: true });
    goals.onRunStarted({ task, run, outDir, workspaceRoot: root });
    appendContextToolCall(store, task.id, run.id, "old-action", "npm publish");
    for (let index = 0; index < 1_005; index += 1) {
      appendFillerContext(store, task.id, run.id, index);
    }
    writeFileSync(join(root, "done.txt"), "done", "utf8");
    writeIntent(outDir, "complete", "finished", ["done.txt"]);
    service.updateTask(task.id, { status: "running", currentRunId: run.id }, run.id);
    const completedTask = service.updateTask(task.id, { status: "completed", currentRunId: run.id }, run.id);
    const decision = await goals.onRunCompleted({
      task: completedTask,
      run: { ...run, status: "completed", endedAt: now.toISOString() },
      outDir,
      workspaceRoot: root,
      finalResponse: "finished"
    });

    expect(decision.action).toBe("continue");
    const report = goals.view(goal.goalId).rounds.at(-1)?.verifier;
    expect(report?.verdict).toBe("fail");
    expect(report?.forbiddenActions.some((item) => item.includes("npm publish"))).toBe(true);
  });

  it("guides two stale rounds and pauses after four rounds without progress", async () => {
    const goal = createGoal(goals, "make measurable progress");
    let task = createTask(service, goal);
    goals.attachTask(goal.goalId, task.id);
    await goals.action(goal.goalId, "start");
    let decision: Awaited<ReturnType<GoalService["onRunCompleted"]>> | null = null;
    for (let index = 1; index <= 4; index += 1) {
      if (index > 1) {
        task = service.updateTask(task.id, { status: "queued" });
        task = service.updateTask(task.id, { status: "running" });
      }
      const run = createRun(service, task, root, "native");
      const outDir = join(root, "out", `no-progress-${index}-${run.id}`);
      mkdirSync(outDir, { recursive: true });
      goals.onRunStarted({ task, run, outDir, workspaceRoot: root });
      writeIntent(outDir, "progress", "same result", ["same-evidence.txt"]);
      service.updateTask(task.id, { status: "running", currentRunId: run.id }, run.id);
      service.updateTask(task.id, { status: "completed", currentRunId: run.id }, run.id);
      decision = await goals.onRunCompleted({
        task,
        run: { ...run, status: "completed", endedAt: now.toISOString() },
        outDir,
        workspaceRoot: root,
        finalResponse: "same result"
      });
      if (index === 2) expect(decision.action === "continue" && decision.prompt).toContain("无进展纠偏");
    }
    expect(decision?.action).toBe("blocked");
    const blocked = goals.get(goal.goalId);
    expect(blocked.currentState).toBe("blocked");
    expect(blocked.stopReason).toBe("no_progress");
    expect(blocked.noProgressCount).toBe(3);
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

function createRun(
  service: HearthService,
  task: TaskRecord,
  root: string,
  executorId: "native" | "codex" | "deepseek-harness" = "native"
): RunRecord {
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
    executorId,
    checkpointSeq: 0,
    budget: { maxTurns: 8 },
    parentRunId: null,
    handoffId: null
  });
}

function writeIntent(outDir: string, status: string, note: string, evidence: string[] = []): void {
  writeFileSync(join(outDir, "goal-intent.json"), JSON.stringify({ status, note, evidence }), "utf8");
}

function appendContextToolCall(
  store: HearthStore,
  taskId: string,
  runId: string,
  id: string,
  command: string
): void {
  store.appendContextItem({
    seq: 0,
    id,
    conversationId: null,
    taskId,
    runId,
    executorId: "native",
    kind: "tool_call",
    role: "tool",
    content: command,
    contentRef: null,
    sha256: null,
    tokens: 0,
    sensitivity: "normal",
    provenance: { tool: "shell", command },
    parentId: null,
    executorEventId: id,
    createdAt: "2026-11-24T02:00:00.000Z"
  });
}

function appendFillerContext(store: HearthStore, taskId: string, runId: string, index: number): void {
  const id = `filler-${index}`;
  store.appendContextItem({
    seq: 0,
    id,
    conversationId: null,
    taskId,
    runId,
    executorId: "native",
    kind: "assistant_message",
    role: "assistant",
    content: `progress ${index}`,
    contentRef: null,
    sha256: null,
    tokens: 0,
    sensitivity: "normal",
    provenance: {},
    parentId: null,
    executorEventId: id,
    createdAt: "2026-11-24T02:00:01.000Z"
  });
}

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ArtifactRecord,
  ExecutorHealth,
  ExecutorId,
  GoalAction,
  GoalCompletionReport,
  GoalContract,
  GoalEligibility,
  GoalRoundIntent,
  GoalRoundRecord,
  GoalStopReason,
  GoalView,
  TaskPauseResult,
  TaskRecord,
  TaskResumeReference,
  RunRecord
} from "@hearth/core";
import {
  GoalStateError,
  assertGoalAction,
  assertGoalTransition,
  evaluateGoalEligibility,
  goalBackoffMs,
  goalProgressDigest,
  isGoalTerminal,
  normalizeGoal
} from "@hearth/core";
import type { HearthService } from "./service.ts";
import { verifyGoalCompletion, type GoalObservedAction } from "./goal-verifier.ts";
import { runGoalCommand, type GoalCommandResult } from "./goal-command.ts";

export interface GoalSchedulerPort {
  pause(taskId: string): Promise<TaskPauseResult>;
  resumePaused(taskId: string, reference: TaskResumeReference): TaskRecord;
  cancel(taskId: string): TaskRecord;
  requeueGoalTask(taskId: string, prompt: string, options?: { allowCompleted?: boolean }): TaskRecord;
  kick(): void;
}

export interface CreateGoalInput {
  title?: string;
  objective: string;
  conversationId?: string | null;
  projectId?: string | null;
  execution: NonNullable<GoalContract["execution"]>;
  criteria?: GoalContract["successCriteria"];
  constraints?: string[];
  forbiddenActions?: string[];
  evidenceRequirements?: string[];
  budget?: {
    maxTurns?: number | undefined;
    maxToolCalls?: number | undefined;
    maxTokens?: number | undefined;
    maxDurationMs?: number | undefined;
    maxHumanMinutes?: number | undefined;
  };
  deadline?: string | null;
  stopConditions?: string[];
  reviewPolicy?: GoalContract["reviewPolicy"];
  maxRounds?: number;
  commandsApproved?: boolean;
  start?: boolean;
}

export type GoalRoundDecision =
  | { action: "continue"; prompt: string; detail: string }
  | { action: "gate"; reason: GoalStopReason; detail: string }
  | { action: "done"; report: GoalCompletionReport }
  | { action: "blocked"; reason: GoalStopReason; detail: string }
  | { action: "none" };

export interface GoalServiceOptions {
  service: HearthService;
  executorHealth: (executorId: ExecutorId) => ExecutorHealth;
  tickMs?: number;
  now?: () => Date;
  review?: ((prompt: string) => Promise<string | null>) | null;
  runCommand?: (argv: string[], cwd: string) => Promise<GoalCommandResult>;
}

interface RunStartedInput {
  task: TaskRecord;
  run: RunRecord;
  outDir: string;
  workspaceRoot: string;
}

interface RunCompletedInput extends RunStartedInput {
  finalResponse: string;
}

export class GoalService {
  private readonly service: HearthService;
  private readonly executorHealth: (executorId: ExecutorId) => ExecutorHealth;
  private readonly tickMs: number;
  private readonly now: () => Date;
  private readonly review: ((prompt: string) => Promise<string | null>) | null;
  private readonly runCommand: (argv: string[], cwd: string) => Promise<GoalCommandResult>;
  private scheduler: GoalSchedulerPort | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: GoalServiceOptions) {
    this.service = options.service;
    this.executorHealth = options.executorHealth;
    this.tickMs = Math.max(0, options.tickMs ?? 30_000);
    this.now = options.now ?? (() => new Date());
    this.review = options.review ?? null;
    this.runCommand = options.runCommand
      ?? ((argv, cwd) => runGoalCommand(argv, { cwd, timeoutMs: 120_000 }));
  }

  attachScheduler(scheduler: GoalSchedulerPort): void {
    this.scheduler = scheduler;
  }

  start(): void {
    if (this.timer || this.tickMs <= 0) return;
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(options: { conversationId?: string | null; projectId?: string | null; includeTerminal?: boolean } = {}): GoalContract[] {
    return this.service.store.listGoals(options);
  }

  findOpenForConversation(conversationId: string): GoalContract | null {
    return this.service.store.listGoals({ conversationId })[0] ?? null;
  }

  get(goalId: string): GoalContract {
    const goal = this.service.store.getGoal(goalId);
    if (!goal) throw new GoalStateError("GOAL_STATE_INVALID", `目标不存在：${goalId}`);
    return normalizeGoal(goal);
  }

  view(goalId: string): GoalView {
    const goal = this.get(goalId);
    const rounds = this.service.store.listGoalRounds(goalId);
    const task = goal.taskId ? this.service.store.getTask(goal.taskId) : null;
    return {
      goal,
      rounds,
      latestReport: this.service.store.latestGoalCompletionReport(goalId),
      task,
      eligibility: this.eligibility(goal)
    };
  }

  create(input: CreateGoalInput): GoalContract {
    const objective = input.objective.trim();
    if (!objective) throw new GoalStateError("GOAL_STATE_INVALID", "目标不能为空");
    if (objective.length > 20_000) throw new GoalStateError("GOAL_STATE_INVALID", "目标不能超过 20000 个字符");
    if (input.conversationId) {
      const existing = this.findOpenForConversation(input.conversationId);
      if (existing) {
        throw new GoalStateError("GOAL_ALREADY_ACTIVE", `当前会话已有目标：${existing.title}`);
      }
    }
    const now = new Date().toISOString();
    const criteria = (input.criteria ?? []).map((criterion, index) => ({
      id: criterion.id?.trim() || `c${index + 1}`,
      description: criterion.description.trim(),
      validator: criterion.validator,
      check: criterion.check.trim(),
      required: criterion.required !== false
    })).filter((criterion) => criterion.description.length > 0 && criterion.check.length > 0);
    if (criteria.length > 20) throw new GoalStateError("GOAL_STATE_INVALID", "成功标准最多 20 条");
    const goal: GoalContract = {
      goalId: `goal-${randomUUID()}`,
      title: (input.title?.trim() || titleFromObjective(objective)).slice(0, 200),
      objective,
      constraints: uniqueStrings(input.constraints ?? []).slice(0, 20),
      forbiddenActions: uniqueStrings(input.forbiddenActions ?? []).slice(0, 20),
      authoritySources: [{
        kind: "user",
        ref: input.conversationId ?? input.projectId ?? "local-user"
      }],
      successCriteria: criteria,
      evidenceRequirements: uniqueStrings(input.evidenceRequirements ?? []).slice(0, 20),
      budget: {},
      stopConditions: uniqueStrings(input.stopConditions ?? []).slice(0, 20),
      reviewPolicy: input.reviewPolicy ?? "human_on_risk",
      currentState: "draft",
      nextHandoff: "等待开始",
      createdAt: now,
      updatedAt: now,
      projectId: input.projectId ?? null,
      conversationId: input.conversationId ?? null,
      taskId: null,
      execution: input.execution,
      armed: false,
      roundCount: 0,
      noProgressCount: 0,
      lastProgressDigest: null,
      nextWakeAt: null,
      stopReason: null,
      revision: 0,
      pauseReference: null,
      commandsApprovedAt: null
    };
    this.appendGoal("goal.created", goal);
    return goal;
  }

  attachTask(goalId: string, taskId: string): GoalContract {
    const goal = this.get(goalId);
    if (goal.taskId && goal.taskId !== taskId) {
      throw new GoalStateError("GOAL_STATE_INVALID", "目标已经绑定其他任务");
    }
    const task = this.service.store.getTask(taskId);
    if (!task) throw new GoalStateError("GOAL_STATE_INVALID", `任务不存在：${taskId}`);
    if (task.goalId !== goalId) throw new GoalStateError("GOAL_STATE_INVALID", "任务没有绑定该目标");
    return this.saveGoal({ ...goal, taskId });
  }

  async action(
    goalId: string,
    action: GoalAction,
    options: { expectedRevision?: number; note?: string; maxRounds?: number } = {}
  ): Promise<GoalView> {
    let goal = this.get(goalId);
    if (options.expectedRevision !== undefined && goal.revision !== options.expectedRevision) {
      throw new GoalStateError("GOAL_REVISION_CONFLICT", `目标修订号已变化：${goal.revision}`);
    }
    assertGoalAction(goal, action);
    const note = options.note?.trim().slice(0, 2000) ?? "";
    switch (action) {
      case "start": {
        if (!goal.taskId) throw new GoalStateError("GOAL_STATE_INVALID", "目标还没有绑定任务，不能开始");
        assertGoalTransition(goal.currentState, "active");
        goal = this.saveGoal({
          ...goal,
          currentState: "active",
          armed: true,
          stopReason: null,
          nextWakeAt: null,
          nextHandoff: note || "目标已开始，准备第一轮"
        });
        if (goal.taskId && this.service.store.getTask(goal.taskId)?.status === "completed") {
          this.startRound(goal);
        }
        break;
      }
      case "pause": {
        const task = goal.taskId ? this.service.store.getTask(goal.taskId) : null;
        let pauseReference = goal.pauseReference ?? null;
        if (task?.status === "running" && this.scheduler) {
          const result = await this.scheduler.pause(task.id);
          pauseReference = result.resume ?? pauseReference;
        }
        goal = this.saveGoal({
          ...goal,
          currentState: "paused",
          armed: false,
          stopReason: null,
          pauseReference,
          nextHandoff: note || "目标已暂停，继续时从最近检查点恢复"
        });
        break;
      }
      case "resume": {
        assertGoalTransition(goal.currentState, "active");
        const task = goal.taskId ? this.service.store.getTask(goal.taskId) : null;
        let nextHandoff = note || "目标已继续";
        if (task?.status === "paused" && goal.pauseReference && this.scheduler) {
          this.scheduler.resumePaused(task.id, goal.pauseReference);
          nextHandoff = note || "已从最近检查点继续";
        } else if (task && (task.status === "completed" || task.status === "recoverable" || task.status === "failed")) {
          this.startRound(goal, options.maxRounds);
        }
        goal = this.saveGoal({
          ...goal,
          currentState: "active",
          armed: true,
          stopReason: null,
          nextWakeAt: null,
          pauseReference: null,
          nextHandoff
        });
        break;
      }
      case "replan": {
        assertGoalTransition(goal.currentState, "active");
        goal = this.saveGoal({
          ...goal,
          currentState: "active",
          armed: true,
          stopReason: null,
          nextWakeAt: null,
          noProgressCount: 0,
          lastProgressDigest: null,
          nextHandoff: note || "已重新规划，换一条路线继续"
        });
        const task = goal.taskId ? this.service.store.getTask(goal.taskId) : null;
        if (task && (task.status === "completed" || task.status === "recoverable" || task.status === "failed")) {
          this.startRound(goal);
        }
        break;
      }
      case "stop": {
        const task = goal.taskId ? this.service.store.getTask(goal.taskId) : null;
        if (task && !["completed", "cancelled"].includes(task.status) && this.scheduler) {
          try { this.scheduler.cancel(task.id); } catch { /* task may already be settling */ }
          const afterCancel = this.get(goal.goalId);
          if (isGoalTerminal(afterCancel.currentState)) return this.view(goal.goalId);
        }
        goal = this.saveGoal({
          ...goal,
          currentState: "cancelled",
          armed: false,
          stopReason: "user_stop",
          nextWakeAt: null,
          nextHandoff: note || "目标已停止"
        });
        break;
      }
      case "complete": {
        goal = await this.requestVerification(goal, note);
        break;
      }
      case "approve": {
        const report = this.service.store.latestGoalCompletionReport(goal.goalId);
        if (!report || report.verdict !== "pass") {
          throw new GoalStateError("GOAL_STATE_INVALID", "没有可通过的验收报告");
        }
        assertGoalTransition(goal.currentState, "done");
        goal = this.saveGoal({
          ...goal,
          currentState: "done",
          armed: false,
          stopReason: null,
          nextWakeAt: null,
          nextHandoff: note || "验收通过，目标已完成"
        });
        break;
      }
    }
    return this.view(goal.goalId);
  }

  eligibility(goalInput: GoalContract): GoalEligibility {
    const goal = normalizeGoal(goalInput);
    if (!goal.taskId) {
      return { eligible: false, reason: "state_not_active", detail: "目标还没有绑定任务" };
    }
    const task = this.service.store.getTask(goal.taskId);
    const rounds = this.service.store.listGoalRounds(goal.goalId);
    const latest = rounds.at(-1) ?? null;
    const hasOpenRound = Boolean(latest && ["running", "gated", "paused"].includes(latest.status));
    const spentTokens = rounds.reduce((total, round) => total + (round.usage?.tokens ?? 0), 0);
    const elapsedMs = Math.max(0, this.now().getTime() - Date.parse(goal.createdAt));
    const execution = goal.execution;
    const executorAvailable = execution ? this.executorHealth(execution.executorId).canRun : false;
    return evaluateGoalEligibility({
      goal,
      now: this.now(),
      hasOpenRound,
      taskStatus: task?.status ?? null,
      executorAvailable,
      spentTokens,
      elapsedMs
    });
  }

  recoverOnBoot(): void {
    const goals = this.service.store.listGoals({ includeTerminal: false });
    for (const raw of goals) {
      const goal = normalizeGoal(raw);
      if (goal.currentState === "draft" || goal.currentState === "blocked") continue;
      if (goal.currentState === "paused" || goal.currentState === "awaiting_user") continue;
      const patch: GoalContract = {
        ...goal,
        armed: true,
        nextWakeAt: null,
        stopReason: null,
        nextHandoff: "宿主重启后继续自动推进"
      };
      if (goal.currentState === "validating") {
        assertGoalTransition(goal.currentState, "active");
        patch.currentState = "active";
      }
      this.saveGoal(patch);
      const latest = this.service.store.latestGoalRound(goal.goalId);
      if (latest && ["running", "gated", "paused"].includes(latest.status)) {
        this.saveRound({ ...latest, status: "interrupted", endedAt: this.now().toISOString() }, "goal.round.settled");
      }
    }
  }

  async tick(): Promise<void> {
    if (this.ticking || !this.scheduler) return;
    this.ticking = true;
    try {
      for (const raw of this.service.store.listGoals()) {
        const goal = normalizeGoal(raw);
        if (goal.currentState !== "active" || !goal.armed || !goal.taskId) continue;
        if (goal.nextWakeAt && Date.parse(goal.nextWakeAt) > this.now().getTime()) continue;
        const task = this.service.store.getTask(goal.taskId);
        if (!task || task.status !== "completed") continue;
        if (!this.eligibility(goal).eligible) continue;
        this.startRound(goal);
      }
    } finally {
      this.ticking = false;
    }
  }

  onRunStarted(input: RunStartedInput): void {
    let goal = this.goalForTask(input.task);
    if (!goal) return;
    if (goal.currentState === "awaiting_user") {
      assertGoalTransition(goal.currentState, "active");
      goal = {
        ...goal,
        currentState: "active",
        armed: true,
        stopReason: null,
        nextWakeAt: null,
        nextHandoff: "收到用户补充，继续目标",
        revision: (goal.revision ?? 0) + 1,
        updatedAt: this.now().toISOString()
      };
    }
    const { round, goalNext } = this.openRound(goal, input);
    this.appendGoal("goal.updated", goalNext);
    this.saveRound(round, "goal.round.started");
  }

  async onRunCompleted(input: RunCompletedInput): Promise<GoalRoundDecision> {
    let goal = this.goalForTask(input.task);
    if (!goal) return { action: "none" };
    let round = this.service.store.listGoalRounds(goal.goalId).find((item) => item.runIds.includes(input.run.id)) ?? null;
    if (!round) {
      const opened = this.openRound(goal, input);
      this.appendGoal("goal.updated", opened.goalNext);
      round = opened.round;
      this.saveRound(round, "goal.round.started");
      goal = opened.goalNext;
    }
    const intent = readGoalIntent(input.outDir);
    const artifacts = this.service.store.listArtifacts(input.task.id)
      .filter((artifact) => artifact.runId === input.run.id);
    const summary = clipText(input.finalResponse || input.task.resultSummary || "", 4000);
    const digest = goalProgressDigest({
      artifactHashes: artifacts.map((artifact) => `${artifact.relativePath}:${artifact.sha256}`),
      summary,
      intentEvidence: intent?.evidence ?? []
    });
    const usage = usageOfRun(input.run);
    round = {
      ...round,
      status: "completed",
      endedAt: this.now().toISOString(),
      summary,
      intent,
      artifactRefs: artifacts.map((artifact) => artifact.relativePath),
      evidenceRefs: [
        ...artifacts.map((artifact) => `artifact:${artifact.relativePath}`),
        "run-evidence.json",
        `run:${input.run.id}`
      ],
      usage,
      progressDigest: digest,
      workspaceRoot: input.workspaceRoot,
      outDir: input.outDir
    };
    this.saveRound(round, "goal.round.settled");

    const verified = await this.maybeVerify(goal, round, input, intent);
    if (verified) {
      this.saveRound({ ...round, verifier: verified.report, summary }, "goal.round.settled");
      return verified.decision;
    }
    if (goal.currentState !== "active") {
      return { action: "none" };
    }

    if (intent?.status === "blocked") {
      this.saveGoal({
        ...goal,
        currentState: "blocked",
        armed: false,
        stopReason: "task_failed",
        nextHandoff: normalizeNote(intent.note, "模型报告当前目标被阻塞")
      });
      return { action: "blocked", reason: "task_failed", detail: intent.note };
    }
    if (intent?.status === "needs_input") {
      this.saveGoal({
        ...goal,
        currentState: "awaiting_user",
        stopReason: "needs_input",
        nextHandoff: normalizeNote(intent.note, "需要你补充信息后继续")
      });
      return { action: "gate", reason: "needs_input", detail: intent.note };
    }

    const noProgress = digest === goal.lastProgressDigest
      ? (goal.noProgressCount ?? 0) + 1
      : 0;
    // Progress tracking is informational only. A goal keeps advancing even when
    // consecutive rounds look similar, because stopping here would be a hidden
    // product-level round limit.
    this.saveGoal({
      ...goal,
      noProgressCount: noProgress,
      lastProgressDigest: digest,
      nextWakeAt: null,
      nextHandoff: "准备下一轮"
    });
    const nextIndex = (goal.roundCount ?? round.index) + 1;
    return {
      action: "continue",
      prompt: buildGoalRoundPrompt(goal, this.service.store.listGoalRounds(goal.goalId), nextIndex),
      detail: `准备第 ${nextIndex} 轮`
    };
  }

  onRunFailed(task: TaskRecord, detail: string): void {
    const goal = this.goalForTask(task);
    if (!goal || isGoalTerminal(goal.currentState)) return;
    const latest = this.service.store.latestGoalRound(goal.goalId);
    if (latest && ["running", "gated", "paused"].includes(latest.status)) {
      this.saveRound({ ...latest, status: "failed", endedAt: this.now().toISOString() }, "goal.round.settled");
    }
    this.saveGoal({
      ...goal,
      currentState: "blocked",
      armed: false,
      stopReason: "task_failed",
      nextWakeAt: null,
      nextHandoff: `本轮执行失败：${clipText(detail, 1200)}。修复后可以重新规划继续`
    });
  }

  onTaskGated(task: TaskRecord, reason: "needs_input" | "approval" | "pause"): void {
    const goal = this.goalForTask(task);
    if (!goal) return;
    const latest = this.service.store.latestGoalRound(goal.goalId);
    if (latest && latest.status === "running") {
      this.saveRound({ ...latest, status: reason === "pause" ? "paused" : "gated" }, "goal.round.settled");
    }
    if (reason === "pause") {
      this.saveGoal({ ...goal, currentState: "paused", armed: false, nextHandoff: "目标已暂停" });
      return;
    }
    if (goal.currentState === "active" || goal.currentState === "validating") {
      assertGoalTransition(goal.currentState, "awaiting_user");
      this.saveGoal({
        ...goal,
        currentState: "awaiting_user",
        stopReason: reason,
        nextHandoff: reason === "approval" ? "等待你确认外部动作" : "等待你补充信息"
      });
    }
  }

  onTaskInterrupted(task: TaskRecord, reason: GoalStopReason, detail: string): void {
    const goal = this.goalForTask(task);
    if (!goal || isGoalTerminal(goal.currentState)) return;
    const latest = this.service.store.latestGoalRound(goal.goalId);
    if (latest && ["running", "gated", "paused"].includes(latest.status)) {
      this.saveRound({ ...latest, status: "gated" }, "goal.round.settled");
    }
    this.saveGoal({
      ...goal,
      currentState: "awaiting_user",
      armed: false,
      stopReason: reason,
      nextWakeAt: null,
      nextHandoff: clipText(detail, 1200)
    });
  }

  onTaskCancelled(task: TaskRecord): void {
    const goal = this.goalForTask(task);
    if (!goal || isGoalTerminal(goal.currentState)) return;
    this.saveGoal({
      ...goal,
      currentState: "cancelled",
      armed: false,
      stopReason: "user_stop",
      nextHandoff: "任务已取消，目标随之停止"
    });
  }

  workRound(task: TaskRecord): GoalRoundRecord | null {
    const goal = this.goalForTask(task);
    if (!goal) return null;
    return this.service.store.latestGoalRound(goal.goalId);
  }

  openRoundForTask(task: TaskRecord): GoalRoundRecord | null {
    const latest = this.workRound(task);
    return latest && ["running", "gated", "paused"].includes(latest.status) ? latest : null;
  }

  private async maybeVerify(
    goal: GoalContract,
    round: GoalRoundRecord,
    input: RunCompletedInput,
    intent: GoalRoundIntent | null
  ): Promise<{ report: GoalCompletionReport; decision: GoalRoundDecision } | null> {
    const shouldVerify = intent?.status === "complete"
      || this.isCheapVerification(goal);
    if (!shouldVerify) return null;
    const state = goal.currentState;
    if (state !== "active" && state !== "awaiting_user" && state !== "validating") return null;
    if (state !== "validating") {
      assertGoalTransition(state, "validating");
      goal = this.saveGoal({ ...goal, currentState: "validating", nextHandoff: "正在验收本轮结果" });
    }
    const report = await verifyGoalCompletion({
      goal,
      taskId: input.task.id,
      roundRunId: input.run.id,
      workspaceRoot: round.workspaceRoot ?? input.workspaceRoot,
      outDir: round.outDir ?? input.outDir,
      artifacts: this.service.store.listArtifacts(input.task.id).filter((artifact) => artifact.runId === input.run.id),
      actions: observedActions(this.service, input.task.id),
      review: this.review,
      runCommand: this.runCommand
    });
    this.appendReport(report);
    if (report.verdict === "pass") {
      if (goal.reviewPolicy === "human_on_complete") {
        this.saveGoal({
          ...goal,
          currentState: "awaiting_user",
          armed: false,
          stopReason: "verifier",
          nextHandoff: "验收已通过，等待你确认完成"
        });
        return { report, decision: { action: "gate", reason: "verifier", detail: "验收已通过，等待你确认完成" } };
      }
      if (goal.reviewPolicy === "human_on_risk" && (report.missingEvidence.length > 0 || report.forbiddenActions.length > 0)) {
        this.saveGoal({
          ...goal,
          currentState: "awaiting_user",
          armed: false,
          stopReason: "verifier",
          nextHandoff: "验收有风险项，等待你确认"
        });
        return { report, decision: { action: "gate", reason: "verifier", detail: "验收有风险项，等待你确认" } };
      }
      assertGoalTransition("validating", "done");
      this.saveGoal({
        ...goal,
        currentState: "done",
        armed: false,
        stopReason: null,
        nextWakeAt: null,
        nextHandoff: "验收通过，目标已完成"
      });
      return { report, decision: { action: "done", report } };
    }
    const failures = this.service.store.listGoalRounds(goal.goalId)
      .filter((item) => item.verifier?.verdict === "fail").length;
    if (report.verdict === "needs_human" || failures >= 2) {
      assertGoalTransition("validating", "awaiting_user");
      this.saveGoal({
        ...goal,
        currentState: "awaiting_user",
        armed: false,
        stopReason: "verifier",
        nextHandoff: report.summary
      });
      return { report, decision: { action: "gate", reason: "verifier", detail: report.summary } };
    }
    assertGoalTransition("validating", "active");
    this.saveGoal({
      ...goal,
      currentState: "active",
      armed: true,
      stopReason: null,
      nextHandoff: `验收未通过：${clipText(report.summary, 800)}`
    });
    return {
      report,
      decision: {
        action: "continue",
        prompt: buildGoalRoundPrompt(
          { ...goal, currentState: "active", armed: true },
          this.service.store.listGoalRounds(goal.goalId),
          (goal.roundCount ?? round.index) + 1,
          report.summary
        ),
        detail: "验收未通过，继续修复"
      }
    };
  }

  private isCheapVerification(goal: GoalContract): boolean {
    if (goal.successCriteria.length === 0) return false;
    return goal.successCriteria
      .filter((criterion) => criterion.required)
      .every((criterion) => !["llm_review", "manual"].includes(criterion.validator));
  }

  private async requestVerification(goal: GoalContract, note: string): Promise<GoalContract> {
    if (!goal.taskId) throw new GoalStateError("GOAL_STATE_INVALID", "目标还没有绑定任务");
    const task = this.service.store.getTask(goal.taskId);
    if (task?.status === "running" || task?.status === "queued") {
      throw new GoalStateError("GOAL_STATE_INVALID", "任务仍在运行，等本轮结束后再验收");
    }
    const round = this.service.store.latestGoalRound(goal.goalId);
    if (!round || !round.outDir || !round.workspaceRoot) {
      throw new GoalStateError("GOAL_STATE_INVALID", "还没有可验收的轮次");
    }
    assertGoalTransition(goal.currentState, "validating");
    const verifying = this.saveGoal({
      ...goal,
      currentState: "validating",
      armed: false,
      nextHandoff: note || "正在验收最近一轮"
    });
    const report = await verifyGoalCompletion({
      goal: verifying,
      taskId: goal.taskId,
      roundRunId: round.runIds.at(-1) ?? "",
      workspaceRoot: round.workspaceRoot,
      outDir: round.outDir,
      artifacts: this.service.store.listArtifacts(goal.taskId).filter((artifact) => round.runIds.includes(artifact.runId)),
      actions: observedActions(this.service, goal.taskId),
      review: this.review,
      runCommand: this.runCommand
    });
    this.appendReport(report);
    this.saveRound({ ...round, verifier: report }, "goal.round.settled");
    if (report.verdict === "pass") {
      assertGoalTransition("validating", "done");
      return this.saveGoal({ ...verifying, currentState: "done", armed: false, nextHandoff: "验收通过" });
    }
    assertGoalTransition("validating", "awaiting_user");
    return this.saveGoal({
      ...verifying,
      currentState: "awaiting_user",
      stopReason: "verifier",
      nextHandoff: report.summary
    });
  }

  private startRound(goalInput: GoalContract, _maxRounds?: number): void {
    if (!this.scheduler) return;
    const taskId = goalInput.taskId;
    if (!taskId) return;
    const goal = goalInput;
    const nextIndex = (goal.roundCount ?? 0) + 1;
    const prompt = buildGoalRoundPrompt(goal, this.service.store.listGoalRounds(goal.goalId), nextIndex);
    this.scheduler.requeueGoalTask(taskId, prompt, { allowCompleted: true });
    this.scheduler.kick();
  }

  private openRound(goalInput: GoalContract, input: RunStartedInput): { round: GoalRoundRecord; goalNext: GoalContract } {
    const goal = normalizeGoal(goalInput);
    const rounds = this.service.store.listGoalRounds(goal.goalId);
    const open = rounds.find((item) => ["running", "gated", "paused"].includes(item.status));
    if (open) {
      const next: GoalRoundRecord = {
        ...open,
        runIds: uniqueStrings([...open.runIds, input.run.id]),
        status: "running",
        endedAt: null,
        workspaceRoot: input.workspaceRoot,
        outDir: input.outDir
      };
      return { round: next, goalNext: goal };
    }
    const index = (rounds.at(-1)?.index ?? 0) + 1;
    const round: GoalRoundRecord = {
      id: `goal-round-${randomUUID()}`,
      goalId: goal.goalId,
      taskId: input.task.id,
      index,
      runIds: [input.run.id],
      status: "running",
      startedAt: this.now().toISOString(),
      endedAt: null,
      summary: null,
      intent: null,
      artifactRefs: [],
      evidenceRefs: [],
      usage: null,
      progressDigest: null,
      verifier: null,
      workspaceRoot: input.workspaceRoot,
      outDir: input.outDir
    };
    const nextGoal: GoalContract = {
      ...goal,
      roundCount: Math.max(goal.roundCount ?? 0, index),
      revision: (goal.revision ?? 0) + 1,
      updatedAt: this.now().toISOString()
    };
    return { round, goalNext: nextGoal };
  }

  private goalForTask(task: TaskRecord): GoalContract | null {
    if (!task.goalId) return null;
    const goal = this.service.store.getGoal(task.goalId);
    return goal ? normalizeGoal(goal) : null;
  }

  private saveGoal(goal: GoalContract): GoalContract {
    const next: GoalContract = {
      ...goal,
      revision: (goal.revision ?? 0) + 1,
      updatedAt: this.now().toISOString()
    };
    this.appendGoal("goal.updated", next);
    return next;
  }

  private appendGoal(type: "goal.created" | "goal.updated", goal: GoalContract): void {
    const event = this.service.store.appendEvent({ type, taskId: goal.taskId ?? null, payload: goal });
    this.service.bus.publish(event);
  }

  private saveRound(round: GoalRoundRecord, type: "goal.round.started" | "goal.round.settled"): void {
    const event = this.service.store.appendEvent({
      type,
      taskId: round.taskId,
      runId: round.runIds.at(-1) ?? null,
      payload: round
    });
    this.service.bus.publish(event);
  }

  private appendReport(report: GoalCompletionReport): void {
    const event = this.service.store.appendEvent({
      type: "goal.completion.recorded",
      taskId: report.taskId,
      payload: report
    });
    this.service.bus.publish(event);
  }
}

function readGoalIntent(outDir: string): GoalRoundIntent | null {
  const path = join(outDir, "goal-intent.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const status = raw.status;
    if (status !== "progress" && status !== "complete" && status !== "blocked" && status !== "needs_input") return null;
    return {
      status,
      note: typeof raw.note === "string" ? raw.note.slice(0, 5000) : "",
      evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((item): item is string => typeof item === "string").slice(0, 50) : [],
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString()
    };
  } catch {
    return null;
  }
}

export function buildGoalRoundPrompt(
  goalInput: GoalContract,
  rounds: GoalRoundRecord[],
  nextIndex: number,
  verifierNote?: string
): string {
  const goal = normalizeGoal(goalInput);
  const previous = rounds.slice(-2);
  const criteria = goal.successCriteria.length > 0
    ? goal.successCriteria.map((criterion, index) =>
      `${index + 1}. [${criterion.validator}] ${criterion.description}${criterion.required ? "" : "（非必需）"}`
    ).join("\n")
    : "未设置显式标准：由独立验收器根据目标和证据判断是否达成。";
  const history = previous.map((round) => [
    `- 第 ${round.index} 轮（${round.status}）：${clipText(round.summary ?? "无摘要", 600)}`,
    round.intent ? `  意图：${round.intent.status} — ${clipText(round.intent.note, 300)}` : "",
    round.verifier ? `  验收：${round.verifier.verdict} — ${clipText(round.verifier.summary, 300)}` : "",
    round.artifactRefs.length > 0 ? `  产物：${round.artifactRefs.slice(0, 12).join("、")}` : ""
  ].filter(Boolean).join("\n")).join("\n");

  return [
    `# 目标模式 · 第 ${nextIndex} 轮`,
    "",
    `## 目标`,
    goal.objective,
    "",
    goal.constraints.length > 0 ? `## 约束\n${goal.constraints.map((item) => `- ${item}`).join("\n")}` : "",
    goal.forbiddenActions.length > 0 ? `## 禁止动作\n${goal.forbiddenActions.map((item) => `- ${item}`).join("\n")}` : "",
    `## 成功标准\n${criteria}`,
    goal.evidenceRequirements.length > 0 ? `## 证据要求\n${goal.evidenceRequirements.map((item) => `- ${item}`).join("\n")}` : "",
    goal.stopConditions.length > 0 ? `## 停止条件\n${goal.stopConditions.map((item) => `- ${item}`).join("\n")}` : "",
    history ? `## 最近轮次\n${history}` : "",
    verifierNote ? `## 上一轮验收结论\n${clipText(verifierNote, 1200)}` : "",
    "",
    "## 本轮规则",
    "- 持续推进直到成功标准满足，没有轮次或时间上限；沿用当前工作区、已有产物和检查点，不要从零重做。",
    "- 先查看上一轮产物和未完成项，再做当前最有价值的动作。",
    "- 遇到失败先诊断并换路线重试；只有确实需要用户提供无法自行获取的信息时，才报告 needs_input。",
    "- 只有成功标准全部满足、证据齐全时，才报告 complete；由独立验收器最终判定，模型自评不算完成。",
    "- 本轮结束前，在本轮输出目录写入 `goal-intent.json`：",
    "  {\"status\":\"progress|complete|blocked|needs_input\",\"note\":\"本轮结果摘要\",\"evidence\":[\"相对路径或产物 id\"]}",
    "- 可用 `get_goal` 查看目标全貌，用 `update_goal` 记录本轮意图。不要创建新的目标。",
    ""
  ].filter(Boolean).join("\n");
}

function usageOfRun(run: RunRecord): GoalRoundRecord["usage"] {
  const started = run.startedAt ? Date.parse(run.startedAt) : null;
  const ended = run.endedAt ? Date.parse(run.endedAt) : null;
  return {
    tokens: (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0),
    turns: run.usage?.turns ?? 0,
    toolCalls: run.usage?.toolCalls ?? 0,
    durationMs: started !== null && Number.isFinite(started)
      ? Math.max(0, (ended !== null && Number.isFinite(ended) ? ended : Date.now()) - started)
      : 0
  };
}

function observedActions(service: HearthService, taskId: string): GoalObservedAction[] {
  const approvals = service.store.listApprovals(taskId).map((approval) => ({
    kind: approval.kind ?? "approval",
    summary: approval.summary ?? approval.kind ?? "approval"
  }));
  const effects = service.store.listEffects(taskId).map((effect) => ({
    kind: effect.effectType ?? "effect",
    summary: effect.targetKey ?? effect.effectType ?? "effect"
  }));
  return [...approvals, ...effects];
}

function sanitizeBudget(budget: {
  maxTurns?: number | undefined;
  maxToolCalls?: number | undefined;
  maxTokens?: number | undefined;
  maxDurationMs?: number | undefined;
  maxHumanMinutes?: number | undefined;
}): GoalContract["budget"] {
  const result: GoalContract["budget"] = {};
  const apply = (key: "maxTurns" | "maxToolCalls" | "maxTokens" | "maxDurationMs" | "maxHumanMinutes", value: number | undefined): void => {
    if (value !== undefined && Number.isFinite(value) && value >= 0) {
      result[key] = Math.trunc(value);
    }
  };
  apply("maxTurns", budget.maxTurns);
  apply("maxToolCalls", budget.maxToolCalls);
  apply("maxTokens", budget.maxTokens);
  apply("maxDurationMs", budget.maxDurationMs);
  apply("maxHumanMinutes", budget.maxHumanMinutes);
  return result;
}

function titleFromObjective(objective: string): string {
  const firstLine = objective.split("\n")[0]?.trim() ?? "";
  return (firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine) || "持久目标";
}

function normalizeNote(value: string | undefined, fallback: string): string {
  return clipText(value?.trim() || fallback, 1200);
}

function clipText(value: string, max: number): string {
  const text = value.replace(/\r\n/g, "\n").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

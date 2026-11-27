import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ArtifactRecord,
  ExecutorHealth,
  ExecutorId,
  GoalAction,
  GoalCompletionReport,
  GoalContract,
  GoalContractAmendment,
  GoalContractPatch,
  GoalContractSnapshot,
  GoalEligibility,
  GoalEvidenceRef,
  GoalExecutionProfile,
  GoalRoundIntent,
  GoalRoundRecord,
  GoalStopReason,
  GoalView,
  TaskInput,
  TaskPauseResult,
  TaskPermissions,
  TaskRecord,
  TaskResumeReference,
  RunRecord
} from "@hearth/core";
import {
  EXECUTOR_IDS,
  TASK_KINDS,
  GoalStateError,
  assertGoalAction,
  assertGoalTransition,
  evaluateGoalEligibility,
  goalBackoffMs,
  goalEvidenceKey,
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
  replanGoalTask(
    taskId: string,
    prompt: string,
    beforeWake?: (task: TaskRecord) => void
  ): Promise<TaskRecord>;
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

export interface GoalActionOptions {
  expectedRevision?: number;
  note?: string;
  maxRounds?: number;
  execution?: GoalExecutionProfile;
  contract?: GoalContractPatch;
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
      originalObjective: objective,
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
      contractRevision: 0,
      executionRevision: 0,
      amendments: [],
      pauseReference: null,
      commandsApprovedAt: null
    };
    this.appendGoal("goal.created", goal);
    if (input.conversationId) {
      // 目标与计划模式互斥：开始一个目标必须落掉残留的 Plan 开关，
      // 否则后续普通消息会被 PLAN_GOAL_CONFLICT 永久挡住。
      this.service.store.updateConversationSettings(input.conversationId, { collaborationMode: "build" });
    }
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
    options: GoalActionOptions = {}
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
        const task = goal.taskId ? this.service.store.getTask(goal.taskId) : null;
        const nextIndex = (goal.roundCount ?? 0) + 1;
        const replannedGoal: GoalContract = {
          ...goal,
          currentState: "active",
          armed: true,
          stopReason: null,
          nextWakeAt: null,
          noProgressCount: 0,
          lastProgressDigest: null,
          nextHandoff: note || "已重新规划，换一条路线继续",
          updatedAt: this.now().toISOString()
        };
        if (!task) {
          goal = this.saveGoal(replannedGoal);
          break;
        }
        if (!this.scheduler) throw new GoalStateError("GOAL_STATE_INVALID", "调度器没有启动，不能重新规划");
        const prompt = [
          buildGoalRoundPrompt(replannedGoal, this.service.store.listGoalRounds(goal.goalId), nextIndex),
          note ? `## 用户重新规划要求\n${note}` : "",
          "## 重新规划规则\n保留已有产物、轮次和证据。安全停止上一轮正在执行的生成，清除无进展计数，然后立即按新路线继续。不要重做已经验证完成的工作。"
        ].filter(Boolean).join("\n\n");
        try {
          await this.scheduler.replanGoalTask(task.id, prompt, () => {
            goal = this.saveGoal(replannedGoal);
          });
        } catch (error) {
          this.saveGoal({
            ...this.get(goal.goalId),
            currentState: "blocked",
            armed: false,
            stopReason: "task_failed",
            nextWakeAt: null,
            nextHandoff: `重新规划失败：${error instanceof Error ? error.message : String(error)}`
          });
          throw error;
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
        const latestRound = this.service.store.latestGoalRound(goal.goalId);
        goal = this.saveGoal({
          ...goal,
          currentState: "done",
          armed: false,
          stopReason: null,
          nextWakeAt: null,
          nextHandoff: note || "验收通过，目标已完成"
        });
        this.publishFinalAnswer(goal, latestRound?.summary ?? null, report.summary, goal.taskId ?? null);
        break;
      }
      case "switch_executor": {
        if (!options.execution) {
          throw new GoalStateError("GOAL_CONTRACT_INVALID", "切换执行器需要完整的执行配置");
        }
        goal = this.switchExecutor(goal, options.execution, note);
        break;
      }
      case "amend_contract": {
        if (!options.contract || Object.keys(options.contract).length === 0) {
          throw new GoalStateError("GOAL_CONTRACT_INVALID", "契约修订不能为空");
        }
        goal = this.amendContract(goal, options.contract, note);
        break;
      }
    }
    return this.view(goal.goalId);
  }

  private switchExecutor(goal: GoalContract, execution: GoalExecutionProfile, note: string): GoalContract {
    const task = goal.taskId ? this.service.store.getTask(goal.taskId) : null;
    if (!task) throw new GoalStateError("GOAL_STATE_INVALID", "目标还没有绑定可切换的执行任务");
    if (task.status === "running" || task.status === "queued") {
      throw new GoalStateError("GOAL_EXECUTION_CONFLICT", "目标任务仍在运行或排队，等本轮结束后再切换执行器");
    }
    const normalized = normalizeExecutionProfile(execution);
    const project = normalized.projectId
      ? this.service.store.getLocalProject(normalized.projectId)
      : null;
    if (normalized.projectId && !project) {
      throw new GoalStateError("GOAL_CONTRACT_INVALID", "切换目标引用了不存在的本地项目");
    }
    const workspacePath = normalized.workspacePath ? resolve(normalized.workspacePath) : null;
    if (workspacePath && (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory())) {
      throw new GoalStateError("GOAL_CONTRACT_INVALID", "切换目标指定的工作目录不存在");
    }
    const workspaceRoot = workspacePath
      ? realpathSync.native(workspacePath)
      : project
        ? resolve(project.path)
        : null;
    const inputs: TaskInput[] = task.inputs.filter((item) => item.kind !== "workspace");
    if (workspaceRoot) inputs.push({ kind: "workspace", label: "工作目录", value: workspaceRoot });
    const permissions: TaskPermissions = {
      ...(task.permissions ?? {}),
      readRoots: workspaceRoot ? [workspaceRoot] : task.permissions?.readRoots ?? [],
      writeRoots: workspaceRoot ? [workspaceRoot] : task.permissions?.writeRoots ?? [],
      networkHosts: normalized.networkHosts,
      networkMode: "open",
      tools: task.permissions?.tools ?? [],
      fullAccess: true,
      approvalMode: "full",
      sandboxMode: "danger-full-access"
    };
    const updatedTask = this.service.updateTask(task.id, {
      executorId: normalized.executorId,
      taskKind: normalized.taskKind,
      expectedOutputs: normalized.expectedOutputs,
      projectId: normalized.projectId ?? null,
      networkHosts: normalized.networkHosts,
      inputs,
      permissions,
      currentRunId: null,
      nextAction: `已切换到 ${normalized.executorId}，等待下一轮`,
      error: null,
      ...(normalized.executionMode && normalized.executorId === "native" ? { executionMode: normalized.executionMode } : {})
    }, task.currentRunId ?? undefined);
    if (!updatedTask) throw new GoalStateError("GOAL_STATE_INVALID", "执行任务切换失败");
    return this.saveGoal({
      ...goal,
      execution: normalized,
      executionRevision: (goal.executionRevision ?? 0) + 1,
      pauseReference: null,
      nextHandoff: note || `下一轮改用 ${normalized.executorId} 执行`
    });
  }

  private amendContract(goal: GoalContract, patch: GoalContractPatch, note: string): GoalContract {
    const before = contractSnapshot(goal);
    const criteria = patch.successCriteria === undefined
      ? goal.successCriteria
      : sanitizeCriteria(patch.successCriteria);
    if (patch.successCriteria !== undefined && criteria.length === 0) {
      throw new GoalStateError("GOAL_CONTRACT_INVALID", "成功标准不能为空");
    }
    const next: GoalContract = {
      ...goal,
      title: patch.title === undefined ? goal.title : requiredText(patch.title, "标题", 200),
      objective: patch.objective === undefined ? goal.objective : requiredText(patch.objective, "目标", 20_000),
      constraints: patch.constraints === undefined ? goal.constraints : uniqueStrings(patch.constraints).slice(0, 20),
      forbiddenActions: patch.forbiddenActions === undefined ? goal.forbiddenActions : uniqueStrings(patch.forbiddenActions).slice(0, 20),
      successCriteria: criteria,
      evidenceRequirements: patch.evidenceRequirements === undefined
        ? goal.evidenceRequirements
        : uniqueStrings(patch.evidenceRequirements).slice(0, 20),
      budget: patch.budget === undefined ? goal.budget : sanitizeBudget(patch.budget),
      stopConditions: patch.stopConditions === undefined
        ? goal.stopConditions
        : uniqueStrings(patch.stopConditions).slice(0, 20),
      reviewPolicy: patch.reviewPolicy ?? goal.reviewPolicy,
      originalObjective: goal.originalObjective ?? goal.objective
    };
    if (patch.deadline !== undefined) {
      if (patch.deadline === null) delete next.deadline;
      else next.deadline = requiredText(patch.deadline, "截止时间", 100);
    }
    const after = contractSnapshot(next);
    const commandsChanged = commandCriteriaKey(before.successCriteria) !== commandCriteriaKey(after.successCriteria);
    const amendment: GoalContractAmendment = {
      revision: (goal.contractRevision ?? 0) + 1,
      at: this.now().toISOString(),
      source: "user",
      note: note || "用户调整目标契约",
      previous: before,
      next: after,
      commandsApprovalCleared: commandsChanged && Boolean(goal.commandsApprovedAt)
    };
    return this.saveGoal({
      ...next,
      contractRevision: amendment.revision,
      amendments: [...(goal.amendments ?? []), amendment],
      ...(commandsChanged ? { commandsApprovedAt: null } : {}),
      nextHandoff: note || "目标契约已更新，下一轮使用新契约",
      nextWakeAt: null
    });
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
      assertGoalTransition(goal.currentState, "paused");
      this.saveGoal({
        ...goal,
        currentState: "paused",
        armed: false,
        nextWakeAt: null,
        stopReason: "host_restart",
        nextHandoff: "宿主重启，上一轮已中断。检查后点击继续，从新轮次开始"
      });
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
    const fenceError = completionFenceError(goal, round, input.task, input.run, this.service.store.getTask(input.task.id));
    if (fenceError) {
      this.appendRejectedResult(goal, round, input.run.id, fenceError);
      return { action: "none" };
    }
    const intent = readGoalIntent(input.outDir, input.run.id);
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
      if (verified.report) {
        this.saveRound({ ...round, verifier: verified.report, summary }, "goal.round.settled");
      }
      if (verified.decision.action !== "done" && verified.decision.action !== "none") {
        this.publishRoundAnswer(goal, round, input.finalResponse);
      }
      return verified.decision;
    }
    if (goal.currentState !== "active") {
      return { action: "none" };
    }

    if (intent?.status === "blocked") {
      this.publishRoundAnswer(goal, round, input.finalResponse);
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
      this.publishRoundAnswer(goal, round, input.finalResponse);
      this.saveGoal({
        ...goal,
        currentState: "awaiting_user",
        stopReason: "needs_input",
        nextHandoff: normalizeNote(intent.note, "需要你补充信息后继续")
      });
      return { action: "gate", reason: "needs_input", detail: intent.note };
    }

    goal = this.recordProgress(goal, digest);
    if (goal.currentState === "blocked") {
      this.publishRoundAnswer(goal, round, input.finalResponse);
      return { action: "blocked", reason: "no_progress", detail: goal.nextHandoff ?? "连续多轮没有形成新证据或产物" };
    }
    const nextIndex = (goal.roundCount ?? round.index) + 1;
    this.publishRoundAnswer(goal, round, input.finalResponse);
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
  ): Promise<{ report: GoalCompletionReport | null; decision: GoalRoundDecision } | null> {
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
      intentEvidence: intent?.evidence ?? [],
      previousRounds: this.service.store.listGoalRounds(goal.goalId).filter((item) => item.id !== round.id),
      actions: observedActions(this.service, input.task.id, input.run.id),
      review: this.review,
      runCommand: this.runCommand
    });
    const currentGoal = this.get(goal.goalId);
    const staleReason = verificationContextError(
      currentGoal,
      goal,
      round,
      this.service.store.getTask(input.task.id),
      input.run.id
    );
    if (staleReason) {
      this.appendRejectedResult(currentGoal, round, input.run.id, staleReason);
      if (currentGoal.currentState === "validating") {
        this.saveGoal({
          ...currentGoal,
          currentState: "awaiting_user",
          armed: false,
          stopReason: "verifier",
          nextHandoff: "验收期间契约或执行器发生变化，旧验收结果已丢弃；检查后继续"
        });
      }
      return { report: null, decision: { action: "none" } };
    }
    goal = currentGoal;
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
      const completed = this.saveGoal({
        ...goal,
        currentState: "done",
        armed: false,
        stopReason: null,
        nextWakeAt: null,
        nextHandoff: "验收通过，目标已完成"
      });
      this.publishFinalAnswer(completed, input.finalResponse, report.summary, input.task.id);
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
    const active = this.saveGoal({
      ...goal,
      currentState: "active",
      armed: true,
      stopReason: null,
      nextHandoff: `验收未通过：${clipText(report.summary, 800)}`
    });
    const progressed = this.recordProgress(active, round.progressDigest ?? goalProgressDigest({
      artifactHashes: round.artifactRefs,
      summary: round.summary ?? "",
      intentEvidence: round.intent?.evidence ?? []
    }));
    if (progressed.currentState === "blocked") {
      return {
        report,
        decision: { action: "blocked", reason: "no_progress", detail: progressed.nextHandoff ?? report.summary }
      };
    }
    return {
      report,
      decision: {
        action: "continue",
        prompt: buildGoalRoundPrompt(
          progressed,
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
      intentEvidence: round.intent?.evidence ?? [],
      previousRounds: this.service.store.listGoalRounds(goal.goalId).filter((item) => item.id !== round.id),
      actions: observedActions(this.service, goal.taskId, round.runIds.at(-1) ?? ""),
      review: this.review,
      runCommand: this.runCommand
    });
    const runId = round.runIds.at(-1) ?? "";
    const currentGoal = this.get(goal.goalId);
    const staleReason = verificationContextError(
      currentGoal,
      verifying,
      round,
      this.service.store.getTask(goal.taskId),
      runId
    );
    if (staleReason) {
      this.appendRejectedResult(currentGoal, round, runId, staleReason);
      if (currentGoal.currentState === "validating") {
        return this.saveGoal({
          ...currentGoal,
          currentState: "awaiting_user",
          armed: false,
          stopReason: "verifier",
          nextHandoff: "验收期间契约或执行器发生变化，旧验收结果已丢弃；检查后继续"
        });
      }
      return currentGoal;
    }
    this.appendReport(report);
    this.saveRound({ ...round, verifier: report }, "goal.round.settled");
    if (report.verdict === "pass") {
      assertGoalTransition("validating", "done");
      const completed = this.saveGoal({ ...currentGoal, currentState: "done", armed: false, nextHandoff: "验收通过" });
      this.publishFinalAnswer(completed, round.summary, report.summary, goal.taskId);
      return completed;
    }
    assertGoalTransition("validating", "awaiting_user");
    return this.saveGoal({
      ...currentGoal,
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
      const goalRevision = goal.revision ?? 0;
      const next: GoalRoundRecord = {
        ...open,
        runIds: uniqueStrings([...open.runIds, input.run.id]),
        status: "running",
        endedAt: null,
        workspaceRoot: input.workspaceRoot,
        outDir: input.outDir,
        executionFence: {
          taskId: input.task.id,
          runId: input.run.id,
          executorId: input.run.executorId ?? input.task.executorId ?? goal.execution?.executorId ?? "native",
          goalRevision,
          contractRevision: goal.contractRevision ?? 0,
          executionRevision: goal.executionRevision ?? 0
        }
      };
      return { round: next, goalNext: goal };
    }
    const index = (rounds.at(-1)?.index ?? 0) + 1;
    const nextGoal: GoalContract = {
      ...goal,
      roundCount: Math.max(goal.roundCount ?? 0, index),
      revision: (goal.revision ?? 0) + 1,
      updatedAt: this.now().toISOString()
    };
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
      outDir: input.outDir,
      executionFence: {
        taskId: input.task.id,
        runId: input.run.id,
        executorId: input.run.executorId ?? input.task.executorId ?? goal.execution?.executorId ?? "native",
        goalRevision: nextGoal.revision ?? goal.revision ?? 0,
        contractRevision: goal.contractRevision ?? 0,
        executionRevision: goal.executionRevision ?? 0
      }
    };
    return { round, goalNext: nextGoal };
  }

  private recordProgress(goal: GoalContract, digest: string): GoalContract {
    const same = goal.lastProgressDigest !== null && digest === goal.lastProgressDigest;
    const noProgressCount = same ? (goal.noProgressCount ?? 0) + 1 : 0;
    if (noProgressCount >= 3) {
      return this.saveGoal({
        ...goal,
        currentState: "blocked",
        armed: false,
        noProgressCount,
        lastProgressDigest: digest,
        stopReason: "no_progress",
        nextWakeAt: null,
        nextHandoff: "连续四轮没有新增证据、产物或验收进展。请调整契约或切换执行器后继续"
      });
    }
    return this.saveGoal({
      ...goal,
      noProgressCount,
      lastProgressDigest: digest,
      nextWakeAt: null,
      nextHandoff: noProgressCount >= 1
        ? "连续两轮没有新增证据或产物，下一轮必须换路线并留下可核验证据"
        : "准备下一轮"
    });
  }

  private goalForTask(task: TaskRecord): GoalContract | null {
    if (!task.goalId) return null;
    const goal = this.service.store.getGoal(task.goalId);
    return goal ? normalizeGoal(goal) : null;
  }

  private publishRoundAnswer(goal: GoalContract, round: GoalRoundRecord, answer: string | null | undefined): void {
    if (!goal.conversationId) return;
    const body = clipText(answer?.trim() ?? "", 6000);
    if (!body) return;
    const messageId = `goal-round-${round.id}`;
    const messages = this.service.store.listChatMessages(goal.conversationId);
    if (messages.some((message) => message.id === messageId)) return;
    this.service.appendChatMessage({
      id: messageId,
      conversationId: goal.conversationId,
      role: "assistant",
      content: body,
      taskId: round.taskId,
      attachments: [],
      createdAt: this.now().toISOString(),
      kind: "text",
      taskStatus: "completed"
    });
  }

  private publishFinalAnswer(
    goal: GoalContract,
    answer: string | null | undefined,
    verification: string | null | undefined,
    taskId: string | null
  ): void {
    if (!goal.conversationId) return;
    const messageId = `goal-final-${goal.goalId}`;
    const messages = this.service.store.listChatMessages(goal.conversationId);
    if (messages.some((message) => message.id === messageId)) return;
    const body = clipText(answer?.trim() ?? "", 6000);
    const verify = clipText(verification?.trim() ?? "", 1200);
    if (!body && !verify) return;
    const content = [
      body || "目标已完成。",
      verify && verify !== body ? `---\n\n**验收结果**\n\n${verify}` : ""
    ].filter(Boolean).join("\n\n");
    this.service.appendChatMessage({
      id: messageId,
      conversationId: goal.conversationId,
      role: "assistant",
      content,
      taskId,
      attachments: [],
      createdAt: this.now().toISOString(),
      kind: "text",
      taskStatus: "completed"
    });
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

  private appendRejectedResult(goal: GoalContract, round: GoalRoundRecord, runId: string, reason: string): void {
    const event = this.service.store.appendEvent({
      type: "goal.result.rejected",
      taskId: round.taskId,
      runId,
      payload: {
        goalId: goal.goalId,
        roundId: round.id,
        reason,
        goalRevision: goal.revision ?? 0,
        contractRevision: goal.contractRevision ?? 0,
        executionRevision: goal.executionRevision ?? 0,
        observedAt: this.now().toISOString()
      }
    });
    this.service.bus.publish(event);
  }
}

function readGoalIntent(outDir: string, runId: string): GoalRoundIntent | null {
  const path = join(outDir, "goal-intent.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const status = raw.status;
    if (status !== "progress" && status !== "complete" && status !== "blocked" && status !== "needs_input") return null;
    return {
      status,
      note: typeof raw.note === "string" ? raw.note.slice(0, 5000) : "",
      evidence: normalizeEvidence(raw.evidence, runId),
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
  const executorId = goal.execution?.executorId ?? "native";
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
    `## 当前契约\n- 契约修订：${goal.contractRevision ?? 0}\n- 执行修订：${goal.executionRevision ?? 0}\n- 执行器：${executorId}`,
    goal.originalObjective && goal.originalObjective !== goal.objective
      ? `## 原始目标（不可变）\n${goal.originalObjective}`
      : "",
    goal.evidenceRequirements.length > 0 ? `## 证据要求\n${goal.evidenceRequirements.map((item) => `- ${item}`).join("\n")}` : "",
    goal.stopConditions.length > 0 ? `## 停止条件\n${goal.stopConditions.map((item) => `- ${item}`).join("\n")}` : "",
    history ? `## 最近轮次\n${history}` : "",
    verifierNote ? `## 上一轮验收结论\n${clipText(verifierNote, 1200)}` : "",
    (goal.noProgressCount ?? 0) >= 1
      ? "## 无进展纠偏\n连续轮次没有新增证据或产物。下一轮必须改变路线，优先补齐可核验的文件、测试、命令或验收证据，并明确说明与上一轮的差异。"
      : "",
    "",
    "## 本轮规则",
    "- 持续推进直到成功标准满足，没有轮次或时间上限；沿用当前工作区、已有产物和检查点，不要从零重做。",
    "- 先查看上一轮产物和未完成项，再做当前最有价值的动作。",
    "- 遇到失败先诊断并换路线重试；只有确实需要用户提供无法自行获取的信息时，才报告 needs_input。",
    "- 只有成功标准全部满足、证据齐全时，才报告 complete；由独立验收器最终判定，模型自评不算完成。",
    "- 本轮结束前，在提示末尾给出的绝对“目标意图文件”路径写入 `goal-intent.json`：",
    "  {\"status\":\"progress|complete|blocked|needs_input\",\"note\":\"本轮结果摘要\",\"evidence\":[{\"ref\":\"相对路径、产物 id 或测试\",\"kind\":\"file|artifact|test|command|note\",\"sha256\":\"可选\",\"runId\":\"可选\"}]}",
    executorId === "native"
      ? "- 可用 `get_goal` 查看目标全貌，用 `update_goal` 记录本轮意图。不要创建新的目标。"
      : "- 当前执行器没有 Hearth 的 `get_goal` 或 `update_goal` 工具。目标状态以本提示和上面给出的意图文件协议为准，不要调用不存在的工具。",
    ""
  ].filter(Boolean).join("\n");
}

function completionFenceError(
  goal: GoalContract,
  round: GoalRoundRecord,
  task: TaskRecord,
  run: RunRecord,
  currentTask: TaskRecord | null
): string | null {
  const fence = round.executionFence;
  if (!fence) return null;
  if (fence.runId !== run.id || !round.runIds.includes(run.id)) return "结果不属于当前轮运行";
  if (fence.taskId !== task.id || round.taskId !== task.id) return "结果不属于当前锚点任务";
  if (currentTask?.currentRunId && currentTask.currentRunId !== run.id) return "任务已经进入新的运行";
  const runExecutor = run.executorId ?? task.executorId ?? "native";
  if (runExecutor !== fence.executorId) return "执行器已经切换，旧运行结果不能结算";
  if ((goal.execution?.executorId ?? "native") !== fence.executorId) return "目标执行器与当前轮不一致";
  if ((goal.contractRevision ?? 0) !== fence.contractRevision) return "目标契约已经修订";
  if ((goal.executionRevision ?? 0) !== fence.executionRevision) return "目标执行配置已经修订";
  if ((goal.revision ?? 0) !== fence.goalRevision) return "目标已经进入新的轮次";
  return null;
}

function verificationContextError(
  current: GoalContract,
  expected: GoalContract,
  round: GoalRoundRecord,
  task: TaskRecord | null,
  runId: string
): string | null {
  if (!round.runIds.includes(runId) || (round.executionFence && round.executionFence.runId !== runId)) {
    return "验收结果不属于当前轮运行";
  }
  if (current.currentState !== "validating") return "目标已经离开验收状态";
  if ((current.revision ?? 0) !== (expected.revision ?? 0)) return "验收期间目标已经被修改";
  if ((current.contractRevision ?? 0) !== (expected.contractRevision ?? 0)) return "验收期间目标契约已经修订";
  if ((current.executionRevision ?? 0) !== (expected.executionRevision ?? 0)) return "验收期间执行配置已经修订";
  if ((current.execution?.executorId ?? "native") !== (expected.execution?.executorId ?? "native")) {
    return "验收期间执行器已经切换";
  }
  if (task?.currentRunId && task.currentRunId !== runId) return "任务已经进入新的运行";
  if (task && (task.executorId ?? "native") !== (expected.execution?.executorId ?? "native")) {
    return "锚点任务执行器与验收上下文不一致";
  }
  return null;
}

function normalizeEvidence(value: unknown, runId: string): GoalEvidenceRef[] {
  if (!Array.isArray(value)) return [];
  const kinds = new Set(["artifact", "command", "file", "note", "review", "run", "test"]);
  const result: GoalEvidenceRef[] = [];
  for (const item of value.slice(0, 50)) {
    if (typeof item === "string") {
      const ref = item.trim().slice(0, 500);
      if (ref) result.push(ref);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const ref = typeof record.ref === "string" ? record.ref.trim().slice(0, 500) : "";
    if (!ref) continue;
    const kind = typeof record.kind === "string" && kinds.has(record.kind)
      ? record.kind as Exclude<GoalEvidenceRef, string>["kind"]
      : undefined;
    result.push({
      ref,
      ...(kind ? { kind } : {}),
      ...(typeof record.sha256 === "string" && /^[a-f0-9]{64}$/i.test(record.sha256)
        ? { sha256: record.sha256.toLowerCase() }
        : {}),
      ...(typeof record.runId === "string" && record.runId.trim() ? { runId: record.runId.trim() } : { runId }),
      observedAt: typeof record.observedAt === "string" && Number.isFinite(Date.parse(record.observedAt))
        ? record.observedAt
        : new Date().toISOString()
    });
  }
  return result;
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

function observedActions(service: HearthService, taskId: string, runId: string): GoalObservedAction[] {
  const approvals = service.store.listApprovals(taskId).map((approval) => ({
    kind: approval.kind ?? "approval",
    summary: approval.summary ?? approval.kind ?? "approval"
  }));
  const effects = service.store.listEffects(taskId).map((effect) => ({
    kind: effect.effectType ?? "effect",
    summary: effect.targetKey ?? effect.effectType ?? "effect"
  }));
  const context: GoalObservedAction[] = [];
  let beforeSeq: number | null = null;
  do {
    const page = service.store.listContextItems(taskId, {
      limit: 1_000,
      ...(beforeSeq === null ? {} : { beforeSeq })
    });
    for (const item of page.items) {
      if (item.runId !== runId || !["tool_call", "tool_result"].includes(item.kind)) continue;
      const provenance = item.provenance as Record<string, unknown>;
      const command = typeof provenance.command === "string" ? provenance.command : "";
      const tool = typeof provenance.tool === "string" ? provenance.tool : "";
      context.push({
        kind: item.kind,
        summary: clipText([tool, command, item.content].filter(Boolean).join(" "), 500)
      });
    }
    beforeSeq = page.nextBefore;
  } while (beforeSeq !== null);
  return [...approvals, ...effects, ...context];
}

function normalizeExecutionProfile(execution: GoalExecutionProfile): GoalExecutionProfile {
  if (!EXECUTOR_IDS.includes(execution.executorId as (typeof EXECUTOR_IDS)[number])) {
    throw new GoalStateError("GOAL_CONTRACT_INVALID", "执行器无效");
  }
  if (!TASK_KINDS.includes(execution.taskKind as (typeof TASK_KINDS)[number])) {
    throw new GoalStateError("GOAL_CONTRACT_INVALID", "任务类型无效");
  }
  return {
    executorId: execution.executorId,
    taskKind: execution.taskKind,
    expectedOutputs: uniqueStrings(execution.expectedOutputs).slice(0, 20),
    projectId: execution.projectId?.trim() || null,
    workspacePath: execution.workspacePath?.trim() || null,
    networkHosts: uniqueStrings(execution.networkHosts).slice(0, 20),
    ...(execution.executionMode ? { executionMode: execution.executionMode } : {})
  };
}

function contractSnapshot(goal: GoalContract): GoalContractSnapshot {
  return {
    title: goal.title,
    objective: goal.objective,
    constraints: [...goal.constraints],
    forbiddenActions: [...goal.forbiddenActions],
    successCriteria: goal.successCriteria.map((criterion) => ({ ...criterion })),
    evidenceRequirements: [...goal.evidenceRequirements],
    budget: { ...goal.budget },
    ...(goal.deadline ? { deadline: goal.deadline } : {}),
    stopConditions: [...goal.stopConditions],
    reviewPolicy: goal.reviewPolicy
  };
}

function sanitizeCriteria(criteria: GoalContract["successCriteria"]): GoalContract["successCriteria"] {
  const validators = new Set(["file", "git", "command", "schema", "manual", "llm_review"]);
  const seen = new Set<string>();
  return criteria.map((criterion, index) => {
    const id = requiredText(criterion.id || `c${index + 1}`, "成功标准 id", 40);
    if (seen.has(id)) throw new GoalStateError("GOAL_CONTRACT_INVALID", `成功标准 id 重复：${id}`);
    seen.add(id);
    if (!validators.has(criterion.validator)) throw new GoalStateError("GOAL_CONTRACT_INVALID", "成功标准验收器无效");
    return {
      id,
      description: requiredText(criterion.description, "成功标准描述", 1_000),
      validator: criterion.validator,
      check: requiredText(criterion.check, "成功标准检查", 4_000),
      required: criterion.required !== false
    };
  }).slice(0, 20);
}

function requiredText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text) throw new GoalStateError("GOAL_CONTRACT_INVALID", `${label}不能为空`);
  if (text.length > max) throw new GoalStateError("GOAL_CONTRACT_INVALID", `${label}不能超过 ${max} 个字符`);
  return text;
}

function commandCriteriaKey(criteria: GoalContract["successCriteria"]): string {
  return criteria
    .filter((criterion) => criterion.validator === "command")
    .map((criterion) => `${criterion.id}\u0000${criterion.required ? "1" : "0"}\u0000${criterion.check}`)
    .sort()
    .join("\u0001");
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

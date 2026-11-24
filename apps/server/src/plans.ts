import { randomUUID } from "node:crypto";
import type {
  ExecutorId,
  PlanActionName,
  PlanExecutionProfile,
  PlanRecord,
  PlanView,
  TaskFollowUpRecord,
  TaskRecord
} from "@hearth/core";
import {
  PlanStateError,
  assertPlanAction,
  assertPlanTransition,
  isTerminalPlanStage,
  nextPlanRevision,
  normalizePlan
} from "@hearth/core";
import type { HearthService } from "./service.ts";

export interface PlanSchedulerPort {
  requeuePlanTask(taskId: string, prompt: string, options?: { allowCompleted?: boolean }): TaskRecord;
  cancel(taskId: string): TaskRecord;
  addFollowUp(taskId: string, content: string, mode: "queue" | "steer"): TaskFollowUpRecord;
  kick(): void;
}

export interface CreatePlanInput {
  conversationId: string;
  projectId?: string | null;
  title?: string;
  objective?: string;
  textInput?: string;
  execution?: Partial<PlanExecutionProfile>;
  /** Create the first planning task immediately. Defaults to true when objective exists. */
  start?: boolean;
}

export interface PlanServiceOptions {
  service: HearthService;
  now?: () => Date;
}

export class PlanService {
  private readonly service: HearthService;
  private readonly now: () => Date;
  private scheduler: PlanSchedulerPort | null = null;

  constructor(options: PlanServiceOptions) {
    this.service = options.service;
    this.now = options.now ?? (() => new Date());
  }

  attachScheduler(scheduler: PlanSchedulerPort): void {
    this.scheduler = scheduler;
  }

  list(options: { conversationId?: string | null; projectId?: string | null; includeTerminal?: boolean } = {}): PlanView[] {
    return this.service.store.listPlans(options).map((plan) => normalizePlan(plan));
  }

  get(planId: string): PlanView | null {
    const plan = this.service.store.getPlan(planId);
    return plan ? normalizePlan(plan) : null;
  }

  activeForConversation(conversationId: string): PlanView | null {
    return this.list({ conversationId, includeTerminal: false })[0] ?? null;
  }

  findByTaskId(taskId: string): PlanView | null {
    const plans = this.service.store.listPlans({ includeTerminal: true });
    return plans.find((plan) => plan.planningTaskId === taskId || plan.executionTaskId === taskId) ?? null;
  }

  create(input: CreatePlanInput): PlanView {
    const conversation = this.service.store.getConversation(input.conversationId);
    if (!conversation) throw new PlanStateError("PLAN_STATE_INVALID", "对话不存在");
    const existing = this.activeForConversation(input.conversationId);
    if (existing) throw new PlanStateError("PLAN_ALREADY_ACTIVE", "当前会话已有未结束的计划，请先批准、重规划或退出");

    const now = this.now().toISOString();
    const objective = input.objective?.trim() || "";
    const title = input.title?.trim() || (objective ? objective.slice(0, 80) : "新计划");
    const plan: PlanRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      projectId: input.projectId ?? conversation.projectId ?? null,
      title,
      objective,
      stage: "planning",
      planningTaskId: null,
      executionTaskId: null,
      planMarkdown: null,
      planPath: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
      completedAt: null,
      error: null,
      ...(input.execution ? { execution: this.normalizeExecution(input.execution, input.projectId ?? conversation.projectId ?? null) } : {})
    };
    this.append("plan.created", plan);

    this.setConversationMode(input.conversationId, "plan");

    const shouldStart = input.start ?? objective.length > 0;
    if (shouldStart && objective) {
      const task = this.createPlanningTask(plan, input.textInput ?? objective);
      return this.attachPlanningTask(plan.id, task.id);
    }
    return normalizePlan(plan);
  }

  attachPlanningTask(planId: string, taskId: string): PlanView {
    const plan = this.require(planId);
    const task = this.service.requireTask(taskId);
    if (task.planId !== planId) throw new PlanStateError("PLAN_STATE_INVALID", "规划任务没有绑定到这个计划");
    const next = this.save({ ...plan, planningTaskId: taskId, objective: plan.objective || task.goal });
    return normalizePlan(next);
  }

  async action(
    planId: string,
    action: PlanActionName,
    options: { expectedRevision?: number; note?: string } = {}
  ): Promise<PlanView> {
    const plan = this.require(planId);
    assertPlanAction(plan.stage, action);
    if (options.expectedRevision !== undefined && options.expectedRevision !== plan.revision) {
      throw new PlanStateError("PLAN_REVISION_CONFLICT", "计划已被更新，请刷新后重试");
    }
    if (action === "approve") return this.approve(plan);
    if (action === "replan") return this.replan(plan, options.note);
    if (action === "cancel") return this.cancel(plan);
    return this.retry(plan);
  }

  continuePlanning(planId: string, content: string, options: { title?: string; textInput?: string } = {}): PlanView {
    const plan = this.require(planId);
    if (plan.stage === "awaiting_approval" || plan.stage === "planning") {
      const task = plan.planningTaskId
        ? this.service.requireTask(plan.planningTaskId)
        : this.createPlanningTask(plan, content);
      const next = this.save({
        ...plan,
        stage: "planning",
        planningTaskId: task.id,
        objective: plan.objective || content,
        title: options.title?.trim() || plan.title,
        planMarkdown: null,
        planPath: null,
        error: null
      });
      this.scheduler?.requeuePlanTask(task.id, content, { allowCompleted: true });
      return normalizePlan(next);
    }
    throw new PlanStateError("PLAN_STATE_INVALID", `计划处于 ${plan.stage} 时不能继续规划`);
  }

  onPlanningTaskReady(taskId: string, planMarkdown: string, planPath: string | null): PlanView | null {
    const plan = this.findByTaskId(taskId);
    if (!plan || plan.planningTaskId !== taskId) return null;
    if (plan.stage !== "planning" && plan.stage !== "awaiting_approval") return null;
    const text = planMarkdown.trim();
    if (!text) return null;
    const next = this.save({
      ...plan,
      stage: "awaiting_approval",
      planMarkdown: text,
      planPath,
      error: null,
      executionTaskId: null
    });
    return normalizePlan(next);
  }

  onPlanningTaskCompleted(taskId: string): PlanView | null {
    const plan = this.findByTaskId(taskId);
    if (!plan) return null;
    if (plan.planningTaskId !== taskId || plan.planMarkdown) return normalizePlan(plan);
    const task = this.service.store.getTask(taskId);
    const text = task?.resultSummary?.trim() ?? "";
    if (!text) return normalizePlan(plan);
    return this.onPlanningTaskReady(taskId, text, null);
  }

  onExecutionTaskCompleted(taskId: string): PlanView | null {
    const plan = this.findByTaskId(taskId);
    if (!plan) return null;
    if (plan.executionTaskId !== taskId || plan.stage !== "executing") return normalizePlan(plan);
    const next = this.save({ ...plan, stage: "completed", completedAt: this.now().toISOString(), error: null });
    this.setConversationMode(plan.conversationId, "build");
    return normalizePlan(next);
  }

  onTaskFailed(taskId: string, reason: string): PlanView | null {
    const plan = this.findByTaskId(taskId);
    if (!plan) return null;
    if (isTerminalPlanStage(plan.stage)) return normalizePlan(plan);
    const next = this.save({ ...plan, stage: "failed", error: reason || "计划任务失败" });
    return normalizePlan(next);
  }

  recoverOnBoot(): void {
    for (const raw of this.service.store.listPlans({ includeTerminal: false })) {
      const plan = normalizePlan(raw);
      if (plan.stage === "executing") {
        const task = plan.executionTaskId ? this.service.store.getTask(plan.executionTaskId) : null;
        if (task?.status === "completed") {
          this.save({ ...plan, stage: "completed", completedAt: this.now().toISOString(), error: null });
          continue;
        }
        this.save({
          ...plan,
          stage: "awaiting_approval",
          error: "宿主重启，执行已停止；确认计划后可以重试"
        });
        if (plan.executionTaskId) {
          try { this.scheduler?.cancel(plan.executionTaskId); } catch { /* may already be terminal */ }
        }
        continue;
      }
      if (plan.stage === "planning" && plan.planMarkdown) {
        this.save({ ...plan, stage: "awaiting_approval", error: "宿主重启，已保留最近一版计划" });
      }
    }
  }

  private approve(plan: PlanRecord): PlanView {
    const markdown = plan.planMarkdown?.trim();
    if (!markdown) throw new PlanStateError("PLAN_STATE_INVALID", "计划还没有正文，不能开始执行");
    const execution = this.executionProfile(plan);
    const task = this.service.createTask({
      title: plan.title,
      goal: plan.objective,
      textInput: this.executionPrompt(plan, markdown),
      conversationId: plan.conversationId,
      executorId: execution.executorId ?? "native",
      taskKind: execution.taskKind,
      expectedOutputs: [],
      ...(plan.projectId ? { projectId: plan.projectId } : {}),
      ...(execution.workspacePath ? { workspacePath: execution.workspacePath } : {}),
      planId: plan.id,
      mode: "build"
    });
    const next = this.save({
      ...plan,
      stage: "executing",
      executionTaskId: task.id,
      approvedAt: this.now().toISOString(),
      error: null
    });
    this.setConversationMode(plan.conversationId, "build");
    this.scheduler?.kick();
    return normalizePlan(next);
  }

  private replan(plan: PlanRecord, note?: string): PlanView {
    const next = this.save({
      ...plan,
      stage: "planning",
      planMarkdown: null,
      planPath: null,
      executionTaskId: null,
      approvedAt: null,
      error: null
    });
    if (plan.executionTaskId) {
      try { this.scheduler?.cancel(plan.executionTaskId); } catch { /* may already be terminal */ }
    }
    const taskId = plan.planningTaskId;
    if (taskId && this.scheduler) {
      const prompt = note?.trim()
        ? `用户要求修改计划。请基于当前工作区和已有调查重新规划，不执行修改。\n\n用户反馈：${note.trim()}`
        : "用户要求修改计划。请基于当前工作区和已有调查重新规划，不执行修改。";
      this.scheduler.requeuePlanTask(taskId, prompt, { allowCompleted: true });
    }
    return normalizePlan(next);
  }

  private cancel(plan: PlanRecord): PlanView {
    if (plan.planningTaskId) {
      try { this.scheduler?.cancel(plan.planningTaskId); } catch { /* already terminal */ }
    }
    if (plan.executionTaskId) {
      try { this.scheduler?.cancel(plan.executionTaskId); } catch { /* already terminal */ }
    }
    const next = this.save({ ...plan, stage: "cancelled", error: null });
    this.setConversationMode(plan.conversationId, "build");
    return normalizePlan(next);
  }

  private retry(plan: PlanRecord): PlanView {
    if (!plan.planMarkdown?.trim()) throw new PlanStateError("PLAN_STATE_INVALID", "没有可重试的计划正文");
    return this.approve({ ...plan, stage: "awaiting_approval", executionTaskId: null, error: null });
  }

  private createPlanningTask(plan: PlanRecord, text: string): TaskRecord {
    if (plan.stage !== "planning") {
      throw new PlanStateError("PLAN_STATE_INVALID", `计划处于 ${plan.stage} 时不能创建规划任务`);
    }
    const execution = this.executionProfile(plan);
    const task = this.service.createTask({
      title: plan.title,
      goal: plan.objective || text,
      textInput: text,
      conversationId: plan.conversationId,
      executorId: "native",
      taskKind: execution.taskKind,
      expectedOutputs: [],
      ...(plan.projectId ? { projectId: plan.projectId } : {}),
      ...(execution.workspacePath ? { workspacePath: execution.workspacePath } : {}),
      planId: plan.id,
      mode: "plan"
    });
    return task;
  }

  private executionProfile(plan: PlanRecord): PlanExecutionProfile {
    return plan.execution ?? {
      executorId: "native",
      taskKind: "general",
      networkHosts: [],
      expectedOutputs: [],
      ...(plan.projectId ? { projectId: plan.projectId } : {})
    };
  }

  private normalizeExecution(input: Partial<PlanExecutionProfile>, projectId: string | null): PlanExecutionProfile {
    return {
      executorId: (input.executorId ?? "native") as ExecutorId,
      taskKind: input.taskKind ?? "general",
      projectId: input.projectId ?? projectId,
      workspacePath: input.workspacePath ?? null,
      networkHosts: input.networkHosts ?? [],
      expectedOutputs: input.expectedOutputs ?? [],
      ...(input.executionMode ? { executionMode: input.executionMode } : {})
    };
  }

  private executionPrompt(plan: PlanRecord, markdown: string): string {
    return [
      `原始目标：${plan.objective || plan.title}`,
      "",
      "以下计划已经由用户明确批准。请严格执行它，不要重新规划，也不要停在方案描述：",
      markdown,
      "",
      "执行要求：",
      "- 直接完成计划中的工作并验证结果；遇到可修复的失败就继续修复。",
      "- 只有出现计划无法覆盖的关键歧义时才停下来。",
      "- 最终只返回完成结果、证据和必要的剩余风险，不输出过程叙述。"
    ].join("\n");
  }

  private setConversationMode(conversationId: string, mode: "build" | "plan"): void {
    this.service.store.updateConversationSettings(conversationId, { collaborationMode: mode });
  }

  private require(planId: string): PlanRecord {
    const plan = this.service.store.getPlan(planId);
    if (!plan) throw new PlanStateError("PLAN_STATE_INVALID", "计划不存在");
    return normalizePlan(plan);
  }

  private save(plan: PlanRecord): PlanRecord {
    const next: PlanRecord = {
      ...plan,
      revision: nextPlanRevision(plan),
      updatedAt: this.now().toISOString()
    };
    assertPlanTransition(plan.stage, next.stage);
    this.append("plan.updated", next);
    return next;
  }

  private append(type: "plan.created" | "plan.updated", plan: PlanRecord): void {
    const event = this.service.store.appendEvent({
      type,
      taskId: plan.planningTaskId ?? plan.executionTaskId ?? null,
      payload: plan
    });
    this.service.bus.publish(event);
  }
}

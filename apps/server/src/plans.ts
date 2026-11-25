import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  mcpServerIds?: string[];
  /** Create the first planning task immediately. Defaults to true when objective exists. */
  start?: boolean;
}

export interface PlanServiceOptions {
  service: HearthService;
  /** Host-owned data directory for plan artifacts, outside per-task worktrees. */
  planRoot: string;
  now?: () => Date;
}

export class PlanService {
  private readonly service: HearthService;
  private readonly planRoot: string;
  private readonly now: () => Date;
  private scheduler: PlanSchedulerPort | null = null;

  constructor(options: PlanServiceOptions) {
    this.service = options.service;
    this.planRoot = resolve(options.planRoot);
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
      planSha256: null,
      planningAttempt: 0,
      planningRunId: null,
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
      const task = this.createPlanningTask(plan, input.textInput ?? objective, input.mcpServerIds);
      return this.attachPlanningTask(plan.id, task.id);
    }
    return normalizePlan(plan);
  }

  attachPlanningTask(planId: string, taskId: string): PlanView {
    const plan = this.require(planId);
    const task = this.service.requireTask(taskId);
    if (task.planId !== planId) throw new PlanStateError("PLAN_STATE_INVALID", "规划任务没有绑定到这个计划");
    const next = this.save({
      ...plan,
      planningTaskId: taskId,
      objective: plan.objective || task.goal,
      planningAttempt: (plan.planningAttempt ?? 0) + 1,
      planningRunId: null
    });
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

  continuePlanning(
    planId: string,
    content: string,
    options: { title?: string; textInput?: string; mcpServerIds?: string[] } = {}
  ): PlanView {
    const plan = this.require(planId);
    if (plan.stage === "awaiting_approval" || plan.stage === "planning") {
      const task = plan.planningTaskId
        ? this.service.requireTask(plan.planningTaskId)
        : this.createPlanningTask(plan, content, options.mcpServerIds);
      if (plan.planningTaskId && options.mcpServerIds) {
        this.service.setTaskMcpServerIds(task.id, options.mcpServerIds);
      }
      const next = this.save({
        ...plan,
        stage: "planning",
        planningTaskId: task.id,
        objective: plan.objective || content,
        title: options.title?.trim() || plan.title,
        planMarkdown: null,
        planPath: null,
        planSha256: null,
        planningAttempt: (plan.planningAttempt ?? 0) + 1,
        planningRunId: null,
        error: null
      });
      this.scheduler?.requeuePlanTask(task.id, content, { allowCompleted: true });
      return normalizePlan(next);
    }
    throw new PlanStateError("PLAN_STATE_INVALID", `计划处于 ${plan.stage} 时不能继续规划`);
  }

  onPlanningRunStarted(taskId: string, runId: string): PlanView | null {
    const plan = this.findByTaskId(taskId);
    if (!plan || plan.planningTaskId !== taskId || plan.stage !== "planning") return null;
    return normalizePlan(this.save({ ...plan, planningRunId: runId }));
  }

  onPlanningTaskReady(
    taskId: string,
    planMarkdown: string,
    planPath: string | null,
    options: { runId?: string } = {}
  ): PlanView | null {
    const plan = this.findByTaskId(taskId);
    if (!plan || plan.planningTaskId !== taskId) return null;
    if (plan.stage !== "planning" && plan.stage !== "awaiting_approval") return null;
    if (options.runId !== undefined && options.runId !== plan.planningRunId) return null;
    const text = normalizePlanMarkdown(planMarkdown);
    const qualityError = validatePlanMarkdown(text);
    if (qualityError) {
      return normalizePlan(this.save({
        ...plan,
        stage: "failed",
        planMarkdown: null,
        planPath: null,
        planSha256: null,
        error: qualityError
      }));
    }
    // A model-provided path is never authoritative. Planning and build tasks use
    // different worktrees, so the approved artifact lives in the host data root.
    const canonicalPath = canonicalPlanPath(this.planRoot, plan.id);
    const sha256 = this.writeCanonicalPlan(canonicalPath, text);
    const next = this.save({
      ...plan,
      stage: "awaiting_approval",
      planMarkdown: text,
      planPath: canonicalPath,
      planSha256: sha256,
      error: null,
      executionTaskId: null
    });
    return normalizePlan(next);
  }

  onPlanningTaskCompleted(
    taskId: string,
    options: { runId?: string } = {}
  ): PlanView | null {
    const plan = this.findByTaskId(taskId);
    if (!plan) return null;
    if (plan.planningTaskId !== taskId || plan.planMarkdown) return normalizePlan(plan);
    const task = this.service.store.getTask(taskId);
    const text = task?.resultSummary?.trim() ?? "";
    if (!text) return normalizePlan(plan);
    return this.onPlanningTaskReady(taskId, text, null, options);
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
      if (plan.stage === "planning") {
        if (plan.planMarkdown) {
          this.save({ ...plan, stage: "awaiting_approval", error: "宿主重启，已保留最近一版计划" });
        } else {
          this.save({
            ...plan,
            stage: "failed",
            planningRunId: null,
            error: "宿主重启，规划尚未完成；请重规划后继续"
          });
          if (plan.planningTaskId) {
            try { this.scheduler?.cancel(plan.planningTaskId); } catch { /* may already be terminal */ }
          }
        }
      }
    }
  }

  private approve(plan: PlanRecord): PlanView {
    const markdown = plan.planMarkdown?.trim();
    if (!markdown) throw new PlanStateError("PLAN_STATE_INVALID", "计划还没有正文，不能开始执行");
    const canonicalPath = canonicalPlanPath(this.planRoot, plan.id);
    const sha256 = this.writeCanonicalPlan(canonicalPath, markdown);
    const approvedPlan: PlanRecord = {
      ...plan,
      planMarkdown: markdown,
      planPath: canonicalPath,
      planSha256: sha256
    };
    const execution = this.executionProfile(plan);
    const planningTask = plan.planningTaskId ? this.service.store.getTask(plan.planningTaskId) : null;
    const task = this.service.createTask({
      title: plan.title,
      goal: plan.objective,
      textInput: this.executionPrompt(approvedPlan, markdown),
      conversationId: plan.conversationId,
      executorId: execution.executorId ?? "native",
      taskKind: execution.taskKind,
      expectedOutputs: execution.expectedOutputs,
      ...(plan.projectId ? { projectId: plan.projectId } : {}),
      ...(execution.workspacePath ? { workspacePath: execution.workspacePath } : {}),
      ...(execution.networkHosts.length > 0 ? { networkHosts: execution.networkHosts } : {}),
      ...(execution.executionMode ? { executionMode: execution.executionMode } : {}),
      ...(planningTask?.mcpServerIds?.length ? { mcpServerIds: planningTask.mcpServerIds } : {}),
      planId: plan.id,
      mode: "build"
    });
    const next = this.save({
      ...approvedPlan,
      stage: "executing",
      executionTaskId: task.id,
      approvedAt: this.now().toISOString(),
      error: null
    });
    this.setConversationMode(plan.conversationId, "build");
    this.scheduler?.kick();
    return normalizePlan(next);
  }

  assertExecutionPlan(planId: string, taskId: string): void {
    const plan = this.require(planId);
    const task = this.service.requireTask(taskId);
    if (plan.stage !== "executing" || plan.executionTaskId !== taskId) {
      throw new PlanStateError("PLAN_STATE_INVALID", "当前构建任务不是这个计划的执行任务");
    }
    if (task.planId !== planId || task.mode !== "build") {
      throw new PlanStateError("PLAN_STATE_INVALID", "构建任务没有绑定批准的完整计划");
    }
    const markdown = plan.planMarkdown?.trim();
    if (!markdown || !plan.planPath || !plan.planSha256) {
      throw new PlanStateError("PLAN_STATE_INVALID", "批准计划缺少正文、规范文件或 SHA-256");
    }
    const canonicalPath = canonicalPlanPath(this.planRoot, plan.id);
    if (resolve(plan.planPath) !== resolve(canonicalPath)) {
      throw new PlanStateError("PLAN_STATE_INVALID", "批准计划文件不在 Hearth 的稳定计划目录");
    }
    const databaseHash = this.sha256Text(`${markdown}\n`);
    if (databaseHash !== plan.planSha256) {
      throw new PlanStateError("PLAN_STATE_INVALID", "批准计划的正文与记录的 SHA-256 不一致");
    }
    let content: string;
    try {
      content = readFileSync(canonicalPath, "utf8");
    } catch {
      throw new PlanStateError("PLAN_STATE_INVALID", "批准计划文件不存在或无法读取；请重新批准计划");
    }
    if (this.sha256Text(content) !== plan.planSha256) {
      throw new PlanStateError("PLAN_STATE_INVALID", "批准计划文件已被修改，SHA-256 校验失败");
    }
  }

  private replan(plan: PlanRecord, note?: string): PlanView {
    const next = this.save({
      ...plan,
      stage: "planning",
      planMarkdown: null,
      planPath: null,
      planSha256: null,
      planningAttempt: (plan.planningAttempt ?? 0) + 1,
      planningRunId: null,
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

  private createPlanningTask(plan: PlanRecord, text: string, mcpServerIds?: string[]): TaskRecord {
    if (plan.stage !== "planning") {
      throw new PlanStateError("PLAN_STATE_INVALID", `计划处于 ${plan.stage} 时不能创建规划任务`);
    }
    const execution = this.executionProfile(plan);
    const task = this.service.createTask({
      title: plan.title,
      goal: plan.objective || text,
      textInput: text,
      conversationId: plan.conversationId,
      executorId: execution.executorId,
      taskKind: execution.taskKind,
      expectedOutputs: [],
      ...(plan.projectId ? { projectId: plan.projectId } : {}),
      ...(execution.workspacePath ? { workspacePath: execution.workspacePath } : {}),
      ...(mcpServerIds?.length ? { mcpServerIds } : {}),
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
      `批准计划：${plan.id}`,
      `计划文件：${plan.planPath ?? "未保存"}`,
      `计划 SHA-256：${plan.planSha256 ?? "未计算"}`,
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

  private writeCanonicalPlan(path: string, markdown: string): string {
    mkdirSync(dirname(path), { recursive: true });
    const content = `${markdown}\n`;
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, content, "utf8");
    renameSync(temp, path);
    return this.sha256Text(content);
  }

  private sha256Text(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }
}

function canonicalPlanPath(planRoot: string, planId: string): string {
  return join(planRoot, `${planId}.md`);
}

export function buildPlanningPrompt(input: {
  title: string;
  objective: string;
  workspaceRoot: string;
  outDir: string;
  executorId: ExecutorId;
}): string {
  const submission = input.executorId === "native"
    ? "调查完成后调用 submit_plan 提交完整方案。"
    : input.executorId === "deepseek-harness"
      ? "调查完成后调用 DSH 的 exit_plan_mode 提交完整方案。Hearth 会捕获 plan-review 正文并接管审批；不要在 DSH 内自行批准，也不要把方案只写成普通最终回复。"
      : "调查完成后直接把完整方案作为最终回复返回。";
  return [
    `# 只读规划任务：${input.title}`,
    "",
    "## 目标",
    input.objective,
    "",
    "## 工作边界",
    `- 工作区：${input.workspaceRoot}`,
    `- 本轮输出目录：${input.outDir}`,
    "- 这是规划阶段。只允许读取、搜索和理解代码或资料，不能创建、修改、删除文件，不能提交 git，不能产生外部副作用。",
    "- 不要询问“是否继续”或等待批准；Hearth 会在收到方案后统一展示审批。",
    "",
    "## 输出契约",
    submission,
    "方案必须是可直接执行的 Markdown，并严格包含以下二级章节：",
    "## 调查结论",
    "## 执行步骤",
    "## 验证方法",
    "## 风险与非目标",
    "",
    "要求：",
    "- 调查结论列出真实文件路径、现有行为、关键约束和根因。",
    "- 执行步骤按顺序排列，每一步说明改哪个文件、改成什么、为什么。",
    "- 验证方法给出可运行的测试、类型检查或检查命令及预期结果。",
    "- 风险与非目标写明回滚风险、兼容性风险、明确不做的事和仍需人工确认的边界。",
    "- 不要只复述过程或调查日志；最终正文就是用户将批准的完整方案。"
  ].join("\n");
}

function normalizePlanMarkdown(value: string): string {
  const text = value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const whole = /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/i.exec(text);
  const block = whole?.[1]?.trim();
  if (block) return block;
  // Models sometimes wrap the plan in a fence after a short preamble such as
  // "Here is the plan:". Extract that fence when it is clearly the whole plan.
  const firstFence = text.indexOf("```");
  if (firstFence > 0 && firstFence < 240) {
    const preamble = text.slice(0, firstFence);
    if (!/#\s|##\s|-\s/.test(preamble)) {
      const fenced = /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/i.exec(text.slice(firstFence).trim());
      const inner = fenced?.[1]?.trim();
      if (inner && /^#{1,6}\s/m.test(inner)) return inner;
    }
  }
  return text;
}

export function validatePlanMarkdown(value: string): string | null {
  const text = normalizePlanMarkdown(value);
  if (!text) return "规划执行器没有返回计划正文";
  if (text.length < 120) return "计划正文过短，无法形成可执行方案";
  const headings = text.split("\n").filter((line) => /^#{2,3}\s+/.test(line.trim())).join("\n");
  const groups = [
    /调查|结论|Findings?|Context/i,
    /步骤|实现|Changes?|Steps?|Plan/i,
    /验证|测试|Verification|Tests?|Commands?/i,
    /风险|非目标|不做|Risks?|Out of scope/i
  ];
  if (groups.some((pattern) => !pattern.test(headings))) {
    return "计划缺少必要章节：调查结论、执行步骤、验证方法、风险与非目标";
  }
  return null;
}

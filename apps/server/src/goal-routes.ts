import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { GoalStateError, EXECUTOR_IDS, TASK_KINDS } from "@hearth/core";
import type { GoalContractPatch } from "@hearth/core";
import type { HearthService } from "./service.ts";
import type { GoalService } from "./goals.ts";

const criterionSchema = z.object({
  id: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().min(1).max(1_000),
  validator: z.enum(["file", "git", "command", "schema", "manual", "llm_review"]),
  check: z.string().trim().min(1).max(4_000),
  required: z.boolean().optional()
}).strict();

const budgetSchema = z.object({
  maxTurns: z.number().int().min(0).optional(),
  maxToolCalls: z.number().int().min(0).optional(),
  maxTokens: z.number().int().min(0).optional(),
  maxDurationMs: z.number().int().min(0).optional(),
  maxHumanMinutes: z.number().int().min(0).optional()
}).strict();

const executionSchema = z.object({
  executorId: z.enum(EXECUTOR_IDS).default("native"),
  taskKind: z.enum(TASK_KINDS).default("general"),
  expectedOutputs: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  projectId: z.string().trim().min(1).max(120).nullable().optional(),
  workspacePath: z.string().trim().min(1).max(4_000).nullable().optional(),
  networkHosts: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  executionMode: z.enum(["quick", "standard", "deep"]).optional()
}).strict();

const createGoalSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  objective: z.string().trim().min(1).max(20_000),
  conversationId: z.string().trim().min(1).max(80).optional(),
  projectId: z.string().trim().min(1).max(120).optional(),
  execution: executionSchema,
  textInput: z.string().max(100_000).optional(),
  fileInputs: z.array(z.object({
    label: z.string().trim().max(255),
    path: z.string().trim().min(1).max(4_000)
  }).strict()).max(10).optional(),
  url: z.string().trim().max(2_048).optional(),
  criteria: z.array(criterionSchema).max(20).optional(),
  constraints: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  forbiddenActions: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  evidenceRequirements: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  budget: budgetSchema.optional(),
  deadline: z.string().datetime().optional(),
  stopConditions: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  reviewPolicy: z.enum(["auto", "human_on_risk", "human_on_complete"]).optional(),
  maxRounds: z.number().int().min(1).max(200).optional(),
  commandsApproved: z.boolean().optional(),
  start: z.boolean().optional()
}).strict();

const contractPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  objective: z.string().trim().min(1).max(20_000).optional(),
  constraints: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  forbiddenActions: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  successCriteria: z.array(criterionSchema).min(1).max(20).optional(),
  evidenceRequirements: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  budget: budgetSchema.optional(),
  deadline: z.string().datetime().nullable().optional(),
  stopConditions: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  reviewPolicy: z.enum(["auto", "human_on_risk", "human_on_complete"]).optional()
}).strict();

const actionSchema = z.object({
  action: z.enum(["start", "pause", "resume", "stop", "replan", "complete", "approve", "switch_executor", "amend_contract"]),
  expectedRevision: z.number().int().min(0).optional(),
  note: z.string().trim().max(2_000).optional(),
  maxRounds: z.number().int().min(1).max(200).optional(),
  execution: executionSchema.optional(),
  contract: contractPatchSchema.optional()
}).strict().superRefine((value, context) => {
  const mutatingExecution = value.action === "switch_executor";
  const mutatingContract = value.action === "amend_contract";
  if ((mutatingExecution || mutatingContract) && value.expectedRevision === undefined) {
    context.addIssue({ code: "custom", path: ["expectedRevision"], message: "该动作必须携带 expectedRevision" });
  }
  if (mutatingExecution && !value.execution) {
    context.addIssue({ code: "custom", path: ["execution"], message: "切换执行器需要完整执行配置" });
  }
  if (mutatingContract && !value.contract) {
    context.addIssue({ code: "custom", path: ["contract"], message: "契约修订不能为空" });
  }
  if (!mutatingExecution && value.execution) {
    context.addIssue({ code: "custom", path: ["execution"], message: "当前动作不接受 execution" });
  }
  if (!mutatingContract && value.contract) {
    context.addIssue({ code: "custom", path: ["contract"], message: "当前动作不接受 contract" });
  }
});

export function registerGoalRoutes(
  app: FastifyInstance,
  options: { service: HearthService; goals: GoalService }
): void {
  const { service, goals } = options;

  app.get("/api/goals", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const conversationId = typeof query.conversationId === "string" ? query.conversationId : undefined;
    const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
    const includeTerminal = query.includeTerminal === "true";
    const items = goals.list({
      ...(conversationId ? { conversationId } : {}),
      ...(projectId ? { projectId } : {}),
      includeTerminal
    }).map((goal) => goals.view(goal.goalId));
    return reply.send({ goals: items });
  });

  app.post("/api/goals", async (request, reply) => {
    const parsed = createGoalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_GOAL", message: parsed.error.issues[0]?.message ?? "目标参数不合法" });
    }
    const body = parsed.data;
    let goalId: string | null = null;
    try {
      const created = goals.create({
        ...(body.title ? { title: body.title } : {}),
        objective: body.objective,
        conversationId: body.conversationId ?? null,
        projectId: body.projectId ?? null,
        execution: {
          executorId: body.execution.executorId,
          taskKind: body.execution.taskKind,
          expectedOutputs: body.execution.expectedOutputs,
          projectId: body.projectId ?? body.execution.projectId ?? null,
          workspacePath: body.execution.workspacePath ?? null,
          networkHosts: body.execution.networkHosts,
          ...(body.execution.executionMode ? { executionMode: body.execution.executionMode } : {})
        },
        ...(body.criteria ? {
          criteria: body.criteria.map((criterion, index) => ({
            id: criterion.id ?? `c${index + 1}`,
            description: criterion.description,
            validator: criterion.validator,
            check: criterion.check,
            required: criterion.required ?? true
          }))
        } : {}),
        ...(body.constraints ? { constraints: body.constraints } : {}),
        ...(body.forbiddenActions ? { forbiddenActions: body.forbiddenActions } : {}),
        ...(body.evidenceRequirements ? { evidenceRequirements: body.evidenceRequirements } : {}),
        ...(body.budget ? { budget: body.budget } : {}),
        deadline: body.deadline ?? null,
        ...(body.stopConditions ? { stopConditions: body.stopConditions } : {}),
        ...(body.reviewPolicy ? { reviewPolicy: body.reviewPolicy } : {}),
        ...(body.maxRounds !== undefined ? { maxRounds: body.maxRounds } : {}),
        ...(body.commandsApproved ? { commandsApproved: true } : {})
      });
      goalId = created.goalId;
      if (body.start === false) {
        return reply.code(201).send({ goal: goals.view(goalId) });
      }
      const task = service.createTask({
        title: created.title,
        goal: created.objective,
        textInput: body.textInput ?? created.objective,
        fileInputs: body.fileInputs ?? [],
        ...(body.url ? { url: body.url } : {}),
        ...(body.projectId ? { projectId: body.projectId } : {}),
        ...(body.execution.workspacePath ? { workspacePath: body.execution.workspacePath } : {}),
        ...(body.conversationId ? { conversationId: body.conversationId } : {}),
        goalId,
        executorId: body.execution.executorId,
        ...(body.execution.executorId === "native"
          ? { executionMode: body.execution.executionMode ?? "standard" }
          : {}),
        taskKind: body.execution.taskKind,
        expectedOutputs: body.execution.expectedOutputs,
        ...(body.execution.networkHosts.length > 0 ? { networkHosts: body.execution.networkHosts } : {})
      });
      goals.attachTask(goalId, task.id);
      await goals.action(goalId, "start");
      return reply.code(201).send({ goal: goals.view(goalId), task });
    } catch (error) {
      if (goalId) {
        try { await goals.action(goalId, "stop", { note: "目标创建失败，已停止" }); } catch { /* best effort */ }
      }
      return sendGoalError(reply, error);
    }
  });

  app.get("/api/goals/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return reply.send(goals.view(id));
    } catch (error) {
      return sendGoalError(reply, error);
    }
  });

  app.post("/api/goals/:id/actions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = actionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "INVALID_GOAL_ACTION", message: parsed.error.issues[0]?.message ?? "动作参数不合法" });
    }
    try {
      const view = await goals.action(id, parsed.data.action, {
        ...(parsed.data.expectedRevision !== undefined ? { expectedRevision: parsed.data.expectedRevision } : {}),
        ...(parsed.data.note ? { note: parsed.data.note } : {}),
        ...(parsed.data.maxRounds !== undefined ? { maxRounds: parsed.data.maxRounds } : {}),
        ...(parsed.data.execution ? {
          execution: {
            executorId: parsed.data.execution.executorId,
            taskKind: parsed.data.execution.taskKind,
            expectedOutputs: parsed.data.execution.expectedOutputs,
            projectId: parsed.data.execution.projectId ?? null,
            workspacePath: parsed.data.execution.workspacePath ?? null,
            networkHosts: parsed.data.execution.networkHosts,
            ...(parsed.data.execution.executionMode ? { executionMode: parsed.data.execution.executionMode } : {})
          }
        } : {}),
        ...(parsed.data.contract ? { contract: normalizeContractPatch(parsed.data.contract) } : {})
      });
      return reply.send(view);
    } catch (error) {
      return sendGoalError(reply, error);
    }
  });
}

function normalizeContractPatch(input: z.infer<typeof contractPatchSchema>): GoalContractPatch {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.objective !== undefined ? { objective: input.objective } : {}),
    ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
    ...(input.forbiddenActions !== undefined ? { forbiddenActions: input.forbiddenActions } : {}),
    ...(input.successCriteria !== undefined ? {
      successCriteria: input.successCriteria.map((criterion, index) => ({
        id: criterion.id ?? `c${index + 1}`,
        description: criterion.description,
        validator: criterion.validator,
        check: criterion.check,
        required: criterion.required ?? true
      }))
    } : {}),
    ...(input.evidenceRequirements !== undefined ? { evidenceRequirements: input.evidenceRequirements } : {}),
    ...(input.budget !== undefined ? {
      budget: {
        ...(input.budget.maxTurns !== undefined ? { maxTurns: input.budget.maxTurns } : {}),
        ...(input.budget.maxToolCalls !== undefined ? { maxToolCalls: input.budget.maxToolCalls } : {}),
        ...(input.budget.maxTokens !== undefined ? { maxTokens: input.budget.maxTokens } : {}),
        ...(input.budget.maxDurationMs !== undefined ? { maxDurationMs: input.budget.maxDurationMs } : {}),
        ...(input.budget.maxHumanMinutes !== undefined ? { maxHumanMinutes: input.budget.maxHumanMinutes } : {})
      }
    } : {}),
    ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
    ...(input.stopConditions !== undefined ? { stopConditions: input.stopConditions } : {}),
    ...(input.reviewPolicy !== undefined ? { reviewPolicy: input.reviewPolicy } : {})
  };
}

function sendGoalError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof GoalStateError) {
    const status = error.code === "GOAL_CONTRACT_INVALID" ? 422 : 409;
    return reply.code(status).send({ error: error.code, message: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/不存在/.test(message)) return reply.code(404).send({ error: "GOAL_NOT_FOUND", message });
  return reply.code(500).send({ error: "GOAL_ACTION_FAILED", message });
}

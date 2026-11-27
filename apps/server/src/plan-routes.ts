import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { EXECUTOR_IDS, PlanStateError, TASK_KINDS } from "@hearth/core";
import type { GoalService } from "./goals.ts";
import type { PlanService } from "./plans.ts";

const executionSchema = z.object({
  executorId: z.enum(EXECUTOR_IDS).default("native"),
  taskKind: z.enum(TASK_KINDS).default("general"),
  projectId: z.string().trim().min(1).max(120).nullable().optional(),
  workspacePath: z.string().trim().min(1).max(4_000).nullable().optional(),
  networkHosts: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  executionMode: z.enum(["quick", "standard", "deep"]).optional()
}).strict();

const createPlanSchema = z.object({
  conversationId: z.string().trim().min(1).max(80),
  projectId: z.string().trim().min(1).max(120).nullable().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  objective: z.string().trim().min(1).max(20_000),
  textInput: z.string().max(100_000).optional(),
  planningExecutorId: z.enum(EXECUTOR_IDS).optional(),
  execution: executionSchema.optional(),
  start: z.boolean().optional()
}).strict();

const actionSchema = z.object({
  action: z.enum(["approve", "replan", "cancel", "retry"]),
  expectedRevision: z.number().int().min(0).optional(),
  note: z.string().trim().max(4_000).optional(),
  planMarkdown: z.string().max(200_000).optional(),
  executorId: z.enum(EXECUTOR_IDS).optional()
}).strict();

export function registerPlanRoutes(
  app: FastifyInstance,
  options: { plans: PlanService; goals?: GoalService }
): void {
  const { plans, goals } = options;

  app.get("/api/plans", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const conversationId = typeof query.conversationId === "string" ? query.conversationId : undefined;
    const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
    const includeTerminal = query.includeTerminal === "true";
    return reply.send({
      plans: plans.list({
        ...(conversationId ? { conversationId } : {}),
        ...(projectId ? { projectId } : {}),
        includeTerminal
      })
    });
  });

  app.post("/api/plans", async (request, reply) => {
    const parsed = createPlanSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_PLAN", message: parsed.error.issues[0]?.message ?? "计划参数不合法" });
    }
    const body = parsed.data;
    try {
      if (goals?.findOpenForConversation(body.conversationId)) {
        return reply.code(409).send({
          error: "PLAN_GOAL_CONFLICT",
          message: "当前会话还有未结束的目标，请先结束目标再开始计划"
        });
      }
      const execution = body.execution ? {
        executorId: body.execution.executorId,
        taskKind: body.execution.taskKind,
        networkHosts: body.execution.networkHosts,
        ...(body.execution.projectId !== undefined ? { projectId: body.execution.projectId } : {}),
        ...(body.execution.workspacePath !== undefined ? { workspacePath: body.execution.workspacePath } : {}),
        ...(body.execution.executionMode ? { executionMode: body.execution.executionMode } : {})
      } : undefined;
      const plan = plans.create({
        conversationId: body.conversationId,
        projectId: body.projectId ?? null,
        ...(body.title ? { title: body.title } : {}),
        objective: body.objective,
        ...(body.textInput ? { textInput: body.textInput } : {}),
        ...(body.planningExecutorId ? { planningExecutorId: body.planningExecutorId } : {}),
        ...(execution ? { execution } : {}),
        ...(body.start !== undefined ? { start: body.start } : {})
      });
      return reply.code(201).send({ plan });
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.get("/api/plans/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const plan = plans.get(id);
    if (!plan) return reply.code(404).send({ error: "PLAN_NOT_FOUND", message: "计划不存在" });
    return reply.send(plan);
  });

  app.post("/api/plans/:id/actions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = actionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_PLAN_ACTION", message: parsed.error.issues[0]?.message ?? "动作参数不合法" });
    }
    try {
      const plan = await plans.action(id, parsed.data.action, {
        ...(parsed.data.expectedRevision !== undefined ? { expectedRevision: parsed.data.expectedRevision } : {}),
        ...(parsed.data.note ? { note: parsed.data.note } : {}),
        ...(parsed.data.planMarkdown !== undefined ? { planMarkdown: parsed.data.planMarkdown } : {}),
        ...(parsed.data.executorId ? { executorId: parsed.data.executorId } : {})
      });
      return reply.send(plan);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });
}

function sendPlanError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PlanStateError) {
    return reply.code(error.code === "PLAN_STATE_INVALID" ? 409 : error.code === "PLAN_ALREADY_ACTIVE" ? 409 : 409)
      .send({ error: error.code, message: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/不存在/.test(message)) return reply.code(404).send({ error: "PLAN_NOT_FOUND", message });
  return reply.code(500).send({ error: "PLAN_ACTION_FAILED", message });
}

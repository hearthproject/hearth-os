import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { LibraryService } from "../library/service.ts";
import { SkillError, type SkillService } from "./service.ts";

const installSchema = z.object({
  source: z.string().trim().min(1).max(4_096),
  ref: z.string().trim().min(1).max(200).nullable().optional(),
  path: z.string().trim().min(1).max(1_000).nullable().optional(),
  name: z.string().trim().min(1).max(120).nullable().optional(),
  confirmed: z.literal(true)
}).strict();

const useSchema = z.object({
  taskId: z.string().trim().min(1).max(80).nullable().optional(),
  runId: z.string().trim().min(1).max(80).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional()
}).strict();

export function registerSkillRoutes(app: FastifyInstance, skills: SkillService, library: LibraryService): void {
  app.get("/api/skills", async () => ({ skills: skills.list() }));

  app.get<{ Params: { id: string } }>("/api/skills/:id", async (request, reply) => {
    const skill = skills.get(request.params.id);
    if (!skill) return reply.code(404).send({ error: "SKILL_NOT_FOUND", message: "没有找到这个技能" });
    return { skill };
  });

  app.post("/api/skills/install", async (request, reply) => {
    const parsed = installSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "SKILL_CONFIRMATION_REQUIRED", message: "安装技能前需要先确认" });
    }
    try {
      const result = await skills.install({
        source: parsed.data.source,
        ref: parsed.data.ref ?? null,
        path: parsed.data.path ?? null,
        name: parsed.data.name ?? null
      });
      library.markDirty();
      return reply.code(201).send(result);
    } catch (error) {
      return skillFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/skills/:id/update", async (request, reply) => {
    try {
      const result = await skills.update(request.params.id);
      library.markDirty();
      return result;
    } catch (error) {
      return skillFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/skills/:id", async (request, reply) => {
    try {
      return skills.remove(request.params.id);
    } catch (error) {
      return skillFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/skills/:id/use", async (request, reply) => {
    const parsed = useSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SKILL_USE", message: "使用方式不正确" });
    try {
      return skills.use(request.params.id, {
        taskId: parsed.data.taskId ?? null,
        runId: parsed.data.runId ?? null,
        note: parsed.data.note ?? null
      });
    } catch (error) {
      return skillFailure(reply, error);
    }
  });
}

function skillFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SkillError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  return reply.code(500).send({ error: "SKILL_FAILED", message: error instanceof Error ? error.message : "技能操作失败" });
}

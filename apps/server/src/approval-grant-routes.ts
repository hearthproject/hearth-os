import type { FastifyInstance } from "fastify";
import type { ApprovalGrantRepository } from "./approval-grants.ts";

export function registerApprovalGrantRoutes(app: FastifyInstance, grants: ApprovalGrantRepository): void {
  app.get("/api/approval-grants", async () => ({ grants: grants.list() }));

  app.delete<{ Params: { id: string } }>("/api/approval-grants/:id", async (request, reply) => {
    if (!grants.revoke(request.params.id)) {
      return reply.code(404).send({ code: "APPROVAL_GRANT_NOT_FOUND", message: "这条自动执行规则不存在或已撤销" });
    }
    return { ok: true };
  });
}

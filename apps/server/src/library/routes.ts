import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { LibraryError, type LibraryService } from "./service.ts";

const treeQuerySchema = z.object({
  depth: z.coerce.number().int().min(1).max(6).default(2),
  parentId: z.string().trim().min(1).max(80).optional()
}).strict();

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).default(20)
}).strict();

const removeNodeSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional()
}).strict();

const addRootSchema = z.object({
  path: z.string().trim().min(1).max(4_096),
  projectId: z.string().trim().min(1).max(120).nullable().optional()
}).strict();

const summarySchema = z.object({
  force: z.boolean().optional()
}).strict();

const resolveQuerySchema = z.object({
  node: z.string().trim().min(1).max(4_096)
}).strict();

export function registerLibraryRoutes(app: FastifyInstance, library: LibraryService): void {
  app.get("/api/library/status", async () => {
    library.tree.ensureRoots();
    return {
      ...library.status(),
      roots: library.tree.listRoots(),
      trashCount: library.tree.repository.listTrash().length
    };
  });

  app.get("/api/library/tree", async (request, reply) => {
    const parsed = treeQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply);
    return { nodes: library.tree.buildTree(parsed.data.depth, parsed.data.parentId ?? null) };
  });

  app.get("/api/library/search", async (request, reply) => {
    const parsed = searchQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply);
    return library.search(parsed.data.q, parsed.data.limit);
  });

  app.post("/api/library/reindex", async () => ({ result: await library.reindex() }));

  app.get("/api/library/resolve", async (request, reply) => {
    const parsed = resolveQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply);
    const node = library.resolveNode(parsed.data.node);
    if (!node) return reply.code(404).send({ error: "NODE_NOT_FOUND", message: "没有找到这份资料" });
    return { node };
  });

  app.get<{ Params: { id: string } }>("/api/library/nodes/:id", async (request, reply) => {
    try {
      return library.getNodeDetails(request.params.id);
    } catch (error) {
      return libraryFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/library/nodes/:id/summary", async (request, reply) => {
    const parsed = summarySchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply);
    try {
      return { summary: await library.summarizeNode(request.params.id, parsed.data.force ?? false) };
    } catch (error) {
      return libraryFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/library/nodes/:id/content", async (request, reply) => {
    try {
      const details = library.getNodeDetails(request.params.id);
      if (!details.document) {
        return reply.code(404).send({ error: "CONTENT_UNAVAILABLE", message: "这份资料暂时没有可预览的文字" });
      }
      return { node: details.node, ...details.document };
    } catch (error) {
      return libraryFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/library/nodes/:id", async (request, reply) => {
    const parsed = removeNodeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply);
    try {
      return { entry: library.removeNode(request.params.id, parsed.data.reason) };
    } catch (error) {
      return libraryFailure(reply, error);
    }
  });

  app.get("/api/library/trash", async () => ({ entries: library.listTrash() }));

  app.post<{ Params: { id: string } }>("/api/library/trash/:id/restore", async (request, reply) => {
    try {
      return library.restoreTrash(request.params.id);
    } catch (error) {
      return libraryFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/library/trash/:id", async (request, reply) => {
    if (!library.deleteTrash(request.params.id)) {
      return reply.code(404).send({ error: "TRASH_NOT_FOUND", message: "回收站里没有这条资料" });
    }
    return { ok: true };
  });

  app.get("/api/library/roots", async () => ({ roots: library.tree.listRoots() }));

  app.post("/api/library/roots", async (request, reply) => {
    const parsed = addRootSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply);
    try {
      const root = library.tree.addRoot(parsed.data.path, { projectId: parsed.data.projectId ?? null });
      library.markDirty();
      return reply.code(201).send({ root });
    } catch (error) {
      return reply.code(400).send({ error: "INVALID_ROOT", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/library/roots/:id", async (request, reply) => {
    if (!library.tree.removeRoot(request.params.id)) {
      return reply.code(404).send({ error: "ROOT_NOT_FOUND", message: "没有找到这个文件夹" });
    }
    library.markDirty();
    return { ok: true };
  });
}

function invalid(reply: FastifyReply) {
  return reply.code(400).send({ error: "INVALID_LIBRARY_REQUEST", message: "请求格式不正确" });
}

function libraryFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof LibraryError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

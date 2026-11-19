import { describe, expect, it, vi } from "vitest";
import {
  KnowledgeClient,
  KnowledgeClientError,
  type KnowledgeHit
} from "./client.ts";
import { DEFAULT_KNOWLEDGE_SETTINGS, type KnowledgeSettings } from "./settings.ts";

function buildSettings(): KnowledgeSettings {
  return {
    ...DEFAULT_KNOWLEDGE_SETTINGS,
    serverArgs: [...DEFAULT_KNOWLEDGE_SETTINGS.serverArgs],
    recall: { ...DEFAULT_KNOWLEDGE_SETTINGS.recall },
    write: { ...DEFAULT_KNOWLEDGE_SETTINGS.write },
    peers: {}
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("KnowledgeClient", () => {
  it("reports health from the raw endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "ok", healthy: true, version: "0.5.5", auth_mode: "dev" }));
    const client = new KnowledgeClient(buildSettings(), { fetchImpl });
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.version).toBe("0.5.5");
    expect(health.authMode).toBe("dev");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("parses grouped find results, dedupes and sorts by score", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: "ok",
        result: {
          resources: [
            { uri: "viking://a", score: 0.4, level: 2, context_type: "resource" },
            { uri: "viking://b", score: 0.9, level: 1, abstract: "摘要" }
          ],
          memories: [{ uri: "viking://a", score: 0.2 }]
        }
      })
    );
    const client = new KnowledgeClient(buildSettings(), { fetchImpl });
    const hits = await client.find({ query: "部署", limit: 3, timeoutMs: 2500 });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.uri).toBe("viking://b");
    expect(hits[1]?.uri).toBe("viking://a");
    expect(hits[0]?.abstract).toBe("摘要");
  });

  it("sends write payload with mode, processing mode and tags", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.uri).toBe("viking://resources/hearth/tasks/t1/task.md");
      expect(body.mode).toBe("create");
      expect(body.processing_mode).toBe("vectors_only");
      expect(body.tag_mode).toBe("replace");
      expect(Array.isArray(body.tags)).toBe(true);
      return jsonResponse({ status: "ok", result: { uri: body.uri } });
    });
    const client = new KnowledgeClient(buildSettings(), { fetchImpl });
    const result = await client.write({
      uri: "viking://resources/hearth/tasks/t1/task.md",
      content: "# 任务",
      mode: "create",
      tags: ["source=hearth"]
    });
    expect(result.uri).toBe("viking://resources/hearth/tasks/t1/task.md");
  });

  it("maps aborts to KNOWLEDGE_TIMEOUT", async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    );
    const client = new KnowledgeClient(buildSettings(), { fetchImpl });
    await expect(client.find({ query: "x", limit: 1, timeoutMs: 500 })).rejects.toMatchObject({
      code: "KNOWLEDGE_TIMEOUT",
      statusCode: 504
    });
  });

  it("opens the circuit after three failures", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        throw new TypeError("fetch failed");
      }
    );
    let now = 1_000;
    const client = new KnowledgeClient(buildSettings(), {
      fetchImpl,
      clock: () => new Date(now),
      circuitThreshold: 3,
      circuitCooldownMs: 60_000
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(client.find({ query: "x", limit: 1, timeoutMs: 500 })).rejects.toBeInstanceOf(
        KnowledgeClientError
      );
    }
    await expect(client.find({ query: "x", limit: 1, timeoutMs: 500 })).rejects.toMatchObject({
      code: "KNOWLEDGE_CIRCUIT_OPEN"
    });
    now = 61_500;
    fetchImpl.mockImplementation(async () => jsonResponse({ status: "ok", result: { resources: [] } }));
    await expect(client.find({ query: "x", limit: 1, timeoutMs: 500 })).resolves.toEqual([]);
  });

  it("returns typed hits from a real-shaped payload", () => {
    const hit: KnowledgeHit = {
      uri: "viking://resources/hearth/p0/baseline.md",
      contextType: "resource",
      level: 2,
      score: 0.77,
      abstract: null,
      tags: []
    };
    expect(hit.uri).toContain("viking://");
  });
});

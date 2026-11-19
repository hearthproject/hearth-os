import type { ContextPackItem, ExecutorId } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";
import type { TaskRecord } from "@hearth/core";
import { KnowledgeClient, KnowledgeClientError, type KnowledgeHit } from "./client.ts";
import { renderKnowledgeBlock, type RenderedKnowledgeBlock } from "./render.ts";
import type { KnowledgeSettings, KnowledgeSettingsStore } from "./settings.ts";

export interface KnowledgeRecallInput {
  query: string;
  taskId?: string | null;
  goalId?: string | null;
  conversationId?: string | null;
  executorId?: ExecutorId | null;
  budgetTokens?: number;
}

export interface KnowledgeRecallResult extends RenderedKnowledgeBlock {
  hits: KnowledgeHit[];
  degraded: boolean;
  durationMs: number;
  reason: string | null;
}

export interface KnowledgeRecallDeps {
  store: HearthStore;
  settings: KnowledgeSettingsStore;
  clientFactory?: (settings: KnowledgeSettings, actorPeerId: string | null) => KnowledgeClient;
  clock?: () => Date;
}

const EMPTY_RESULT: KnowledgeRecallResult = {
  block: "",
  items: [],
  usedTokens: 0,
  hits: [],
  degraded: false,
  durationMs: 0,
  reason: "disabled"
};

export class KnowledgeRecallService {
  private readonly store: HearthStore;
  private readonly settings: KnowledgeSettingsStore;
  private readonly clientFactory: (settings: KnowledgeSettings, actorPeerId: string | null) => KnowledgeClient;
  private readonly clock: () => Date;

  constructor(deps: KnowledgeRecallDeps) {
    this.store = deps.store;
    this.settings = deps.settings;
    this.clock = deps.clock ?? (() => new Date());
    this.clientFactory =
      deps.clientFactory ??
      ((settings, actorPeerId) =>
        new KnowledgeClient(settings, actorPeerId ? { actorPeerId } : {}));
  }

  isEnabled(): boolean {
    return this.settings.get().enabled;
  }

  async recall(input: KnowledgeRecallInput): Promise<KnowledgeRecallResult> {
    const settings = this.settings.get();
    if (!settings.enabled) return { ...EMPTY_RESULT };
    const query = buildQuery(input, this.store.getTask(input.taskId ?? ""));
    if (!query) return { ...EMPTY_RESULT, reason: "empty-query" };

    const startedAt = this.clock().getTime();
    const task = input.taskId ? this.store.getTask(input.taskId) : null;
    const targetUri = task?.projectId ? `viking://resources/hearth/projects/${task.projectId}` : undefined;
    const actorPeer =
      input.executorId ? (settings.peers[input.executorId] ?? input.executorId) : null;
    const client = this.clientFactory(settings, actorPeer);
    const limit = settings.recall.maxItems * 2;
    const timeoutMs = settings.recall.timeoutMs;

    const requests: Array<Promise<KnowledgeHit[]>> = [];
    if (settings.recall.includeResources) {
      requests.push(
        client.find({
          query,
          limit,
          timeoutMs,
          levels: [1, 2],
          contextTypes: ["resource"],
          ...(targetUri ? { targetUri } : {}),
          ...(settings.recall.minScore !== null ? { minScore: settings.recall.minScore } : {})
        })
      );
    }
    if (settings.recall.includeMemories) {
      requests.push(
        client.find({
          query,
          limit,
          timeoutMs,
          levels: [0, 1, 2],
          contextTypes: ["memory"],
          ...(settings.recall.minScore !== null ? { minScore: settings.recall.minScore } : {})
        })
      );
    }
    if (settings.recall.includeSkills) {
      requests.push(
        client.find({
          query,
          limit,
          timeoutMs,
          levels: [0, 1, 2],
          contextTypes: ["skill"],
          ...(settings.recall.minScore !== null ? { minScore: settings.recall.minScore } : {})
        })
      );
    }

    const settled = await Promise.allSettled(requests);
    const failures = settled.filter((entry) => entry.status === "rejected");
    const merged = dedupe(
      settled.flatMap((entry) => (entry.status === "fulfilled" ? entry.value : []))
    )
      .filter((hit) => (settings.recall.minScore === null ? true : (hit.score ?? 0) >= settings.recall.minScore))
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, settings.recall.maxItems);

    if (merged.length === 0) {
      return {
        ...EMPTY_RESULT,
        degraded: failures.length > 0,
        durationMs: this.clock().getTime() - startedAt,
        reason: failures.length > 0 ? describeFailure(failures[0]) : "no-hit"
      };
    }

    const excerpts = await this.excerptsFor(client, merged, timeoutMs);
    const rendered = renderKnowledgeBlock(merged, excerpts, {
      maxTokens: input.budgetTokens ?? settings.recall.maxTokens
    });
    return {
      ...rendered,
      hits: merged,
      degraded: failures.length === settled.length && settled.length > 0,
      durationMs: this.clock().getTime() - startedAt,
      reason: failures.length > 0 ? describeFailure(failures[0]) : null
    };
  }

  private async excerptsFor(
    client: KnowledgeClient,
    hits: KnowledgeHit[],
    timeoutMs: number
  ): Promise<Map<string, string>> {
    const excerpts = new Map<string, string>();
    for (const hit of hits) {
      if (hit.abstract) excerpts.set(hit.uri, hit.abstract);
    }
    const missing = hits.filter((hit) => !hit.abstract).slice(0, 2);
    await Promise.allSettled(
      missing.map(async (hit) => {
        try {
          const text = await client.read(hit.uri, { timeoutMs: Math.min(timeoutMs, 1500) });
          excerpts.set(hit.uri, text.slice(0, 1200));
        } catch {
          excerpts.set(hit.uri, "（未返回摘要，可按 URI 读取原文）");
        }
      })
    );
    for (const hit of missing) {
      if (!excerpts.has(hit.uri)) excerpts.set(hit.uri, "（未返回摘要，可按 URI 读取原文）");
    }
    return excerpts;
  }
}

export function knowledgeItemsOf(result: KnowledgeRecallResult): ContextPackItem[] {
  return result.items;
}

function buildQuery(input: KnowledgeRecallInput, task: TaskRecord | null): string {
  const parts = [input.query, task?.title, task?.goal, task?.nextAction].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0
  );
  return parts.join("\n").replace(/\s+/g, " ").trim().slice(0, 1500);
}

function dedupe(hits: KnowledgeHit[]): KnowledgeHit[] {
  const seen = new Set<string>();
  const result: KnowledgeHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.uri)) continue;
    seen.add(hit.uri);
    result.push(hit);
  }
  return result;
}

function describeFailure(entry: PromiseSettledResult<KnowledgeHit[]> | undefined): string {
  if (!entry || entry.status !== "rejected") return "unknown";
  const error = entry.reason;
  if (error instanceof KnowledgeClientError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

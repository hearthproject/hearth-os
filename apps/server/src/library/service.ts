import { createHash } from "node:crypto";
import type {
  LibraryNode,
  LibrarySearchHit,
  LibrarySearchResult,
  LibraryStatus,
  LibraryTrashEntry,
  MemoryRecord
} from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";
import type { MemoryService } from "../memory.ts";
import { bufferToEmbedding, cosineSimilarity, embeddingToBuffer, type EmbeddingProvider } from "./embedding.ts";
import { LibraryIndexer, type LibraryIndexResult } from "./indexer.ts";
import { localSummary, type LibrarySummaryGenerator, type LibrarySummarySource } from "./summary.ts";
import { LibraryTreeService } from "./tree.ts";

const TRASH_DAYS = 30;

export class LibraryError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "LibraryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface LibraryServiceOptions {
  memory?: MemoryService;
  indexer?: LibraryIndexer;
  embeddingProvider?: EmbeddingProvider;
  summaryGenerator?: LibrarySummaryGenerator;
}

export interface LibraryReindexResult extends LibraryIndexResult {
  embedded: number;
  semanticError: string | null;
}

export interface LibrarySummaryResult {
  nodeId: string;
  content: string;
  stale: false;
  generated: boolean;
  model: string | null;
}

export class LibraryService {
  readonly tree: LibraryTreeService;
  readonly indexer: LibraryIndexer;
  private readonly store: HearthStore;
  private readonly memory: MemoryService | null;
  private readonly embeddingProvider: EmbeddingProvider | null;
  private summaryGenerator: LibrarySummaryGenerator | null;
  private dirty = true;
  private refresh: Promise<LibraryReindexResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor(store: HearthStore, options: LibraryServiceOptions = {}) {
    this.store = store;
    this.memory = options.memory ?? null;
    this.embeddingProvider = options.embeddingProvider ?? null;
    this.summaryGenerator = options.summaryGenerator ?? null;
    this.tree = new LibraryTreeService(store);
    this.indexer = options.indexer ?? new LibraryIndexer(store, this.tree);
  }

  start(): void {
    if (this.timer || this.interval) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reindex().catch(() => undefined);
    }, 1_500);
    this.timer.unref();
    this.interval = setInterval(() => this.purgeExpiredTrash(), 6 * 60 * 60 * 1_000);
    this.interval.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
  }

  markDirty(): void {
    this.dirty = true;
    this.tree.repository.markAllSummariesStale();
  }

  setSummaryGenerator(generator: LibrarySummaryGenerator | null): void {
    this.summaryGenerator = generator;
  }

  status(): LibraryStatus {
    this.tree.repository.resetSummaryUsageIfNeeded();
    const settings = this.tree.repository.getSettings();
    const modelId = this.embeddingProvider?.modelId ?? settings.modelId;
    return {
      nodeCount: this.tree.repository.countNodes(),
      chunkCount: this.tree.repository.countChunks(),
      indexedCount: this.countDocuments(),
      pendingJobs: this.tree.repository.listJobs("pending", 10_000).length,
      semanticReady: this.embeddingProvider?.state === "ready"
        && this.tree.repository.listChunksPendingEmbedding(modelId, 1).length === 0,
      semanticEnabled: settings.semanticEnabled,
      modelId,
      modelState: this.embeddingProvider?.state ?? "missing",
      modelDownloadProgress: this.embeddingProvider?.progress ?? null,
      lastIndexAt: this.lastIndexedAt(),
      summaryTokensUsedToday: settings.summaryTokensUsedToday
    };
  }

  async summarizeNode(id: string, force = false): Promise<LibrarySummaryResult> {
    const node = this.tree.getNode(id);
    if (!node) throw new LibraryError("NODE_NOT_FOUND", "没有找到这个资料", 404);
    const children = this.tree.repository.listChildren(id, { limit: 200 });
    const source: LibrarySummarySource = {
      node,
      children: children.map((child) => ({
        id: child.id,
        title: child.title,
        kind: child.kind,
        excerpt: this.tree.repository.listChunks(child.id)[0]?.text ?? null,
        summary: this.tree.repository.getSummary(child.id, 1)?.content ?? null,
        updatedAt: child.updatedAt
      }))
    };
    const sourceHash = createHash("sha256")
      .update(JSON.stringify(source.children.map((child) => [child.id, child.title, child.kind, child.updatedAt, child.summary, child.excerpt])))
      .digest("hex");
    const previous = this.tree.repository.getSummary(id, 1);
    if (!force && previous && !previous.stale && previous.sourceHash === sourceHash) {
      return { nodeId: id, content: previous.content, stale: false, generated: false, model: null };
    }

    this.tree.repository.resetSummaryUsageIfNeeded();
    const settings = this.tree.repository.getSettings();
    const withinBudget = settings.summaryTokensUsedToday < settings.dailySummaryTokens;
    let value = this.summaryGenerator && withinBudget ? await this.summaryGenerator(source).catch(() => null) : null;
    value ??= localSummary(source);
    this.tree.repository.upsertSummary({
      nodeId: id,
      level: 1,
      content: value.content,
      sourceHash,
      model: value.model,
      tokenCount: value.tokenCount
    });
    if (value.tokenCount > 0) this.tree.repository.addSummaryUsage(value.tokenCount);
    return { nodeId: id, content: value.content, stale: false, generated: true, model: value.model };
  }

  async reindex(): Promise<LibraryReindexResult> {
    if (this.refresh) return this.refresh;
    this.refresh = this.indexer.indexAll()
      .then(async (result) => {
        const semantic = await this.embedPending();
        this.dirty = false;
        return { ...result, ...semantic };
      })
      .finally(() => {
        this.refresh = null;
      });
    return this.refresh;
  }

  private async embedPending(): Promise<{ embedded: number; semanticError: string | null }> {
    const provider = this.embeddingProvider;
    if (!provider || !this.tree.repository.getSettings().semanticEnabled) return { embedded: 0, semanticError: null };
    const pending = this.tree.repository.listChunksPendingEmbedding(provider.modelId, 5_000);
    if (pending.length === 0) return { embedded: 0, semanticError: null };
    try {
      await provider.load();
      let embedded = 0;
      for (let offset = 0; offset < pending.length; offset += 32) {
        const batch = pending.slice(offset, offset + 32);
        const vectors = await provider.embed(batch.map((chunk) => chunk.text));
        if (vectors.length !== batch.length) throw new Error("语义模型返回的向量数量不正确");
        for (let index = 0; index < batch.length; index += 1) {
          const vector = vectors[index];
          if (!vector || vector.length !== provider.dimensions) {
            throw new Error(`语义向量维度不正确：预期 ${provider.dimensions}`);
          }
          this.tree.repository.setChunkEmbedding(
            batch[index]!.id,
            embeddingToBuffer(vector),
            provider.modelId,
            provider.modelVersion
          );
          embedded += 1;
        }
      }
      return { embedded, semanticError: null };
    } catch (error) {
      return {
        embedded: 0,
        semanticError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async search(query: string, limit = 20): Promise<LibrarySearchResult> {
    const started = performance.now();
    const clean = query.trim();
    if (!clean) return { query: clean, hits: [], total: 0, semanticUsed: false, tookMs: 0 };
    if (this.tree.repository.countChunks() === 0 || this.dirty) await this.reindex();
    const candidateLimit = Math.max(50, limit * 5);
    const raw = this.tree.repository.searchFts(clean, candidateLimit);
    const merged = new Map<string, { nodeId: string; text: string; ftsRank: number | null; vectorRank: number | null }>();
    raw.forEach((hit, index) => {
      const previous = merged.get(hit.nodeId);
      if (previous) {
        previous.ftsRank = Math.min(previous.ftsRank ?? Number.POSITIVE_INFINITY, index + 1);
      } else {
        merged.set(hit.nodeId, { nodeId: hit.nodeId, text: hit.text, ftsRank: index + 1, vectorRank: null });
      }
    });

    let semanticUsed = false;
    const settings = this.tree.repository.getSettings();
    if (settings.semanticEnabled && this.embeddingProvider) {
      try {
        const chunks = this.tree.repository.listChunksWithEmbedding(this.embeddingProvider.modelId, 20_000);
        if (chunks.length > 0) {
          const [queryVector] = await this.embeddingProvider.embed([clean]);
          if (queryVector && queryVector.length === this.embeddingProvider.dimensions) {
            const vectorHits = chunks.flatMap((chunk) => {
              if (!chunk.embedding) return [];
              return [{ chunk, score: cosineSimilarity(queryVector, bufferToEmbedding(chunk.embedding)) }];
            }).sort((left, right) => right.score - left.score).slice(0, candidateLimit);
            vectorHits.forEach((hit, index) => {
              const previous = merged.get(hit.chunk.nodeId);
              if (previous) {
                previous.vectorRank = index + 1;
                if (!previous.ftsRank) previous.text = hit.chunk.text;
              } else {
                merged.set(hit.chunk.nodeId, {
                  nodeId: hit.chunk.nodeId,
                  text: hit.chunk.text,
                  ftsRank: null,
                  vectorRank: index + 1
                });
              }
            });
            semanticUsed = true;
          }
        }
      } catch {
        semanticUsed = false;
      }
    }

    const hits: LibrarySearchHit[] = [];
    for (const candidate of merged.values()) {
      const node = this.tree.repository.getNode(candidate.nodeId);
      if (!node || this.tree.repository.isHidden(node.ref, node.path)) continue;
      const lexical = candidate.ftsRank ? 1 / (60 + candidate.ftsRank) : 0;
      const semantic = candidate.vectorRank ? 1 / (60 + candidate.vectorRank) : 0;
      const matchedBy = candidate.ftsRank && candidate.vectorRank
        ? "hybrid"
        : candidate.vectorRank
          ? "vector"
          : [...clean].length < 3 ? "like" : "fts";
      hits.push({
        node,
        score: lexical + semantic,
        snippet: makeSnippet(candidate.text, clean),
        matchedBy
      });
    }
    hits.sort((left, right) => right.score - left.score);
    return {
      query: clean,
      hits: hits.slice(0, limit),
      total: hits.length,
      semanticUsed,
      tookMs: Math.round(performance.now() - started)
    };
  }

  getNode(id: string): LibraryNode | null {
    return this.tree.getNode(id);
  }

  resolveNode(selector: string): LibraryNode | null {
    const clean = selector.trim();
    if (!clean) return null;
    if (clean.startsWith("hearth://")) return this.tree.getNodeByRef(clean);
    return this.tree.getNode(clean) ?? this.tree.getNodeByPath(clean);
  }

  getNodeDetails(id: string): {
    node: LibraryNode;
    document: { content: string; extractor: string; language: string | null; charCount: number } | null;
    chunkCount: number;
    children: LibraryNode[];
  } {
    const node = this.tree.getNode(id);
    if (!node) throw new LibraryError("NODE_NOT_FOUND", "没有找到这个资料", 404);
    const document = this.tree.repository.getDocument(id);
    return {
      node,
      document: document ? {
        content: document.content,
        extractor: document.extractor,
        language: document.language,
        charCount: document.charCount
      } : null,
      chunkCount: this.tree.repository.listChunks(id).length,
      children: this.tree.repository.listChildren(id)
    };
  }

  removeNode(id: string, reason = "用户移入回收站"): LibraryTrashEntry {
    const node = this.tree.getNode(id);
    if (!node) throw new LibraryError("NODE_NOT_FOUND", "没有找到这个资料", 404);
    if (node.kind === "root") throw new LibraryError("ROOT_PROTECTED", "顶层资料不能删除");
    const memory = node.kind === "memory" ? this.store.getMemory(node.refId) : null;
    const document = this.tree.repository.getDocument(node.id);
    const expiresAt = new Date(Date.now() + TRASH_DAYS * 24 * 60 * 60 * 1_000).toISOString();
    const entry = this.tree.repository.addTrash({
      node,
      snapshot: {
        node,
        document: document ? { content: document.content, extractor: document.extractor, language: document.language } : null,
        ...(memory ? { memory } : {})
      },
      expiresAt
    });
    this.tree.repository.hideNode(node, reason);
    if (memory && memory.status !== "forgotten") this.memory?.forget(memory.id, reason);
    this.markDirty();
    return entry;
  }

  listTrash(): LibraryTrashEntry[] {
    this.purgeExpiredTrash();
    return this.tree.repository.listTrash();
  }

  restoreTrash(id: string): { entry: LibraryTrashEntry; restoredMemoryId: string | null } {
    const entry = this.tree.repository.getTrash(id);
    if (!entry) throw new LibraryError("TRASH_NOT_FOUND", "回收站里没有这条资料", 404);
    if (entry.restoredAt) throw new LibraryError("ALREADY_RESTORED", "这条资料已经恢复过", 409);
    this.tree.repository.unhidePath(entry.path);
    let restoredMemoryId: string | null = null;
    const memorySnapshot = entry.snapshot?.memory as MemoryRecord | undefined;
    if (entry.kind === "memory" && memorySnapshot && this.store.getMemory(memorySnapshot.id)?.status === "forgotten") {
      const restored = this.memory?.create({
        kind: memorySnapshot.kind,
        content: memorySnapshot.content,
        subjectKey: memorySnapshot.subjectKey,
        scope: memorySnapshot.scope,
        tags: memorySnapshot.tags,
        source: { type: "user", id: null, label: "从回收站恢复", excerpt: null },
        confidence: memorySnapshot.confidence,
        sensitivity: memorySnapshot.sensitivity,
        tier: memorySnapshot.tier,
        originClass: "user",
        trust: memorySnapshot.trust,
        allowRecall: memorySnapshot.allowRecall
      });
      if (restored) {
        restoredMemoryId = restored.id;
        if (memorySnapshot.status === "active") this.memory?.confirm(restored.id);
        this.tree.repository.deleteNode(entry.nodeId);
      }
    }
    const restored = this.tree.repository.restoreTrash(id);
    if (!restored) throw new LibraryError("TRASH_NOT_FOUND", "回收站里没有这条资料", 404);
    this.tree.syncAll();
    this.markDirty();
    return { entry: restored, restoredMemoryId };
  }

  deleteTrash(id: string): boolean {
    const entry = this.tree.repository.getTrash(id);
    if (!entry) return false;
    this.tree.repository.deleteNodesUnderPath(entry.path);
    this.tree.repository.deleteTrash(id);
    this.markDirty();
    return true;
  }

  purgeExpiredTrash(): number {
    const now = new Date().toISOString();
    const expired = this.tree.repository.listTrash().filter((entry) => entry.expiresAt <= now);
    for (const entry of expired) this.deleteTrash(entry.id);
    return expired.length;
  }

  private countDocuments(): number {
    return Number((this.store.db.prepare("SELECT COUNT(*) AS count FROM context_documents").get() as { count?: number }).count ?? 0);
  }

  private lastIndexedAt(): string | null {
    const row = this.store.db.prepare("SELECT MAX(updated_at) AS at FROM context_documents").get() as { at?: string | null };
    return row.at ?? null;
  }
}

function makeSnippet(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const index = normalized.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, index >= 0 ? index - 50 : 0);
  const snippet = normalized.slice(start, start + 260);
  return `${start > 0 ? "…" : ""}${snippet}${start + snippet.length < normalized.length ? "…" : ""}`;
}

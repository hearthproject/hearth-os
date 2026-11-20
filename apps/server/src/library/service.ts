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
import { LibraryIndexer, type LibraryIndexResult } from "./indexer.ts";
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
}

export class LibraryService {
  readonly tree: LibraryTreeService;
  readonly indexer: LibraryIndexer;
  private readonly store: HearthStore;
  private readonly memory: MemoryService | null;
  private dirty = true;
  private refresh: Promise<LibraryIndexResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor(store: HearthStore, options: LibraryServiceOptions = {}) {
    this.store = store;
    this.memory = options.memory ?? null;
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
  }

  status(): LibraryStatus {
    const settings = this.tree.repository.getSettings();
    return {
      nodeCount: this.tree.repository.countNodes(),
      chunkCount: this.tree.repository.countChunks(),
      indexedCount: this.countDocuments(),
      pendingJobs: this.tree.repository.listJobs("pending", 10_000).length,
      semanticReady: false,
      semanticEnabled: settings.semanticEnabled,
      modelId: settings.modelId,
      modelState: "missing",
      modelDownloadProgress: null,
      lastIndexAt: this.lastIndexedAt(),
      summaryTokensUsedToday: settings.summaryTokensUsedToday
    };
  }

  async reindex(): Promise<LibraryIndexResult> {
    if (this.refresh) return this.refresh;
    this.refresh = this.indexer.indexAll()
      .then((result) => {
        this.dirty = false;
        return result;
      })
      .finally(() => {
        this.refresh = null;
      });
    return this.refresh;
  }

  async search(query: string, limit = 20): Promise<LibrarySearchResult> {
    const started = performance.now();
    const clean = query.trim();
    if (!clean) return { query: clean, hits: [], total: 0, semanticUsed: false, tookMs: 0 };
    if (this.tree.repository.countChunks() === 0 || this.dirty) await this.reindex();
    const raw = this.tree.repository.searchFts(clean, Math.max(50, limit * 5));
    const deduped = new Map<string, LibrarySearchHit>();
    for (const hit of raw) {
      const node = this.tree.repository.getNode(hit.nodeId);
      if (!node || this.tree.repository.isHidden(node.ref, node.path)) continue;
      const previous = deduped.get(node.id);
      const score = hit.score > 0 ? hit.score : 1;
      if (!previous || score > previous.score) {
        deduped.set(node.id, {
          node,
          score,
          snippet: makeSnippet(hit.text, clean),
          matchedBy: [...clean].length < 3 ? "like" : "fts"
        });
      }
    }
    const hits = [...deduped.values()].sort((left, right) => right.score - left.score).slice(0, limit);
    return {
      query: clean,
      hits,
      total: deduped.size,
      semanticUsed: false,
      tookMs: Math.round(performance.now() - started)
    };
  }

  getNode(id: string): LibraryNode | null {
    return this.tree.getNode(id);
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

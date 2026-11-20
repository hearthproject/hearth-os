import { randomUUID } from "node:crypto";
import type {
  ApprovalGrant,
  LibraryNode,
  LibraryNodeKind,
  LibraryRoot,
  LibrarySettings,
  LibrarySettingsPatch,
  LibraryTrashEntry
} from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";

type Row = Record<string, unknown>;

const VISIBLE_NODE_SQL = `NOT EXISTS (
  SELECT 1 FROM library_hidden h
  WHERE h.ref = context_nodes.ref
     OR context_nodes.path = h.path
     OR substr(context_nodes.path, 1, length(h.path) + 1) = h.path || '/'
)`;

export interface LibraryJob {
  id: string;
  kind: string;
  ref: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryDocumentRecord {
  nodeId: string;
  content: string;
  contentHash: string;
  extractor: string;
  language: string | null;
  charCount: number;
  updatedAt: string;
}

export interface LibraryChunkRecord {
  id: string;
  nodeId: string;
  ordinal: number;
  text: string;
  startOffset: number | null;
  endOffset: number | null;
  tokenCount: number;
  contentHash: string;
  embedding: Buffer | null;
  embeddingModel: string | null;
  embeddingVersion: string | null;
  createdAt: string;
}

export interface LibraryChunkInput {
  id: string;
  ordinal: number;
  text: string;
  startOffset: number | null;
  endOffset: number | null;
  tokenCount: number;
  contentHash: string;
}

export interface LibraryNodeListOptions {
  parentId?: string | null;
  kind?: LibraryNodeKind | undefined;
  projectId?: string | null | undefined;
  includeTrashed?: boolean;
  limit?: number;
}

export interface LibraryFtsHit {
  nodeId: string;
  chunkId: string;
  text: string;
  score: number;
}

export class LibraryRepository {
  private readonly store: HearthStore;

  constructor(store: HearthStore) {
    this.store = store;
    this.store.db.prepare("INSERT OR IGNORE INTO library_settings (id) VALUES (1)").run();
  }

  getNode(id: string): LibraryNode | null {
    const row = this.store.db.prepare(`SELECT * FROM context_nodes WHERE id = ? AND ${VISIBLE_NODE_SQL}`).get(id) as Row | undefined;
    return row ? nodeFromRow(row) : null;
  }

  getNodeByRef(ref: string): LibraryNode | null {
    const row = this.store.db.prepare(`SELECT * FROM context_nodes WHERE ref = ? AND ${VISIBLE_NODE_SQL}`).get(ref) as Row | undefined;
    return row ? nodeFromRow(row) : null;
  }

  listChildren(parentId: string | null, options: { includeTrashed?: boolean; limit?: number } = {}): LibraryNode[] {
    const limit = Math.max(1, Math.min(5_000, options.limit ?? 2_000));
    const trashed = options.includeTrashed ? "" : " AND trashed_at IS NULL";
    const rows = parentId === null
      ? this.store.db.prepare(`SELECT * FROM context_nodes WHERE parent_id IS NULL${trashed} AND ${VISIBLE_NODE_SQL} ORDER BY title ASC LIMIT ?`).all(limit) as Row[]
      : this.store.db.prepare(`SELECT * FROM context_nodes WHERE parent_id = ?${trashed} AND ${VISIBLE_NODE_SQL} ORDER BY title ASC LIMIT ?`).all(parentId, limit) as Row[];
    return rows.map(nodeFromRow);
  }

  listNodes(options: LibraryNodeListOptions = {}): LibraryNode[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (options.parentId !== undefined) {
      if (options.parentId === null) clauses.push("parent_id IS NULL");
      else {
        clauses.push("parent_id = ?");
        values.push(options.parentId);
      }
    }
    if (options.kind) {
      clauses.push("kind = ?");
      values.push(options.kind);
    }
    if (options.projectId !== undefined) {
      if (options.projectId === null) clauses.push("project_id IS NULL");
      else {
        clauses.push("project_id = ?");
        values.push(options.projectId);
      }
    }
    if (!options.includeTrashed) clauses.push("trashed_at IS NULL");
    clauses.push(VISIBLE_NODE_SQL);
    const where = `WHERE ${clauses.join(" AND ")}`;
    values.push(Math.max(1, Math.min(10_000, options.limit ?? 5_000)));
    const rows = this.store.db
      .prepare(`SELECT * FROM context_nodes ${where} ORDER BY kind ASC, title ASC LIMIT ?`)
      .all(...values) as Row[];
    return rows.map(nodeFromRow);
  }

  upsertNode(node: LibraryNode): LibraryNode {
    this.store.db.prepare(
      `INSERT INTO context_nodes
        (id, ref, kind, ref_id, parent_id, path, title, project_id, mime_type, size_bytes,
         content_hash, status, sensitivity, metadata_json, created_at, updated_at, trashed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET
         kind=excluded.kind, ref_id=excluded.ref_id, parent_id=excluded.parent_id,
         path=excluded.path, title=excluded.title, project_id=excluded.project_id,
         mime_type=excluded.mime_type, size_bytes=excluded.size_bytes,
         content_hash=excluded.content_hash, status=excluded.status,
         sensitivity=excluded.sensitivity, metadata_json=excluded.metadata_json,
         updated_at=excluded.updated_at, trashed_at=excluded.trashed_at`
    ).run(
      node.id, node.ref, node.kind, node.refId, node.parentId, node.path, node.title,
      node.projectId, node.mimeType, node.sizeBytes, node.contentHash, node.status,
      node.sensitivity, JSON.stringify(node.metadata), node.createdAt, node.updatedAt, node.trashedAt
    );
    const saved = this.store.db.prepare("SELECT * FROM context_nodes WHERE ref = ?").get(node.ref) as Row | undefined;
    if (!saved) throw new Error(`failed to persist library node ${node.ref}`);
    return nodeFromRow(saved);
  }

  updateNode(id: string, patch: Partial<Pick<LibraryNode, "parentId" | "path" | "title" | "status" | "metadata" | "trashedAt" | "updatedAt" | "contentHash" | "sizeBytes" | "mimeType" | "sensitivity">>): LibraryNode | null {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (patch.parentId !== undefined) {
      fields.push("parent_id = ?");
      values.push(patch.parentId);
    }
    if (patch.path !== undefined) {
      fields.push("path = ?");
      values.push(patch.path);
    }
    if (patch.title !== undefined) {
      fields.push("title = ?");
      values.push(patch.title);
    }
    if (patch.status !== undefined) {
      fields.push("status = ?");
      values.push(patch.status);
    }
    if (patch.metadata !== undefined) {
      fields.push("metadata_json = ?");
      values.push(JSON.stringify(patch.metadata));
    }
    if (patch.trashedAt !== undefined) {
      fields.push("trashed_at = ?");
      values.push(patch.trashedAt);
    }
    if (patch.updatedAt !== undefined) {
      fields.push("updated_at = ?");
      values.push(patch.updatedAt);
    }
    if (patch.contentHash !== undefined) {
      fields.push("content_hash = ?");
      values.push(patch.contentHash);
    }
    if (patch.sizeBytes !== undefined) {
      fields.push("size_bytes = ?");
      values.push(patch.sizeBytes);
    }
    if (patch.mimeType !== undefined) {
      fields.push("mime_type = ?");
      values.push(patch.mimeType);
    }
    if (patch.sensitivity !== undefined) {
      fields.push("sensitivity = ?");
      values.push(patch.sensitivity);
    }
    if (fields.length === 0) return this.getNode(id);
    this.store.db.prepare(`UPDATE context_nodes SET ${fields.join(", ")} WHERE id = ?`).run(...values as never[], id);
    return this.getNode(id);
  }

  deleteNode(id: string): void {
    this.store.db.exec("BEGIN");
    try {
      this.store.db.prepare("DELETE FROM context_chunks_fts WHERE node_id = ?").run(id);
      this.store.db.prepare("DELETE FROM context_chunks WHERE node_id = ?").run(id);
      this.store.db.prepare("DELETE FROM context_documents WHERE node_id = ?").run(id);
      this.store.db.prepare("DELETE FROM context_summaries WHERE node_id = ?").run(id);
      this.store.db.prepare("DELETE FROM context_nodes WHERE id = ?").run(id);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  countNodes(): number {
    return Number((this.store.db.prepare(`SELECT COUNT(*) AS count FROM context_nodes WHERE trashed_at IS NULL AND ${VISIBLE_NODE_SQL}`).get() as Row).count ?? 0);
  }

  countChunks(): number {
    return Number((this.store.db.prepare("SELECT COUNT(*) AS count FROM context_chunks").get() as Row).count ?? 0);
  }

  getDocument(nodeId: string): LibraryDocumentRecord | null {
    const row = this.store.db.prepare("SELECT * FROM context_documents WHERE node_id = ?").get(nodeId) as Row | undefined;
    return row ? {
      nodeId: String(row.node_id),
      content: String(row.content),
      contentHash: String(row.content_hash),
      extractor: String(row.extractor),
      language: row.language === null ? null : String(row.language),
      charCount: Number(row.char_count),
      updatedAt: String(row.updated_at)
    } : null;
  }

  upsertDocument(input: LibraryDocumentRecord): void {
    this.store.db.prepare(
      `INSERT INTO context_documents (node_id, content, content_hash, extractor, language, char_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET content=excluded.content, content_hash=excluded.content_hash,
         extractor=excluded.extractor, language=excluded.language, char_count=excluded.char_count,
         updated_at=excluded.updated_at`
    ).run(input.nodeId, input.content, input.contentHash, input.extractor, input.language, input.charCount, input.updatedAt);
  }

  deleteDocument(nodeId: string): void {
    this.store.db.prepare("DELETE FROM context_chunks_fts WHERE node_id = ?").run(nodeId);
    this.store.db.prepare("DELETE FROM context_chunks WHERE node_id = ?").run(nodeId);
    this.store.db.prepare("DELETE FROM context_documents WHERE node_id = ?").run(nodeId);
  }

  replaceChunks(nodeId: string, chunks: LibraryChunkInput[]): void {
    this.store.db.exec("BEGIN");
    try {
      this.store.db.prepare("DELETE FROM context_chunks_fts WHERE node_id = ?").run(nodeId);
      this.store.db.prepare("DELETE FROM context_chunks WHERE node_id = ?").run(nodeId);
      const insert = this.store.db.prepare(
        `INSERT INTO context_chunks
          (id, node_id, ordinal, text, start_offset, end_offset, token_count, content_hash, embedding, embedding_model, embedding_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`
      );
      const insertFts = this.store.db.prepare("INSERT INTO context_chunks_fts (text, node_id, chunk_id) VALUES (?, ?, ?)");
      const now = new Date().toISOString();
      for (const chunk of chunks) {
        insert.run(chunk.id, nodeId, chunk.ordinal, chunk.text, chunk.startOffset, chunk.endOffset, chunk.tokenCount, chunk.contentHash, now);
        insertFts.run(chunk.text, nodeId, chunk.id);
      }
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  listChunks(nodeId: string): LibraryChunkRecord[] {
    const rows = this.store.db.prepare("SELECT * FROM context_chunks WHERE node_id = ? ORDER BY ordinal ASC").all(nodeId) as Row[];
    return rows.map(chunkFromRow);
  }

  listChunksWithEmbedding(modelId: string, limit = 10_000): LibraryChunkRecord[] {
    const rows = this.store.db.prepare(
      "SELECT * FROM context_chunks WHERE embedding IS NOT NULL AND embedding_model = ? ORDER BY created_at ASC LIMIT ?"
    ).all(modelId, limit) as Row[];
    return rows.map(chunkFromRow);
  }

  setChunkEmbedding(chunkId: string, embedding: Buffer, modelId: string, modelVersion: string): void {
    this.store.db.prepare(
      "UPDATE context_chunks SET embedding = ?, embedding_model = ?, embedding_version = ? WHERE id = ?"
    ).run(embedding, modelId, modelVersion, chunkId);
  }

  searchFts(query: string, limit = 50): LibraryFtsHit[] {
    const clean = query.trim();
    if (!clean) return [];
    if ([...clean].length < 3) {
      const rows = this.store.db.prepare(
        `SELECT node_id, id AS chunk_id, text FROM context_chunks WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`
      ).all(`%${clean}%`, limit) as Row[];
      return rows.map((row) => ({ nodeId: String(row.node_id), chunkId: String(row.chunk_id), text: String(row.text), score: 0 }));
    }
    const escaped = clean.replace(/"/g, '""');
    const rows = this.store.db.prepare(
      `SELECT node_id, chunk_id, text, bm25(context_chunks_fts) AS rank
       FROM context_chunks_fts WHERE context_chunks_fts MATCH ? ORDER BY rank ASC LIMIT ?`
    ).all(`"${escaped}"`, limit) as Row[];
    return rows.map((row) => ({
      nodeId: String(row.node_id),
      chunkId: String(row.chunk_id),
      text: String(row.text),
      score: -Number(row.rank ?? 0)
    }));
  }

  getSummary(nodeId: string, level: number): { content: string; stale: boolean; sourceHash: string } | null {
    const row = this.store.db.prepare("SELECT * FROM context_summaries WHERE node_id = ? AND level = ?").get(nodeId, level) as Row | undefined;
    return row ? { content: String(row.content), stale: Number(row.stale) === 1, sourceHash: String(row.source_hash) } : null;
  }

  upsertSummary(input: { nodeId: string; level: number; content: string; sourceHash: string; model: string | null; tokenCount: number }): void {
    this.store.db.prepare(
      `INSERT INTO context_summaries (node_id, level, content, source_hash, model, token_count, stale, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(node_id, level) DO UPDATE SET content=excluded.content, source_hash=excluded.source_hash,
         model=excluded.model, token_count=excluded.token_count, stale=0, generated_at=excluded.generated_at`
    ).run(input.nodeId, input.level, input.content, input.sourceHash, input.model, input.tokenCount, new Date().toISOString());
  }

  markSummaryStale(nodeId: string): void {
    this.store.db.prepare("UPDATE context_summaries SET stale = 1 WHERE node_id = ?").run(nodeId);
  }

  markAllSummariesStale(): void {
    this.store.db.prepare("UPDATE context_summaries SET stale = 1").run();
  }

  listRoots(): LibraryRoot[] {
    return (this.store.db.prepare("SELECT * FROM library_roots ORDER BY created_at ASC").all() as Row[]).map(rootFromRow);
  }

  upsertRoot(root: LibraryRoot): LibraryRoot {
    this.store.db.prepare(
      `INSERT INTO library_roots
        (id, path, kind, project_id, recursive, include_globs_json, exclude_globs_json,
         last_scan_at, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, project_id=excluded.project_id,
         recursive=excluded.recursive, include_globs_json=excluded.include_globs_json,
         exclude_globs_json=excluded.exclude_globs_json, last_scan_at=excluded.last_scan_at,
         status=excluded.status, error=excluded.error, updated_at=excluded.updated_at`
    ).run(
      root.id, root.path, root.kind, root.projectId, root.recursive ? 1 : 0,
      JSON.stringify(root.includeGlobs), JSON.stringify(root.excludeGlobs),
      root.lastScanAt, root.status, root.error, root.createdAt, root.updatedAt
    );
    const saved = this.store.db.prepare("SELECT * FROM library_roots WHERE path = ?").get(root.path) as Row | undefined;
    if (!saved) throw new Error(`failed to persist library root ${root.path}`);
    return rootFromRow(saved);
  }

  deleteRoot(path: string): void {
    this.store.db.prepare("DELETE FROM library_roots WHERE path = ?").run(path);
  }

  addTrash(input: { node: LibraryNode; snapshot: Record<string, unknown> | null; expiresAt: string }): LibraryTrashEntry {
    const id = randomUUID();
    const deletedAt = new Date().toISOString();
    this.store.db.prepare(
      `INSERT INTO library_trash (id, node_id, ref, kind, title, path, snapshot_json, deleted_at, expires_at, restored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(id, input.node.id, input.node.ref, input.node.kind, input.node.title, input.node.path, input.snapshot ? JSON.stringify(input.snapshot) : null, deletedAt, input.expiresAt);
    return {
      id, nodeId: input.node.id, ref: input.node.ref, kind: input.node.kind,
      title: input.node.title, path: input.node.path, snapshot: input.snapshot,
      deletedAt, expiresAt: input.expiresAt, restoredAt: null
    };
  }

  listTrash(includeRestored = false): LibraryTrashEntry[] {
    const rows = includeRestored
      ? this.store.db.prepare("SELECT * FROM library_trash ORDER BY deleted_at DESC").all() as Row[]
      : this.store.db.prepare("SELECT * FROM library_trash WHERE restored_at IS NULL ORDER BY deleted_at DESC").all() as Row[];
    return rows.map(trashFromRow);
  }

  getTrash(id: string): LibraryTrashEntry | null {
    const row = this.store.db.prepare("SELECT * FROM library_trash WHERE id = ?").get(id) as Row | undefined;
    return row ? trashFromRow(row) : null;
  }

  hideNode(node: LibraryNode, reason: string | null = null): void {
    this.store.db.prepare(
      `INSERT INTO library_hidden (ref, path, kind, reason, hidden_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET path=excluded.path, kind=excluded.kind, reason=excluded.reason, hidden_at=excluded.hidden_at`
    ).run(node.ref, node.path, node.kind, reason, new Date().toISOString());
  }

  unhidePath(path: string): void {
    this.store.db.prepare(
      "DELETE FROM library_hidden WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'"
    ).run(path, path, path);
  }

  isHidden(ref: string, path: string): boolean {
    const row = this.store.db.prepare(
      `SELECT 1 AS hidden FROM library_hidden
       WHERE ref = ? OR path = ? OR substr(?, 1, length(path) + 1) = path || '/' LIMIT 1`
    ).get(ref, path, path) as Row | undefined;
    return Boolean(row);
  }

  deleteTrash(id: string): void {
    this.store.db.prepare("DELETE FROM library_trash WHERE id = ?").run(id);
  }

  deleteNodesUnderPath(path: string): number {
    const rows = this.store.db.prepare(
      "SELECT id FROM context_nodes WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'"
    ).all(path, path, path) as Row[];
    for (const row of rows) this.deleteNode(String(row.id));
    this.store.db.prepare("DELETE FROM library_hidden WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'")
      .run(path, path, path);
    return rows.length;
  }

  restoreTrash(id: string): LibraryTrashEntry | null {
    const restoredAt = new Date().toISOString();
    this.store.db.prepare("UPDATE library_trash SET restored_at = ? WHERE id = ? AND restored_at IS NULL").run(restoredAt, id);
    return this.getTrash(id);
  }

  deleteExpiredTrash(now = new Date().toISOString()): number {
    const result = this.store.db.prepare("DELETE FROM library_trash WHERE restored_at IS NULL AND expires_at <= ?").run(now);
    return Number(result.changes ?? 0);
  }

  enqueueJob(kind: string, ref: string): LibraryJob {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.store.db.prepare(
      `INSERT INTO library_jobs (id, kind, ref, status, attempts, next_attempt_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
       ON CONFLICT(kind, ref) DO UPDATE SET status='pending', next_attempt_at=NULL, updated_at=excluded.updated_at`
    ).run(id, kind, ref, now, now);
    return this.getJobByKindRef(kind, ref) as LibraryJob;
  }

  getJobByKindRef(kind: string, ref: string): LibraryJob | null {
    const row = this.store.db.prepare("SELECT * FROM library_jobs WHERE kind = ? AND ref = ?").get(kind, ref) as Row | undefined;
    return row ? jobFromRow(row) : null;
  }

  listJobs(status?: string, limit = 100): LibraryJob[] {
    const rows = status
      ? this.store.db.prepare("SELECT * FROM library_jobs WHERE status = ? ORDER BY created_at ASC LIMIT ?").all(status, limit) as Row[]
      : this.store.db.prepare("SELECT * FROM library_jobs ORDER BY created_at ASC LIMIT ?").all(limit) as Row[];
    return rows.map(jobFromRow);
  }

  claimJobs(limit: number, now = new Date().toISOString()): LibraryJob[] {
    const rows = this.store.db.prepare(
      `SELECT * FROM library_jobs WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT ?`
    ).all(now, limit) as Row[];
    const claimed: LibraryJob[] = [];
    for (const row of rows) {
      const result = this.store.db.prepare(
        "UPDATE library_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'"
      ).run(now, String(row.id));
      if (Number(result.changes ?? 0) === 1) claimed.push(jobFromRow({ ...row, status: "running", attempts: Number(row.attempts ?? 0) + 1, updated_at: now }));
    }
    return claimed;
  }

  finishJob(id: string, input: { status: "completed" | "failed"; lastError?: string | null; nextAttemptAt?: string | null }): void {
    this.store.db.prepare(
      "UPDATE library_jobs SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?"
    ).run(input.status, input.lastError ?? null, input.nextAttemptAt ?? null, new Date().toISOString(), id);
  }

  getSettings(): LibrarySettings {
    const row = this.store.db.prepare("SELECT * FROM library_settings WHERE id = 1").get() as Row;
    return settingsFromRow(row);
  }

  updateSettings(patch: LibrarySettingsPatch): LibrarySettings {
    const current = this.getSettings();
    const next: LibrarySettings = {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      updatedAt: new Date().toISOString()
    } as LibrarySettings;
    this.store.db.prepare(
      `UPDATE library_settings SET semantic_enabled = ?, model_id = ?, model_version = ?,
         daily_summary_tokens = ?, max_file_bytes = ?, max_chunks_per_node = ?,
         include_globs_json = ?, exclude_globs_json = ?, updated_at = ? WHERE id = 1`
    ).run(
      next.semanticEnabled ? 1 : 0, next.modelId, next.modelVersion, next.dailySummaryTokens,
      next.maxFileBytes, next.maxChunksPerNode, JSON.stringify(next.includeGlobs),
      JSON.stringify(next.excludeGlobs), next.updatedAt
    );
    return this.getSettings();
  }

  addSummaryUsage(tokens: number): number {
    const today = new Date().toISOString().slice(0, 10);
    const current = this.getSettings();
    const used = current.summaryTokensUsedToday + Math.max(0, tokens);
    this.store.db.prepare(
      "UPDATE library_settings SET summary_tokens_used_today = ?, summary_usage_date = ? WHERE id = 1"
    ).run(used, today);
    return used;
  }

  resetSummaryUsageIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    const row = this.store.db.prepare("SELECT summary_usage_date FROM library_settings WHERE id = 1").get() as Row;
    if (String(row.summary_usage_date ?? "") !== today) {
      this.store.db.prepare("UPDATE library_settings SET summary_tokens_used_today = 0, summary_usage_date = ? WHERE id = 1").run(today);
    }
  }

  listGrants(includeRevoked = false): ApprovalGrant[] {
    const rows = includeRevoked
      ? this.store.db.prepare("SELECT * FROM approval_grants ORDER BY created_at DESC").all() as Row[]
      : this.store.db.prepare("SELECT * FROM approval_grants WHERE revoked_at IS NULL ORDER BY created_at DESC").all() as Row[];
    return rows.map(grantFromRow);
  }

  findGrant(service: string, action: string, scopeKey = "{}"): ApprovalGrant | null {
    const row = this.store.db.prepare(
      "SELECT * FROM approval_grants WHERE service = ? AND action = ? AND scope_json = ? AND revoked_at IS NULL LIMIT 1"
    ).get(service, action, scopeKey) as Row | undefined;
    return row ? grantFromRow(row) : null;
  }

  createGrant(service: string, action: string, scope: Record<string, unknown> = {}): ApprovalGrant {
    const id = randomUUID();
    const now = new Date().toISOString();
    const scopeJson = JSON.stringify(scope);
    this.store.db.prepare(
      `INSERT INTO approval_grants (id, service, action, scope_json, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(service, action, scope_json) WHERE revoked_at IS NULL DO UPDATE SET last_used_at = NULL`
    ).run(id, service, action, scopeJson, now);
    const row = this.store.db.prepare(
      "SELECT * FROM approval_grants WHERE service = ? AND action = ? AND scope_json = ? AND revoked_at IS NULL LIMIT 1"
    ).get(service, action, scopeJson) as Row;
    return grantFromRow(row);
  }

  touchGrant(id: string): void {
    this.store.db.prepare("UPDATE approval_grants SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  revokeGrant(id: string): void {
    this.store.db.prepare("UPDATE approval_grants SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  revokeAllGrants(): void {
    this.store.db.prepare("UPDATE approval_grants SET revoked_at = ? WHERE revoked_at IS NULL").run(new Date().toISOString());
  }
}

function nodeFromRow(row: Row): LibraryNode {
  return {
    id: String(row.id),
    ref: String(row.ref),
    kind: String(row.kind) as LibraryNodeKind,
    refId: String(row.ref_id),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    path: String(row.path),
    title: String(row.title),
    projectId: row.project_id === null ? null : String(row.project_id),
    mimeType: row.mime_type === null ? null : String(row.mime_type),
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    contentHash: row.content_hash === null ? null : String(row.content_hash),
    status: String(row.status) as LibraryNode["status"],
    sensitivity: String(row.sensitivity) as LibraryNode["sensitivity"],
    metadata: parseJsonObject(row.metadata_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    trashedAt: row.trashed_at === null ? null : String(row.trashed_at)
  };
}

function chunkFromRow(row: Row): LibraryChunkRecord {
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    ordinal: Number(row.ordinal),
    text: String(row.text),
    startOffset: row.start_offset === null ? null : Number(row.start_offset),
    endOffset: row.end_offset === null ? null : Number(row.end_offset),
    tokenCount: Number(row.token_count),
    contentHash: String(row.content_hash),
    embedding: row.embedding instanceof Uint8Array ? Buffer.from(row.embedding) : null,
    embeddingModel: row.embedding_model === null ? null : String(row.embedding_model),
    embeddingVersion: row.embedding_version === null ? null : String(row.embedding_version),
    createdAt: String(row.created_at)
  };
}

function rootFromRow(row: Row): LibraryRoot {
  return {
    id: String(row.id),
    path: String(row.path),
    kind: String(row.kind) as LibraryRoot["kind"],
    projectId: row.project_id === null ? null : String(row.project_id),
    recursive: Number(row.recursive) === 1,
    includeGlobs: parseJsonArray(row.include_globs_json),
    excludeGlobs: parseJsonArray(row.exclude_globs_json),
    lastScanAt: row.last_scan_at === null ? null : String(row.last_scan_at),
    status: String(row.status) as LibraryRoot["status"],
    error: row.error === null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function trashFromRow(row: Row): LibraryTrashEntry {
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    ref: String(row.ref),
    kind: String(row.kind) as LibraryTrashEntry["kind"],
    title: String(row.title),
    path: String(row.path),
    snapshot: row.snapshot_json === null ? null : parseJsonObject(row.snapshot_json),
    deletedAt: String(row.deleted_at),
    expiresAt: String(row.expires_at),
    restoredAt: row.restored_at === null ? null : String(row.restored_at)
  };
}

function jobFromRow(row: Row): LibraryJob {
  return {
    id: String(row.id),
    kind: String(row.kind),
    ref: String(row.ref),
    status: String(row.status),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? null : String(row.next_attempt_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function settingsFromRow(row: Row): LibrarySettings {
  return {
    semanticEnabled: Number(row.semantic_enabled) === 1,
    modelId: String(row.model_id),
    modelVersion: String(row.model_version),
    dailySummaryTokens: Number(row.daily_summary_tokens),
    summaryTokensUsedToday: Number(row.summary_tokens_used_today),
    maxFileBytes: Number(row.max_file_bytes),
    maxChunksPerNode: Number(row.max_chunks_per_node),
    includeGlobs: parseJsonArray(row.include_globs_json),
    excludeGlobs: parseJsonArray(row.exclude_globs_json),
    updatedAt: row.updated_at === null ? null : String(row.updated_at)
  };
}

function grantFromRow(row: Row): ApprovalGrant {
  return {
    id: String(row.id),
    service: String(row.service),
    action: String(row.action),
    scope: parseJsonObject(row.scope_json),
    createdAt: String(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at)
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

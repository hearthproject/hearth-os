// Durable evidence plane for Hearth OS.
//
// This database is separate from the runtime event log on purpose: evidence is
// append-only, content-addressed and read-mostly, while the runtime store stays
// the single writer for task/run state. Eval never opens this file directly;
// it reads through the read-only HTTP API.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  ArtifactProvenance,
  CompatibilityDiff,
  RuntimeManifest
} from "./contracts.ts";
import { compatibilityDiff } from "./contracts.ts";
import type { RuntimeExchange } from "@hearth/agent-runtime";
import type { CassetteMetadata } from "@hearth/agent-runtime";

type DbRow = Record<string, SQLInputValue>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_manifests (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  completeness TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifact_provenance (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  completeness TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cassettes (
  cassette_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL,
  exchange_count INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exchanges (
  id TEXT PRIMARY KEY,
  cassette_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  request_fingerprint TEXT,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  task_id TEXT,
  rule_id TEXT,
  policy_version TEXT,
  decision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cost_entries (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_id TEXT,
  provider TEXT,
  model TEXT,
  usd REAL NOT NULL,
  input_tokens INTEGER NOT NULL,
  cached_input_tokens INTEGER NOT NULL,
  cache_write_input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_output_tokens INTEGER NOT NULL,
  at_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget_state (
  scope_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS degradations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_results (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  run_id TEXT,
  task_id TEXT,
  verdict TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_preflights (
  id TEXT PRIMARY KEY,
  policy_hash TEXT NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_variants (
  variant_id TEXT PRIMARY KEY,
  effective_digest TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS forks (
  run_id TEXT PRIMARY KEY,
  parent_run_id TEXT NOT NULL,
  checkpoint_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replay_reports (
  id TEXT PRIMARY KEY,
  cassette_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  matched INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS provenance_task_idx ON artifact_provenance(task_id, created_at);
CREATE INDEX IF NOT EXISTS exchanges_run_idx ON exchanges(run_id, sequence);
CREATE INDEX IF NOT EXISTS cost_run_idx ON cost_entries(run_id, created_at);
CREATE INDEX IF NOT EXISTS cost_scope_idx ON cost_entries(scope_key, at_date);
CREATE INDEX IF NOT EXISTS degradation_run_idx ON degradations(run_id, created_at);
`;

export interface StoredCassette {
  metadata: CassetteMetadata;
  exchanges: RuntimeExchange[];
}

export interface CostEntry {
  id: string;
  scopeKey: string;
  runId: string;
  taskId: string;
  projectId: string | null;
  provider: string | null;
  model: string | null;
  usd: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  atDate: string;
  createdAt: string;
  pricingSnapshotId: string | null;
  pricingVersion: string | null;
  breakdown: Record<string, number>;
}

export class EvidenceStore {
  private readonly db: DatabaseSync;
  readonly blobRoot: string;

  constructor(path: string, blobRoot?: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.blobRoot = blobRoot ?? join(dirname(path), "evidence-blobs");
    mkdirSync(this.blobRoot, { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(work: () => T): T {
    this.db.exec("SAVEPOINT evidence_tx");
    try {
      const result = work();
      this.db.exec("RELEASE SAVEPOINT evidence_tx");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT evidence_tx");
      this.db.exec("RELEASE SAVEPOINT evidence_tx");
      throw error;
    }
  }

  saveManifest(manifest: RuntimeManifest): RuntimeManifest {
    this.db.prepare(
      `INSERT INTO runtime_manifests (run_id, task_id, fingerprint, completeness, created_at, finalized_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         fingerprint=excluded.fingerprint, completeness=excluded.completeness,
         finalized_at=excluded.finalized_at, payload_json=excluded.payload_json`
    ).run(
      manifest.runId,
      manifest.taskId,
      manifest.compatibilityFingerprint,
      manifest.completeness.status,
      manifest.createdAt,
      manifest.finalizedAt,
      JSON.stringify(manifest)
    );
    return manifest;
  }

  getManifest(runId: string): RuntimeManifest | null {
    const row = this.db.prepare("SELECT payload_json FROM runtime_manifests WHERE run_id = ?").get(runId) as DbRow | undefined;
    return row ? JSON.parse(String(row.payload_json)) as RuntimeManifest : null;
  }

  listManifests(taskId: string, limit = 50): RuntimeManifest[] {
    const rows = this.db.prepare(
      "SELECT payload_json FROM runtime_manifests WHERE task_id = ? ORDER BY created_at DESC LIMIT ?"
    ).all(taskId, Math.max(1, Math.min(500, limit))) as DbRow[];
    return rows.map((row) => JSON.parse(String(row.payload_json)) as RuntimeManifest);
  }

  listAllManifests(limit = 200): RuntimeManifest[] {
    const rows = this.db.prepare(
      "SELECT payload_json FROM runtime_manifests ORDER BY created_at DESC LIMIT ?"
    ).all(Math.max(1, Math.min(2_000, limit))) as DbRow[];
    return rows.map((row) => JSON.parse(String(row.payload_json)) as RuntimeManifest);
  }

  compareManifests(leftRunId: string, rightRunId: string): CompatibilityDiff {
    return compatibilityDiff(this.getManifest(leftRunId), this.getManifest(rightRunId));
  }

  saveProvenance(provenance: ArtifactProvenance): ArtifactProvenance {
    this.db.prepare(
      `INSERT INTO artifact_provenance (artifact_id, task_id, run_id, sha256, completeness, created_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(artifact_id) DO UPDATE SET payload_json=excluded.payload_json, completeness=excluded.completeness`
    ).run(
      provenance.artifactId,
      provenance.taskId,
      provenance.runId,
      provenance.sha256,
      provenance.completeness.status,
      provenance.createdAt,
      JSON.stringify(provenance)
    );
    return provenance;
  }

  getProvenance(artifactId: string): ArtifactProvenance | null {
    const row = this.db.prepare("SELECT payload_json FROM artifact_provenance WHERE artifact_id = ?").get(artifactId) as DbRow | undefined;
    return row ? JSON.parse(String(row.payload_json)) as ArtifactProvenance : null;
  }

  listProvenanceForTask(taskId: string, limit = 200): ArtifactProvenance[] {
    const rows = this.db.prepare(
      "SELECT payload_json FROM artifact_provenance WHERE task_id = ? ORDER BY created_at ASC LIMIT ?"
    ).all(taskId, Math.max(1, Math.min(1_000, limit))) as DbRow[];
    return rows.map((row) => JSON.parse(String(row.payload_json)) as ArtifactProvenance);
  }

  listProvenanceForRun(runId: string): ArtifactProvenance[] {
    const rows = this.db.prepare(
      "SELECT payload_json FROM artifact_provenance WHERE run_id = ? ORDER BY created_at ASC"
    ).all(runId) as DbRow[];
    return rows.map((row) => JSON.parse(String(row.payload_json)) as ArtifactProvenance);
  }

  saveCassette(cassetteId: string, metadata: CassetteMetadata, exchanges: RuntimeExchange[]): void {
    this.transaction(() => {
      this.db.prepare(
        `INSERT INTO cassettes (cassette_id, run_id, task_id, created_at, exchange_count, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(cassette_id) DO UPDATE SET exchange_count=excluded.exchange_count, payload_json=excluded.payload_json`
      ).run(
        cassetteId,
        metadata.runId,
        metadata.taskId,
        metadata.createdAt,
        exchanges.length,
        JSON.stringify(metadata)
      );
      for (const exchange of exchanges) {
        this.db.prepare(
          `INSERT INTO exchanges (id, cassette_id, run_id, sequence, kind, request_fingerprint, created_at, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`
        ).run(
          exchange.id,
          cassetteId,
          exchange.runId,
          exchange.sequence,
          exchange.kind,
          exchange.requestFingerprint,
          exchange.createdAt,
          JSON.stringify(exchange)
        );
      }
    });
  }

  listCassettes(runId?: string, limit = 50): CassetteMetadata[] {
    const rows = runId
      ? this.db.prepare("SELECT payload_json FROM cassettes WHERE run_id = ? ORDER BY created_at DESC LIMIT ?").all(runId, limit) as DbRow[]
      : this.db.prepare("SELECT payload_json FROM cassettes ORDER BY created_at DESC LIMIT ?").all(limit) as DbRow[];
    return rows.map((row) => JSON.parse(String(row.payload_json)) as CassetteMetadata);
  }

  getCassette(cassetteId: string): StoredCassette | null {
    const metaRow = this.db.prepare("SELECT payload_json FROM cassettes WHERE cassette_id = ?").get(cassetteId) as DbRow | undefined;
    if (!metaRow) return null;
    const exchanges = (this.db.prepare(
      "SELECT payload_json FROM exchanges WHERE cassette_id = ? ORDER BY sequence ASC"
    ).all(cassetteId) as DbRow[]).map((row) => JSON.parse(String(row.payload_json)) as RuntimeExchange);
    return { metadata: JSON.parse(String(metaRow.payload_json)) as CassetteMetadata, exchanges };
  }

  listExchanges(runId: string, kind?: string): RuntimeExchange[] {
    const rows = kind
      ? this.db.prepare("SELECT payload_json FROM exchanges WHERE run_id = ? AND kind = ? ORDER BY sequence ASC").all(runId, kind) as DbRow[]
      : this.db.prepare("SELECT payload_json FROM exchanges WHERE run_id = ? ORDER BY sequence ASC").all(runId) as DbRow[];
    return rows.map((row) => JSON.parse(String(row.payload_json)) as RuntimeExchange);
  }

  recordPolicyDecision(input: {
    id: string;
    runId: string | null;
    taskId: string | null;
    ruleId: string | null;
    policyVersion: string | null;
    decision: string;
    createdAt: string;
    payload: Record<string, unknown>;
  }): void {
    this.db.prepare(
      `INSERT INTO policy_decisions (id, run_id, task_id, rule_id, policy_version, decision, created_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, decision=excluded.decision`
    ).run(
      input.id,
      input.runId,
      input.taskId,
      input.ruleId,
      input.policyVersion,
      input.decision,
      input.createdAt,
      JSON.stringify(input.payload)
    );
  }

  listPolicyDecisions(input: { runId?: string; taskId?: string; limit?: number } = {}): Array<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(500, input.limit ?? 200));
    const rows = input.runId
      ? this.db.prepare("SELECT payload_json FROM policy_decisions WHERE run_id = ? ORDER BY created_at ASC LIMIT ?").all(input.runId, limit) as DbRow[]
      : input.taskId
        ? this.db.prepare("SELECT payload_json FROM policy_decisions WHERE task_id = ? ORDER BY created_at ASC LIMIT ?").all(input.taskId, limit) as DbRow[]
        : this.db.prepare("SELECT payload_json FROM policy_decisions ORDER BY created_at DESC LIMIT ?").all(limit) as DbRow[];
    return rows.map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
  }

  appendCost(entry: CostEntry): void {
    this.db.prepare(
      `INSERT INTO cost_entries (id, scope_key, run_id, task_id, project_id, provider, model, usd, input_tokens,
         cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, at_date, created_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`
    ).run(
      entry.id,
      entry.scopeKey,
      entry.runId,
      entry.taskId,
      entry.projectId,
      entry.provider,
      entry.model,
      entry.usd,
      entry.inputTokens,
      entry.cachedInputTokens,
      entry.cacheWriteInputTokens,
      entry.outputTokens,
      entry.reasoningOutputTokens,
      entry.atDate,
      entry.createdAt,
      JSON.stringify(entry)
    );
  }

  listCosts(input: { runId?: string; scopeKey?: string; taskId?: string; day?: string; limit?: number } = {}): CostEntry[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (input.runId) { conditions.push("run_id = ?"); params.push(input.runId); }
    if (input.scopeKey) { conditions.push("scope_key = ?"); params.push(input.scopeKey); }
    if (input.taskId) { conditions.push("task_id = ?"); params.push(input.taskId); }
    if (input.day) { conditions.push("at_date = ?"); params.push(input.day); }
    const limit = Math.max(1, Math.min(2_000, input.limit ?? 1_000));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT payload_json FROM cost_entries ${where} ORDER BY created_at ASC LIMIT ?`
    ).all(...params, limit) as DbRow[];
    return rows.map((row) => JSON.parse(String(row.payload_json)) as CostEntry);
  }

  saveBudgetState(scopeKey: string, payload: Record<string, unknown>, updatedAt: string): void {
    this.db.prepare(
      `INSERT INTO budget_state (scope_key, payload_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(scope_key) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at`
    ).run(scopeKey, JSON.stringify(payload), updatedAt);
  }

  getBudgetState(scopeKey: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT payload_json FROM budget_state WHERE scope_key = ?").get(scopeKey) as DbRow | undefined;
    return row ? JSON.parse(String(row.payload_json)) as Record<string, unknown> : null;
  }

  appendDegradation(record: Record<string, unknown> & { id: string; runId: string; createdAt: string }): void {
    this.db.prepare(
      "INSERT INTO degradations (id, run_id, created_at, payload_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json"
    ).run(record.id, record.runId, record.createdAt, JSON.stringify(record));
  }

  listDegradations(runId?: string, limit = 100): Array<Record<string, unknown>> {
    const rows = runId
      ? this.db.prepare("SELECT payload_json FROM degradations WHERE run_id = ? ORDER BY created_at ASC LIMIT ?").all(runId, limit) as DbRow[]
      : this.db.prepare("SELECT payload_json FROM degradations ORDER BY created_at DESC LIMIT ?").all(limit) as DbRow[];
    return rows.map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
  }

  saveVerificationResult(input: {
    id: string; specId: string; runId: string | null; taskId: string | null; verdict: string; createdAt: string; payload: Record<string, unknown>;
  }): void {
    this.db.prepare(
      `INSERT INTO verification_results (id, spec_id, run_id, task_id, verdict, created_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`
    ).run(input.id, input.specId, input.runId, input.taskId, input.verdict, input.createdAt, JSON.stringify(input.payload));
  }

  listVerificationResults(input: { runId?: string; taskId?: string; limit?: number } = {}): Array<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(500, input.limit ?? 100));
    const rows = input.runId
      ? this.db.prepare("SELECT payload_json FROM verification_results WHERE run_id = ? ORDER BY created_at DESC LIMIT ?").all(input.runId, limit) as DbRow[]
      : input.taskId
        ? this.db.prepare("SELECT payload_json FROM verification_results WHERE task_id = ? ORDER BY created_at DESC LIMIT ?").all(input.taskId, limit) as DbRow[]
        : this.db.prepare("SELECT payload_json FROM verification_results ORDER BY created_at DESC LIMIT ?").all(limit) as DbRow[];
    return rows.map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
  }

  savePreflight(input: { id: string; policyHash: string; taskId: string | null; createdAt: string; payload: Record<string, unknown> }): void {
    this.db.prepare(
      `INSERT INTO policy_preflights (id, policy_hash, task_id, created_at, payload_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`
    ).run(input.id, input.policyHash, input.taskId, input.createdAt, JSON.stringify(input.payload));
  }

  listPreflights(taskId?: string, limit = 50): Array<Record<string, unknown>> {
    const rows = taskId
      ? this.db.prepare("SELECT payload_json FROM policy_preflights WHERE task_id = ? ORDER BY created_at DESC LIMIT ?").all(taskId, limit) as DbRow[]
      : this.db.prepare("SELECT payload_json FROM policy_preflights ORDER BY created_at DESC LIMIT ?").all(limit) as DbRow[];
    return rows.map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
  }

  saveVariant(variantId: string, effectiveDigest: string, payload: Record<string, unknown>, updatedAt: string): void {
    this.db.prepare(
      `INSERT INTO harness_variants (variant_id, effective_digest, updated_at, payload_json) VALUES (?, ?, ?, ?)
       ON CONFLICT(variant_id) DO UPDATE SET effective_digest=excluded.effective_digest, payload_json=excluded.payload_json, updated_at=excluded.updated_at`
    ).run(variantId, effectiveDigest, updatedAt, JSON.stringify(payload));
  }

  listVariants(): Array<Record<string, unknown>> {
    return (this.db.prepare("SELECT payload_json FROM harness_variants ORDER BY variant_id ASC").all() as DbRow[])
      .map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
  }

  saveFork(record: { runId: string; parentRunId: string; checkpointSeq: number; createdAt: string; payload: Record<string, unknown> }): void {
    this.db.prepare(
      "INSERT INTO forks (run_id, parent_run_id, checkpoint_seq, created_at, payload_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET payload_json=excluded.payload_json"
    ).run(record.runId, record.parentRunId, record.checkpointSeq, record.createdAt, JSON.stringify(record.payload));
  }

  getFork(runId: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT payload_json FROM forks WHERE run_id = ?").get(runId) as DbRow | undefined;
    return row ? JSON.parse(String(row.payload_json)) as Record<string, unknown> : null;
  }

  saveReplayReport(input: {
    id: string; cassetteId: string; runId: string; mode: string; matched: boolean; createdAt: string; payload: Record<string, unknown>;
  }): void {
    this.db.prepare(
      `INSERT INTO replay_reports (id, cassette_id, run_id, mode, matched, created_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`
    ).run(input.id, input.cassetteId, input.runId, input.mode, input.matched ? 1 : 0, input.createdAt, JSON.stringify(input.payload));
  }

  getReplayReport(id: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT payload_json FROM replay_reports WHERE id = ?").get(id) as DbRow | undefined;
    return row ? JSON.parse(String(row.payload_json)) as Record<string, unknown> : null;
  }

  listReplayReports(input: { cassetteId?: string; runId?: string; limit?: number } = {}): Array<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(200, input.limit ?? 50));
    const rows = input.cassetteId
      ? this.db.prepare("SELECT payload_json FROM replay_reports WHERE cassette_id = ? ORDER BY created_at DESC LIMIT ?").all(input.cassetteId, limit) as DbRow[]
      : input.runId
        ? this.db.prepare("SELECT payload_json FROM replay_reports WHERE run_id = ? ORDER BY created_at DESC LIMIT ?").all(input.runId, limit) as DbRow[]
        : this.db.prepare("SELECT payload_json FROM replay_reports ORDER BY created_at DESC LIMIT ?").all(limit) as DbRow[];
    return rows.map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
  }
}

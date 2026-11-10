import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { LoadedCase } from "@hearth/eval-core/node";
import type {
  CaseManifest,
  CaseVersionSummary,
  EvalEventRecord,
  ExperimentRecord,
  ExperimentRunRecord,
  GraderResultRecord,
  HumanReviewRecord
} from "@hearth/eval-core";

type DbRow = Record<string, SQLInputValue>;

export interface StoredCase {
  summary: CaseVersionSummary;
  manifest: CaseManifest;
  updatedAt: string;
}

export interface RunMetrics {
  inputTokens: number;
  outputTokens: number;
  retryCount: number;
  approvalCount: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS case_versions (
  case_key TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  family TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  run_modes_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  environment_json TEXT NOT NULL,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS experiment_runs (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  case_key TEXT NOT NULL,
  case_version INTEGER NOT NULL,
  case_content_hash TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  repetition INTEGER NOT NULL,
  status TEXT NOT NULL,
  hearth_task_id TEXT,
  output_dir TEXT NOT NULL,
  external_ref TEXT NOT NULL UNIQUE,
  attempt INTEGER NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  score REAL,
  error TEXT,
  review_reasons_json TEXT NOT NULL,
  usage_json TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  approval_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS grader_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  criterion_id TEXT NOT NULL,
  source TEXT NOT NULL,
  passed INTEGER,
  score REAL,
  confidence REAL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  model TEXT,
  prompt_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS human_reviews (
  run_id TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  decision TEXT NOT NULL,
  score REAL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS eval_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  experiment_id TEXT,
  run_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS experiment_runs_experiment_idx ON experiment_runs(experiment_id, status);
CREATE INDEX IF NOT EXISTS experiment_runs_review_idx ON experiment_runs(status, updated_at);
CREATE INDEX IF NOT EXISTS grader_results_run_idx ON grader_results(run_id);
CREATE INDEX IF NOT EXISTS eval_events_experiment_idx ON eval_events(experiment_id, seq);
CREATE INDEX IF NOT EXISTS eval_events_run_idx ON eval_events(run_id, seq);
`;

export class EvalStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  syncCases(cases: LoadedCase[]): void {
    const now = new Date().toISOString();
    const statement = this.db.prepare(
      `INSERT INTO case_versions (case_key, version, title, family, difficulty, run_modes_json, content_hash, manifest_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(case_key) DO UPDATE SET
         version=excluded.version, title=excluded.title, family=excluded.family,
         difficulty=excluded.difficulty, run_modes_json=excluded.run_modes_json,
         content_hash=excluded.content_hash, manifest_json=excluded.manifest_json,
         updated_at=excluded.updated_at`
    );
    this.transaction(() => {
      for (const loaded of cases) {
        const manifest = loaded.manifest;
        statement.run(
          manifest.id,
          manifest.version,
          manifest.title,
          manifest.family,
          manifest.difficulty,
          JSON.stringify(manifest.runModes),
          loaded.contentHash,
          JSON.stringify(manifest),
          now
        );
      }
    });
  }

  listCases(): StoredCase[] {
    return (this.db.prepare("SELECT * FROM case_versions ORDER BY family ASC, case_key ASC").all() as DbRow[])
      .map(rowToCase);
  }

  getCase(caseKey: string): StoredCase | null {
    const row = this.db.prepare("SELECT * FROM case_versions WHERE case_key = ?").get(caseKey) as DbRow | undefined;
    return row ? rowToCase(row) : null;
  }

  createExperiment(experiment: ExperimentRecord): ExperimentRecord {
    this.db.prepare(
      `INSERT INTO experiments (id, name, status, config_json, environment_json, summary_json, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      experiment.id,
      experiment.name,
      experiment.status,
      JSON.stringify(experiment.config),
      JSON.stringify(experiment.environment),
      experiment.summary ? JSON.stringify(experiment.summary) : null,
      experiment.createdAt,
      experiment.startedAt,
      experiment.finishedAt
    );
    return experiment;
  }

  updateExperiment(id: string, patch: Partial<ExperimentRecord>): ExperimentRecord | null {
    const columns: Record<string, string> = {
      name: "name",
      status: "status",
      startedAt: "started_at",
      finishedAt: "finished_at"
    };
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      this.db.prepare(`UPDATE experiments SET ${column} = ? WHERE id = ?`)
        .run((patch[key as keyof ExperimentRecord] as SQLInputValue) ?? null, id);
    }
    if ("summary" in patch) {
      this.db.prepare("UPDATE experiments SET summary_json = ? WHERE id = ?")
        .run(patch.summary ? JSON.stringify(patch.summary) : null, id);
    }
    return this.getExperiment(id);
  }

  getExperiment(id: string): ExperimentRecord | null {
    const row = this.db.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToExperiment(row) : null;
  }

  listExperiments(limit = 100): ExperimentRecord[] {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    return (this.db.prepare("SELECT * FROM experiments ORDER BY created_at DESC LIMIT ?").all(bounded) as DbRow[])
      .map(rowToExperiment);
  }

  createRuns(runs: ExperimentRunRecord[]): void {
    const statement = this.db.prepare(
      `INSERT INTO experiment_runs (id, experiment_id, case_key, case_version, case_content_hash, executor_id, repetition, status, hearth_task_id, output_dir, external_ref, attempt, started_at, finished_at, score, error, review_reasons_json, usage_json, retry_count, approval_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.transaction(() => {
      for (const run of runs) {
        statement.run(
          run.id, run.experimentId, run.caseKey, run.caseVersion, run.caseContentHash,
          run.executorId, run.repetition, run.status, run.hearthTaskId, run.outputDir,
          run.externalRef, run.attempt, run.startedAt, run.finishedAt, run.score, run.error,
          JSON.stringify(run.reviewReasons), null, 0, 0, run.createdAt, run.updatedAt
        );
      }
    });
  }

  updateRun(id: string, patch: Partial<ExperimentRunRecord>): ExperimentRunRecord | null {
    const columns: Record<string, string> = {
      status: "status",
      hearthTaskId: "hearth_task_id",
      attempt: "attempt",
      startedAt: "started_at",
      finishedAt: "finished_at",
      score: "score",
      error: "error",
      updatedAt: "updated_at"
    };
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      this.db.prepare(`UPDATE experiment_runs SET ${column} = ? WHERE id = ?`)
        .run((patch[key as keyof ExperimentRunRecord] as SQLInputValue) ?? null, id);
    }
    if ("reviewReasons" in patch) {
      this.db.prepare("UPDATE experiment_runs SET review_reasons_json = ? WHERE id = ?")
        .run(JSON.stringify(patch.reviewReasons ?? []), id);
    }
    return this.getRun(id);
  }

  setRunMetrics(id: string, metrics: RunMetrics): void {
    this.db.prepare("UPDATE experiment_runs SET usage_json = ?, retry_count = ?, approval_count = ? WHERE id = ?")
      .run(JSON.stringify({ inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens }), metrics.retryCount, metrics.approvalCount, id);
  }

  getRunMetrics(id: string): RunMetrics | null {
    const row = this.db.prepare("SELECT usage_json, retry_count, approval_count FROM experiment_runs WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return null;
    const usage = row.usage_json == null ? {} : JSON.parse(String(row.usage_json)) as { inputTokens?: number; outputTokens?: number };
    return {
      inputTokens: Number(usage.inputTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
      retryCount: Number(row.retry_count ?? 0),
      approvalCount: Number(row.approval_count ?? 0)
    };
  }

  getRun(id: string): ExperimentRunRecord | null {
    const row = this.db.prepare("SELECT * FROM experiment_runs WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToRun(row) : null;
  }

  getRunByExternalRef(externalRef: string): ExperimentRunRecord | null {
    const row = this.db.prepare("SELECT * FROM experiment_runs WHERE external_ref = ?").get(externalRef) as DbRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(experimentId: string): ExperimentRunRecord[] {
    return (this.db.prepare(
      "SELECT * FROM experiment_runs WHERE experiment_id = ? ORDER BY case_key ASC, executor_id ASC, repetition ASC"
    ).all(experimentId) as DbRow[]).map(rowToRun);
  }

  listQueuedRuns(experimentId: string): ExperimentRunRecord[] {
    return (this.db.prepare(
      "SELECT * FROM experiment_runs WHERE experiment_id = ? AND status = 'queued' ORDER BY rowid ASC"
    ).all(experimentId) as DbRow[]).map(rowToRun);
  }

  replaceGraderResults(runId: string, results: GraderResultRecord[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM grader_results WHERE run_id = ?").run(runId);
      const statement = this.db.prepare(
        `INSERT INTO grader_results (id, run_id, criterion_id, source, passed, score, confidence, reason, evidence_json, model, prompt_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const result of results) {
        statement.run(
          result.id, result.runId, result.criterionId, result.source,
          result.passed === null ? null : result.passed ? 1 : 0,
          result.score, result.confidence, result.reason, JSON.stringify(result.evidence),
          result.model, result.promptHash, result.createdAt
        );
      }
    });
  }

  deleteGraderResultsBySource(runId: string, source: GraderResultRecord["source"]): void {
    this.db.prepare("DELETE FROM grader_results WHERE run_id = ? AND source = ?").run(runId, source);
  }

  listGraderResults(runId: string): GraderResultRecord[] {
    return (this.db.prepare("SELECT * FROM grader_results WHERE run_id = ? ORDER BY rowid ASC").all(runId) as DbRow[])
      .map(rowToGraderResult);
  }

  upsertHumanReview(review: HumanReviewRecord): HumanReviewRecord {
    this.db.prepare(
      `INSERT INTO human_reviews (run_id, id, reviewer, decision, score, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         reviewer=excluded.reviewer, decision=excluded.decision, score=excluded.score,
         note=excluded.note, updated_at=excluded.updated_at`
    ).run(
      review.runId, review.id, review.reviewer, review.decision, review.score,
      review.note, review.createdAt, review.updatedAt
    );
    return this.getHumanReview(review.runId) ?? review;
  }

  getHumanReview(runId: string): HumanReviewRecord | null {
    const row = this.db.prepare("SELECT * FROM human_reviews WHERE run_id = ?").get(runId) as DbRow | undefined;
    return row ? rowToHumanReview(row) : null;
  }

  listPendingReviewRuns(limit = 200): ExperimentRunRecord[] {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    return (this.db.prepare(
      `SELECT r.* FROM experiment_runs r
       LEFT JOIN human_reviews h ON h.run_id = r.id
       WHERE h.run_id IS NULL
         AND (r.status IN ('needs_review', 'failed', 'blocked', 'error') OR r.review_reasons_json <> '[]')
       ORDER BY r.updated_at ASC LIMIT ?`
    ).all(bounded) as DbRow[]).map(rowToRun);
  }

  countPendingReviews(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM experiment_runs r
       LEFT JOIN human_reviews h ON h.run_id = r.id
       WHERE h.run_id IS NULL
         AND (r.status IN ('needs_review', 'failed', 'blocked', 'error') OR r.review_reasons_json <> '[]')`
    ).get() as DbRow | undefined;
    return Number(row?.count ?? 0);
  }

  countRunningExperiments(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM experiments WHERE status IN ('queued', 'running', 'grading')").get() as DbRow | undefined;
    return Number(row?.count ?? 0);
  }

  appendEvent(type: string, input: { experimentId?: string | null; runId?: string | null; payload?: Record<string, unknown> } = {}): EvalEventRecord {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(
      "INSERT INTO eval_events (type, experiment_id, run_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      type,
      input.experimentId ?? null,
      input.runId ?? null,
      JSON.stringify(input.payload ?? {}),
      createdAt
    );
    return {
      seq: Number(result.lastInsertRowid),
      type,
      experimentId: input.experimentId ?? null,
      runId: input.runId ?? null,
      payload: input.payload ?? {},
      createdAt
    };
  }

  listEvents(input: { afterSeq?: number; experimentId?: string; runId?: string; limit?: number } = {}): EvalEventRecord[] {
    const conditions = ["seq > ?"];
    const params: SQLInputValue[] = [input.afterSeq ?? 0];
    if (input.experimentId) {
      conditions.push("experiment_id = ?");
      params.push(input.experimentId);
    }
    if (input.runId) {
      conditions.push("run_id = ?");
      params.push(input.runId);
    }
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit ?? 300)));
    params.push(limit);
    return (this.db.prepare(
      `SELECT * FROM eval_events WHERE ${conditions.join(" AND ")} ORDER BY seq ASC LIMIT ?`
    ).all(...params) as DbRow[]).map(rowToEvent);
  }

  recoverInterrupted(): number {
    const now = new Date().toISOString();
    const error = "评测服务重启，运行被中断";
    const result = this.db.prepare(
      `UPDATE experiment_runs SET status = 'error', error = ?, finished_at = ?, updated_at = ?
       WHERE status IN ('queued', 'created', 'running', 'waiting', 'grading')`
    ).run(error, now, now);
    this.db.prepare(
      `UPDATE experiments SET status = 'needs_review', finished_at = ?
       WHERE status IN ('queued', 'running', 'grading')`
    ).run(now);
    const count = Number(result.changes);
    if (count > 0) this.appendEvent("system.recovered", { payload: { interruptedRuns: count } });
    return count;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function rowToCase(row: DbRow): StoredCase {
  return {
    summary: {
      caseKey: String(row.case_key),
      version: Number(row.version),
      title: String(row.title),
      family: String(row.family) as CaseVersionSummary["family"],
      difficulty: String(row.difficulty) as CaseVersionSummary["difficulty"],
      runModes: JSON.parse(String(row.run_modes_json)) as CaseVersionSummary["runModes"],
      contentHash: String(row.content_hash)
    },
    manifest: JSON.parse(String(row.manifest_json)) as CaseManifest,
    updatedAt: String(row.updated_at)
  };
}

function rowToExperiment(row: DbRow): ExperimentRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    status: String(row.status) as ExperimentRecord["status"],
    config: JSON.parse(String(row.config_json)) as ExperimentRecord["config"],
    environment: JSON.parse(String(row.environment_json)) as ExperimentRecord["environment"],
    createdAt: String(row.created_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    summary: row.summary_json == null ? null : JSON.parse(String(row.summary_json)) as ExperimentRecord["summary"]
  };
}

function rowToRun(row: DbRow): ExperimentRunRecord {
  return {
    id: String(row.id),
    experimentId: String(row.experiment_id),
    caseKey: String(row.case_key),
    caseVersion: Number(row.case_version),
    caseContentHash: String(row.case_content_hash),
    executorId: String(row.executor_id),
    repetition: Number(row.repetition),
    status: String(row.status) as ExperimentRunRecord["status"],
    hearthTaskId: row.hearth_task_id == null ? null : String(row.hearth_task_id),
    outputDir: String(row.output_dir),
    externalRef: String(row.external_ref),
    attempt: Number(row.attempt),
    startedAt: row.started_at == null ? null : String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    score: row.score == null ? null : Number(row.score),
    error: row.error == null ? null : String(row.error),
    reviewReasons: JSON.parse(String(row.review_reasons_json)) as ExperimentRunRecord["reviewReasons"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToGraderResult(row: DbRow): GraderResultRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    criterionId: String(row.criterion_id),
    source: String(row.source) as GraderResultRecord["source"],
    passed: row.passed == null ? null : Number(row.passed) === 1,
    score: row.score == null ? null : Number(row.score),
    confidence: row.confidence == null ? null : Number(row.confidence),
    reason: String(row.reason),
    evidence: JSON.parse(String(row.evidence_json)) as string[],
    model: row.model == null ? null : String(row.model),
    promptHash: row.prompt_hash == null ? null : String(row.prompt_hash),
    createdAt: String(row.created_at)
  };
}

function rowToHumanReview(row: DbRow): HumanReviewRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    reviewer: String(row.reviewer),
    decision: String(row.decision) as HumanReviewRecord["decision"],
    score: row.score == null ? null : Number(row.score),
    note: String(row.note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToEvent(row: DbRow): EvalEventRecord {
  return {
    seq: Number(row.seq),
    type: String(row.type),
    experimentId: row.experiment_id == null ? null : String(row.experiment_id),
    runId: row.run_id == null ? null : String(row.run_id),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    createdAt: String(row.created_at)
  };
}

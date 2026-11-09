export const EVAL_FAMILIES = [
  "email",
  "calendar",
  "documents",
  "research",
  "code",
  "web",
  "desktop",
  "cross-app"
] as const;
export type EvalFamily = (typeof EVAL_FAMILIES)[number];

export const EVAL_DIFFICULTIES = ["normal", "edge", "failure", "adversarial"] as const;
export type EvalDifficulty = (typeof EVAL_DIFFICULTIES)[number];

export const EVAL_RUN_MODES = ["offline", "live-optional", "live-only"] as const;
export type EvalRunMode = (typeof EVAL_RUN_MODES)[number];

export const EXPERIMENT_STATUSES = [
  "queued",
  "running",
  "grading",
  "needs_review",
  "completed",
  "failed",
  "cancelled"
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const EXPERIMENT_RUN_STATUSES = [
  "queued",
  "created",
  "running",
  "waiting",
  "grading",
  "needs_review",
  "passed",
  "failed",
  "blocked",
  "cancelled",
  "error"
] as const;
export type ExperimentRunStatus = (typeof EXPERIMENT_RUN_STATUSES)[number];

export const REVIEW_TRIGGER_KINDS = [
  "low_confidence",
  "judge_conflict",
  "blocker_anomaly",
  "failed_sample",
  "judge_unavailable",
  "sampled"
] as const;
export type ReviewTriggerKind = (typeof REVIEW_TRIGGER_KINDS)[number];

export const GRADER_KINDS = [
  "file",
  "text",
  "json",
  "csv",
  "artifact_count",
  "state"
] as const;
export type GraderKind = (typeof GRADER_KINDS)[number];

export interface EvalInput {
  kind: "file" | "url" | "text";
  label: string;
  path?: string;
  value?: string;
  optional?: boolean;
}

export interface FileGraderConfig {
  kind: "file";
  path: string;
  minBytes?: number;
}

export interface TextGraderConfig {
  kind: "text";
  path: string;
  includes?: string[];
  excludes?: string[];
  regex?: string[];
}

export interface JsonGraderConfig {
  kind: "json";
  path: string;
  requiredPaths?: string[];
  equals?: Record<string, unknown>;
  minArrayLength?: Record<string, number>;
}

export interface CsvGraderConfig {
  kind: "csv";
  path: string;
  requiredColumns?: string[];
  minRows?: number;
  requiredValues?: Array<{ column: string; equals: string }>;
}

export interface ArtifactCountGraderConfig {
  kind: "artifact_count";
  prefix?: string;
  suffix?: string;
  min: number;
}

export interface StateGraderConfig {
  kind: "state";
  path: string;
  expected: Record<string, unknown>;
}

export type GraderConfig =
  | FileGraderConfig
  | TextGraderConfig
  | JsonGraderConfig
  | CsvGraderConfig
  | ArtifactCountGraderConfig
  | StateGraderConfig;

export interface GraderSpec {
  id: string;
  title: string;
  config: GraderConfig;
}

export interface EvalCriterion {
  id: string;
  label: string;
  source: "deterministic" | "judge" | "human";
  points: number;
  severity: "blocker" | "scored";
  graderId?: string;
  rubric?: string;
}

export interface CaseManifest {
  schemaVersion: 1;
  id: string;
  version: number;
  title: string;
  family: EvalFamily;
  difficulty: EvalDifficulty;
  runModes: EvalRunMode[];
  description: string;
  goal: string;
  tags: string[];
  timeoutMs: number;
  inputs: EvalInput[];
  liveInputs?: EvalInput[];
  networkHosts?: string[];
  expectedOutputs: string[];
  graders: GraderSpec[];
  criteria: EvalCriterion[];
  humanReview: {
    prompt: string;
    sampleRate: number;
  };
}

export interface ExperimentConfig {
  name: string;
  caseIds: string[];
  executorIds: string[];
  repetitions: number;
  runMode: "offline" | "live";
  autoJudge: boolean;
  autoRetry: boolean;
  maxConcurrency: number;
  baselineExperimentId?: string | null;
}

export interface ExperimentEnvironment {
  hearthUrl: string;
  hearthNow: string | null;
  schemaVersion: number | null;
  instanceId: string | null;
  executorSettings: Record<string, unknown>;
  judgeModel: string | null;
  evalVersion: string;
}

export interface CaseVersionSummary {
  caseKey: string;
  version: number;
  title: string;
  family: EvalFamily;
  difficulty: EvalDifficulty;
  runModes: EvalRunMode[];
  contentHash: string;
}

export interface ExperimentRecord {
  id: string;
  name: string;
  status: ExperimentStatus;
  config: ExperimentConfig;
  environment: ExperimentEnvironment;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  summary: ExperimentSummary | null;
}

export interface ExperimentRunRecord {
  id: string;
  experimentId: string;
  caseKey: string;
  caseVersion: number;
  caseContentHash: string;
  executorId: string;
  repetition: number;
  status: ExperimentRunStatus;
  hearthTaskId: string | null;
  outputDir: string;
  externalRef: string;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  score: number | null;
  error: string | null;
  reviewReasons: ReviewTriggerKind[];
  createdAt: string;
  updatedAt: string;
}

export interface GraderResultRecord {
  id: string;
  runId: string;
  criterionId: string;
  source: "deterministic" | "judge" | "human";
  passed: boolean | null;
  score: number | null;
  confidence: number | null;
  reason: string;
  evidence: string[];
  model: string | null;
  promptHash: string | null;
  createdAt: string;
}

export interface HumanReviewRecord {
  id: string;
  runId: string;
  reviewer: string;
  decision: "pass" | "fail" | "unknown";
  score: number | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface FamilySummary {
  family: EvalFamily;
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  needsReview: number;
  passRate: number | null;
  avgScore: number | null;
}

export interface ExperimentSummary {
  experimentId: string;
  totalRuns: number;
  passed: number;
  failed: number;
  blocked: number;
  needsReview: number;
  passRate: number | null;
  avgScore: number | null;
  avgDurationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  retries: number;
  approvals: number;
  families: FamilySummary[];
  failureDiagnostics: Array<{ kind: string; count: number; runIds: string[] }>;
  generatedAt: string;
}

export interface ExperimentComparison {
  leftExperimentId: string;
  rightExperimentId: string;
  aligned: boolean;
  warnings: string[];
  left: ExperimentSummary | null;
  right: ExperimentSummary | null;
  familyDeltas: Array<{ family: EvalFamily; leftPassRate: number | null; rightPassRate: number | null; delta: number | null }>;
}

export interface EvalEventRecord {
  seq: number;
  type: string;
  experimentId: string | null;
  runId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface EvalTaskRequest {
  externalRef: string;
  title: string;
  goal: string;
  inputs: Array<{ kind: "file" | "url"; label: string; value: string; sha256?: string }>;
  expectedOutputs: string[];
  executorId?: string;
  runMode: "offline" | "live";
  networkHosts?: string[];
  outputDir: string;
  timeoutMs?: number;
}

export interface JudgeCriterionRequest {
  id: string;
  label: string;
  rubric: string;
  points: number;
}

export interface JudgeRequest {
  taskId: string;
  criteria: JudgeCriterionRequest[];
  deterministic: Array<{ criterionId: string; passed: boolean; reason: string }>;
  locale?: string;
}

export interface JudgeCriterionResult {
  id: string;
  passed: boolean;
  confidence: number;
  reason: string;
  evidence: string[];
}

export interface JudgeResponse {
  model: string;
  promptHash: string;
  criteria: JudgeCriterionResult[];
  overallConfidence: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ScoringOutcome {
  verdict: "passed" | "failed" | "needs_review";
  score: number | null;
  objectiveScore: number | null;
  judgeScore: number | null;
  humanScore: number | null;
  blockerFailures: string[];
  reviewReasons: ReviewTriggerKind[];
}

export type ArtifactMap = Record<string, { text: string; bytes: number; mimeType?: string }>;

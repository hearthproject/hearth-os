import type {
  CaseManifest,
  CaseVersionSummary,
  EvalEventRecord,
  EvalFamily,
  ExperimentComparison,
  ExperimentRecord,
  ExperimentRunRecord,
  ExperimentSummary,
  GraderResultRecord,
  HumanReviewRecord,
  ReviewTriggerKind
} from "./types.ts";

export interface CreateExperimentRequest {
  name?: string;
  caseIds: string[];
  executorIds: string[];
  repetitions: number;
  runMode: "offline" | "live";
  autoJudge: boolean;
  autoRetry: boolean;
  maxConcurrency: number;
  baselineExperimentId?: string | null;
}

export interface CaseCatalogResponse {
  cases: CaseVersionSummary[];
  counts: Record<EvalFamily, number>;
  generatedAt: string;
}

export interface CaseDetailResponse {
  case: CaseVersionSummary;
  manifest: CaseManifest;
  hasGolden: boolean;
}

export interface ExperimentsResponse {
  experiments: ExperimentRecord[];
}

export interface ExperimentDetailResponse {
  experiment: ExperimentRecord;
  runs: ExperimentRunRecord[];
  summary: ExperimentSummary | null;
  events: EvalEventRecord[];
}

export interface RunArtifactView {
  path: string;
  bytes: number;
  mimeType: string;
  preview: string | null;
}

export interface RunDetailResponse {
  run: ExperimentRunRecord;
  case: CaseVersionSummary | null;
  manifest: CaseManifest | null;
  graders: GraderResultRecord[];
  review: HumanReviewRecord | null;
  events: EvalEventRecord[];
  artifacts: RunArtifactView[];
  hearthTask: Record<string, unknown> | null;
}

export interface ReviewQueueItem {
  run: ExperimentRunRecord;
  case: CaseVersionSummary | null;
  experimentName: string;
  reasons: ReviewTriggerKind[];
  summary: string;
}

export interface ReviewsResponse {
  reviews: ReviewQueueItem[];
}

export interface SubmitReviewRequest {
  decision: "pass" | "fail" | "unknown";
  reviewer?: string;
  note?: string;
}

export interface CompareResponse extends ExperimentComparison {
  leftName: string | null;
  rightName: string | null;
}

export interface EvalSystemResponse {
  evalVersion: string;
  hearthUrl: string;
  hearthReachable: boolean;
  hearthStatus: string;
  judgeConfigured: boolean;
  judgeModel: string | null;
  catalogCases: number;
  catalogIssues: number;
  artifactRoot: string;
  dataDir: string;
  runningExperiments: number;
  pendingReviews: number;
  generatedAt: string;
}

export interface DashboardResponse {
  catalog: CaseCatalogResponse;
  recentExperiments: ExperimentRecord[];
  latestSummary: ExperimentSummary | null;
  pendingReviews: number;
  runningExperiments: number;
  system: EvalSystemResponse;
}

export interface EvalEventsResponse {
  events: EvalEventRecord[];
}

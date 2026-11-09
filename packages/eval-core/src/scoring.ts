import type {
  CaseManifest,
  EvalCriterion,
  FamilySummary,
  ReviewTriggerKind,
  ScoringOutcome
} from "./types.ts";
import type { GraderOutcome } from "./graders.ts";
import { EVAL_FAMILIES } from "./types.ts";

export interface JudgeOutcome {
  criteria: Record<string, { passed: boolean; confidence: number; reason: string }>;
  overallConfidence: number;
}

export interface ScoreRunInput {
  manifest: CaseManifest;
  deterministic: Record<string, GraderOutcome>;
  judge: JudgeOutcome | null;
  judgeExpected: boolean;
  humanDecision: "pass" | "fail" | "unknown" | null;
  humanReviewed?: boolean;
  reviewReasonSeed: string;
  runFailed: boolean;
  sampleRate?: number;
}

export const PASS_THRESHOLD = 80;
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

export function scoreRun(input: ScoreRunInput): ScoringOutcome {
  const { manifest } = input;
  const reviewReasons = new Set<ReviewTriggerKind>();
  const deterministicCriteria = manifest.criteria.filter((criterion) => criterion.source === "deterministic");
  const judgeCriteria = manifest.criteria.filter((criterion) => criterion.source === "judge");
  const humanCriteria = manifest.criteria.filter((criterion) => criterion.source === "human");

  if (input.runFailed) reviewReasons.add("failed_sample");
  for (const criterion of deterministicCriteria) {
    if (!input.deterministic[criterion.id]) {
      reviewReasons.add(criterion.severity === "blocker" ? "blocker_anomaly" : "low_confidence");
    }
  }

  const blockerFailures = deterministicCriteria
    .filter((criterion) => criterion.severity === "blocker")
    .filter((criterion) => input.deterministic[criterion.id]?.passed !== true)
    .map((criterion) => criterion.id);

  const objectiveAvailable = deterministicCriteria.every((criterion) => Boolean(input.deterministic[criterion.id]));
  const judgeAvailable = !input.judgeExpected || Boolean(input.judge && judgeCriteria.every((criterion) => input.judge?.criteria[criterion.id]));
  if (input.judgeExpected && !judgeAvailable) reviewReasons.add("judge_unavailable");

  const objectiveScore = objectiveAvailable
    ? pointsScore(deterministicCriteria, (criterion) => input.deterministic[criterion.id]?.passed === true, 60)
    : null;
  const judgeScore = judgeAvailable && judgeCriteria.length > 0
    ? pointsScore(judgeCriteria, (criterion) => input.judge?.criteria[criterion.id]?.passed === true, 30)
    : null;

  if (input.judge && judgeCriteria.length > 0) {
    for (const criterion of judgeCriteria) {
      const result = input.judge.criteria[criterion.id];
      if (result && result.confidence < LOW_CONFIDENCE_THRESHOLD) reviewReasons.add("low_confidence");
    }
    if (input.judge.overallConfidence < LOW_CONFIDENCE_THRESHOLD) reviewReasons.add("low_confidence");
    const deterministicAllPassed = objectiveAvailable && deterministicCriteria.every((criterion) => input.deterministic[criterion.id]?.passed === true);
    const judgeAllPassed = judgeCriteria.every((criterion) => input.judge?.criteria[criterion.id]?.passed === true);
    if (deterministicAllPassed !== judgeAllPassed) reviewReasons.add("judge_conflict");
  }

  if (shouldSample(input.reviewReasonSeed, input.sampleRate ?? manifest.humanReview.sampleRate)) {
    reviewReasons.add("sampled");
  }

  const humanScore = input.humanDecision === "pass"
    ? 100
    : input.humanDecision === "fail"
      ? 0
      : null;

  if (input.humanDecision === "unknown") reviewReasons.add("low_confidence");
  if (input.humanReviewed && (input.humanDecision === "pass" || input.humanDecision === "fail")) {
    reviewReasons.clear();
  }
  if (blockerFailures.length > 0) {
    return {
      verdict: "failed",
      score: 0,
      objectiveScore,
      judgeScore,
      humanScore,
      blockerFailures,
      reviewReasons: [...reviewReasons]
    };
  }
  if (reviewReasons.size > 0) {
    return {
      verdict: "needs_review",
      score: projectedScore(objectiveScore, judgeScore, humanScore, humanCriteria.length, input.judgeExpected),
      objectiveScore,
      judgeScore,
      humanScore,
      blockerFailures: [],
      reviewReasons: [...reviewReasons]
    };
  }

  const score = projectedScore(objectiveScore, judgeScore, humanScore, humanCriteria.length, input.judgeExpected);
  return {
    verdict: score !== null && score >= PASS_THRESHOLD ? "passed" : "failed",
    score,
    objectiveScore,
    judgeScore,
    humanScore,
    blockerFailures: [],
    reviewReasons: []
  };
}

function pointsScore(criteria: EvalCriterion[], passed: (criterion: EvalCriterion) => boolean, sourceTotal: number): number {
  if (criteria.length === 0) return 100;
  const earned = criteria.reduce((sum, criterion) => sum + (passed(criterion) ? criterion.points : 0), 0);
  return round(earned / sourceTotal * 100);
}

function projectedScore(
  objectiveScore: number | null,
  judgeScore: number | null,
  humanScore: number | null,
  humanCriteriaCount: number,
  judgeExpected: boolean
): number | null {
  if (objectiveScore === null) return null;
  if (judgeExpected && judgeScore === null) return null;
  if (humanScore !== null && humanCriteriaCount > 0) {
    return round(objectiveScore * 0.6 + (judgeScore ?? 0) * 0.3 + humanScore * 0.1);
  }
  if (judgeExpected && judgeScore !== null) return round(objectiveScore * (60 / 90) + judgeScore * (30 / 90));
  return objectiveScore;
}

export function shouldSample(seed: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const bucket = fnv1a(seed) % 10_000;
  return bucket < Math.floor(rate * 10_000);
}

export function familySummary(
  family: CaseManifest["family"],
  rows: Array<{ family: CaseManifest["family"]; status: string; score: number | null; reviewPending: boolean }>
): FamilySummary {
  const selected = rows.filter((row) => row.family === family);
  const passed = selected.filter((row) => row.status === "passed").length;
  const failed = selected.filter((row) => row.status === "failed" || row.status === "error").length;
  const blocked = selected.filter((row) => row.status === "blocked").length;
  const needsReview = selected.filter((row) => row.reviewPending || row.status === "needs_review").length;
  const scores = selected.flatMap((row) => row.score === null ? [] : [row.score]);
  return {
    family,
    total: selected.length,
    passed,
    failed,
    blocked,
    needsReview,
    passRate: selected.length === 0 ? null : round(passed / selected.length * 100),
    avgScore: scores.length === 0 ? null : round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
  };
}

export function emptyFamilySummaries(): FamilySummary[] {
  return EVAL_FAMILIES.map((family) => ({
    family,
    total: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    needsReview: 0,
    passRate: null,
    avgScore: null
  }));
}

export function isReviewTrigger(value: string): value is ReviewTriggerKind {
  return ["low_confidence", "judge_conflict", "blocker_anomaly", "failed_sample", "judge_unavailable", "sampled"].includes(value);
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

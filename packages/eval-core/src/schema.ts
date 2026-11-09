import { z } from "zod";
import {
  EVAL_DIFFICULTIES,
  EVAL_FAMILIES,
  EVAL_RUN_MODES,
  GRADER_KINDS
} from "./types.ts";

const inputSchema = z.object({
  kind: z.enum(["file", "url", "text"]),
  label: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(1000).optional(),
  value: z.string().max(4000).optional(),
  optional: z.boolean().optional()
}).strict();

const fileGraderSchema = z.object({
  kind: z.literal("file"),
  path: z.string().trim().min(1),
  minBytes: z.number().int().nonnegative().optional()
}).strict();

const textGraderSchema = z.object({
  kind: z.literal("text"),
  path: z.string().trim().min(1),
  includes: z.array(z.string()).max(50).optional(),
  excludes: z.array(z.string()).max(50).optional(),
  regex: z.array(z.string().min(1)).max(20).optional()
}).strict();

const jsonGraderSchema = z.object({
  kind: z.literal("json"),
  path: z.string().trim().min(1),
  requiredPaths: z.array(z.string().trim().min(1)).max(100).optional(),
  equals: z.record(z.string(), z.unknown()).optional(),
  minArrayLength: z.record(z.string(), z.number().int().nonnegative()).optional()
}).strict();

const csvGraderSchema = z.object({
  kind: z.literal("csv"),
  path: z.string().trim().min(1),
  requiredColumns: z.array(z.string().trim().min(1)).max(100).optional(),
  minRows: z.number().int().nonnegative().optional(),
  requiredValues: z.array(z.object({ column: z.string().trim().min(1), equals: z.string() })).max(100).optional()
}).strict();

const artifactCountGraderSchema = z.object({
  kind: z.literal("artifact_count"),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  min: z.number().int().nonnegative()
}).strict();

const stateGraderSchema = z.object({
  kind: z.literal("state"),
  path: z.string().trim().min(1),
  expected: z.record(z.string(), z.unknown())
}).strict();

export const graderConfigSchema = z.discriminatedUnion("kind", [
  fileGraderSchema,
  textGraderSchema,
  jsonGraderSchema,
  csvGraderSchema,
  artifactCountGraderSchema,
  stateGraderSchema
]);

export const graderSpecSchema = z.object({
  id: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  config: graderConfigSchema
}).strict();

export const criterionSchema = z.object({
  id: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(300),
  source: z.enum(["deterministic", "judge", "human"]),
  points: z.number().int().nonnegative().max(100),
  severity: z.enum(["blocker", "scored"]),
  graderId: z.string().trim().min(1).optional(),
  rubric: z.string().trim().min(1).max(4000).optional()
}).strict();

export const caseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().trim().regex(/^[A-Z][A-Z0-9-]{1,30}$/),
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  family: z.enum(EVAL_FAMILIES),
  difficulty: z.enum(EVAL_DIFFICULTIES),
  runModes: z.array(z.enum(EVAL_RUN_MODES)).min(1),
  description: z.string().trim().min(1).max(2000),
  goal: z.string().trim().min(1).max(8000),
  tags: z.array(z.string().trim().min(1).max(60)).max(20),
  timeoutMs: z.number().int().min(30_000).max(3_600_000),
  inputs: z.array(inputSchema).min(1).max(30),
  liveInputs: z.array(inputSchema).max(30).optional(),
  networkHosts: z.array(z.string().trim().min(1).max(255)).max(20).optional(),
  expectedOutputs: z.array(z.string().trim().min(1).max(300)).min(1).max(30),
  graders: z.array(graderSpecSchema).min(1).max(80),
  criteria: z.array(criterionSchema).min(2).max(80),
  humanReview: z.object({
    prompt: z.string().trim().min(1).max(2000),
    sampleRate: z.number().min(0).max(1)
  }).strict()
}).strict();

export const experimentConfigSchema = z.object({
  name: z.string().trim().min(1).max(160),
  caseIds: z.array(z.string().trim().min(1).max(40)).min(1).max(100),
  executorIds: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
  repetitions: z.number().int().min(1).max(5),
  runMode: z.enum(["offline", "live"]),
  autoJudge: z.boolean(),
  autoRetry: z.boolean(),
  maxConcurrency: z.number().int().min(1).max(8),
  baselineExperimentId: z.string().trim().min(1).max(120).nullable().optional()
}).strict();

export const humanReviewInputSchema = z.object({
  reviewer: z.string().trim().min(1).max(120),
  decision: z.enum(["pass", "fail", "unknown"]),
  note: z.string().max(8000),
  overrideNote: z.string().max(8000).optional()
}).strict().superRefine((value, context) => {
  if ((value.decision === "fail" || value.decision === "unknown") && !value.note.trim()) {
    context.addIssue({ code: "custom", path: ["note"], message: "失败或未知结论必须填写说明" });
  }
});

export type CaseManifestValidation =
  | { success: true; data: z.infer<typeof caseManifestSchema> }
  | { success: false; issues: Array<{ path: string; message: string }> };

export function validateCaseManifest(input: unknown): CaseManifestValidation {
  const parsed = caseManifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message
      }))
    };
  }
  const manifest = parsed.data;
  const issues: z.ZodIssue[] = [];
  const graderIds = new Set(manifest.graders.map((grader) => grader.id));
  const criterionIds = new Set<string>();
  const totals = { deterministic: 0, judge: 0, human: 0 };
  for (const criterion of manifest.criteria) {
    if (criterionIds.has(criterion.id)) {
      issues.push({ code: "custom", path: ["criteria"], message: `重复评分项：${criterion.id}` });
    }
    criterionIds.add(criterion.id);
    totals[criterion.source] += criterion.points;
    if (criterion.source === "deterministic" && (!criterion.graderId || !graderIds.has(criterion.graderId))) {
      issues.push({ code: "custom", path: ["criteria"], message: `确定性评分项 ${criterion.id} 缺少有效 graderId` });
    }
    if (criterion.source === "judge" && !criterion.rubric) {
      issues.push({ code: "custom", path: ["criteria"], message: `模型评分项 ${criterion.id} 缺少 rubric` });
    }
    if (criterion.severity === "blocker" && criterion.source !== "deterministic") {
      issues.push({ code: "custom", path: ["criteria"], message: `blocker ${criterion.id} 必须由确定性 grader 判定` });
    }
  }
  if (totals.deterministic !== 60 || totals.judge !== 30 || totals.human !== 10) {
    issues.push({
      code: "custom",
      path: ["criteria"],
      message: `评分权重必须为确定性 60、裁判 30、人工 10，当前为 ${totals.deterministic}/${totals.judge}/${totals.human}`
    });
  }
  if (!manifest.criteria.some((criterion) => criterion.severity === "blocker")) {
    issues.push({ code: "custom", path: ["criteria"], message: "至少需要一个 blocker" });
  }
  const usedGraders = new Set(manifest.criteria.map((criterion) => criterion.graderId).filter(Boolean));
  for (const grader of manifest.graders) {
    if (!usedGraders.has(grader.id)) {
      issues.push({ code: "custom", path: ["graders"], message: `grader ${grader.id} 未被任何评分项使用` });
    }
  }
  if (issues.length > 0) {
    return {
      success: false,
      issues: issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }))
    };
  }
  return { success: true, data: manifest as z.infer<typeof caseManifestSchema> };
}

export const GRADER_KIND_VALUES = GRADER_KINDS;

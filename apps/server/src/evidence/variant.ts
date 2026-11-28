// Harness variants: named, hashable control settings that both OS and Eval use.
//
// A variant is a small declarative overlay, never an arbitrary code path. The
// effective configuration digest is what experiments compare.
import type { TaskPermissions } from "@hearth/core";
import { canonicalJson, digestOf } from "./contracts.ts";
import type { RuntimeManifest } from "./contracts.ts";

export interface HarnessVariantSpec {
  schemaVersion: 1;
  id: string;
  label: string;
  description: string;
  overrides: {
    contextPolicyVersion?: string;
    compactionThreshold?: number;
    maxParallelTools?: number;
    toolPolicy?: "full" | "deferred";
    directTools?: string[];
    approvalMode?: TaskPermissions["approvalMode"];
    retryMaxRetries?: number;
    promptRegistryVersion?: string;
    maxTurns?: number;
    maxToolCalls?: number;
    degradationPolicy?: string;
  };
}

export interface EffectiveHarnessConfig {
  variantId: string;
  contextPolicyVersion: string;
  compactionThreshold: number;
  maxParallelTools: number;
  toolPolicy: "full" | "deferred";
  directTools: string[];
  approvalMode: NonNullable<TaskPermissions["approvalMode"]>;
  retryMaxRetries: number;
  promptRegistryVersion: string;
  maxTurns: number;
  maxToolCalls: number;
  degradationPolicy: string;
  digest: string;
  /** Raw overlay actually declared by the variant; used to decide which knobs to touch. */
  overrides: HarnessVariantSpec["overrides"];
}

export interface VariantBaseline {
  contextPolicyVersion: string;
  compactionThreshold: number;
  maxParallelTools: number;
  toolPolicy: "full" | "deferred";
  directTools: string[];
  approvalMode: NonNullable<TaskPermissions["approvalMode"]>;
  retryMaxRetries: number;
  promptRegistryVersion: string;
  maxTurns: number;
  maxToolCalls: number;
  degradationPolicy: string;
}

export const BASELINE_VARIANT: HarnessVariantSpec = {
  schemaVersion: 1,
  id: "baseline",
  label: "基线",
  description: "当前默认 Harness 配置，作为所有成对实验的对照。",
  overrides: {}
};

export const BUILTIN_VARIANTS: HarnessVariantSpec[] = [
  BASELINE_VARIANT,
  {
    schemaVersion: 1,
    id: "context-compact",
    label: "更早压缩上下文",
    description: "把压缩阈值前移，验证上下文压缩对成功率与成本的影响。",
    overrides: { compactionThreshold: 0.5, contextPolicyVersion: "compact-0.5" }
  },
  {
    schemaVersion: 1,
    id: "tools-deferred",
    label: "延迟工具目录",
    description: "先暴露小工具集，其余按需加载，降低工具 schema 体积。",
    overrides: { toolPolicy: "deferred", directTools: ["read_file", "write_file", "finish_task"] }
  },
  {
    schemaVersion: 1,
    id: "parallel-tools",
    label: "并行工具调用",
    description: "允许更多并行工具调用，观察长尾延迟与错误率。",
    overrides: { maxParallelTools: 4 }
  }
];

/**
 * Resolve a variant by id. Unknown ids are a hard error so a typo cannot silently
 * fall back to the baseline and invalidate an A/B experiment.
 */
export function variantById(id: string, extra: HarnessVariantSpec[] = []): HarnessVariantSpec {
  const found = [...BUILTIN_VARIANTS, ...extra].find((variant) => variant.id === id);
  if (!found) throw new Error(`未知 Harness Variant：${id}`);
  return found;
}

export function validateVariant(value: unknown): { ok: true; spec: HarnessVariantSpec } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return { ok: false, errors: ["variant 必须是对象"] };
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  if (typeof record.id !== "string" || !record.id) errors.push("id 必填");
  if (typeof record.label !== "string") errors.push("label 必填");
  if (!record.overrides || typeof record.overrides !== "object") errors.push("overrides 必填");
  const overrides = (record.overrides ?? {}) as Record<string, unknown>;
  for (const key of ["compactionThreshold"]) {
    if (overrides[key] !== undefined) {
      const number = Number(overrides[key]);
      if (!Number.isFinite(number) || number <= 0 || number > 1) errors.push(`${key} 必须在 (0,1]`);
    }
  }
  if (overrides.maxParallelTools !== undefined) {
    const number = Number(overrides.maxParallelTools);
    if (!Number.isInteger(number) || number < 1 || number > 32) errors.push("maxParallelTools 必须是 1..32 的整数");
  }
  return errors.length === 0
    ? { ok: true, spec: record as unknown as HarnessVariantSpec }
    : { ok: false, errors };
}

export function effectiveConfig(base: VariantBaseline, variant: HarnessVariantSpec): EffectiveHarnessConfig {
  const overrides = variant.overrides;
  const merged = {
    variantId: variant.id,
    contextPolicyVersion: overrides.contextPolicyVersion ?? base.contextPolicyVersion,
    compactionThreshold: overrides.compactionThreshold ?? base.compactionThreshold,
    maxParallelTools: overrides.maxParallelTools ?? base.maxParallelTools,
    toolPolicy: overrides.toolPolicy ?? base.toolPolicy,
    directTools: [...(overrides.directTools ?? base.directTools)].sort(),
    approvalMode: overrides.approvalMode ?? base.approvalMode,
    retryMaxRetries: overrides.retryMaxRetries ?? base.retryMaxRetries,
    promptRegistryVersion: overrides.promptRegistryVersion ?? base.promptRegistryVersion,
    maxTurns: overrides.maxTurns ?? base.maxTurns,
    maxToolCalls: overrides.maxToolCalls ?? base.maxToolCalls,
    degradationPolicy: overrides.degradationPolicy ?? base.degradationPolicy
  };
  return { ...merged, overrides: variant.overrides, digest: digestOf(merged) };
}

/** Runtime-side metrics aggregated from manifests, used by the Lab report. */
export function variantMetrics(manifests: RuntimeManifest[]): Record<string, unknown> {
  const completed = manifests.filter((manifest) => Boolean(manifest.finalizedAt)).length;
  const fingerprints = new Set(manifests.map((manifest) => manifest.compatibilityFingerprint));
  const incomplete = manifests.filter((manifest) => manifest.completeness.status === "incomplete_provenance").length;
  return {
    runs: manifests.length,
    completed,
    distinctFingerprints: fingerprints.size,
    incompleteProvenance: incomplete,
    variants: [...new Set(manifests.map((manifest) => manifest.variant?.harnessVariantId ?? "unlabelled"))]
  };
}

export function variantCanonical(spec: HarnessVariantSpec): string {
  return canonicalJson(spec);
}

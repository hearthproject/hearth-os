// Canonical evidence contract shared by Hearth OS (producer) and Hearth Eval (reader).
//
// The schema is versioned. `hearth-eval` keeps an independent reader with the
// same version plus golden fixtures; contract tests fail on drift.
import { createHash } from "node:crypto";

export const EVIDENCE_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_CONTRACT_ID = "hearth-evidence/1" as const;

export interface RepoState {
  role: "hearth-os" | "hearth-eval" | "other";
  commit: string | null;
  branch: string | null;
  dirty: boolean | null;
  version: string | null;
}

export interface RuntimeModelFact {
  providerId: string | null;
  providerName: string | null;
  protocol: string;
  modelId: string;
  modelVersion: string | null;
  sampling: {
    temperature: number | null;
    maxTokens: number | null;
    reasoningEffort: string | null;
    seed: number | null;
  };
  contextWindowTokens: number | null;
}

export interface RuntimePromptFact {
  registryVersion: string;
  systemPromptHash: string | null;
  finalPromptHash: string | null;
  toolSchemaHash: string | null;
}

export interface RuntimeToolFact {
  catalogDigest: string | null;
  catalogSize: number | null;
  policy: "full" | "deferred" | "unknown";
  directTools: string[];
  mcpVersion: string | null;
}

export interface RuntimeContextFact {
  policyVersion: string | null;
  compactionThreshold: number | null;
  packId: string | null;
  mode: string | null;
}

export interface RuntimeApprovalFact {
  mode: string;
  policyVersion: string | null;
  policyHash: string | null;
  teamMode: boolean;
  recoveryPolicy: string | null;
  retryPolicy: string | null;
}
export interface RuntimeSandboxFact {
  backend: string;
  mode: string;
  networkMode: string;
  image: string | null;
  appContainer: string | null;
}

export interface RuntimeJudgeFact {
  model: string | null;
  promptHash: string | null;
  calibrationVersion: string | null;
}

export interface RuntimePricingFact {
  snapshotId: string;
  version: string;
  asOf: string;
}

export interface RuntimeBudgetFact {
  scope: "task" | "project" | "daily" | "experiment" | "ci" | "none";
  limits: Record<string, number>;
  degradationPolicy: string | null;
}

export interface RuntimeVariantFact {
  harnessVariantId: string;
  effectiveConfigDigest: string;
}

export interface RuntimeDepsFact {
  lockfileDigest: string | null;
}

export interface ManifestCompleteness {
  status: "complete" | "incomplete_provenance";
  missing: string[];
}

export interface RuntimeManifest {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  kind: "hearth-runtime-manifest";
  contract: typeof EVIDENCE_CONTRACT_ID;
  runId: string;
  taskId: string;
  taskTitle: string | null;
  createdAt: string;
  finalizedAt: string | null;
  repos: RepoState[];
  cases: { ids: string[]; versions: Record<string, number>; catalogDigest: string | null } | null;
  model: RuntimeModelFact | null;
  prompt: RuntimePromptFact | null;
  tools: RuntimeToolFact | null;
  context: RuntimeContextFact | null;
  approval: RuntimeApprovalFact | null;
  sandbox: RuntimeSandboxFact | null;
  judge: RuntimeJudgeFact | null;
  pricing: RuntimePricingFact | null;
  budget: RuntimeBudgetFact | null;
  variant: RuntimeVariantFact | null;
  deps: RuntimeDepsFact | null;
  executorId: string | null;
  /** Canonical digest of the fields that decide behavioural comparability. */
  compatibilityFingerprint: string;
  completeness: ManifestCompleteness;
}

export interface ProvenanceRef {
  kind: "artifact" | "file" | "url" | "text" | "context_pack" | "input";
  ref: string;
  sha256: string | null;
  bytes: number | null;
  label: string | null;
}

export interface ArtifactProvenance {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  kind: "hearth-artifact-provenance";
  contract: typeof EVIDENCE_CONTRACT_ID;
  artifactId: string;
  taskId: string;
  runId: string;
  relativePath: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  producedBy: {
    runId: string;
    stepId: string | null;
    turn: number | null;
    toolCallId: string | null;
    toolName: string | null;
    operationIds: string[];
    checkpointSeq: number | null;
    inference: "explicit" | "inferred" | "unknown";
  };
  inputs: ProvenanceRef[];
  model: { providerId: string | null; modelId: string | null; requestFingerprint: string | null } | null;
  toolSchemaHash: string | null;
  policy: {
    version: string | null;
    hash: string | null;
    ruleId: string | null;
    approvalId: string | null;
    decision: string | null;
    permissionMode: string | null;
  } | null;
  environment: {
    digest: string;
    sandbox: string | null;
    workspaceDigest: string | null;
  } | null;
  parents: Array<{ artifactId: string; sha256: string; relation: "derived_from" | "replaces" | "companion" }>;
  lineage: { parentRunId: string | null; attempt: number | null };
  completeness: ManifestCompleteness;
}

export interface CompatibilityComponent {
  component: string;
  left: string | null;
  right: string | null;
  status: "same" | "changed" | "missing_left" | "missing_right" | "missing_both";
}

export interface CompatibilityDiff {
  same: boolean;
  leftFingerprint: string | null;
  rightFingerprint: string | null;
  components: CompatibilityComponent[];
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic JSON used for every digest in the contract. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown, seen: Set<unknown> = new Set()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    output[key] = canonicalize(item, seen);
  }
  return output;
}

export function digestOf(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/** Fields that must match for two runs to be behaviourally comparable. */
export interface FingerprintPayload {
  repos: Array<{ role: string; commit: string | null; dirty: boolean | null }>;
  cases: RuntimeManifest["cases"];
  model: RuntimeModelFact | null;
  prompt: Pick<RuntimePromptFact, "registryVersion" | "systemPromptHash" | "finalPromptHash" | "toolSchemaHash"> | null;
  tools: Pick<RuntimeToolFact, "catalogDigest" | "policy" | "directTools" | "mcpVersion"> | null;
  context: Pick<RuntimeContextFact, "policyVersion" | "compactionThreshold" | "mode"> | null;
  approval: Pick<RuntimeApprovalFact, "mode" | "policyVersion" | "policyHash" | "teamMode"> | null;
  sandbox: Pick<RuntimeSandboxFact, "backend" | "mode" | "networkMode" | "image" | "appContainer"> | null;
  judge: RuntimeJudgeFact | null;
  pricing: Pick<RuntimePricingFact, "snapshotId" | "version"> | null;
  budget: Pick<RuntimeBudgetFact, "limits" | "degradationPolicy"> | null;
  variant: RuntimeVariantFact | null;
  deps: RuntimeDepsFact | null;
}

export function fingerprintPayload(manifest: RuntimeManifest): FingerprintPayload {
  return {
    repos: manifest.repos.map((repo) => ({ role: repo.role, commit: repo.commit, dirty: repo.dirty })),
    cases: manifest.cases,
    model: manifest.model,
    prompt: manifest.prompt
      ? {
          registryVersion: manifest.prompt.registryVersion,
          systemPromptHash: manifest.prompt.systemPromptHash,
          finalPromptHash: manifest.prompt.finalPromptHash,
          toolSchemaHash: manifest.prompt.toolSchemaHash
        }
      : null,
    tools: manifest.tools
      ? {
          catalogDigest: manifest.tools.catalogDigest,
          policy: manifest.tools.policy,
          directTools: manifest.tools.directTools,
          mcpVersion: manifest.tools.mcpVersion
        }
      : null,
    context: manifest.context
      ? {
          policyVersion: manifest.context.policyVersion,
          compactionThreshold: manifest.context.compactionThreshold,
          mode: manifest.context.mode
        }
      : null,
    approval: manifest.approval
      ? {
          mode: manifest.approval.mode,
          policyVersion: manifest.approval.policyVersion,
          policyHash: manifest.approval.policyHash,
          teamMode: manifest.approval.teamMode
        }
      : null,
    sandbox: manifest.sandbox
      ? {
          backend: manifest.sandbox.backend,
          mode: manifest.sandbox.mode,
          networkMode: manifest.sandbox.networkMode,
          image: manifest.sandbox.image,
          appContainer: manifest.sandbox.appContainer
        }
      : null,
    judge: manifest.judge,
    pricing: manifest.pricing ? { snapshotId: manifest.pricing.snapshotId, version: manifest.pricing.version } : null,
    budget: manifest.budget ? { limits: manifest.budget.limits, degradationPolicy: manifest.budget.degradationPolicy } : null,
    variant: manifest.variant,
    deps: manifest.deps
  };
}

export function compatibilityFingerprint(manifest: RuntimeManifest): string {
  return sha256Hex(canonicalJson(fingerprintPayload(manifest)));
}

const COMPONENT_FIELDS: Array<{ component: string; pick: (manifest: RuntimeManifest) => unknown }> = [
  { component: "repos", pick: (m) => m.repos.map((repo) => `${repo.role}:${repo.commit ?? "unknown"}:${repo.dirty ? "dirty" : "clean"}`) },
  { component: "cases", pick: (m) => m.cases },
  { component: "model", pick: (m) => m.model },
  { component: "prompt", pick: (m) => m.prompt },
  { component: "tools", pick: (m) => m.tools },
  { component: "context", pick: (m) => m.context },
  { component: "approval", pick: (m) => m.approval },
  { component: "sandbox", pick: (m) => m.sandbox },
  { component: "judge", pick: (m) => m.judge },
  { component: "pricing", pick: (m) => m.pricing },
  { component: "budget", pick: (m) => m.budget },
  { component: "variant", pick: (m) => m.variant },
  { component: "deps", pick: (m) => m.deps }
];

function componentValue(manifest: RuntimeManifest | null, pick: (manifest: RuntimeManifest) => unknown): string | null {
  if (!manifest) return null;
  const value = pick(manifest);
  if (value === null || value === undefined) return null;
  return canonicalJson(value);
}

/** Component-level diff rendered on the experiment comparison page. */
export function compatibilityDiff(left: RuntimeManifest | null, right: RuntimeManifest | null): CompatibilityDiff {
  const components = COMPONENT_FIELDS.map(({ component, pick }): CompatibilityComponent => {
    const leftValue = componentValue(left, pick);
    const rightValue = componentValue(right, pick);
    if (leftValue === null && rightValue === null) {
      return { component, left: null, right: null, status: "missing_both" };
    }
    if (leftValue === null) return { component, left: null, right: rightValue, status: "missing_left" };
    if (rightValue === null) return { component, left: leftValue, right: null, status: "missing_right" };
    return { component, left: leftValue, right: rightValue, status: leftValue === rightValue ? "same" : "changed" };
  });
  return {
    same: left !== null && right !== null && components.every((item) => item.status === "same" || item.status === "missing_both"),
    leftFingerprint: left?.compatibilityFingerprint ?? null,
    rightFingerprint: right?.compatibilityFingerprint ?? null,
    components
  };
}

const REQUIRED_MANIFEST_FIELDS: Array<{ field: string; present: (manifest: RuntimeManifest) => boolean }> = [
  { field: "repos", present: (m) => m.repos.length > 0 && m.repos.every((repo) => Boolean(repo.commit)) },
  { field: "model", present: (m) => Boolean(m.model?.modelId) },
  { field: "prompt.systemPromptHash", present: (m) => Boolean(m.prompt?.systemPromptHash) },
  { field: "prompt.toolSchemaHash", present: (m) => Boolean(m.prompt?.toolSchemaHash) },
  { field: "tools.catalogDigest", present: (m) => Boolean(m.tools?.catalogDigest) },
  { field: "context.policyVersion", present: (m) => Boolean(m.context?.policyVersion) },
  { field: "approval.mode", present: (m) => Boolean(m.approval?.mode) },
  { field: "sandbox.backend", present: (m) => Boolean(m.sandbox?.backend) },
  { field: "pricing.snapshotId", present: (m) => Boolean(m.pricing?.snapshotId) },
  { field: "deps.lockfileDigest", present: (m) => Boolean(m.deps?.lockfileDigest) }
];

export function manifestCompleteness(manifest: RuntimeManifest): ManifestCompleteness {
  const missing = REQUIRED_MANIFEST_FIELDS.filter((item) => !item.present(manifest)).map((item) => item.field);
  return missing.length === 0
    ? { status: "complete", missing: [] }
    : { status: "incomplete_provenance", missing };
}

export interface BuildRuntimeManifestInput {
  runId: string;
  taskId: string;
  taskTitle?: string | null;
  createdAt: string;
  finalizedAt?: string | null;
  repos: RepoState[];
  cases?: RuntimeManifest["cases"];
  model?: RuntimeModelFact | null;
  prompt?: RuntimePromptFact | null;
  tools?: RuntimeToolFact | null;
  context?: RuntimeContextFact | null;
  approval?: RuntimeApprovalFact | null;
  sandbox?: RuntimeSandboxFact | null;
  judge?: RuntimeJudgeFact | null;
  pricing?: RuntimePricingFact | null;
  budget?: RuntimeBudgetFact | null;
  variant?: RuntimeVariantFact | null;
  deps?: RuntimeDepsFact | null;
  executorId?: string | null;
}

export function buildRuntimeManifest(input: BuildRuntimeManifestInput): RuntimeManifest {
  const manifest: RuntimeManifest = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: "hearth-runtime-manifest",
    contract: EVIDENCE_CONTRACT_ID,
    runId: input.runId,
    taskId: input.taskId,
    taskTitle: input.taskTitle ?? null,
    createdAt: input.createdAt,
    finalizedAt: input.finalizedAt ?? null,
    repos: input.repos,
    cases: input.cases ?? null,
    model: input.model ?? null,
    prompt: input.prompt ?? null,
    tools: input.tools ?? null,
    context: input.context ?? null,
    approval: input.approval ?? null,
    sandbox: input.sandbox ?? null,
    judge: input.judge ?? null,
    pricing: input.pricing ?? null,
    budget: input.budget ?? null,
    variant: input.variant ?? null,
    deps: input.deps ?? null,
    executorId: input.executorId ?? null,
    compatibilityFingerprint: "",
    completeness: { status: "incomplete_provenance", missing: [] }
  };
  const withFingerprint: RuntimeManifest = {
    ...manifest,
    compatibilityFingerprint: compatibilityFingerprint(manifest)
  };
  return { ...withFingerprint, completeness: manifestCompleteness(withFingerprint) };
}

export function verifyManifestFingerprint(manifest: RuntimeManifest): boolean {
  return compatibilityFingerprint(manifest) === manifest.compatibilityFingerprint;
}

/** Runtime-side reader used by tests and by `/api/evidence/...` handlers. */
export function parseRuntimeManifest(value: unknown): RuntimeManifest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "hearth-runtime-manifest") return null;
  if (record.schemaVersion !== EVIDENCE_SCHEMA_VERSION) return null;
  if (typeof record.runId !== "string" || typeof record.taskId !== "string") return null;
  return record as unknown as RuntimeManifest;
}

export interface ProvenanceInputDescriptor {
  inputs?: ProvenanceRef[];
  parents?: ArtifactProvenance["parents"];
  producedBy?: Partial<ArtifactProvenance["producedBy"]>;
  model?: ArtifactProvenance["model"];
  policy?: ArtifactProvenance["policy"];
  environment?: ArtifactProvenance["environment"];
  lineage?: Partial<ArtifactProvenance["lineage"]>;
}

const REQUIRED_PROVENANCE_FIELDS: Array<{ field: string; present: (provenance: ArtifactProvenance) => boolean }> = [
  { field: "producedBy.runId", present: (p) => Boolean(p.producedBy.runId) },
  { field: "producedBy.toolCallId", present: (p) => Boolean(p.producedBy.toolCallId) },
  { field: "inputs", present: (p) => p.inputs.length > 0 },
  { field: "model.requestFingerprint", present: (p) => Boolean(p.model?.requestFingerprint) },
  { field: "toolSchemaHash", present: (p) => Boolean(p.toolSchemaHash) },
  { field: "policy.version", present: (p) => Boolean(p.policy?.version) },
  { field: "environment.digest", present: (p) => Boolean(p.environment?.digest) }
];

export function provenanceCompleteness(provenance: ArtifactProvenance): ManifestCompleteness {
  const missing = REQUIRED_PROVENANCE_FIELDS.filter((item) => !item.present(provenance)).map((item) => item.field);
  return missing.length === 0
    ? { status: "complete", missing: [] }
    : { status: "incomplete_provenance", missing };
}

export interface BuildArtifactProvenanceInput extends ProvenanceInputDescriptor {
  artifact: { id: string; taskId: string; runId: string; relativePath: string; mimeType: string; sha256: string; bytes: number; createdAt: string };
  toolSchemaHash?: string | null;
}

export function buildArtifactProvenance(input: BuildArtifactProvenanceInput): ArtifactProvenance {
  const producedBy = {
    runId: input.producedBy?.runId ?? input.artifact.runId,
    stepId: input.producedBy?.stepId ?? null,
    turn: input.producedBy?.turn ?? null,
    toolCallId: input.producedBy?.toolCallId ?? null,
    toolName: input.producedBy?.toolName ?? null,
    operationIds: input.producedBy?.operationIds ?? [],
    checkpointSeq: input.producedBy?.checkpointSeq ?? null,
    inference: input.producedBy?.inference ?? "unknown"
  } satisfies ArtifactProvenance["producedBy"];
  const base: ArtifactProvenance = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: "hearth-artifact-provenance",
    contract: EVIDENCE_CONTRACT_ID,
    artifactId: input.artifact.id,
    taskId: input.artifact.taskId,
    runId: input.artifact.runId,
    relativePath: input.artifact.relativePath,
    mimeType: input.artifact.mimeType,
    sha256: input.artifact.sha256,
    bytes: input.artifact.bytes,
    createdAt: input.artifact.createdAt,
    producedBy,
    inputs: input.inputs ?? [],
    model: input.model ?? null,
    toolSchemaHash: null,
    policy: input.policy ?? null,
    environment: input.environment ?? null,
    parents: input.parents ?? [],
    lineage: {
      parentRunId: input.lineage?.parentRunId ?? null,
      attempt: input.lineage?.attempt ?? null
    },
    completeness: { status: "incomplete_provenance", missing: [] }
  };
  const withSchema = { ...base, toolSchemaHash: input.toolSchemaHash ?? null };
  const provenance: ArtifactProvenance = { ...withSchema, completeness: provenanceCompleteness(withSchema as ArtifactProvenance) };
  return provenance;
}

export function artifactProvenanceCompleteness(provenance: ArtifactProvenance): ManifestCompleteness {
  return provenanceCompleteness(provenance);
}

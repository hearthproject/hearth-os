export const ASSERTION_CONFIDENCES = ["confirmed", "observed", "inferred", "stale"] as const;
export type AssertionConfidence = (typeof ASSERTION_CONFIDENCES)[number];

export const ENTITY_KINDS = [
  "person",
  "org",
  "project",
  "goal",
  "task",
  "document",
  "artifact",
  "account",
  "device",
  "topic"
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const ENTITY_STATUSES = ["active", "merged", "archived", "deleted"] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

export const ENTITY_SENSITIVITIES = ["normal", "sensitive", "secret"] as const;
export type EntitySensitivity = (typeof ENTITY_SENSITIVITIES)[number];

export interface EntityRecord {
  id: string;
  kind: EntityKind;
  canonicalName: string;
  status: EntityStatus;
  sensitivity: EntitySensitivity;
  confidence: AssertionConfidence;
  mergedInto: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EntityAliasRecord {
  id: string;
  entityId: string;
  alias: string;
  normalized: string;
  sourceKind: string;
  confidence: AssertionConfidence;
  createdAt: string;
}

export interface RelationRecord {
  id: string;
  fromEntityId: string;
  predicate: string;
  toEntityId: string;
  confidence: AssertionConfidence;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
  evidenceRefs: string[];
  supersededBy: string | null;
}

export interface EntityStateRecord {
  id: string;
  entityId: string;
  key: string;
  value: unknown;
  confidence: AssertionConfidence;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
  sourceRef: string | null;
  evidenceRefs: string[];
  supersededBy: string | null;
}

export const DECISION_STATUSES = ["active", "superseded", "revoked"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface DecisionRecord {
  id: string;
  subjectEntityId: string | null;
  goalId: string | null;
  taskId: string | null;
  title: string;
  decision: string;
  rationale: string | null;
  alternatives: string[];
  decidedBy: "user" | "agent" | "external";
  decidedAt: string;
  status: DecisionStatus;
  supersededBy: string | null;
  evidenceRefs: string[];
}

export const COMMITMENT_STATUSES = ["open", "fulfilled", "broken", "cancelled", "expired"] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export interface CommitmentRecord {
  id: string;
  entityId: string | null;
  counterpartyEntityId: string | null;
  goalId: string | null;
  taskId: string | null;
  description: string;
  dueAt: string | null;
  status: CommitmentStatus;
  confidence: AssertionConfidence;
  sourceRef: string | null;
  evidenceRefs: string[];
  fulfilledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const MENTION_RESOLUTIONS = ["resolved", "ambiguous", "unresolved"] as const;
export type MentionResolution = (typeof MENTION_RESOLUTIONS)[number];

export interface MentionCandidate {
  entityId: string;
  label: string;
  score: number;
  reason: string;
}

export interface MentionRecord {
  id: string;
  surface: string;
  normalized: string;
  entityId: string | null;
  conversationId: string | null;
  taskId: string | null;
  messageId: string | null;
  resolution: MentionResolution;
  candidates: MentionCandidate[];
  confidence: number;
  createdAt: string;
}

export const CONTEXT_PACK_LANES = ["must_know", "relevant", "recallable", "omitted"] as const;
export type ContextPackLane = (typeof CONTEXT_PACK_LANES)[number];

export interface ContextPackItem {
  packId: string;
  ref: string;
  lane: ContextPackLane;
  sourceKind: string;
  sourceId: string;
  title: string;
  summary: string;
  confidence: AssertionConfidence;
  source: string;
  validUntil: string | null;
  reason: string;
  score: number;
  tokens: number;
  expandable: boolean;
}

export interface ContextPack {
  id: string;
  scopeKind: "chat" | "task" | "goal" | "handoff" | "delegation";
  scopeId: string;
  goalId: string | null;
  taskId: string | null;
  conversationId: string | null;
  hash: string;
  budgetTokens: number;
  usedTokens: number;
  omitted: string[];
  parentPackId: string | null;
  createdAt: string;
  items: ContextPackItem[];
}

export interface MemoryEntityLink {
  memoryId: string;
  entityId: string;
  relation: "about" | "mentions" | "evidence_for";
}

export const TASK_EDGE_KINDS = ["subtask", "dependency", "review"] as const;
export type TaskEdgeKind = (typeof TASK_EDGE_KINDS)[number];

export const TASK_JOIN_POLICIES = ["all", "any", "n_of_m"] as const;
export type TaskJoinPolicy = (typeof TASK_JOIN_POLICIES)[number];

export interface TaskEdge {
  parentTaskId: string;
  childTaskId: string;
  kind: TaskEdgeKind;
  joinPolicy: TaskJoinPolicy;
  requiredCount: number;
  createdAt: string;
}

export const PREPARED_ACTION_STATUSES = ["prepared", "committed", "discarded", "expired"] as const;
export type PreparedActionStatus = (typeof PREPARED_ACTION_STATUSES)[number];

export interface PreparedActionRecord {
  id: string;
  taskId: string | null;
  goalId: string | null;
  kind: "draft_email" | "calendar_check" | "research" | "test_run" | "diff";
  actionDigest: string;
  preview: Record<string, unknown>;
  status: PreparedActionStatus;
  expiresAt: string | null;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export const THREAD_SUBSCRIPTION_STATUSES = ["active", "paused", "ended"] as const;
export type ThreadSubscriptionStatus = (typeof THREAD_SUBSCRIPTION_STATUSES)[number];

export interface ThreadSubscriptionRecord {
  id: string;
  threadKey: string;
  taskId: string;
  runId: string | null;
  cursor: string | null;
  filter: Record<string, unknown>;
  status: ThreadSubscriptionStatus;
  createdAt: string;
  updatedAt: string;
}

export const BACKGROUND_TOOL_STATUSES = ["queued", "running", "finished", "failed", "stopped"] as const;
export type BackgroundToolStatus = (typeof BACKGROUND_TOOL_STATUSES)[number];

export interface BackgroundToolJob {
  id: string;
  taskId: string;
  runId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  status: BackgroundToolStatus;
  output: string;
  outputRef: string | null;
  exitCode: number | null;
  stopReason: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export const WATCHDOG_ACTIONS = ["warn", "pause", "cancel", "handoff"] as const;
export type WatchdogAction = (typeof WATCHDOG_ACTIONS)[number];

export interface WatchdogEvent {
  id: string;
  taskId: string | null;
  runId: string | null;
  reason: string;
  detail: string;
  action: WatchdogAction;
  evidenceRefs: string[];
  createdAt: string;
}

export interface AttentionFeedbackRecord {
  id: string;
  attentionId: string;
  kind: string;
  action: "accept" | "ignore" | "snooze" | "resolve" | "wrong";
  timeOfDay: string;
  channel: string;
  createdAt: string;
}

export const INTAKE_DECISIONS = ["ignore", "chat", "task", "attention"] as const;
export type IntakeDecision = (typeof INTAKE_DECISIONS)[number];

export interface IntakeDecisionRecord {
  id: string;
  sourceRef: string;
  route: IntakeDecision;
  reason: string;
  confidence: number;
  createdAt: string;
}

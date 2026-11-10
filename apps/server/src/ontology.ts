import { createHash, randomUUID } from "node:crypto";
import type {
  AssertionConfidence,
  AttentionItem,
  CommitmentRecord,
  DecisionRecord,
  EntityAliasRecord,
  EntityKind,
  EntityRecord,
  EntitySensitivity,
  EntityStateRecord,
  MentionRecord,
  RelationRecord
} from "@hearth/core";
import type { HearthService } from "./service.ts";

const CONFIDENCE_RANK: Record<AssertionConfidence, number> = {
  inferred: 0,
  observed: 1,
  confirmed: 2,
  stale: -1
};

export interface EnsureEntityInput {
  kind: EntityKind;
  name: string;
  aliases?: string[];
  confidence?: AssertionConfidence;
  sensitivity?: EntitySensitivity;
  sourceKind?: string;
  evidenceRef?: string;
}

export interface RecordStateInput {
  entityId: string;
  key: string;
  value: unknown;
  confidence: AssertionConfidence;
  sourceRef: string | null;
  evidenceRefs: string[];
  validFrom?: string;
  supersede?: boolean;
}

export interface RecordStateResult {
  state: EntityStateRecord;
  conflict: AttentionItem | null;
}

export interface RecordDecisionInput {
  title: string;
  decision: string;
  decidedBy: DecisionRecord["decidedBy"];
  evidenceRefs: string[];
  subjectEntityId?: string | null;
  goalId?: string | null;
  taskId?: string | null;
  rationale?: string | null;
  alternatives?: string[];
  supersedeSameSubject?: boolean;
}

export interface RecordCommitmentInput {
  description: string;
  dueAt?: string | null;
  confidence: AssertionConfidence;
  evidenceRefs: string[];
  entityId?: string | null;
  counterpartyEntityId?: string | null;
  goalId?: string | null;
  taskId?: string | null;
  sourceRef?: string | null;
}

export class OntologyService {
  constructor(private readonly service: HearthService) {}

  ensureEntity(input: EnsureEntityInput): EntityRecord {
    const name = input.name.trim();
    if (!name) throw new Error("实体名称不能为空");
    const normalized = normalizeEntityText(name);
    const byName = this.service.store.findEntitiesByName(name, input.kind)[0];
    const byAlias = this.service.store.findEntitiesByAlias(normalized, input.kind)[0];
    const existing = byName ?? byAlias;
    const now = new Date().toISOString();
    if (existing) {
      const aliases = [...new Set([name, ...(input.aliases ?? [])].map((value) => value.trim()).filter(Boolean))];
      for (const alias of aliases) this.ensureAlias(existing, alias, input.sourceKind ?? "ontology", input.confidence ?? existing.confidence);
      if (CONFIDENCE_RANK[input.confidence ?? "observed"] > CONFIDENCE_RANK[existing.confidence]) {
        const updated = { ...existing, confidence: input.confidence!, updatedAt: now };
        this.append("entity.updated", updated);
        return updated;
      }
      return existing;
    }
    const entity: EntityRecord = {
      id: `ent:${randomUUID()}`,
      kind: input.kind,
      canonicalName: name,
      status: "active",
      sensitivity: input.sensitivity ?? "normal",
      confidence: input.confidence ?? "observed",
      mergedInto: null,
      createdAt: now,
      updatedAt: now
    };
    this.append("entity.created", entity);
    for (const alias of [...new Set([name, ...(input.aliases ?? [])].map((value) => value.trim()).filter(Boolean))]) {
      this.ensureAlias(entity, alias, input.sourceKind ?? "ontology", input.confidence ?? "observed");
    }
    return entity;
  }

  findEntityByMention(text: string, kind?: EntityKind): EntityRecord | null {
    const normalized = normalizeEntityText(text);
    return this.service.store.findEntitiesByName(text, kind)[0]
      ?? this.service.store.findEntitiesByAlias(normalized, kind)[0]
      ?? null;
  }

  recordState(input: RecordStateInput): RecordStateResult {
    const now = input.validFrom ?? new Date().toISOString();
    const active = this.service.store.listEntityStates({ entityId: input.entityId, key: input.key, activeOnly: true, limit: 20 });
    const sameValue = active.find((state) => stableValue(state.value) === stableValue(input.value));
    if (sameValue) {
      if (CONFIDENCE_RANK[input.confidence] > CONFIDENCE_RANK[sameValue.confidence]) {
        const confirmed: EntityStateRecord = {
          ...sameValue,
          confidence: input.confidence,
          sourceRef: input.sourceRef ?? sameValue.sourceRef,
          evidenceRefs: [...new Set([...sameValue.evidenceRefs, ...input.evidenceRefs])],
          recordedAt: now
        };
        this.append("entity.state.upserted", confirmed, null);
        return { state: confirmed, conflict: null };
      }
      return { state: sameValue, conflict: null };
    }

    const state: EntityStateRecord = {
      id: `st:${randomUUID()}`,
      entityId: input.entityId,
      key: input.key,
      value: input.value,
      confidence: input.confidence,
      validFrom: now,
      validTo: null,
      recordedAt: now,
      sourceRef: input.sourceRef,
      evidenceRefs: [...new Set(input.evidenceRefs)],
      supersededBy: null
    };

    if (active.length === 0) {
      this.append("entity.state.upserted", state, null);
      return { state, conflict: null };
    }

    const current = active[0]!;
    const canOverride = input.supersede || (input.confidence === "confirmed" && current.confidence !== "confirmed");
    if (canOverride) {
      const retired: EntityStateRecord = { ...current, validTo: now, supersededBy: state.id };
      this.append("entity.state.upserted", retired, null);
      this.append("entity.state.upserted", state, null);
      return { state, conflict: null };
    }

    const conflicting: EntityStateRecord = { ...state, validTo: now, supersededBy: current.id };
    this.append("entity.state.upserted", conflicting, null);
    return { state: conflicting, conflict: this.raiseConflict(input, current) };
  }

  recordRelation(input: {
    fromEntityId: string;
    predicate: string;
    toEntityId: string;
    confidence: AssertionConfidence;
    evidenceRefs: string[];
    validFrom?: string | null;
    validTo?: string | null;
  }): RelationRecord {
    const existing = this.service.store.listRelations({
      fromEntityId: input.fromEntityId,
      toEntityId: input.toEntityId,
      predicate: input.predicate,
      activeOnly: input.validTo == null,
      limit: 5
    })[0];
    if (existing) return existing;
    const now = new Date().toISOString();
    const relation: RelationRecord = {
      id: `rel:${randomUUID()}`,
      fromEntityId: input.fromEntityId,
      predicate: input.predicate,
      toEntityId: input.toEntityId,
      confidence: input.confidence,
      validFrom: input.validFrom ?? now,
      validTo: input.validTo ?? null,
      recordedAt: now,
      evidenceRefs: [...new Set(input.evidenceRefs)],
      supersededBy: null
    };
    this.append("relation.upserted", relation, null);
    return relation;
  }

  recordDecision(input: RecordDecisionInput): DecisionRecord {
    const now = new Date().toISOString();
    const existing = input.supersedeSameSubject
      ? this.service.store.listDecisions({
          status: "active",
          ...(input.subjectEntityId ? { subjectEntityId: input.subjectEntityId } : {}),
          ...(input.goalId ? { goalId: input.goalId } : {}),
          limit: 20
        }).find((decision) => normalizeEntityText(decision.title) === normalizeEntityText(input.title))
      : undefined;
    const decision: DecisionRecord = {
      id: `dec:${randomUUID()}`,
      subjectEntityId: input.subjectEntityId ?? null,
      goalId: input.goalId ?? null,
      taskId: input.taskId ?? null,
      title: input.title,
      decision: input.decision,
      rationale: input.rationale ?? null,
      alternatives: input.alternatives ?? [],
      decidedBy: input.decidedBy,
      decidedAt: now,
      status: "active",
      supersededBy: null,
      evidenceRefs: [...new Set(input.evidenceRefs)]
    };
    if (existing) {
      this.append("decision.upserted", { ...existing, status: "superseded", supersededBy: decision.id }, input.taskId ?? null);
    }
    this.append("decision.upserted", decision, input.taskId ?? null);
    return decision;
  }

  recordCommitment(input: RecordCommitmentInput): CommitmentRecord {
    const normalized = normalizeEntityText(input.description);
    const existing = this.service.store.listCommitments({ status: "open", limit: 500 }).find((commitment) =>
      normalizeEntityText(commitment.description) === normalized
      && (input.taskId == null || commitment.taskId === input.taskId)
      && (input.sourceRef == null || commitment.sourceRef === input.sourceRef)
    );
    if (existing) return existing;
    const now = new Date().toISOString();
    const commitment: CommitmentRecord = {
      id: `cmt:${randomUUID()}`,
      entityId: input.entityId ?? null,
      counterpartyEntityId: input.counterpartyEntityId ?? null,
      goalId: input.goalId ?? null,
      taskId: input.taskId ?? null,
      description: input.description,
      dueAt: input.dueAt ?? null,
      status: "open",
      confidence: input.confidence,
      sourceRef: input.sourceRef ?? null,
      evidenceRefs: [...new Set(input.evidenceRefs)],
      fulfilledAt: null,
      createdAt: now,
      updatedAt: now
    };
    this.append("commitment.upserted", commitment, input.taskId ?? null);
    return commitment;
  }

  recordMention(mention: MentionRecord): MentionRecord {
    this.append("mention.recorded", mention, mention.taskId);
    return mention;
  }

  forgetEvidence(evidenceRef: string): ReturnType<HearthService["store"]["forgetOntologyEvidence"]> & { entityIds: string[] } {
    const affected = this.service.store.db.prepare(
      "SELECT DISTINCT entity_id FROM entity_states WHERE evidence_refs_json LIKE ? UNION SELECT DISTINCT from_entity_id AS entity_id FROM relations WHERE evidence_refs_json LIKE ? UNION SELECT DISTINCT to_entity_id AS entity_id FROM relations WHERE evidence_refs_json LIKE ?"
    ).all(`%${evidenceRef}%`, `%${evidenceRef}%`, `%${evidenceRef}%`) as Array<Record<string, unknown>>;
    const result = this.service.store.forgetOntologyEvidence(evidenceRef);
    const now = new Date().toISOString();
    for (const row of affected) {
      const entity = this.service.store.getEntity(String(row.entity_id));
      if (entity && entity.status === "active") this.append("entity.updated", { ...entity, confidence: "stale", updatedAt: now }, null);
    }
    return { ...result, entityIds: affected.map((row) => String(row.entity_id)) };
  }

  snapshot(): { entities: number; relations: number; states: number; decisions: number; commitments: number; packs: number } {
    return {
      entities: this.service.store.listEntities({ limit: 100_000 }).length,
      relations: this.service.store.listRelations({ limit: 100_000 }).length,
      states: this.service.store.listEntityStates({ limit: 100_000 }).length,
      decisions: this.service.store.listDecisions({ limit: 100_000 }).length,
      commitments: this.service.store.listCommitments({ limit: 100_000 }).length,
      packs: this.service.store.listContextPacks({ limit: 100_000 }).length
    };
  }

  private ensureAlias(entity: EntityRecord, alias: string, sourceKind: string, confidence: AssertionConfidence): EntityAliasRecord {
    const existing = this.service.store.listEntityAliases(entity.id)
      .find((record) => record.normalized === normalizeEntityText(alias));
    if (existing) return existing;
    const record: EntityAliasRecord = {
      id: `alias:${randomUUID()}`,
      entityId: entity.id,
      alias,
      normalized: normalizeEntityText(alias),
      sourceKind,
      confidence,
      createdAt: new Date().toISOString()
    };
    this.append("entity.alias.upserted", record, null);
    return record;
  }

  private raiseConflict(input: RecordStateInput, current: EntityStateRecord): AttentionItem {
    const digest = createHash("sha256").update(`${input.entityId}\n${input.key}\n${stableValue(input.value)}`).digest("hex").slice(0, 16);
    const dedupeKey = `ontology-conflict:${input.entityId}:${input.key}:${digest}`;
    const existing = this.service.store.findOpenAttentionByDedupe(dedupeKey);
    if (existing) return existing;
    const entity = this.service.store.getEntity(input.entityId);
    const now = new Date().toISOString();
    const item: AttentionItem = {
      id: `attn:conflict:${randomUUID()}`,
      dedupeKey,
      kind: "conflict",
      priority: 2,
      critical: false,
      title: `确认“${entity?.canonicalName ?? input.entityId}”的${input.key}状态`,
      waitingOn: "user",
      waitingSince: now,
      nextAction: "选择正确值，或指定应优先采用的来源",
      consequence: "继续使用冲突状态可能导致错误决定或向错误对象执行动作",
      whyNow: "两个来源在同一时间段给出了不同状态，系统不会静默覆盖",
      goalId: null,
      taskId: null,
      intentId: null,
      source: "ontology",
      status: "open",
      snoozeUntil: null,
      entityId: input.entityId,
      evidenceRefs: [...new Set([...current.evidenceRefs, ...input.evidenceRefs])],
      options: [
        { id: "keep-current", label: "保留原状态", action: `state:${current.id}`, consequence: `继续使用 ${formatValue(current.value)}` },
        { id: "use-new", label: "采用新状态", action: `state:${input.entityId}:${input.key}`, consequence: `改为 ${formatValue(input.value)}` },
        { id: "defer", label: "稍后处理", action: "snooze", consequence: "暂时保留冲突" }
      ],
      impact: 4,
      urgency: 3,
      confidence: 1,
      reversibility: "easy",
      blastRadius: "self",
      score: 8,
      aggregationKey: `ontology:${input.entityId}:${input.key}`,
      shadowed: false,
      createdAt: now,
      updatedAt: now
    };
    this.append("attention.updated", item, null);
    return item;
  }

  private append(type: string, payload: unknown, taskId?: string | null): void {
    const event = this.service.store.appendEvent({
      type,
      ...(taskId === undefined ? {} : { taskId }),
      payload
    });
    this.service.bus.publish(event);
  }
}

export function normalizeEntityText(value: string): string {
  return value.trim().toLowerCase().replace(/[\s\-_/]+/g, " ").replace(/\s+/g, " ");
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(",")}}`;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

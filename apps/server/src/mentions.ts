import { randomUUID } from "node:crypto";
import type { EntityKind, EntityRecord, MentionCandidate, MentionRecord } from "@hearth/core";
import { normalizeEntityText, type OntologyService } from "./ontology.ts";
import type { HearthService } from "./service.ts";

export interface MentionContext {
  text: string;
  conversationId?: string | null;
  taskId?: string | null;
  messageId?: string | null;
  scopeEntityIds?: string[];
  irreversible?: boolean;
}

export interface MentionResolutionResult {
  mentions: MentionRecord[];
  needsClarification: boolean;
  blocksAction: boolean;
  question: string | null;
}

interface ScoredCandidate extends MentionCandidate {
  entity: EntityRecord;
}

export class MentionResolver {
  constructor(
    private readonly service: HearthService,
    private readonly ontology: OntologyService
  ) {}

  resolveText(context: MentionContext): MentionResolutionResult {
    const surfaces = this.detectSurfaces(context.text);
    const mentions = surfaces.map((surface) => this.resolveSurface(surface, context));
    const ambiguous = mentions.filter((mention) => mention.resolution !== "resolved");
    return {
      mentions,
      needsClarification: ambiguous.length > 0,
      blocksAction: Boolean(context.irreversible && ambiguous.length > 0),
      question: ambiguous.length > 0 ? this.clarificationQuestion(ambiguous[0]!) : null
    };
  }

  resolveSurface(surface: string, context: Omit<MentionContext, "text">): MentionRecord {
    const normalized = normalizeEntityText(surface);
    const candidates = this.candidates(surface, normalized, context);
    const top1 = candidates[0];
    const top2 = candidates[1];
    const resolved = Boolean(top1 && top1.score >= 0.75 && (!top2 || top1.score - top2.score >= 0.15));
    const mention: MentionRecord = {
      id: `mention:${randomUUID()}`,
      surface,
      normalized,
      entityId: resolved ? top1!.entityId : null,
      conversationId: context.conversationId ?? null,
      taskId: context.taskId ?? null,
      messageId: context.messageId ?? null,
      resolution: resolved ? "resolved" : candidates.length > 0 ? "ambiguous" : "unresolved",
      candidates: candidates.slice(0, 3).map(({ entity: _entity, ...candidate }) => candidate),
      confidence: top1?.score ?? 0,
      createdAt: new Date().toISOString()
    };
    return this.ontology.recordMention(mention);
  }

  clarificationQuestion(mention: MentionRecord): string {
    if (mention.candidates.length === 0) return `你说的“${mention.surface}”我还没有对应到具体对象，能否补充全名或来源？`;
    const choices = mention.candidates.slice(0, 3).map((candidate) => candidate.label).join("、");
    return `你说的“${mention.surface}”是指${choices}中的哪一个？`;
  }

  private detectSurfaces(text: string): string[] {
    const entries = new Map<string, string>();
    for (const entity of this.service.store.listEntities({ status: "active", limit: 5000 })) {
      if (entity.canonicalName.trim().length >= 2) entries.set(normalizeEntityText(entity.canonicalName), entity.canonicalName);
    }
    for (const alias of this.service.store.listEntityAliases()) {
      if (alias.alias.trim().length >= 2) entries.set(alias.normalized, alias.alias);
    }
    const normalizedText = normalizeEntityText(text);
    const matches: Array<{ surface: string; index: number }> = [];
    for (const [normalized, surface] of entries) {
      const index = normalizedText.indexOf(normalized);
      if (index >= 0) matches.push({ surface, index });
    }
    matches.sort((a, b) => a.index - b.index || b.surface.length - a.surface.length);
    const used: Array<[number, number]> = [];
    const result: string[] = [];
    for (const match of matches) {
      const end = match.index + normalizeEntityText(match.surface).length;
      if (used.some(([start, finish]) => match.index < finish && end > start)) continue;
      used.push([match.index, end]);
      result.push(match.surface);
    }
    return result;
  }

  private candidates(surface: string, normalized: string, context: Omit<MentionContext, "text">): ScoredCandidate[] {
    const entities = this.service.store.listEntities({ status: "active", limit: 5000 });
    const scope = new Set(context.scopeEntityIds ?? []);
    if (context.conversationId) {
      for (const mention of this.service.store.listMentions({ conversationId: context.conversationId, limit: 100 })) {
        if (mention.entityId) scope.add(mention.entityId);
      }
    }
    if (context.taskId) {
      for (const mention of this.service.store.listMentions({ taskId: context.taskId, limit: 100 })) {
        if (mention.entityId) scope.add(mention.entityId);
      }
    }
    const neighbors = new Set<string>();
    for (const entityId of scope) {
      for (const relation of this.service.store.listRelations({ fromEntityId: entityId, activeOnly: true, limit: 200 })) neighbors.add(relation.toEntityId);
      for (const relation of this.service.store.listRelations({ toEntityId: entityId, activeOnly: true, limit: 200 })) neighbors.add(relation.fromEntityId);
    }
    const prior = new Set(this.service.store.listMentions({ normalized, limit: 100 }).filter((mention) => mention.resolution === "resolved" && mention.entityId).map((mention) => mention.entityId!));
    const now = Date.now();
    const scored = entities.flatMap((entity): ScoredCandidate[] => {
      const aliases = this.service.store.listEntityAliases(entity.id);
      const canonical = normalizeEntityText(entity.canonicalName);
      const exactAlias = canonical === normalized || aliases.some((alias) => alias.normalized === normalized);
      const fuzzyAlias = !exactAlias && (canonical.includes(normalized) || normalized.includes(canonical) || aliases.some((alias) => alias.normalized.includes(normalized) || normalized.includes(alias.normalized)));
      if (!exactAlias && !fuzzyAlias && !scope.has(entity.id) && !neighbors.has(entity.id)) return [];
      const aliasMatch = exactAlias ? 1 : fuzzyAlias ? 0.55 : 0;
      const ageDays = Math.max(0, (now - Date.parse(entity.updatedAt)) / 86_400_000);
      const recency = Math.max(0, 1 - ageDays / 90);
      const scopeAffinity = scope.has(entity.id) ? 1 : 0;
      const graphProximity = neighbors.has(entity.id) ? 1 : 0;
      const userConfirmationHistory = prior.has(entity.id) ? 1 : 0;
      const typeCompatibility = typeCompatibilityFor(surface, entity.kind);
      const score = 0.35 * aliasMatch + 0.20 * recency + 0.15 * scopeAffinity
        + 0.15 * typeCompatibility + 0.10 * graphProximity + 0.05 * userConfirmationHistory;
      return [{
        entityId: entity.id,
        label: `${entity.canonicalName}（${entity.kind}）`,
        score: Math.round(score * 1000) / 1000,
        reason: exactAlias ? "别名精确匹配" : fuzzyAlias ? "名称部分匹配" : scopeAffinity > 0 ? "当前会话最近出现" : "一跳关系邻居",
        entity
      }];
    });
    return scored.sort((a, b) => b.score - a.score);
  }
}

function typeCompatibilityFor(surface: string, kind: EntityKind): number {
  if (/@/.test(surface) || /^1\d{10}$/.test(surface)) return kind === "person" || kind === "account" ? 1 : 0.1;
  if (/公司|团队|组织|学校|银行/.test(surface)) return kind === "org" ? 1 : 0.2;
  if (/项目|计划|方案/.test(surface)) return kind === "project" || kind === "topic" ? 1 : 0.2;
  return kind === "person" ? 0.6 : 0.4;
}

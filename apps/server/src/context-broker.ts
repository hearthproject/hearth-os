import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type {
  AssertionConfidence,
  ContextPack,
  ContextPackItem,
  ContextPackLane,
  DecisionRecord,
  EntityRecord,
  MemoryRecord
} from "@hearth/core";
import { estimateTokens, type ContextService } from "./context.ts";
import { normalizeEntityText, type OntologyService } from "./ontology.ts";
import type { HearthService } from "./service.ts";

export interface CompileContextInput {
  scopeKind: ContextPack["scopeKind"];
  scopeId: string;
  goalId?: string | null;
  taskId?: string | null;
  conversationId?: string | null;
  query: string;
  budgetTokens: number;
  parentPackId?: string | null;
  mustKnow?: ContextPackItem[];
  includeIdentity?: boolean;
  includeRecentContext?: boolean;
}

interface Candidate {
  item: ContextPackItem;
  lexical: number;
  recency: number;
  graph: number;
}

export class ContextBroker {
  constructor(
    private readonly service: HearthService,
    private readonly context: ContextService,
    private readonly ontology: OntologyService
  ) {}

  compile(input: CompileContextInput): ContextPack {
    const stateVersion = this.stateVersion();
    const parentRefs = this.parentPackRefs(input);
    const allMustKnow = [...(input.includeIdentity === false ? [] : [this.identityItem()]), ...(input.mustKnow ?? []), ...this.mustKnowItems(input)];
    const allCandidates = this.candidates(input);
    const mustKnow = allMustKnow.filter((item) => this.isWithinParentPack(item, input, parentRefs));
    const candidates = allCandidates.filter((candidate) => this.isWithinParentPack(candidate.item, input, parentRefs));
    const lanes: Record<ContextPackLane, ContextPackItem[]> = {
      must_know: dedupeItems(mustKnow),
      relevant: [],
      recallable: [],
      omitted: []
    };
    let usedTokens = sumTokens(lanes.must_know);
    if (parentRefs) {
      for (const item of [...allMustKnow, ...allCandidates.map((candidate) => candidate.item)]) {
        if (this.isWithinParentPack(item, input, parentRefs)) continue;
        if (lanes.omitted.some((entry) => entry.ref === item.ref)) continue;
        lanes.omitted.push({ ...item, lane: "omitted", reason: "父委派上下文包未包含此来源", tokens: 0 });
      }
    }
    for (const candidate of candidates.sort((a, b) => candidateScore(b) - candidateScore(a))) {
      if (lanes.must_know.some((item) => item.ref === candidate.item.ref)) continue;
      if (usedTokens + candidate.item.tokens <= input.budgetTokens) {
        lanes.relevant.push(candidate.item);
        usedTokens += candidate.item.tokens;
        continue;
      }
      const recallable = summarizeForExpansion(candidate.item);
      if (usedTokens + recallable.tokens <= input.budgetTokens) {
        lanes.recallable.push(recallable);
        usedTokens += recallable.tokens;
        continue;
      }
      lanes.omitted.push({ ...candidate.item, lane: "omitted", reason: `超出 ${input.budgetTokens} token 预算；可用 ref 展开`, tokens: 0 });
    }
    for (const item of this.expiredOrRestrictedItems(input)) lanes.omitted.push(item);
    const omitted = lanes.omitted.map((item) => `${item.ref}: ${item.reason}`);
    const hash = packHash(input, lanes, stateVersion);
    const existing = this.service.store.findContextPackByHash(hash);
    if (existing) return existing;
    const now = new Date().toISOString();
    const pack: ContextPack = {
      id: `ctxpack:${hash.slice(0, 24)}`,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      goalId: input.goalId ?? null,
      taskId: input.taskId ?? null,
      conversationId: input.conversationId ?? null,
      hash,
      budgetTokens: input.budgetTokens,
      usedTokens,
      omitted,
      parentPackId: input.parentPackId ?? null,
      createdAt: now,
      items: [...lanes.must_know, ...lanes.relevant, ...lanes.recallable, ...lanes.omitted].map((item) => ({ ...item, packId: `ctxpack:${hash.slice(0, 24)}` }))
    };
    const event = this.service.store.appendEvent({ type: "context.pack.created", taskId: input.taskId ?? null, payload: pack });
    this.service.bus.publish(event);
    return pack;
  }

  render(pack: ContextPack): string {
    const sections: string[] = [];
    const add = (title: string, lane: ContextPackLane, intro: string): void => {
      const items = pack.items.filter((item) => item.lane === lane);
      if (items.length === 0) return;
      sections.push(`## ${title}\n${intro}\n${items.map((item) => renderItem(item)).join("\n")}`);
    };
    add("你必须知道的", "must_know", "这些是身份、目标、硬约束、最新决定和开放承诺；全部注入。每个引用都可以用 expand_ref 展开。");
    add("相关", "relevant", "与当前任务直接相关，已按预算注入。");
    add("可展开", "recallable", "只注入摘要和 ref；需要全文时调用 expand_ref(ref)。");
    add("已省略", "omitted", "以下内容因预算、权限或时效未注入。不要假设它们不存在；如确需使用，先 expand_ref 或向用户确认。");
    return sections.join("\n\n");
  }

  expandRef(ref: string, packId?: string | null): string {
    const pack = packId ? this.service.store.getContextPack(packId) : null;
    const item = pack?.items.find((entry) => entry.ref === ref) ?? this.service.store.listContextPacks({ limit: 200 })
      .flatMap((candidate) => candidate.items)
      .find((entry) => entry.ref === ref);
    if (!item) return `找不到引用 ${ref}。请先确认 ref 来自当前 Context Pack。`;
    const body = this.expandBody(ref, pack?.taskId ?? null);
    return body ?? `引用 ${ref} 已失效或无权展开（${item.reason}）。`;
  }

  private parentPackRefs(input: CompileContextInput): Set<string> | null {
    if (!input.parentPackId) return null;
    const pack = this.service.store.getContextPack(input.parentPackId);
    if (!pack) return null;
    return new Set(pack.items.filter((item) => item.lane !== "omitted").map((item) => item.ref));
  }

  private isWithinParentPack(item: ContextPackItem, input: CompileContextInput, parentRefs: Set<string> | null): boolean {
    if (!parentRefs) return true;
    if (parentRefs.has(item.ref)) return true;
    if (item.sourceKind === "profile") return true;
    if (input.taskId && item.ref === `task:${input.taskId}`) return true;
    if (input.goalId && item.ref === `goal:${input.goalId}`) return true;
    return false;
  }

  private mustKnowItems(input: CompileContextInput): ContextPackItem[] {
    const items: ContextPackItem[] = [];
    if (input.goalId) {
      const goal = this.service.store.getGoal(input.goalId);
      if (goal) {
        const summary = [
          goal.title,
          goal.objective,
          goal.constraints.length > 0 ? `约束：${goal.constraints.join("；")}` : "",
          goal.forbiddenActions.length > 0 ? `禁止：${goal.forbiddenActions.join("；")}` : "",
          goal.deadline ? `截止：${goal.deadline}` : ""
        ].filter(Boolean).join("；");
        items.push(makeItem({
          ref: `goal:${goal.goalId}`, sourceKind: "goal", sourceId: goal.goalId,
          title: goal.title, summary, confidence: "confirmed", source: "GoalContract",
          reason: "当前目标的硬约束与验收边界", score: 1, expandable: true
        }));
      }
    }
    if (input.taskId) {
      const task = this.service.store.getTask(input.taskId);
      if (task) {
        items.push(makeItem({
          ref: `task:${task.id}`, sourceKind: "task", sourceId: task.id,
          title: task.title,
          summary: `${task.goal}${task.deadline ? `；截止 ${task.deadline}` : ""}；状态 ${task.status}${task.nextAction ? `；下一步 ${task.nextAction}` : ""}`,
          confidence: "confirmed", source: "TaskRecord", reason: "当前任务目标与下一步", score: 1, expandable: true
        }));
      }
    }
    for (const decision of this.service.store.listDecisions({ status: "active", limit: 12 })) {
      items.push(decisionItem(decision, "最新有效决定"));
    }
    for (const commitment of this.service.store.listCommitments({ status: "open", limit: 12 })) {
      items.push(commitmentItem(commitment));
    }
    return items;
  }

  private candidates(input: CompileContextInput): Candidate[] {
    const candidates: Candidate[] = [];
    const matchedEntities = this.matchEntities(input.query);
    for (const entity of matchedEntities) candidates.push(this.entityCandidate(entity, input.query));
    const entityIds = new Set(matchedEntities.map((entity) => entity.id));
    for (const entityId of entityIds) {
      for (const state of this.service.store.listEntityStates({ entityId, activeOnly: true, limit: 20 })) {
        candidates.push({
          item: makeItem({
            ref: `st:${state.id}`, sourceKind: "state", sourceId: state.id,
            title: `${this.service.store.getEntity(entityId)?.canonicalName ?? entityId} · ${state.key}`,
            summary: `${state.key} = ${formatValue(state.value)}`, confidence: state.confidence,
            source: state.sourceRef ?? "ontology", validUntil: state.validTo,
            reason: "与当前查询实体直接相关的有效状态", score: 0.82, expandable: true
          }),
          lexical: 0.7, recency: recencyScore(state.recordedAt), graph: 1
        });
      }
      for (const relation of this.service.store.listRelations({ fromEntityId: entityId, activeOnly: true, limit: 30 })) {
        const from = this.service.store.getEntity(relation.fromEntityId);
        const to = this.service.store.getEntity(relation.toEntityId);
        candidates.push({
          item: makeItem({
            ref: `rel:${relation.id}`, sourceKind: "relation", sourceId: relation.id,
            title: `${from?.canonicalName ?? relation.fromEntityId} ${relation.predicate} ${to?.canonicalName ?? relation.toEntityId}`,
            summary: `${relation.predicate}；有效自 ${relation.validFrom ?? relation.recordedAt}`,
            confidence: relation.confidence, source: relation.evidenceRefs.join("、") || "ontology",
            reason: "命中实体的一跳关系", score: 0.72, expandable: true
          }),
          lexical: 0.4, recency: recencyScore(relation.recordedAt), graph: 1
        });
      }
    }
    const allowedSensitive = this.service.store.getMemorySettings()?.allowSensitive ?? false;
    for (const memory of this.service.store.listMemories({ status: "active", limit: 500 })) {
      if (!memoryRecallAllowed(memory, allowedSensitive)) continue;
      const lexical = lexicalScore(input.query, `${memory.subjectKey}\n${memory.tags.join(" ")}\n${memory.content}`);
      if (lexical === 0 && !entityIds.size) continue;
      const linked = this.service.store.listMemoryEntityLinks({ memoryId: memory.id }).some((link) => entityIds.has(link.entityId));
      candidates.push({
        item: memoryItem(memory),
        lexical,
        recency: recencyScore(memory.updatedAt),
        graph: linked ? 1 : 0
      });
    }
    if (input.taskId && input.includeRecentContext !== false) {
      for (const contextItem of this.context.listItems(input.taskId, { limit: 100 }).items) {
        if (["notice", "summary", "checkpoint", "method"].includes(contextItem.kind)) continue;
        if (contextItem.sensitivity !== "normal") {
          continue;
        }
        const lexical = lexicalScore(input.query, contextItem.content);
        candidates.push({
          item: makeItem({
            ref: `ctx:${contextItem.id}`, sourceKind: "context_item", sourceId: contextItem.id,
            title: contextLabel(contextItem.kind), summary: clipText(contextItem.content, 900),
            confidence: "observed", source: String(contextItem.provenance.source ?? "context"),
            reason: lexical > 0 ? "与当前查询词面相关" : "任务内最近上下文", score: Math.max(0.35, lexical),
            expandable: Boolean(contextItem.contentRef) || contextItem.content.length > 900
          }),
          lexical: Math.max(0.35, lexical), recency: recencyScore(contextItem.createdAt), graph: 0
        });
      }
    }
    for (const source of this.service.store.listReadySourceItems(100)) {
      const lexical = lexicalScore(input.query, `${source.title ?? ""}\n${source.label}`);
      if (lexical === 0) continue;
      candidates.push({
        item: makeItem({
          ref: `src:${source.id}`, sourceKind: "source_item", sourceId: source.id,
          title: source.title || source.label, summary: `来源条目 ${source.locator}；${source.bytes} bytes`,
          confidence: "observed", source: source.locator, reason: "与查询词面相关、可按需展开全文",
          score: lexical, expandable: Boolean(source.contentPath)
        }),
        lexical, recency: recencyScore(source.fetchedAt), graph: 0
      });
    }
    for (const decision of this.service.store.listDecisions({ status: "active", ...(input.taskId ? { taskId: input.taskId } : {}), limit: 20 })) {
      const lexical = lexicalScore(input.query, `${decision.title}\n${decision.decision}`);
      if (lexical > 0) candidates.push({ item: decisionItem(decision, "与当前任务相关的决定"), lexical, recency: recencyScore(decision.decidedAt), graph: 0.5 });
    }
    return dedupeCandidates(candidates);
  }

  private expiredOrRestrictedItems(input: CompileContextInput): ContextPackItem[] {
    const omitted: ContextPackItem[] = [];
    if (input.taskId) {
      for (const contextItem of this.context.listItems(input.taskId, { limit: 100 }).items) {
        if (contextItem.sensitivity === "normal") continue;
        omitted.push(makeItem({
          ref: `ctx:${contextItem.id}`, sourceKind: "context_item", sourceId: contextItem.id,
          title: contextLabel(contextItem.kind), summary: "内容因敏感度未注入",
          confidence: "observed", source: String(contextItem.provenance.source ?? "context"),
          reason: `sensitivity=${contextItem.sensitivity}，未授权注入`, score: 0, expandable: false, tokens: 0
        }) as ContextPackItem);
        omitted[omitted.length - 1]!.lane = "omitted";
      }
    }
    return omitted;
  }

  private identityItem(): ContextPackItem {
    const name = this.service.store.getAppSetting("profile.name")
      ?? this.service.store.getAppSetting("profile.displayName")
      ?? this.service.store.getAppSetting("onboarding.name")
      ?? "本地用户";
    return makeItem({
      ref: "profile:local", sourceKind: "profile", sourceId: "local",
      title: "用户身份", summary: `${name}；数据保存在本机，可审计、可遗忘、可导出`,
      confidence: "confirmed", source: "local-profile", reason: "身份是所有上下文的最小基线",
      score: 1, expandable: true
    });
  }

  private matchEntities(query: string): EntityRecord[] {
    const normalized = normalizeEntityText(query);
    return this.service.store.listEntities({ status: "active", limit: 5000 }).filter((entity) => {
      const name = normalizeEntityText(entity.canonicalName);
      if (name.length >= 2 && normalized.includes(name)) return true;
      return this.service.store.listEntityAliases(entity.id).some((alias) => alias.normalized.length >= 2 && normalized.includes(alias.normalized));
    }).slice(0, 20);
  }

  private entityCandidate(entity: EntityRecord, query: string): Candidate {
    const states = this.service.store.listEntityStates({ entityId: entity.id, activeOnly: true, limit: 6 });
    return {
      item: makeItem({
        ref: `ent:${entity.id}`, sourceKind: "entity", sourceId: entity.id,
        title: entity.canonicalName,
        summary: `${entity.kind}${states.length > 0 ? `；${states.map((state) => `${state.key}=${formatValue(state.value)}`).join("；")}` : ""}`,
        confidence: entity.confidence, source: "ontology", reason: "当前查询明确提到了这个实体",
        score: 0.9, expandable: true
      }),
      lexical: lexicalScore(query, entity.canonicalName), recency: recencyScore(entity.updatedAt), graph: 1
    };
  }

  private expandBody(ref: string, taskId: string | null): string | null {
    const [kind, ...parts] = ref.split(":");
    const id = parts.join(":");
    if (kind === "ent") {
      const entity = this.service.store.getEntity(id);
      if (!entity) return null;
      const aliases = this.service.store.listEntityAliases(id);
      const states = this.service.store.listEntityStates({ entityId: id, activeOnly: true, limit: 50 });
      const relations = this.service.store.listRelations({ fromEntityId: id, activeOnly: true, limit: 50 });
      return JSON.stringify({ entity, aliases, states, relations }, null, 2).slice(0, 16_000);
    }
    if (kind === "st") {
      const row = this.service.store.db.prepare("SELECT * FROM entity_states WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? JSON.stringify(row, null, 2) : null;
    }
    if (kind === "rel") {
      const row = this.service.store.db.prepare("SELECT * FROM relations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? JSON.stringify(row, null, 2) : null;
    }
    if (kind === "dec") return JSON.stringify(this.service.store.getDecision(id), null, 2);
    if (kind === "cmt") return JSON.stringify(this.service.store.getCommitment(id), null, 2);
    if (kind === "mem") return this.service.store.getMemory(id)?.content.slice(0, 16_000) ?? null;
    if (kind === "src") {
      const item = this.service.store.getSourceItem(id);
      if (!item) return null;
      if (item.contentPath && existsSync(item.contentPath)) {
        try { return readFileSync(item.contentPath, "utf8").slice(0, 16_000); } catch { return null; }
      }
      return JSON.stringify(item, null, 2);
    }
    if (kind === "ctx") {
      if (!taskId) return null;
      const item = this.context.listItems(taskId, { limit: 5_000 }).items.find((entry) => entry.id === id);
      return item ? clipText(item.content, 16_000) : null;
    }
    if (kind === "goal") return JSON.stringify(this.service.store.getGoal(id), null, 2);
    if (kind === "task") return JSON.stringify(this.service.store.getTask(id), null, 2);
    if (kind === "approval") return JSON.stringify(this.service.store.getApproval(id), null, 2);
    if (kind === "profile") return this.identityItem().summary;
    return null;
  }

  private stateVersion(): string {
    const row = this.service.store.db.prepare(`SELECT
      (SELECT COUNT(*) FROM entities) AS entities,
      (SELECT COUNT(*) FROM entity_states) AS states,
      (SELECT COUNT(*) FROM decisions) AS decisions,
      (SELECT COUNT(*) FROM commitments) AS commitments,
      (SELECT COUNT(*) FROM memories) AS memories,
      (SELECT COUNT(*) FROM context_items) AS context_items,
      (SELECT latestEventCreatedAt FROM (SELECT MAX(created_at) AS latestEventCreatedAt FROM events)) AS event_at`).get() as Record<string, unknown>;
    return Object.values(row).map(String).join(":");
  }
}

function makeItem(input: {
  ref: string; sourceKind: string; sourceId: string; title: string; summary: string;
  confidence: AssertionConfidence; source: string; reason: string; score: number;
  expandable: boolean; validUntil?: string | null; tokens?: number;
}): ContextPackItem {
  return {
    packId: "pending",
    ref: input.ref,
    lane: "relevant",
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    title: input.title,
    summary: input.summary,
    confidence: input.confidence,
    source: input.source,
    validUntil: input.validUntil ?? null,
    reason: input.reason,
    score: input.score,
    tokens: input.tokens ?? estimateTokens(`${input.title}\n${input.summary}`),
    expandable: input.expandable
  };
}

function decisionItem(decision: DecisionRecord, reason: string): ContextPackItem {
  return makeItem({
    ref: `dec:${decision.id}`, sourceKind: "decision", sourceId: decision.id,
    title: decision.title, summary: `${decision.decision}${decision.rationale ? `；理由：${decision.rationale}` : ""}`,
    confidence: "confirmed", source: decision.evidenceRefs.join("、") || "decision",
    reason, score: 0.95, expandable: true
  });
}

function commitmentItem(commitment: import("@hearth/core").CommitmentRecord): ContextPackItem {
  return makeItem({
    ref: `cmt:${commitment.id}`, sourceKind: "commitment", sourceId: commitment.id,
    title: commitment.description,
    summary: `${commitment.status}${commitment.dueAt ? `；到期 ${commitment.dueAt}` : ""}`,
    confidence: commitment.confidence, source: commitment.sourceRef ?? (commitment.evidenceRefs.join("、") || "commitment"),
    validUntil: commitment.dueAt, reason: "开放承诺必须进入 must-know，避免忘记或重复承诺",
    score: 0.96, expandable: true
  });
}

function memoryItem(memory: MemoryRecord): ContextPackItem {
  return makeItem({
    ref: `mem:${memory.id}`, sourceKind: "memory", sourceId: memory.id,
    title: `${memory.kind} · ${memory.subjectKey}`, summary: clipText(memory.content, 600),
    confidence: memory.confidence === "high" ? "confirmed" : memory.confidence === "medium" ? "observed" : "inferred",
    source: memory.source.label, validUntil: memory.validUntil ?? memory.expiresAt,
    reason: "通过词面、实体或时间信号召回", score: 0.7, expandable: true
  });
}

function summarizeForExpansion(item: ContextPackItem): ContextPackItem {
  const summary = clipText(item.summary, 180);
  return { ...item, lane: "recallable", summary, reason: "预算不足，仅保留 ref 与摘要", tokens: estimateTokens(`${item.title}\n${summary}`) + 8, expandable: true };
}

function dedupeItems(items: ContextPackItem[]): ContextPackItem[] {
  const map = new Map<string, ContextPackItem>();
  for (const item of items) if (!map.has(item.ref)) map.set(item.ref, item);
  return [...map.values()];
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = map.get(candidate.item.ref);
    if (!existing || candidateScore(candidate) > candidateScore(existing)) map.set(candidate.item.ref, candidate);
  }
  return [...map.values()];
}

function candidateScore(candidate: Candidate): number {
  return 0.30 * candidate.lexical + 0.25 * candidate.graph + 0.20 * candidate.recency + 0.10 * candidate.item.score;
}

function packHash(input: CompileContextInput, lanes: Record<ContextPackLane, ContextPackItem[]>, stateVersion: string): string {
  const payload = {
    scope: `${input.scopeKind}:${input.scopeId}`,
    goalId: input.goalId ?? null,
    taskId: input.taskId ?? null,
    conversationId: input.conversationId ?? null,
    query: input.query,
    budget: input.budgetTokens,
    parentPackId: input.parentPackId ?? null,
    stateVersion,
    lanes: Object.fromEntries(Object.entries(lanes).map(([lane, items]) => [lane, items.map((item) => item.ref).sort()]))
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function lexicalScore(query: string, text: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return 0;
  const textTokens = tokenize(text);
  let hits = 0;
  for (const token of queryTokens) if (textTokens.has(token)) hits += 1;
  return Math.min(1, hits / Math.max(1, Math.min(queryTokens.size, 8)));
}

function tokenize(text: string): Set<string> {
  const normalized = normalizeEntityText(text);
  const tokens = new Set(normalized.match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{2,}/g) ?? []);
  const chinese = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const phrase of chinese) {
    for (let index = 0; index + 2 <= phrase.length; index += 1) tokens.add(phrase.slice(index, index + 2));
  }
  return tokens;
}

function recencyScore(iso: string): number {
  const ageDays = Math.max(0, (Date.now() - Date.parse(iso)) / 86_400_000);
  return Math.max(0, 1 - ageDays / 60);
}

function sumTokens(items: ContextPackItem[]): number {
  return items.reduce((sum, item) => sum + item.tokens, 0);
}

function memoryRecallAllowed(memory: MemoryRecord, allowSensitive: boolean): boolean {
  if (!memory.allowRecall || memory.taint !== "clean" || memory.originClass === "untrusted" || memory.trust === "none") return false;
  if (memory.sensitivity !== "normal" && !allowSensitive) return false;
  if (memory.validUntil && Date.parse(memory.validUntil) <= Date.now()) return false;
  if (memory.expiresAt && Date.parse(memory.expiresAt) <= Date.now()) return false;
  return true;
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function contextLabel(kind: string): string {
  const labels: Record<string, string> = {
    user_message: "用户消息", assistant_message: "执行器回复", tool_call: "工具调用",
    tool_result: "工具结果", artifact: "产物", source: "来源", memory_recall: "记忆召回"
  };
  return labels[kind] ?? kind;
}

function renderItem(item: ContextPackItem): string {
  const meta = [item.confidence, `来源=${item.source}`, item.validUntil ? `有效期至=${item.validUntil}` : "", item.expandable ? "可 expand_ref" : ""].filter(Boolean).join("，");
  return `- [${item.ref}] ${item.title}（${meta}）\n  ${item.summary.replace(/\n/g, " ")}\n  为何在此：${item.reason}`;
}

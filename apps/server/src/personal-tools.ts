import type { AgentTool, AgentToolResult } from "@hearth/agent-runtime";
import type {
  AssertionConfidence,
  CommitmentRecord,
  DecisionRecord,
  EntityKind,
  EntityRecord,
  EntityStateRecord,
  RelationRecord
} from "@hearth/core";
import { normalizeEntityText, OntologyService } from "./ontology.ts";
import type { HearthService } from "./service.ts";

export const PERSONAL_READ_TOOL_NAMES = [
  "get_entity",
  "get_entity_state",
  "get_relations",
  "get_decision",
  "list_commitments"
] as const;

const MAX_RESULTS = 50;
const MAX_CONTENT_CHARS = 16_000;
const ENTITY_KINDS = new Set([
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
]);

interface PersonalToolDependencies {
  service: HearthService;
  ontology: OntologyService;
}

interface EntityLookup {
  entity: EntityRecord | null;
  matches: EntityRecord[];
}

export function createPersonalReadTools(deps: PersonalToolDependencies): AgentTool[] {
  return [
    getEntityTool(deps),
    getEntityStateTool(deps),
    getRelationsTool(deps),
    getDecisionTool(deps),
    listCommitmentsTool(deps)
  ];
}

function getEntityTool({ service, ontology }: PersonalToolDependencies): AgentTool {
  return {
    definition: {
      name: "get_entity",
      description: "只读查询个人本体中的实体、别名和基础元数据。可用 ent: 稳定引用、精确名称或别名定位；返回结果不会修改数据。",
      parameters: {
        type: "object",
        properties: {
          entity: { type: "string", description: "实体名称或别名" },
          id: { type: "string", description: "实体稳定引用，例如 ent:..." },
          kind: { type: "string", description: "可选的实体类型过滤" }
        },
        additionalProperties: false
      }
    },
    async execute(input) {
      const args = objectArgs(input);
      const lookup = lookupEntity(service, ontology, args);
      if (!lookup) return failure("缺少 entity 或 id。");
      if (!lookup.entity) return unknownEntity(lookup.matches);
      const entity = lookup.entity;
      return ok({
        entity: publicEntity(entity),
        aliases: service.store.listEntityAliases(entity.id),
        activeStateCount: service.store.listEntityStates({ entityId: entity.id, activeOnly: true, limit: 1_000 }).length,
        activeRelationCount: service.store.listRelations({ fromEntityId: entity.id, activeOnly: true, limit: 1_000 }).length
          + service.store.listRelations({ toEntityId: entity.id, activeOnly: true, limit: 1_000 }).length
      });
    }
  };
}

function getEntityStateTool({ service, ontology }: PersonalToolDependencies): AgentTool {
  return {
    definition: {
      name: "get_entity_state",
      description: "只读查询某个实体的状态字段及其置信度、有效期和证据。状态冲突时不会静默选边，会同时列出有效状态。",
      parameters: {
        type: "object",
        properties: {
          entity: { type: "string", description: "实体名称或别名" },
          id: { type: "string", description: "实体稳定引用，例如 ent:..." },
          key: { type: "string", description: "可选的状态字段，例如 company、deadline、email" },
          activeOnly: { type: "boolean", description: "只返回当前有效状态，默认 true" },
          limit: { type: "number", description: "最多返回多少个状态，默认 50" }
        },
        additionalProperties: false
      }
    },
    async execute(input) {
      const args = objectArgs(input);
      const lookup = lookupEntity(service, ontology, args);
      if (!lookup) return failure("缺少 entity 或 id。");
      if (!lookup.entity) return unknownEntity(lookup.matches);
      const entity = lookup.entity;
      const key = optionalString(args, "key");
      const activeOnly = booleanArg(args, "activeOnly", true);
      const limit = boundedLimit(args);
      const states = service.store.listEntityStates({
        entityId: entity.id,
        ...(key ? { key } : {}),
        ...(activeOnly ? { activeOnly: true } : {}),
        limit
      });
      return ok({
        entity: publicEntity(entity),
        activeOnly,
        states: states.map((state) => publicState(entity, state))
      });
    }
  };
}

function getRelationsTool({ service, ontology }: PersonalToolDependencies): AgentTool {
  return {
    definition: {
      name: "get_relations",
      description: "只读查询实体的一跳关系。默认合并出边和入边，并返回关系对象的基本信息。",
      parameters: {
        type: "object",
        properties: {
          entity: { type: "string", description: "实体名称或别名" },
          id: { type: "string", description: "实体稳定引用，例如 ent:..." },
          predicate: { type: "string", description: "可选的关系谓词" },
          direction: { type: "string", enum: ["both", "outgoing", "incoming"], description: "查询方向，默认 both" },
          activeOnly: { type: "boolean", description: "只返回当前有效关系，默认 true" },
          limit: { type: "number", description: "最多返回多少条关系，默认 50" }
        },
        additionalProperties: false
      }
    },
    async execute(input) {
      const args = objectArgs(input);
      const lookup = lookupEntity(service, ontology, args);
      if (!lookup) return failure("缺少 entity 或 id。");
      if (!lookup.entity) return unknownEntity(lookup.matches);
      const entity = lookup.entity;
      const predicate = optionalString(args, "predicate");
      const direction = normalizeDirection(optionalString(args, "direction"));
      const activeOnly = booleanArg(args, "activeOnly", true);
      const limit = boundedLimit(args);
      const rows: Array<RelationRecord & { direction: "outgoing" | "incoming" }> = [];
      if (direction !== "incoming") {
        for (const relation of service.store.listRelations({
          fromEntityId: entity.id,
          ...(predicate ? { predicate } : {}),
          ...(activeOnly ? { activeOnly: true } : {}),
          limit
        })) rows.push({ ...relation, direction: "outgoing" });
      }
      if (direction !== "outgoing") {
        for (const relation of service.store.listRelations({
          toEntityId: entity.id,
          ...(predicate ? { predicate } : {}),
          ...(activeOnly ? { activeOnly: true } : {}),
          limit
        })) rows.push({ ...relation, direction: "incoming" });
      }
      const deduped = [...new Map(rows.map((relation) => [relation.id, relation])).values()].slice(0, limit);
      return ok({
        entity: publicEntity(entity),
        relations: deduped.map((relation) => {
          const otherId = relation.direction === "outgoing" ? relation.toEntityId : relation.fromEntityId;
          const other = service.store.getEntity(otherId);
          return {
            ...relation,
            otherEntity: other ? publicEntity(other) : null
          };
        })
      });
    }
  };
}

function getDecisionTool({ service, ontology }: PersonalToolDependencies): AgentTool {
  return {
    definition: {
      name: "get_decision",
      description: "只读查询用户或 Agent 已经做出的决定，可按稳定引用、实体、任务、目标、状态或标题定位。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "决定稳定引用，例如 dec:..." },
          entity: { type: "string", description: "按决定所涉及的实体名称或别名过滤" },
          entityId: { type: "string", description: "按决定所涉及的实体稳定引用过滤" },
          taskId: { type: "string", description: "按任务 ID 过滤" },
          goalId: { type: "string", description: "按目标 ID 过滤" },
          status: { type: "string", enum: ["active", "superseded", "revoked"], description: "决定状态" },
          title: { type: "string", description: "标题包含的文字，不区分大小写" },
          limit: { type: "number", description: "最多返回多少条，默认 50" }
        },
        additionalProperties: false
      }
    },
    async execute(input) {
      const args = objectArgs(input);
      const id = optionalString(args, "id");
      if (id) {
        const decision = service.store.getDecision(id);
        return decision ? ok({ decisions: [decision] }) : failure(`没有找到决定：${id}`, "DECISION_NOT_FOUND");
      }
      let subjectEntityId = optionalString(args, "entityId");
      if (!subjectEntityId && optionalString(args, "entity")) {
        const lookup = lookupEntity(service, ontology, args);
        if (!lookup?.entity) return lookup ? unknownEntity(lookup.matches) : failure("无法解析实体。");
        subjectEntityId = lookup.entity.id;
      }
      const status = optionalString(args, "status");
      const taskId = optionalString(args, "taskId");
      const goalId = optionalString(args, "goalId");
      const title = optionalString(args, "title")?.toLocaleLowerCase();
      const limit = boundedLimit(args);
      let decisions: DecisionRecord[] = service.store.listDecisions({
        ...(status ? { status } : {}),
        ...(taskId ? { taskId } : {}),
        ...(goalId ? { goalId } : {}),
        ...(subjectEntityId ? { subjectEntityId } : {}),
        limit: title ? 1_000 : limit
      });
      if (title) decisions = decisions.filter((decision) => decision.title.toLocaleLowerCase().includes(title)).slice(0, limit);
      return ok({ decisions });
    }
  };
}

function listCommitmentsTool({ service, ontology }: PersonalToolDependencies): AgentTool {
  return {
    definition: {
      name: "list_commitments",
      description: "只读列出承诺及其状态、到期时间和证据。默认只返回开放承诺，避免把已履行或已取消事项当成待办。",
      parameters: {
        type: "object",
        properties: {
          entity: { type: "string", description: "按承诺相关实体名称或别名过滤" },
          entityId: { type: "string", description: "按承诺相关实体稳定引用过滤" },
          status: { type: "string", enum: ["open", "fulfilled", "broken", "cancelled", "expired"], description: "承诺状态，默认 open" },
          includeClosed: { type: "boolean", description: "设为 true 时返回所有状态" },
          dueBefore: { type: "string", description: "只返回该 ISO 时间前到期的承诺" },
          taskId: { type: "string", description: "按任务 ID 过滤" },
          goalId: { type: "string", description: "按目标 ID 过滤" },
          limit: { type: "number", description: "最多返回多少条，默认 50" }
        },
        additionalProperties: false
      }
    },
    async execute(input) {
      const args = objectArgs(input);
      let entityId = optionalString(args, "entityId");
      if (!entityId && optionalString(args, "entity")) {
        const lookup = lookupEntity(service, ontology, args);
        if (!lookup?.entity) return lookup ? unknownEntity(lookup.matches) : failure("无法解析实体。");
        entityId = lookup.entity.id;
      }
      const includeClosed = booleanArg(args, "includeClosed", false);
      const status = optionalString(args, "status") ?? (includeClosed ? undefined : "open");
      const dueBefore = optionalString(args, "dueBefore");
      const taskId = optionalString(args, "taskId");
      const goalId = optionalString(args, "goalId");
      const limit = boundedLimit(args);
      let commitments: CommitmentRecord[] = service.store.listCommitments({
        ...(status ? { status } : {}),
        ...(dueBefore ? { dueBefore } : {}),
        ...(taskId ? { taskId } : {}),
        ...(goalId ? { goalId } : {}),
        limit: entityId ? 1_000 : limit
      });
      if (entityId) {
        commitments = commitments
          .filter((commitment) => commitment.entityId === entityId || commitment.counterpartyEntityId === entityId)
          .slice(0, limit);
      }
      return ok({
        commitments: commitments.map((commitment) => {
          const entity = commitment.entityId ? service.store.getEntity(commitment.entityId) : null;
          const counterparty = commitment.counterpartyEntityId ? service.store.getEntity(commitment.counterpartyEntityId) : null;
          return {
            ...commitment,
            entity: entity ? publicEntity(entity) : null,
            counterparty: counterparty ? publicEntity(counterparty) : null
          };
        })
      });
    }
  };
}

function lookupEntity(service: HearthService, ontology: OntologyService, args: Record<string, unknown>): EntityLookup | null {
  const id = optionalString(args, "id") ?? optionalString(args, "entityId");
  if (id) {
    const entity = service.store.getEntity(id) ?? ontology.findEntityByMention(id, entityKind(args));
    return { entity, matches: entity ? [entity] : [] };
  }
  const query = optionalString(args, "entity");
  if (!query) return null;
  const kind = entityKind(args);
  const exact = [
    ...service.store.findEntitiesByName(query, kind),
    ...service.store.findEntitiesByAlias(normalizeEntityText(query), kind)
  ];
  const uniqueExact = dedupeEntities(exact);
  if (uniqueExact.length > 0) return { entity: uniqueExact.length === 1 ? uniqueExact[0] ?? null : null, matches: uniqueExact };
  const normalized = normalizeEntityText(query);
  const matches = service.store.listEntities({ ...(kind ? { kind } : {}), status: "active", limit: 2_000 })
    .filter((entity) => {
      if (normalizeEntityText(entity.canonicalName).includes(normalized)) return true;
      return service.store.listEntityAliases(entity.id).some((alias) => alias.normalized.includes(normalized));
    })
    .slice(0, MAX_RESULTS);
  return { entity: matches.length === 1 ? matches[0] ?? null : null, matches };
}

function dedupeEntities(entities: EntityRecord[]): EntityRecord[] {
  return [...new Map(entities.map((entity) => [entity.id, entity])).values()];
}

function entityKind(args: Record<string, unknown>): EntityKind | undefined {
  const value = optionalString(args, "kind");
  return value && ENTITY_KINDS.has(value) ? value as EntityKind : undefined;
}

function normalizeDirection(value: string | undefined): "both" | "outgoing" | "incoming" {
  return value === "outgoing" || value === "incoming" ? value : "both";
}

function publicEntity(entity: EntityRecord): EntityRecord {
  return { ...entity };
}

function publicState(entity: EntityRecord, state: EntityStateRecord): Record<string, unknown> {
  const redacted = entity.sensitivity === "secret";
  return {
    ...state,
    value: redacted ? null : state.value,
    redacted: redacted ? "secret" : null
  };
}

function boundedLimit(args: Record<string, unknown>): number {
  return Math.max(1, Math.min(MAX_RESULTS, integerArg(args, "limit", MAX_RESULTS)));
}

function integerArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function booleanArg(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectArgs(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function ok(payload: unknown): AgentToolResult {
  return { content: render(payload) };
}

function failure(message: string, code = "INVALID_ARGUMENT"): AgentToolResult {
  return { content: JSON.stringify({ error: code, message }, null, 2), isError: true };
}

function unknownEntity(matches: EntityRecord[]): AgentToolResult {
  if (matches.length === 0) return failure("没有找到匹配的实体。", "ENTITY_NOT_FOUND");
  return {
    content: JSON.stringify({
      error: "ENTITY_AMBIGUOUS",
      message: "匹配到多个实体，请使用 id 指定其中一个。",
      candidates: matches.map((entity) => publicEntity(entity))
    }, null, 2),
    isError: true
  };
}

function render(payload: unknown): string {
  const text = JSON.stringify(payload, null, 2);
  if (text.length <= MAX_CONTENT_CHARS) return text;
  return JSON.stringify({
    truncated: true,
    note: `结果超过 ${MAX_CONTENT_CHARS} 字符，请缩小查询范围或降低 limit。`,
    preview: text.slice(0, MAX_CONTENT_CHARS)
  }, null, 2);
}
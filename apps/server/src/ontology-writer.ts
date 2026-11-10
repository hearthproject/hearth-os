import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ApprovalRecord, ChatMessageRecord, SourceItem, TaskRecord } from "@hearth/core";
import type { HearthService } from "./service.ts";
import type { OntologyService } from "./ontology.ts";

export interface WritebackResult {
  entitiesCreated: number;
  statesRecorded: number;
  decisionsRecorded: number;
  commitmentsRecorded: number;
  conflicts: number;
}

export class OntologyWriter {
  constructor(
    private readonly service: HearthService,
    private readonly ontology: OntologyService
  ) {}

  captureTaskOutcome(taskId: string): WritebackResult {
    const result = emptyResult();
    const task = this.service.store.getTask(taskId);
    if (!task) return result;
    const taskRef = `task:${task.id}`;
    const taskEntity = this.ontology.ensureEntity({
      kind: "task",
      name: task.title,
      aliases: [task.id],
      confidence: "observed",
      sourceKind: "task",
      evidenceRef: taskRef
    });
    result.entitiesCreated += taskEntity.createdAt === taskEntity.updatedAt ? 1 : 0;
    const state = this.ontology.recordState({
      entityId: taskEntity.id,
      key: "status",
      value: task.status,
      confidence: "observed",
      sourceRef: taskRef,
      evidenceRefs: [taskRef]
    });
    result.statesRecorded += 1;
    if (state.conflict) result.conflicts += 1;
    if (task.resultSummary?.trim()) {
      const summaryState = this.ontology.recordState({
        entityId: taskEntity.id,
        key: "latest_result",
        value: task.resultSummary.trim().slice(0, 1000),
        confidence: "observed",
        sourceRef: taskRef,
        evidenceRefs: [taskRef]
      });
      result.statesRecorded += 1;
      if (summaryState.conflict) result.conflicts += 1;
    }
    if (task.goalId) {
      const goal = this.service.store.getGoal(task.goalId);
      if (goal) {
        const goalEntity = this.ontology.ensureEntity({
          kind: "goal",
          name: goal.title,
          aliases: [goal.goalId],
          confidence: "confirmed",
          sourceKind: "goal",
          evidenceRef: `goal:${goal.goalId}`
        });
        this.ontology.recordRelation({
          fromEntityId: taskEntity.id,
          predicate: "serves_goal",
          toEntityId: goalEntity.id,
          confidence: "confirmed",
          evidenceRefs: [taskRef, `goal:${goal.goalId}`]
        });
      }
    }
    for (const artifact of this.service.store.listArtifacts(taskId)) {
      const artifactEntity = this.ontology.ensureEntity({
        kind: "artifact",
        name: artifact.relativePath,
        aliases: [artifact.id, artifact.absolutePath],
        confidence: "confirmed",
        sourceKind: "artifact",
        evidenceRef: `artifact:${artifact.id}`
      });
      this.ontology.recordRelation({
        fromEntityId: taskEntity.id,
        predicate: "produced",
        toEntityId: artifactEntity.id,
        confidence: "confirmed",
        evidenceRefs: [`artifact:${artifact.id}`]
      });
    }
    for (const input of task.inputs) {
      if (input.kind !== "source" || !input.source) continue;
      const sourceEntity = this.ontology.ensureEntity({
        kind: "document",
        name: input.source.title || input.label,
        aliases: [input.source.itemKey, input.source.itemId, input.source.locator],
        confidence: "observed",
        sourceKind: "source",
        evidenceRef: `src:${input.source.itemId}`
      });
      this.ontology.recordRelation({
        fromEntityId: taskEntity.id,
        predicate: "uses_source",
        toEntityId: sourceEntity.id,
        confidence: "observed",
        evidenceRefs: [`src:${input.source.itemId}`]
      });
    }
    return result;
  }

  captureApprovalDecision(approval: ApprovalRecord): WritebackResult {
    const result = emptyResult();
    if (!["approved", "consumed", "rejected", "revoked"].includes(approval.status)) return result;
    const eventRef = `approval:${approval.id}`;
    const targets = extractTargetNames(approval.target);
    let subjectEntityId: string | null = null;
    for (const target of targets) {
      const entity = this.ontology.ensureEntity({
        kind: "topic",
        name: target,
        confidence: "observed",
        sourceKind: "approval",
        evidenceRef: eventRef
      });
      subjectEntityId ??= entity.id;
    }
    this.ontology.recordDecision({
      title: approval.summary,
      decision: approval.status === "approved" || approval.status === "consumed" ? "approved" : approval.status === "rejected" ? "rejected" : "revoked",
      decidedBy: "user",
      evidenceRefs: [eventRef],
      subjectEntityId,
      goalId: approval.goalId ?? null,
      taskId: approval.taskId,
      rationale: approval.rejectionCount ? `历史拒绝次数：${approval.rejectionCount}` : null
    });
    result.decisionsRecorded += 1;
    return result;
  }

  captureChatTurn(message: ChatMessageRecord): WritebackResult {
    const result = emptyResult();
    if (message.role !== "user") return result;
    const eventRef = `chat:${message.id}`;
    const text = message.content.trim();
    if (!text) return result;
    if (isExplicitConfirmation(text)) {
      this.ontology.recordDecision({
        title: `对话确认：${text.slice(0, 80)}`,
        decision: text.slice(0, 2000),
        decidedBy: "user",
        evidenceRefs: [eventRef],
        taskId: message.taskId ?? null,
        supersedeSameSubject: true
      });
      result.decisionsRecorded += 1;
    }
    const commitment = extractCommitment(text);
    if (commitment) {
      this.ontology.recordCommitment({
        description: commitment.description,
        dueAt: commitment.dueAt,
        confidence: isExplicitConfirmation(text) ? "confirmed" : "inferred",
        evidenceRefs: [eventRef],
        taskId: message.taskId ?? null,
        sourceRef: eventRef
      });
      result.commitmentsRecorded += 1;
    }
    return result;
  }

  captureSourceItem(item: SourceItem, text?: string | null): WritebackResult {
    const result = emptyResult();
    const sourceRef = `src:${item.id}`;
    const content = text ?? readSourceText(item);
    const entity = this.ontology.ensureEntity({
      kind: "document",
      name: item.title || item.label,
      aliases: [item.itemKey, item.id, item.locator],
      confidence: "observed",
      sourceKind: "source",
      evidenceRef: sourceRef
    });
    result.entitiesCreated += entity.createdAt === entity.updatedAt ? 1 : 0;
    const state = this.ontology.recordState({
      entityId: entity.id,
      key: "source_status",
      value: item.status,
      confidence: "observed",
      sourceRef,
      evidenceRefs: [sourceRef]
    });
    result.statesRecorded += 1;
    if (state.conflict) result.conflicts += 1;
    if (content) {
      const emails = [...new Set(content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])].slice(0, 20);
      for (const email of emails) {
        const person = this.ontology.ensureEntity({
          kind: "person",
          name: email,
          aliases: [email],
          confidence: "observed",
          sourceKind: "source",
          evidenceRef: sourceRef
        });
        this.ontology.recordRelation({
          fromEntityId: person.id,
          predicate: "mentioned_in",
          toEntityId: entity.id,
          confidence: "observed",
          evidenceRefs: [sourceRef]
        });
      }
      const commitment = extractCommitment(content);
      if (commitment) {
        this.ontology.recordCommitment({
          description: commitment.description,
          dueAt: commitment.dueAt,
          confidence: "observed",
          evidenceRefs: [sourceRef],
          entityId: entity.id,
          sourceRef
        });
        result.commitmentsRecorded += 1;
      }
    }
    return result;
  }

  userCorrects(input: {
    entityId: string;
    key: string;
    value: unknown;
    evidenceRef: string;
    taskId?: string | null;
  }): WritebackResult {
    const result = emptyResult();
    const recorded = this.ontology.recordState({
      entityId: input.entityId,
      key: input.key,
      value: input.value,
      confidence: "confirmed",
      sourceRef: input.evidenceRef,
      evidenceRefs: [input.evidenceRef],
      supersede: true
    });
    result.statesRecorded += 1;
    if (recorded.conflict) result.conflicts += 1;
    this.ontology.recordDecision({
      title: `用户纠正：${input.key}`,
      decision: JSON.stringify(input.value),
      decidedBy: "user",
      evidenceRefs: [input.evidenceRef],
      subjectEntityId: input.entityId,
      taskId: input.taskId ?? null
    });
    result.decisionsRecorded += 1;
    return result;
  }

  forget(sourceRef: string): WritebackResult & { propagation: ReturnType<OntologyService["forgetEvidence"]> } {
    const propagation = this.ontology.forgetEvidence(sourceRef);
    return { ...emptyResult(), propagation };
  }
}

function emptyResult(): WritebackResult {
  return { entitiesCreated: 0, statesRecorded: 0, decisionsRecorded: 0, commitmentsRecorded: 0, conflicts: 0 };
}

function extractTargetNames(target: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const key of ["to", "recipient", "subject", "title", "path", "repo", "url", "target", "name"]) {
    const value = target[key];
    if (typeof value === "string" && value.trim()) names.push(value.trim().slice(0, 120));
  }
  return [...new Set(names)].slice(0, 5);
}

function isExplicitConfirmation(text: string): boolean {
  return /^(对|是的|对，|好，|好的|可以|就这个|确认|没错|同意|以后都这样|记住|按这个来)/.test(text.trim());
}

function extractCommitment(text: string): { description: string; dueAt: string | null } | null {
  if (!/(?:前|之前|截止|明天|后天|周[一二三四五六日天]|下周|月底|完成|发送|提交|回复|准备)/.test(text)) return null;
  if (!/(?:要|需要|请|帮我|记得|承诺|会|完成|发送|提交|回复|准备)/.test(text)) return null;
  const sentence = text.split(/[。！？\n]/).find((part) => /(?:前|之前|截止|明天|后天|周[一二三四五六日天]|下周|月底|完成|发送|提交|回复|准备)/.test(part));
  const description = sentence?.trim().slice(0, 200);
  if (!description) return null;
  return { description, dueAt: parseRelativeDue(description) };
}

function parseRelativeDue(text: string): string | null {
  const now = new Date();
  const isoDay = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (isoDay) {
    const date = new Date(Number(isoDay[1]), Number(isoDay[2]) - 1, Number(isoDay[3]), 18, 0, 0);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (/明天/.test(text)) { const date = new Date(now); date.setDate(date.getDate() + 1); date.setHours(18, 0, 0, 0); return date.toISOString(); }
  if (/后天/.test(text)) { const date = new Date(now); date.setDate(date.getDate() + 2); date.setHours(18, 0, 0, 0); return date.toISOString(); }
  const week = text.match(/(?:下)?周([一二三四五六日天])/);
  if (week) {
    const day = week[1] ?? "";
    const target = "一二三四五六日".indexOf(day === "天" ? "日" : day);
    const date = new Date(now);
    const delta = (target + 7 - date.getDay()) % 7 + (/下周/.test(text) ? 7 : 0);
    date.setDate(date.getDate() + (delta || 7));
    date.setHours(18, 0, 0, 0);
    return date.toISOString();
  }
  return null;
}

function readSourceText(item: SourceItem): string | null {
  if (!item.contentPath || !existsSync(item.contentPath)) return null;
  try {
    return readFileSync(item.contentPath, "utf8").slice(0, 200_000);
  } catch {
    return null;
  }
}

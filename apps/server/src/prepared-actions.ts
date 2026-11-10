import { createHash, randomUUID } from "node:crypto";
import type { ApprovalRecord, PreparedActionRecord } from "@hearth/core";
import type { HearthService } from "./service.ts";

export interface PrepareActionInput {
  taskId?: string | null;
  goalId?: string | null;
  kind: PreparedActionRecord["kind"];
  preview: Record<string, unknown>;
  evidenceRefs: string[];
  actionDigest?: string;
  expiresAt?: string | null;
}

export class PreparedActionError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "PreparedActionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const EXTERNAL_KINDS = new Set<PreparedActionRecord["kind"]>(["draft_email", "calendar_check"]);

export class PreparedActionService {
  constructor(private readonly service: HearthService, private readonly now: () => Date = () => new Date()) {}

  prepare(input: PrepareActionInput): PreparedActionRecord {
    if (!input.evidenceRefs.length) {
      throw new PreparedActionError("PREPARED_ACTION_EVIDENCE_REQUIRED", "预备动作必须引用证据");
    }
    if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) {
      throw new PreparedActionError("PREPARED_ACTION_EXPIRY_INVALID", "过期时间格式不正确");
    }
    const now = this.now();
    const record: PreparedActionRecord = {
      id: `pa:${randomUUID()}`,
      taskId: input.taskId ?? null,
      goalId: input.goalId ?? null,
      kind: input.kind,
      actionDigest: input.actionDigest ?? digest({ kind: input.kind, preview: input.preview }),
      preview: input.preview,
      status: "prepared",
      expiresAt: input.expiresAt ?? new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
      evidenceRefs: [...new Set(input.evidenceRefs)],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.persist(record);
    return record;
  }

  commit(id: string, input: { approvalRef?: string; evidenceRefs?: string[] } = {}): PreparedActionRecord {
    const record = this.require(id);
    if (record.status !== "prepared") {
      throw new PreparedActionError("PREPARED_ACTION_NOT_COMMITTABLE", `预备动作当前状态：${record.status}`, 409);
    }
    if (record.expiresAt && Date.parse(record.expiresAt) <= this.now().getTime()) {
      const expired = this.transition(record, "expired");
      throw new PreparedActionError("PREPARED_ACTION_EXPIRED", `预备动作已过期：${expired.id}`, 409);
    }
    if (EXTERNAL_KINDS.has(record.kind)) {
      const approvalRef = input.approvalRef?.trim();
      if (!approvalRef) {
        throw new PreparedActionError("PREPARED_ACTION_APPROVAL_REQUIRED", "外部动作必须先取得审批引用，预备动作本身不构成授权", 409);
      }
      const approval = this.service.store.getApproval(approvalRef);
      if (!approval || !["approved", "consumed"].includes(approval.status)) {
        throw new PreparedActionError("PREPARED_ACTION_APPROVAL_INVALID", "审批引用不存在或尚未批准", 409);
      }
      if (record.taskId && approval.taskId !== record.taskId) {
        throw new PreparedActionError("PREPARED_ACTION_APPROVAL_TASK_MISMATCH", "审批不属于该预备动作所在任务", 409);
      }
      if (!approvalMatchesPreparedAction(approval, record)) {
        throw new PreparedActionError(
          "PREPARED_ACTION_APPROVAL_MISMATCH",
          "审批没有绑定到这个预备动作及其精确参数，不能复用其他动作的审批",
          409
        );
      }
    }
    return this.transition(record, "committed", input.evidenceRefs ?? []);
  }

  discard(id: string, reason = "用户放弃"): PreparedActionRecord {
    const record = this.require(id);
    if (record.status !== "prepared") return record;
    return this.transition(record, "discarded", [], reason);
  }

  expireStale(): PreparedActionRecord[] {
    const now = this.now().getTime();
    const expired: PreparedActionRecord[] = [];
    for (const record of this.service.store.listPreparedActions({ status: "prepared", limit: 500 })) {
      if (record.expiresAt && Date.parse(record.expiresAt) <= now) expired.push(this.transition(record, "expired"));
    }
    return expired;
  }

  list(opts: { taskId?: string; status?: string; limit?: number } = {}): PreparedActionRecord[] {
    return this.service.store.listPreparedActions(opts);
  }

  get(id: string): PreparedActionRecord | null {
    return this.service.store.getPreparedAction(id);
  }

  private transition(record: PreparedActionRecord, status: PreparedActionRecord["status"], evidenceRefs: string[] = [], _reason?: string): PreparedActionRecord {
    const updated: PreparedActionRecord = {
      ...record,
      status,
      evidenceRefs: [...new Set([...record.evidenceRefs, ...evidenceRefs])],
      updatedAt: this.now().toISOString()
    };
    this.persist(updated);
    return updated;
  }

  private persist(record: PreparedActionRecord): void {
    const event = this.service.store.appendEvent({
      type: "prepared-action.updated",
      taskId: record.taskId,
      payload: record
    });
    this.service.bus.publish(event);
  }

  private require(id: string): PreparedActionRecord {
    const record = this.service.store.getPreparedAction(id);
    if (!record) throw new PreparedActionError("PREPARED_ACTION_NOT_FOUND", "预备动作不存在", 404);
    return record;
  }
}

function approvalMatchesPreparedAction(approval: ApprovalRecord, record: PreparedActionRecord): boolean {
  if (approval.actionDigest && approval.actionDigest === record.actionDigest) return true;
  if (
    approval.target.preparedActionId === record.id
    && approval.target.actionDigest === record.actionDigest
  ) return true;
  if (
    approval.preview.preparedActionId === record.id
    && approval.preview.actionDigest === record.actionDigest
  ) return true;
  if (record.kind === "draft_email") {
    const draftId = typeof record.preview.outboxDraftId === "string"
      ? record.preview.outboxDraftId
      : typeof record.preview.draftId === "string" ? record.preview.draftId : null;
    if (draftId && approval.target.draftId === draftId) return true;
  }
  return false;
}

function digest(preview: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(preview)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
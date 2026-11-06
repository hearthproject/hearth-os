import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { ApprovalRecord, EffectRecord, OutboxAttachment, OutboxDraft, RunRecord, TaskRecord } from "@hearth/core";
import { ApprovalManager } from "./approvals.ts";
import { WORKSPACE_DIR } from "./config.ts";
import type { HearthService } from "./service.ts";

const OUTBOX_APPROVAL_TTL_MS = 10 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface OutboxDraftInput {
  account?: string | undefined;
  to?: string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  attachmentIds?: string[] | undefined;
}

export interface OutboxSubmitResult {
  draft: OutboxDraft;
  approval: ApprovalRecord;
  task: TaskRecord;
}

export class OutboxError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "OutboxError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class OutboxService {
  private readonly service: HearthService;
  private readonly approvals: ApprovalManager;
  private readonly workspaceRoot: string;

  constructor(service: HearthService, approvals: ApprovalManager, workspaceRoot = WORKSPACE_DIR) {
    this.service = service;
    this.approvals = approvals;
    this.workspaceRoot = workspaceRoot;
  }

  list(): OutboxDraft[] {
    return this.service.store.listOutboxDrafts();
  }

  get(id: string): OutboxDraft {
    const draft = this.service.store.getOutboxDraft(id);
    if (!draft) throw new OutboxError("OUTBOX_DRAFT_NOT_FOUND", "发件箱草稿不存在", 404);
    return draft;
  }

  create(input: OutboxDraftInput): OutboxDraft {
    const now = new Date().toISOString();
    const draft: OutboxDraft = {
      id: randomUUID(),
      account: normalizeAccount(input.account),
      to: normalizeAddresses(input.to, "收件人"),
      cc: normalizeAddresses(input.cc, "抄送"),
      bcc: normalizeAddresses(input.bcc, "密送"),
      subject: normalizeText(input.subject, 500, "主题"),
      body: normalizeText(input.body, 200_000, "正文"),
      attachments: this.resolveAttachments(input.attachmentIds ?? []),
      status: "draft",
      taskId: null,
      approvalId: null,
      effectId: null,
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      discardedAt: null
    };
    return this.service.createOutboxDraft(draft);
  }

  update(id: string, input: OutboxDraftInput): OutboxDraft {
    const current = this.get(id);
    if (current.status !== "draft" && current.status !== "rejected") {
      throw new OutboxError("OUTBOX_DRAFT_LOCKED", "只有草稿或已拒绝的草稿可以修改", 409);
    }
    const now = new Date().toISOString();
    return this.service.updateOutboxDraft(id, {
      account: input.account === undefined ? current.account : normalizeAccount(input.account),
      to: input.to === undefined ? current.to : normalizeAddresses(input.to, "收件人"),
      cc: input.cc === undefined ? current.cc : normalizeAddresses(input.cc, "抄送"),
      bcc: input.bcc === undefined ? current.bcc : normalizeAddresses(input.bcc, "密送"),
      subject: input.subject === undefined ? current.subject : normalizeText(input.subject, 500, "主题"),
      body: input.body === undefined ? current.body : normalizeText(input.body, 200_000, "正文"),
      attachments: input.attachmentIds === undefined ? current.attachments : this.resolveAttachments(input.attachmentIds),
      status: "draft",
      taskId: null,
      approvalId: null,
      effectId: null,
      updatedAt: now,
      submittedAt: null,
      discardedAt: null
    });
  }

  discard(id: string): OutboxDraft {
    const current = this.get(id);
    if (!["draft", "rejected", "failed"].includes(current.status)) {
      throw new OutboxError("OUTBOX_DRAFT_LOCKED", "正在审批或已经写入的草稿不能丢弃", 409);
    }
    return this.service.updateOutboxDraft(id, {
      status: "discarded",
      updatedAt: new Date().toISOString(),
      discardedAt: new Date().toISOString()
    });
  }

  submit(id: string): OutboxSubmitResult {
    const draft = this.get(id);
    if (draft.status !== "draft" && draft.status !== "rejected") {
      throw new OutboxError("OUTBOX_DRAFT_LOCKED", "只有草稿或已拒绝的草稿可以提交审批", 409);
    }
    this.assertComplete(draft);

    const task = this.service.createTask({
      title: `本地发件箱：${draft.subject}`,
      goal: `审批草稿“${draft.subject}”，批准后只写入本机发件箱，不连接邮件服务器。`
    });
    const now = new Date().toISOString();
    const runId = randomUUID();
    const run: RunRecord = {
      id: runId,
      taskId: task.id,
      attempt: 1,
      status: "waiting_approval",
      threadId: null,
      workspace: join(this.workspaceRoot, runId),
      startedAt: now,
      endedAt: now,
      failure: null,
      usage: null,
      leaseEpoch: null,
      createdAt: now
    };

    try {
      this.service.createRun(run);
      this.service.updateTask(task.id, {
        status: "running",
        currentRunId: runId,
        nextAction: "准备本地发件箱审批",
        error: null
      }, runId);
      this.service.updateTask(task.id, {
        status: "waiting_approval",
        currentRunId: runId,
        nextAction: "等待你确认写入本地发件箱",
        error: null
      }, runId);

      const approval = this.approvals.request({
        taskId: task.id,
        runId,
        kind: "outbox.local-write",
        summary: `将“${draft.subject}”写入本地发件箱（不会发送）`,
        target: {
          draftId: draft.id,
          account: draft.account,
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          body: draft.body,
          attachments: draft.attachments,
          transport: "local-outbox"
        },
        preview: {
          title: draft.subject,
          body: draft.body,
          account: draft.account,
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          attachments: draft.attachments,
          impact: "只写入本机 .hearth/outbox，不连接邮件服务器，也不会发送给收件人。",
          reversible: true,
          undo: "删除对应本地发件箱文件即可撤销；不会影响任何外部账户。"
        },
        ttlMs: OUTBOX_APPROVAL_TTL_MS
      });

      const submitted = this.service.updateOutboxDraft(draft.id, {
        status: "pending_approval",
        taskId: task.id,
        approvalId: approval.id,
        effectId: null,
        submittedAt: now,
        updatedAt: now
      });
      return { draft: submitted, approval, task: this.service.requireTask(task.id) };
    } catch (error) {
      const latestTask = this.service.store.getTask(task.id);
      if (latestTask && latestTask.status !== "cancelled" && latestTask.status !== "completed") {
        this.service.updateTask(task.id, {
          status: "cancelled",
          currentRunId: runId,
          nextAction: null,
          error: null
        }, runId);
      }
      this.service.updateOutboxDraft(draft.id, { status: "draft", updatedAt: new Date().toISOString() });
      throw error;
    }
  }

  reconcileApproval(approvalId: string): OutboxDraft | null {
    const approval = this.service.store.getApproval(approvalId);
    if (!approval || approval.kind !== "outbox.local-write") return null;
    const draftId = approval.target.draftId;
    if (typeof draftId !== "string") return null;
    const draft = this.service.store.getOutboxDraft(draftId);
    if (!draft || draft.approvalId !== approval.id) return null;

    if (approval.status === "pending") return draft;
    if (approval.status === "expired") {
      return this.service.updateOutboxDraft(draft.id, {
        status: "draft",
        taskId: null,
        approvalId: null,
        effectId: null,
        updatedAt: new Date().toISOString(),
        submittedAt: null
      });
    }
    if (approval.status === "rejected") {
      return this.service.updateOutboxDraft(draft.id, {
        status: "rejected",
        taskId: approval.taskId,
        approvalId: approval.id,
        effectId: null,
        updatedAt: new Date().toISOString()
      });
    }

    const effect = approval.effectId ? this.service.store.getEffect(approval.effectId) : null;
    const status = effectStatusToDraftStatus(effect);
    return this.service.updateOutboxDraft(draft.id, {
      status,
      taskId: approval.taskId,
      approvalId: approval.id,
      effectId: effect?.id ?? null,
      updatedAt: new Date().toISOString()
    });
  }

  reconcileTask(taskId: string): OutboxDraft[] {
    return this.service.store
      .listApprovals(taskId)
      .filter((approval) => approval.kind === "outbox.local-write")
      .map((approval) => this.reconcileApproval(approval.id))
      .filter((draft): draft is OutboxDraft => draft !== null);
  }

  private assertComplete(draft: OutboxDraft): void {
    if (draft.to.length === 0) throw new OutboxError("OUTBOX_RECIPIENT_REQUIRED", "提交审批前至少需要一个收件人", 400);
    if (!draft.subject.trim()) throw new OutboxError("OUTBOX_SUBJECT_REQUIRED", "提交审批前需要填写主题", 400);
    if (!draft.body.trim()) throw new OutboxError("OUTBOX_BODY_REQUIRED", "提交审批前需要填写正文", 400);
    for (const address of [...draft.to, ...draft.cc, ...draft.bcc]) {
      if (!EMAIL_PATTERN.test(address)) throw new OutboxError("OUTBOX_INVALID_ADDRESS", `邮箱地址格式不正确：${address}`, 400);
    }
    for (const attachment of draft.attachments) {
      const artifact = this.service.store.getArtifact(attachment.artifactId);
      if (!artifact || artifact.sha256 !== attachment.sha256 || !existsSync(artifact.absolutePath)) {
        throw new OutboxError("OUTBOX_ATTACHMENT_UNAVAILABLE", `附件已不可用：${attachment.name}`, 409);
      }
    }
  }

  private resolveAttachments(artifactIds: string[]): OutboxAttachment[] {
    const attachments: OutboxAttachment[] = [];
    const seen = new Set<string>();
    for (const artifactId of artifactIds) {
      if (seen.has(artifactId)) continue;
      seen.add(artifactId);
      const artifact = this.service.store.getArtifact(artifactId);
      if (!artifact) throw new OutboxError("OUTBOX_ATTACHMENT_NOT_FOUND", "选择的附件不存在", 404);
      attachments.push({
        artifactId: artifact.id,
        name: basename(artifact.relativePath),
        mimeType: artifact.mimeType,
        sha256: artifact.sha256,
        bytes: artifact.bytes
      });
    }
    if (attachments.length > 20) throw new OutboxError("OUTBOX_TOO_MANY_ATTACHMENTS", "一次最多附加 20 个文件", 400);
    return attachments;
  }
}

export function outboxDraftIdFromApproval(approval: ApprovalRecord): string | null {
  return typeof approval.target.draftId === "string" ? approval.target.draftId : null;
}

function normalizeAccount(value: string | undefined): string {
  return normalizeText(value, 200, "账户") || "local-outbox";
}

function normalizeAddresses(values: string[] | undefined, label: string): string[] {
  if (!values) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const address = value.trim();
    if (!address) continue;
    if (address.length > 320) throw new OutboxError("OUTBOX_INVALID_ADDRESS", `${label}地址过长`, 400);
    if (/[\r\n]/.test(address)) throw new OutboxError("OUTBOX_INVALID_ADDRESS", `${label}地址不能包含换行`, 400);
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(address);
  }
  if (normalized.length > 50) throw new OutboxError("OUTBOX_TOO_MANY_RECIPIENTS", `${label}一次最多 50 个地址`, 400);
  return normalized;
}

function normalizeText(value: string | undefined, maxLength: number, label: string): string {
  if (value === undefined) return "";
  if (value.length > maxLength) throw new OutboxError("OUTBOX_TEXT_TOO_LONG", `${label}超过 ${maxLength} 个字符`, 400);
  return value;
}

function effectStatusToDraftStatus(effect: EffectRecord | null): OutboxDraft["status"] {
  if (!effect) return "failed";
  if (effect.status === "succeeded") return "stored";
  if (effect.status === "uncertain") return "uncertain";
  return "failed";
}


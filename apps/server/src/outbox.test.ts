import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { ApprovalManager } from "./approvals.ts";
import { OutboxService } from "./outbox.ts";
import { HearthService } from "./service.ts";
import type { EmailService } from "./email.ts";

describe("outbox service", () => {
  let store: HearthStore;
  let service: HearthService;
  let outbox: OutboxService;
  let approvals: ApprovalManager;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    approvals = new ApprovalManager(service, async () => ({}));
    outbox = new OutboxService(service, approvals, "C:/tmp/outbox-runs");
  });

  afterEach(() => store.close());

  it("saves, edits, and discards a draft without creating a task", () => {
    const draft = outbox.create({ subject: "Draft", body: "First version" });
    expect(draft.status).toBe("draft");
    expect(service.store.listTasks()).toHaveLength(0);

    const updated = outbox.update(draft.id, {
      to: ["reviewer@example.test"],
      body: "Second version"
    });
    expect(updated.body).toBe("Second version");
    expect(updated.to).toEqual(["reviewer@example.test"]);

    expect(outbox.discard(draft.id).status).toBe("discarded");
    expect(() => outbox.update(draft.id, { body: "Nope" })).toThrowError(expect.objectContaining({ code: "OUTBOX_DRAFT_LOCKED" }));
  });

  it("creates one short-lived approval and a cancelled integrity task on rejection", async () => {
    const draft = outbox.create({
      account: "local-test",
      to: ["reviewer@example.test"],
      subject: "Weekly update",
      body: "The local outbox does not send mail."
    });

    const submitted = await outbox.submit(draft.id);
    expect(submitted.draft.status).toBe("pending_approval");
    expect(submitted.approval.kind).toBe("outbox.local-write");
    expect(submitted.approval.target.draftId).toBe(draft.id);
    expect(submitted.approval.preview.delivery).toBeUndefined();
    expect(submitted.approval.preview.impact).toContain("不会发送");
    const ttl = Date.parse(submitted.approval.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(service.requireTask(submitted.task.id).status).toBe("waiting_approval");

    const decision = await approvals.decide(submitted.approval.id, "reject", submitted.approval.parameterHash);
    const reconciled = outbox.reconcileApproval(decision.approval.id);
    expect(reconciled?.status).toBe("rejected");
    expect(decision.effect).toBeNull();

    const editable = outbox.update(draft.id, { body: "A revised draft" });
    expect(editable.status).toBe("draft");
    expect(editable.approvalId).toBeNull();
  });


  it("creates a real-send approval for an SMTP account and reconciles it as sent", async () => {
    const mail = {
      accounts: {
        get: (id: string) => ({
          id,
          name: "工作邮箱",
          fromName: "Hearth",
          fromAddress: "sender@example.com",
          smtp: { host: "smtp.example.com" }
        })
      }
    } as unknown as EmailService;
    const smtpOutbox = new OutboxService(service, approvals, "C:/tmp/outbox-runs", mail);
    const draft = smtpOutbox.create({
      account: "smtp:acct-1",
      to: ["reviewer@example.test"],
      subject: "Weekly update",
      body: "This one should really send."
    });

    const submitted = await smtpOutbox.submit(draft.id);
    expect(submitted.approval.kind).toBe("email.smtp-send");
    expect(submitted.approval.preview.impact).toContain("真实发送");
    expect(submitted.approval.preview.reversible).toBe(false);
    expect(submitted.approval.target).toMatchObject({
      accountId: "acct-1",
      from: "sender@example.com",
      transport: "smtp"
    });
    expect(submitted.approval.actionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(submitted.approval.action).toMatchObject({
      resolvedAction: {
        kind: "email",
        network: { host: "smtp.example.com", method: "SMTP" },
        targetRevision: expect.stringMatching(/^draft-sha256:[a-f0-9]{64}$/),
        risk: "high",
        sideEffectClass: "external_irreversible"
      }
    });
    expect(service.requireTask(submitted.task.id).status).toBe("waiting_approval");

    const decision = await approvals.decide(submitted.approval.id, "approve", submitted.approval.parameterHash);
    expect(decision.effect?.kind).toBe("email.smtp-send");
    expect(smtpOutbox.reconcileApproval(submitted.approval.id)?.status).toBe("sent");
  });

  it("requires a recipient, subject, and body before approval", async () => {
    const draft = outbox.create({ subject: "Incomplete" });
    await expect(outbox.submit(draft.id)).rejects.toMatchObject({ code: "OUTBOX_RECIPIENT_REQUIRED" });

    const withRecipient = outbox.update(draft.id, { to: ["reviewer@example.test"] });
    expect(withRecipient.status).toBe("draft");
    await expect(outbox.submit(draft.id)).rejects.toMatchObject({ code: "OUTBOX_BODY_REQUIRED" });
  });
});

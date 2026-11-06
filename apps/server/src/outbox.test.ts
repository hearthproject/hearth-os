import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { ApprovalManager } from "./approvals.ts";
import { OutboxService } from "./outbox.ts";
import { HearthService } from "./service.ts";

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

    const submitted = outbox.submit(draft.id);
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

  it("requires a recipient, subject, and body before approval", () => {
    const draft = outbox.create({ subject: "Incomplete" });
    expect(() => outbox.submit(draft.id)).toThrowError(expect.objectContaining({ code: "OUTBOX_RECIPIENT_REQUIRED" }));

    const withRecipient = outbox.update(draft.id, { to: ["reviewer@example.test"] });
    expect(withRecipient.status).toBe("draft");
    expect(() => outbox.submit(draft.id)).toThrowError(expect.objectContaining({ code: "OUTBOX_BODY_REQUIRED" }));
  });
});

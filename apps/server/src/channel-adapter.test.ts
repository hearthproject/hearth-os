import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EffectRecord } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { ChannelIngressService, type ChannelInbound } from "./channel-adapter.ts";

describe("ChannelIngressService", () => {
  let store: HearthStore;
  let channels: ChannelIngressService;
  let now: Date;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    now = new Date("2026-11-10T03:30:00.000Z");
    channels = new ChannelIngressService(store, () => now);
  });

  afterEach(() => store.close());

  it("fails closed on bad or expired authentication", () => {
    expect(() => channels.receive(message({ auth: { ok: false, reason: "bad signature" } }))).toThrowError(
      expect.objectContaining({ code: "CHANNEL_AUTH_FAILED", statusCode: 401 })
    );
    expect(() => channels.receive(message({
      auth: { ok: true, credentialExpiresAt: "2026-11-10T03:29:59.000Z" }
    }))).toThrowError(expect.objectContaining({ code: "CHANNEL_CREDENTIAL_EXPIRED" }));
  });

  it("processes a duplicate external message once even when its cursor is older", () => {
    const first = channels.receive(message({ cursor: 5, generation: 1 }));
    const duplicate = channels.receive(message({ cursor: 0, generation: 1 }));

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.record.id).toBe(first.record.id);
    expect(store.listChannelDeliveries("feishu", "chat-1")).toHaveLength(1);
    expect(store.getChannelCursor("feishu", "chat-1")).toMatchObject({ generation: 1, cursor: 5 });
  });

  it("rejects stale generations and cursors without overwriting a newer cursor", () => {
    channels.receive(message({ externalId: "m-1", cursor: 5, generation: 2 }));
    expect(() => channels.receive(message({ externalId: "m-2", cursor: 99, generation: 1 }))).toThrowError(
      expect.objectContaining({ code: "CHANNEL_GENERATION_STALE" })
    );
    expect(() => channels.receive(message({ externalId: "m-3", cursor: 4, generation: 2 }))).toThrowError(
      expect.objectContaining({ code: "CHANNEL_CURSOR_STALE" })
    );

    channels.receive(message({ externalId: "m-4", cursor: 1, generation: 3 }));
    expect(store.getChannelCursor("feishu", "chat-1")).toMatchObject({ generation: 3, cursor: 1 });
    expect(() => channels.receive(message({ externalId: "m-5", cursor: 99, generation: 2 }))).toThrowError(
      expect.objectContaining({ code: "CHANNEL_GENERATION_STALE" })
    );
    expect(store.getChannelCursor("feishu", "chat-1")).toMatchObject({ generation: 3, cursor: 1 });
  });

  it("redacts inbound payloads before persistence", () => {
    const record = channels.receive(message({ text: "Authorization: Bearer abcdefghijklmnop" })).record;
    expect(String(record.payload.text)).not.toContain("abcdefghijklmnop");
    expect(String(record.payload.text)).toContain("[REDACTED]");
  });

  it("requires a successful effect receipt before outbound delivery", async () => {
    const intent = channels.prepareOutbound({
      channel: "feishu",
      threadKey: "chat-1",
      externalId: "out-1",
      payload: { text: "reply" }
    });
    const pending = effect(intent.idempotencyKey, "pending");
    await expect(channels.deliver(intent, pending, { send: async () => ({ ok: true }) })).rejects.toMatchObject({
      code: "CHANNEL_EFFECT_NOT_READY"
    });

    const succeeded = effect(intent.idempotencyKey, "succeeded");
    let sends = 0;
    const sender = { send: async () => { sends += 1; return { messageId: "sent-1" }; } };
    const delivered = await channels.deliver(intent, succeeded, sender);
    const duplicate = await channels.deliver(intent, succeeded, sender);
    expect(delivered.record.status).toBe("processed");
    expect(delivered.receipt).toEqual({ messageId: "sent-1" });
    expect(duplicate.duplicate).toBe(true);
    expect(sends).toBe(1);
  });

  it("records retryable and terminal failures and acknowledges idempotently", () => {
    const received = channels.receive(message({ externalId: "fail-1" })).record;
    const retrying = channels.fail(received.id, new Error("temporary"), true);
    expect(retrying).toMatchObject({ status: "retrying", attemptCount: 2, lastError: "temporary" });
    const failed = channels.fail(received.id, new Error("permanent"), false);
    expect(failed.status).toBe("failed");
    const processed = channels.ack(received.id, { ok: true });
    expect(processed.status).toBe("processed");
    expect(channels.ack(received.id, { ok: false }).receipt).toEqual({ ok: true });
  });
});

function message(patch: Partial<ChannelInbound> = {}): ChannelInbound {
  return {
    channel: "feishu",
    externalId: "m-0",
    threadKey: "chat-1",
    sender: "ou-1",
    text: "hello",
    auth: { ok: true, principal: "ou-1" },
    generation: 1,
    cursor: 0,
    ...patch
  };
}

function effect(idempotencyKey: string, status: EffectRecord["status"]): EffectRecord {
  return {
    id: "effect-1",
    taskId: "task-1",
    approvalId: "approval-1",
    kind: "channel.send",
    idempotencyKey,
    status,
    target: {},
    receipt: status === "succeeded" ? { messageId: "sent-1" } : null,
    error: null,
    createdAt: "2026-11-10T03:30:00.000Z",
    updatedAt: "2026-11-10T03:30:00.000Z"
  };
}

import { createHash, randomUUID } from "node:crypto";
import type { ChannelDeliveryRecord, ChannelDirection, EffectRecord } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";
import { redactSecrets } from "./context.ts";

export interface ChannelAuthentication {
  ok: boolean;
  principal?: string;
  reason?: string;
  credentialExpiresAt?: string | null;
}

export interface ChannelInbound {
  channel: string;
  externalId: string;
  threadKey: string;
  sender: string;
  text: string;
  attachments?: string[];
  receivedAt?: string;
  generation?: number;
  cursor?: number;
  idempotencyKey?: string;
  auth: ChannelAuthentication;
}

export interface ChannelReceiveResult {
  duplicate: boolean;
  record: ChannelDeliveryRecord;
}

export interface ChannelOutboundIntent {
  effectKind: "channel.send";
  channel: string;
  threadKey: string;
  externalId: string;
  idempotencyKey: string;
  target: Record<string, unknown>;
  requiresApproval: true;
}

export interface ChannelSender {
  send(intent: ChannelOutboundIntent): Promise<Record<string, unknown>>;
}

export class ChannelError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "ChannelError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ChannelIngressService {
  constructor(
    private readonly store: HearthStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  receive(input: ChannelInbound): ChannelReceiveResult {
    this.authenticate(input.auth);
    const generation = input.generation ?? 1;
    const cursor = input.cursor ?? 0;
    const existing = this.store.getChannelDelivery(input.channel, input.externalId, "inbound");
    if (existing) return { duplicate: true, record: existing };
    const current = this.store.getChannelCursor(input.channel, input.threadKey);
    if (current && generation < current.generation) {
      throw new ChannelError("CHANNEL_GENERATION_STALE", `渠道代次已过期：${generation} < ${current.generation}`);
    }
    if (current && generation === current.generation && cursor < current.cursor) {
      throw new ChannelError("CHANNEL_CURSOR_STALE", `渠道游标已过期：${cursor} < ${current.cursor}`);
    }
    const now = this.now().toISOString();
    const record = this.store.createChannelDelivery({
      id: randomUUID(),
      channel: input.channel,
      externalId: input.externalId,
      threadKey: input.threadKey,
      direction: "inbound",
      idempotencyKey: input.idempotencyKey ?? idempotencyKey(input.channel, input.externalId, "inbound"),
      generation,
      status: "processing",
      payload: redactPayload({
        sender: input.sender,
        text: input.text,
        attachments: input.attachments ?? [],
        cursor,
        principal: input.auth.principal ?? null
      }),
      attemptCount: 1,
      lastError: null,
      lastAttemptAt: now,
      processedAt: null,
      effectId: null,
      receipt: null,
      createdAt: now,
      updatedAt: now
    });
    this.store.setChannelCursor({
      channel: input.channel,
      threadKey: input.threadKey,
      generation,
      cursor,
      updatedAt: now
    });
    return { duplicate: false, record };
  }

  ack(deliveryId: string, receipt: Record<string, unknown> | null = null): ChannelDeliveryRecord {
    const current = this.store.getChannelDeliveryById(deliveryId);
    if (!current) throw new ChannelError("CHANNEL_DELIVERY_NOT_FOUND", "渠道投递记录不存在", 404);
    if (current.status === "processed") return current;
    const updated = this.store.updateChannelDelivery(deliveryId, {
      status: "processed",
      processedAt: this.now().toISOString(),
      receipt,
      updatedAt: this.now().toISOString()
    });
    if (!updated) throw new ChannelError("CHANNEL_DELIVERY_NOT_FOUND", "渠道投递记录不存在", 404);
    return updated;
  }

  fail(deliveryId: string, error: unknown, retryable: boolean): ChannelDeliveryRecord {
    const current = this.store.getChannelDeliveryById(deliveryId);
    if (!current) throw new ChannelError("CHANNEL_DELIVERY_NOT_FOUND", "渠道投递记录不存在", 404);
    const message = error instanceof Error ? error.message : String(error);
    const now = this.now().toISOString();
    const updated = this.store.updateChannelDelivery(deliveryId, {
      status: retryable ? "retrying" : "failed",
      attemptCount: current.attemptCount + 1,
      lastError: message,
      lastAttemptAt: now,
      updatedAt: now
    });
    if (!updated) throw new ChannelError("CHANNEL_DELIVERY_NOT_FOUND", "渠道投递记录不存在", 404);
    return updated;
  }

  prepareOutbound(input: {
    channel: string;
    threadKey: string;
    externalId: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
  }): ChannelOutboundIntent {
    if (!input.channel.trim() || !input.threadKey.trim() || !input.externalId.trim()) {
      throw new ChannelError("CHANNEL_TARGET_REQUIRED", "渠道出站目标不能为空", 400);
    }
    return {
      effectKind: "channel.send",
      channel: input.channel,
      threadKey: input.threadKey,
      externalId: input.externalId,
      idempotencyKey: input.idempotencyKey ?? idempotencyKey(input.channel, input.externalId, "outbound"),
      target: { ...input.payload },
      requiresApproval: true
    };
  }

  async deliver(
    intent: ChannelOutboundIntent,
    effect: EffectRecord,
    sender: ChannelSender
  ): Promise<{ duplicate: boolean; record: ChannelDeliveryRecord; receipt: Record<string, unknown> }> {
    if (effect.kind !== intent.effectKind || effect.idempotencyKey !== intent.idempotencyKey) {
      throw new ChannelError("CHANNEL_EFFECT_MISMATCH", "渠道出站意图与效果账本不一致", 409);
    }
    if (effect.status !== "succeeded" || !effect.receipt) {
      throw new ChannelError("CHANNEL_EFFECT_NOT_READY", "渠道出站必须先有成功回执，不能绕过审批和效果账本", 409);
    }
    const existing = this.store.getChannelDelivery(intent.channel, intent.externalId, "outbound");
    if (existing) return { duplicate: true, record: existing, receipt: existing.receipt ?? effect.receipt };
    const now = this.now().toISOString();
    const record = this.store.createChannelDelivery({
      id: randomUUID(),
      channel: intent.channel,
      externalId: intent.externalId,
      threadKey: intent.threadKey,
      direction: "outbound",
      idempotencyKey: intent.idempotencyKey,
      generation: 1,
      status: "processing",
      payload: intent.target,
      attemptCount: 1,
      lastError: null,
      lastAttemptAt: now,
      processedAt: null,
      effectId: effect.id,
      receipt: effect.receipt,
      createdAt: now,
      updatedAt: now
    });
    try {
      const receipt = await sender.send(intent);
      const processed = this.ack(record.id, receipt);
      return { duplicate: false, record: processed, receipt };
    } catch (error) {
      this.fail(record.id, error, true);
      throw error;
    }
  }

  private authenticate(auth: ChannelAuthentication | undefined): void {
    if (!auth?.ok) {
      throw new ChannelError("CHANNEL_AUTH_FAILED", auth?.reason ?? "渠道认证失败", 401);
    }
    if (auth.credentialExpiresAt && new Date(auth.credentialExpiresAt).getTime() <= this.now().getTime()) {
      throw new ChannelError("CHANNEL_CREDENTIAL_EXPIRED", "渠道凭据已过期", 401);
    }
  }
}

export function channelDirection(options: { inbound?: boolean } = {}): ChannelDirection {
  return options.inbound === false ? "outbound" : "inbound";
}

function idempotencyKey(channel: string, externalId: string, direction: ChannelDirection): string {
  return createHash("sha256").update(`${channel}:${direction}:${externalId}`).digest("hex");
}

function redactPayload(value: Record<string, unknown>): Record<string, unknown> {
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") return redactSecrets(input);
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, item]) => [key, walk(item)]));
    }
    return input;
  };
  return walk(value) as Record<string, unknown>;
}

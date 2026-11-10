import { randomUUID } from "node:crypto";
import type { EventEnvelope, ThreadSubscriptionRecord } from "@hearth/core";
import type { HearthService } from "./service.ts";

export interface SubscribeThreadInput {
  threadKey: string;
  taskId: string;
  runId?: string | null;
  filter?: Record<string, unknown>;
}

export interface ThreadDelivery {
  subscriptionId: string;
  seq: number;
  type: string;
  taskId: string | null;
  runId: string | null;
  recordedAt: string;
}

export class ThreadSubscriptionError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ThreadSubscriptionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ThreadSubscriptionService {
  private unsubscribe: (() => void) | null = null;
  private readonly deliveries: ThreadDelivery[] = [];
  private listeners = new Set<(delivery: ThreadDelivery) => void>();

  constructor(
    private readonly service: HearthService,
    private readonly now: () => Date = () => new Date()
  ) {
    this.unsubscribe = this.service.bus.subscribe((event) => this.observe(event));
  }

  subscribe(input: SubscribeThreadInput): ThreadSubscriptionRecord {
    const threadKey = input.threadKey.trim();
    if (!threadKey) throw new ThreadSubscriptionError("THREAD_KEY_REQUIRED", "必须提供线程 key");
    this.service.requireTask(input.taskId);
    const now = this.now().toISOString();
    const existing = this.service.store.listThreadSubscriptions({ threadKey })
      .find((candidate) => candidate.taskId === input.taskId && candidate.status !== "ended");
    const record: ThreadSubscriptionRecord = existing
      ? {
          ...existing,
          runId: input.runId ?? existing.runId,
          filter: input.filter ?? existing.filter,
          status: "active",
          updatedAt: now
        }
      : {
          id: `thread:${randomUUID()}`,
          threadKey,
          taskId: input.taskId,
          runId: input.runId ?? null,
          cursor: null,
          filter: input.filter ?? {},
          status: "active",
          createdAt: now,
          updatedAt: now
        };
    this.persist(record);
    return record;
  }

  pause(id: string): ThreadSubscriptionRecord {
    return this.transition(id, "paused");
  }

  resume(id: string): ThreadSubscriptionRecord {
    return this.transition(id, "active");
  }

  end(id: string): ThreadSubscriptionRecord {
    return this.transition(id, "ended");
  }

  list(opts: { threadKey?: string; taskId?: string; status?: string } = {}): ThreadSubscriptionRecord[] {
    return this.service.store.listThreadSubscriptions(opts);
  }

  recentDeliveries(limit = 50): ThreadDelivery[] {
    return this.deliveries.slice(-Math.max(1, Math.min(limit, 500))).reverse();
  }

  onDelivery(listener: (delivery: ThreadDelivery) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  private observe(event: EventEnvelope): void {
    if (!event.taskId) return;
    if (event.type.startsWith("thread-subscription.")) return;
    for (const subscription of this.service.store.listThreadSubscriptions({ taskId: event.taskId, status: "active" })) {
      if (subscription.runId && event.runId && subscription.runId !== event.runId) continue;
      if (!accepts(subscription.filter, event)) continue;
      const delivery: ThreadDelivery = {
        subscriptionId: subscription.id,
        seq: event.seq,
        type: event.type,
        taskId: event.taskId,
        runId: event.runId,
        recordedAt: this.now().toISOString()
      };
      this.deliveries.push(delivery);
      if (this.deliveries.length > 500) this.deliveries.splice(0, this.deliveries.length - 500);
      this.persist({ ...subscription, cursor: String(event.seq), updatedAt: this.now().toISOString() });
      for (const listener of this.listeners) {
        try {
          listener(delivery);
        } catch {
          // A subscriber must never break event fan-out.
        }
      }
    }
  }

  private transition(id: string, status: ThreadSubscriptionRecord["status"]): ThreadSubscriptionRecord {
    const record = this.service.store.listThreadSubscriptions().find((candidate) => candidate.id === id);
    if (!record) throw new ThreadSubscriptionError("THREAD_SUBSCRIPTION_NOT_FOUND", "订阅不存在", 404);
    if (record.status === "ended" && status !== "ended") {
      throw new ThreadSubscriptionError("THREAD_SUBSCRIPTION_ENDED", "已结束的订阅不能恢复", 409);
    }
    const updated: ThreadSubscriptionRecord = { ...record, status, updatedAt: this.now().toISOString() };
    this.persist(updated);
    return updated;
  }

  private persist(record: ThreadSubscriptionRecord): void {
    const event = this.service.store.appendEvent({
      type: "thread-subscription.updated",
      taskId: record.taskId,
      payload: record
    });
    this.service.bus.publish(event);
  }
}

function accepts(filter: Record<string, unknown>, event: EventEnvelope): boolean {
  const types = Array.isArray(filter.types) ? filter.types.filter((value): value is string => typeof value === "string") : [];
  if (types.length > 0 && !types.some((pattern) => pattern.endsWith("*") ? event.type.startsWith(pattern.slice(0, -1)) : event.type === pattern)) {
    return false;
  }
  const exclude = Array.isArray(filter.excludeTypes) ? filter.excludeTypes.filter((value): value is string => typeof value === "string") : [];
  if (exclude.includes(event.type)) return false;
  return true;
}
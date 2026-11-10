import { randomUUID } from "node:crypto";
import type {
  ConnectionOutboxItem,
  ConnectionOutboxStatus,
  ConnectionReplayPlan,
  ConnectionRuntimeStatus,
  ConnectionSession,
  DeviceCapabilityKind,
  DeviceRecord,
  OfflineProjection
} from "@hearth/core";
import type { HearthService } from "./service.ts";

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90 * 1000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SCOPES = 20;
const MAX_IDEMPOTENCY_KEY = 200;

const READ_SCOPES = new Set(["read", "tasks", "attention", "effects", "all"]);
const DEVICE_SCOPE_CAPABILITIES: Record<string, DeviceCapabilityKind> = {
  observe: "observe",
  "device.observe": "observe",
  "desktop.control": "desktop.control",
  "device.control": "desktop.control",
  "ui.automation": "ui.automation",
  "device.ui": "ui.automation"
};

export interface ConnectionConnectInput {
  deviceId: string;
  userId: string;
  scopes?: string[] | undefined;
}

export interface ConnectionReconnectInput {
  generation: number;
  scopes?: string[] | undefined;
}

export interface ConnectionOutboxInput {
  generation: number;
  scope: string;
  kind: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface ConnectionOutboxResolution {
  generation: number;
  status: Extract<ConnectionOutboxStatus, "committed" | "rejected" | "conflict">;
  result?: Record<string, unknown> | undefined;
  error?: string | undefined;
}

export interface ConnectionServiceOptions {
  service: HearthService;
  now?: () => Date;
  sessionTtlMs?: number;
  heartbeatTimeoutMs?: number;
  cacheTtlMs?: number;
}

export class ConnectionError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ConnectionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ConnectionService {
  private readonly service: HearthService;
  private readonly now: () => Date;
  private readonly sessionTtlMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly cacheTtlMs: number;

  constructor(options: ConnectionServiceOptions) {
    this.service = options.service;
    this.now = options.now ?? (() => new Date());
    this.sessionTtlMs = boundedMs(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS, 5_000, 24 * 60 * 60 * 1000);
    this.heartbeatTimeoutMs = boundedMs(options.heartbeatTimeoutMs, DEFAULT_HEARTBEAT_TIMEOUT_MS, 1_000, 60 * 60 * 1000);
    this.cacheTtlMs = boundedMs(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 60_000, 30 * 24 * 60 * 60 * 1000);
  }

  connect(input: ConnectionConnectInput): ConnectionRuntimeStatus {
    const deviceId = normalizeText(input.deviceId, 120, "设备标识");
    const userId = normalizeText(input.userId, 120, "用户标识");
    const device = this.deviceFor(deviceId);
    const requested = normalizeScopes(input.scopes, isLocalDevice(deviceId) ? ["*"] : []);
    this.assertDeviceUsable(deviceId, device);
    const existing = this.service.store.getConnectionSessionByDevice(deviceId, userId);
    const currentTime = this.now();
    if (existing && this.isFreshConnected(existing, currentTime)) {
      return this.status(existing.id);
    }
    const now = currentTime.toISOString();
    const initial = !existing;
    const granted = initial
      ? requested.filter((scope) => this.scopeGrantable(device, scope))
      : existing.scopes;
    const pending = initial
      ? requested.filter((scope) => !granted.includes(scope))
      : unique([...existing.pendingScopes, ...requested.filter((scope) => !granted.includes(scope))]);
    const session: ConnectionSession = {
      id: existing?.id ?? `CONN-${randomUUID()}`,
      deviceId,
      userId,
      generation: (existing?.generation ?? 0) + 1,
      cursor: existing?.cursor ?? 0,
      scopes: granted,
      pendingScopes: pending,
      status: "connected",
      lastError: null,
      connectedAt: now,
      expiresAt: new Date(currentTime.getTime() + this.sessionTtlMs).toISOString(),
      lastHeartbeatAt: now,
      cursorAt: existing?.cursorAt ?? now,
      disconnectedAt: null,
      disconnectReason: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    if (existing && (existing.status === "disconnected" || !this.isFreshConnected(existing, currentTime))) {
      this.isolateStaleOutbox(existing, session);
    }
    this.persistSession(session);
    return this.status(session.id);
  }

  reconnect(id: string, input: ConnectionReconnectInput): ConnectionReplayPlan {
    const session = this.requireSession(id);
    this.assertGeneration(session, input.generation);
    const device = this.deviceFor(session.deviceId);
    this.assertDeviceUsable(session.deviceId, device);
    const requested = normalizeScopes(input.scopes, []);
    const now = this.now();
    const cursor = session.cursor ?? 0;
    const latestCursor = this.service.store.latestDataEventSeq();
    const pulledEvents = this.service.store.listEvents(cursor).filter((event) => !event.type.startsWith("connection.")).length;
    const staleItems = this.isolateStaleOutbox(session, {
      ...session,
      generation: session.generation + 1
    });
    const next: ConnectionSession = {
      ...session,
      generation: session.generation + 1,
      cursor: latestCursor,
      cursorAt: now.toISOString(),
      scopes: session.scopes,
      pendingScopes: unique([...session.pendingScopes, ...requested.filter((scope) => !session.scopes.includes(scope))]),
      status: "connected",
      lastError: null,
      connectedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.sessionTtlMs).toISOString(),
      lastHeartbeatAt: now.toISOString(),
      disconnectedAt: null,
      disconnectReason: null,
      updatedAt: now.toISOString()
    };
    this.persistSession(next);
    const items = this.service.store.listConnectionOutbox(id, "queued")
      .filter((item) => item.generation === next.generation);
    return {
      connectionId: id,
      generation: next.generation,
      ready: true,
      reason: staleItems > 0 ? "旧代次的离线操作已隔离，请核对后重新提交" : null,
      sourceCursor: latestCursor,
      latestCursor,
      pulledEvents,
      staleItems,
      items
    };
  }

  heartbeat(id: string, generation: number): ConnectionRuntimeStatus {
    const session = this.requireSession(id);
    this.assertGeneration(session, generation);
    const device = this.deviceFor(session.deviceId);
    this.assertDeviceUsable(session.deviceId, device);
    const now = this.now();
    if (Date.parse(session.expiresAt) <= now.getTime()) {
      const expired = this.withSession(session, {
        status: "disconnected",
        lastError: "连接已过期，需要重新建立连接",
        disconnectedAt: now.toISOString(),
        disconnectReason: null,
        updatedAt: now.toISOString()
      });
      this.persistSession(expired);
      throw new ConnectionError("CONNECTION_EXPIRED", "连接已过期，请重新连接", 409);
    }
    const next = this.withSession(session, {
      status: "connected",
      lastError: null,
      lastHeartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.sessionTtlMs).toISOString(),
      disconnectedAt: null,
      disconnectReason: null,
      updatedAt: now.toISOString()
    });
    this.persistSession(next);
    return this.status(id);
  }

  disconnect(id: string, generation: number, reason?: string): ConnectionRuntimeStatus {
    const session = this.requireSession(id);
    this.assertGeneration(session, generation);
    const now = this.now().toISOString();
    const next = this.withSession(session, {
      status: "disconnected",
      lastError: null,
      disconnectedAt: now,
      disconnectReason: reason?.trim() ? reason.trim().slice(0, 500) : null,
      updatedAt: now
    });
    this.persistSession(next);
    return this.status(id);
  }

  status(id: string): ConnectionRuntimeStatus {
    return this.computeStatus(this.requireSession(id));
  }

  projection<T = unknown>(id: string, scope = "all", expectedGeneration?: number): OfflineProjection<T> {
    const session = this.requireSession(id);
    if (expectedGeneration !== undefined) this.assertGeneration(session, expectedGeneration);
    this.assertDeviceUsable(session.deviceId, this.deviceFor(session.deviceId));
    this.assertProjectionScope(session, scope);
    const runtime = this.computeStatus(session);
    const data = this.projectionData(scope) as T;
    return {
      connectionId: id,
      generation: session.generation,
      scope,
      data,
      dataFreshness: runtime.dataFreshness,
      cached: runtime.dataFreshness !== "current",
      asOf: runtime.asOf,
      sourceCursor: runtime.sourceCursor,
      latestCursor: runtime.latestCursor
    };
  }

  listOutbox(id: string): ConnectionOutboxItem[] {
    this.requireSession(id);
    return this.service.store.listConnectionOutbox(id);
  }

  enqueue(id: string, input: ConnectionOutboxInput): ConnectionOutboxItem {
    const session = this.requireSession(id);
    this.assertGeneration(session, input.generation);
    this.assertDeviceUsable(session.deviceId, this.deviceFor(session.deviceId));
    const scope = normalizeScope(input.scope);
    this.assertProjectionScope(session, scope);
    const kind = normalizeText(input.kind, 80, "操作类型");
    const idempotencyKey = normalizeText(input.idempotencyKey, MAX_IDEMPOTENCY_KEY, "幂等键");
    if (idempotencyKey.length < 8) throw new ConnectionError("INVALID_IDEMPOTENCY_KEY", "幂等键至少需要 8 个字符", 400);
    const existing = this.service.store.getConnectionOutboxByIdempotencyKey(id, idempotencyKey);
    if (existing) return existing;
    const now = this.now().toISOString();
    const runtime = this.computeStatus(session);
    const remoteAction = scope.startsWith("remote.") || kind.startsWith("remote.");
    const uncertain = remoteAction && runtime.transport !== "connected";
    const item: ConnectionOutboxItem = {
      id: `COB-${randomUUID()}`,
      connectionId: id,
      generation: session.generation,
      deviceId: session.deviceId,
      userId: session.userId,
      scope,
      kind,
      idempotencyKey,
      payload: clonePayload(input.payload),
      status: uncertain ? "uncertain" : "queued",
      error: uncertain ? "连接已断开，远程动作可能已经执行，需要读取回执核对" : null,
      effectId: null,
      result: null,
      submittedAt: null,
      committedAt: null,
      createdAt: now,
      updatedAt: now
    };
    this.persistOutbox(item);
    return item;
  }

  submit(id: string, itemId: string, generation: number): ConnectionOutboxItem {
    const session = this.requireSession(id);
    this.assertGeneration(session, generation);
    this.assertDeviceUsable(session.deviceId, this.deviceFor(session.deviceId));
    const item = this.requireOutbox(id, itemId);
    if (item.generation !== session.generation) {
      throw new ConnectionError("CONNECTION_GENERATION_STALE", "这条离线操作属于旧连接代次，不能直接提交", 409);
    }
    if (item.status === "committed") return item;
    if (item.status !== "queued") {
      throw new ConnectionError("OUTBOX_NOT_SUBMITTABLE", `当前操作状态为 ${item.status}，不能直接提交`, 409);
    }
    const now = this.now().toISOString();
    const submitted = this.updateOutbox(item, { status: "submitted", submittedAt: now, updatedAt: now, error: null });
    try {
      const result = this.applyIntent(submitted);
      return this.updateOutbox(submitted, {
        status: "committed",
        result,
        committedAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
        error: null
      });
    } catch (error) {
      return this.updateOutbox(submitted, {
        status: "rejected",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: this.now().toISOString()
      });
    }
  }

  resolveOutbox(id: string, itemId: string, input: ConnectionOutboxResolution): ConnectionOutboxItem {
    const session = this.requireSession(id);
    this.assertGeneration(session, input.generation);
    const item = this.requireOutbox(id, itemId);
    if (item.generation !== session.generation) {
      throw new ConnectionError("CONNECTION_GENERATION_STALE", "这条操作属于旧连接代次，不能直接结算", 409);
    }
    if (item.status === "committed" || item.status === "rejected" || item.status === "conflict") return item;
    const now = this.now().toISOString();
    return this.updateOutbox(item, {
      status: input.status,
      result: input.result ?? item.result,
      error: input.error?.trim() ? input.error.trim().slice(0, 2000) : null,
      committedAt: input.status === "committed" ? now : item.committedAt,
      updatedAt: now
    });
  }

  approveScopes(id: string, scopes: string[]): ConnectionRuntimeStatus {
    const session = this.requireSession(id);
    const device = this.deviceFor(session.deviceId);
    this.assertDeviceUsable(session.deviceId, device);
    const requested = normalizeScopes(scopes, []);
    if (requested.length === 0) throw new ConnectionError("INVALID_SCOPE", "至少需要批准一项能力", 400);
    for (const scope of requested) {
      if (!this.scopeGrantable(device, scope)) {
        throw new ConnectionError("CAPABILITY_APPROVAL_REQUIRED", `能力 ${scope} 需要先由设备能力审批单独批准`, 409);
      }
    }
    const next = this.withSession(session, {
      scopes: unique([...session.scopes, ...requested]),
      pendingScopes: session.pendingScopes.filter((scope) => !requested.includes(scope)),
      updatedAt: this.now().toISOString()
    });
    this.persistSession(next);
    return this.status(id);
  }

  private computeStatus(session: ConnectionSession): ConnectionRuntimeStatus {
    const now = this.now();
    const latestCursor = this.service.store.latestDataEventSeq();
    const sourceCursor = session.cursor ?? 0;
    const device = this.deviceFor(session.deviceId);
    let transport: ConnectionRuntimeStatus["transport"] = session.status === "connected" ? "connected" : "disconnected";
    let lastError = session.lastError;
    if (device?.status === "revoked") {
      transport = "failed";
      lastError = "设备已撤销，连接不能继续执行或读取";
    } else if (session.status === "connected") {
      const heartbeatAt = Date.parse(session.lastHeartbeatAt);
      if (Date.parse(session.expiresAt) <= now.getTime()) {
        transport = "failed";
        lastError ??= "连接已过期";
      } else if (Number.isFinite(heartbeatAt) && now.getTime() - heartbeatAt > this.heartbeatTimeoutMs) {
        transport = "failed";
        lastError ??= "连接心跳超时";
      }
    } else if (session.lastError) {
      transport = "failed";
    }
    const subscription: ConnectionRuntimeStatus["subscription"] = transport === "failed"
      ? "failed"
      : transport === "disconnected"
        ? "stale"
        : sourceCursor < latestCursor ? "catching_up" : "live";
    const cacheExpiresAt = new Date(Date.parse(session.cursorAt || session.updatedAt) + this.cacheTtlMs).toISOString();
    const dataFreshness: ConnectionRuntimeStatus["dataFreshness"] = transport === "connected"
      ? sourceCursor >= latestCursor ? "current" : "cached"
      : now.getTime() > Date.parse(cacheExpiresAt) ? "expired" : "cached";
    const activeLeases = this.service.store.listTaskLeases().filter((lease) => Date.parse(lease.expiresAt) > now.getTime());
    const ownedLease = activeLeases.find((lease) => lease.ownerDeviceId === session.deviceId);
    const executionOwnership: ConnectionRuntimeStatus["executionOwnership"] = transport === "connected"
      ? ownedLease ? "leased" : "owned"
      : activeLeases.length > 0 ? "unknown" : "unknown";
    return {
      connectionId: session.id,
      deviceId: session.deviceId,
      generation: session.generation,
      transport,
      subscription,
      dataFreshness,
      executionOwnership,
      sourceCursor,
      latestCursor,
      asOf: this.service.store.eventTimestampAtOrBefore(sourceCursor) ?? session.cursorAt,
      cacheExpiresAt,
      pendingScopes: session.pendingScopes,
      scopeApprovalRequired: session.pendingScopes.length > 0,
      lastError,
      session
    };
  }

  private projectionData(scope: string): unknown {
    if (scope === "tasks") {
      return this.service.store.listTasks().slice(0, 100).map((task) => ({
        id: task.id, title: task.title, status: task.status, updatedAt: task.updatedAt,
        goalId: task.goalId, currentRunId: task.currentRunId, nextAction: task.nextAction
      }));
    }
    if (scope === "attention") {
      return this.service.store.listAttentionItems({ status: "open", limit: 100 });
    }
    if (scope === "effects") {
      return this.service.store.listAllEffects().slice(-100).map((effect) => ({
        id: effect.id, taskId: effect.taskId, status: effect.status,
        effectType: effect.effectType, error: effect.error, createdAt: effect.createdAt
      }));
    }
    return {
      tasks: this.service.store.listTasks().slice(0, 50).map((task) => ({
        id: task.id, title: task.title, status: task.status, updatedAt: task.updatedAt
      })),
      attention: this.service.store.listAttentionItems({ status: "open", limit: 50 }),
      effects: this.service.store.listAllEffects().slice(-50).map((effect) => ({
        id: effect.id, taskId: effect.taskId, status: effect.status, error: effect.error
      }))
    };
  }

  private applyIntent(item: ConnectionOutboxItem): Record<string, unknown> {
    if (item.kind === "task.follow-up") {
      const taskId = typeof item.payload.taskId === "string" ? item.payload.taskId : "";
      const content = typeof item.payload.content === "string" ? item.payload.content.trim() : "";
      const mode = item.payload.mode === "steer" ? "steer" : "queue";
      if (!taskId || !content) throw new Error("任务跟进需要 taskId 和 content");
      const followUp = this.service.createTaskFollowUp(taskId, content, mode);
      return { followUpId: followUp.id };
    }
    throw new Error(`不支持的离线操作类型：${item.kind}`);
  }

  private isolateStaleOutbox(previous: ConnectionSession, next: ConnectionSession): number {
    const stale = this.service.store.listConnectionOutbox(previous.id)
      .filter((item) => item.generation < next.generation && !["committed", "rejected", "conflict"].includes(item.status));
    for (const item of stale) {
      this.updateOutbox(item, {
        status: "conflict",
        error: "旧连接代次的离线操作已隔离，请核对服务端事实后重新提交",
        updatedAt: this.now().toISOString()
      });
    }
    return stale.length;
  }

  private persistSession(session: ConnectionSession): void {
    const event = this.service.store.appendEvent({ type: "connection.updated", payload: session });
    this.service.bus.publish(event);
  }

  private persistOutbox(item: ConnectionOutboxItem): void {
    const event = this.service.store.appendEvent({ type: "connection.outbox.updated", payload: item });
    this.service.bus.publish(event);
  }

  private updateOutbox(item: ConnectionOutboxItem, patch: Partial<ConnectionOutboxItem>): ConnectionOutboxItem {
    const updated = { ...item, ...patch };
    this.persistOutbox(updated);
    return updated;
  }

  private requireSession(id: string): ConnectionSession {
    const session = this.service.store.getConnectionSession(id);
    if (!session) throw new ConnectionError("CONNECTION_NOT_FOUND", "连接不存在", 404);
    return session;
  }

  private requireOutbox(connectionId: string, itemId: string): ConnectionOutboxItem {
    const item = this.service.store.getConnectionOutboxItem(itemId);
    if (!item || item.connectionId !== connectionId) {
      throw new ConnectionError("OUTBOX_ITEM_NOT_FOUND", "离线操作不存在", 404);
    }
    return item;
  }

  private assertGeneration(session: ConnectionSession, generation: number): void {
    if (!Number.isInteger(generation) || generation !== session.generation) {
      throw new ConnectionError("CONNECTION_GENERATION_STALE", "连接代次已失效，请重新连接后提交", 409);
    }
  }

  private deviceFor(deviceId: string): DeviceRecord | null {
    if (isLocalDevice(deviceId)) return null;
    return this.service.store.getDevice(deviceId);
  }

  private assertDeviceUsable(deviceId: string, device: DeviceRecord | null): void {
    if (isLocalDevice(deviceId)) return;
    if (!device) throw new ConnectionError("DEVICE_NOT_FOUND", "设备不存在或尚未配对", 403);
    if (device.status === "revoked") throw new ConnectionError("DEVICE_REVOKED", "设备已撤销，连接不能继续", 403);
  }

  private scopeGrantable(device: DeviceRecord | null, scope: string): boolean {
    if (!device) return true;
    if (READ_SCOPES.has(scope)) return true;
    const capability = DEVICE_SCOPE_CAPABILITIES[scope];
    if (!capability) return false;
    return device.capabilities.some((item) => item.kind === capability && item.status === "approved");
  }

  private assertProjectionScope(session: ConnectionSession, scope: string): void {
    if (session.scopes.includes("*") || session.scopes.includes("read")) return;
    if (session.scopes.includes(scope)) return;
    if (scope.startsWith("remote.") && session.scopes.some((item) => item.startsWith("remote."))) return;
    throw new ConnectionError("CONNECTION_SCOPE_DENIED", `当前连接没有 ${scope} 权限`, 403);
  }

  private isFreshConnected(session: ConnectionSession, now: Date): boolean {
    return session.status === "connected"
      && Date.parse(session.expiresAt) > now.getTime()
      && now.getTime() - Date.parse(session.lastHeartbeatAt) <= this.heartbeatTimeoutMs;
  }

  private withSession(session: ConnectionSession, patch: Partial<ConnectionSession>): ConnectionSession {
    return { ...session, ...patch };
  }
}

function normalizeText(value: string, max: number, label: string): string {
  const text = value.trim();
  if (!text || text.length > max) throw new ConnectionError("INVALID_CONNECTION_INPUT", `${label}不能为空且不能超过 ${max} 个字符`, 400);
  return text;
}

function normalizeScope(value: string): string {
  const scope = value.trim();
  if (!scope || scope.length > 80 || !/^[a-zA-Z0-9*._:-]+$/.test(scope)) {
    throw new ConnectionError("INVALID_SCOPE", "连接能力标识格式不正确", 400);
  }
  return scope;
}

function normalizeScopes(values: string[] | undefined, fallback: string[]): string[] {
  const scopes = unique((values ?? fallback).map(normalizeScope));
  if (scopes.length > MAX_SCOPES) throw new ConnectionError("TOO_MANY_SCOPES", `一次最多声明 ${MAX_SCOPES} 项能力`, 400);
  return scopes;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isLocalDevice(deviceId: string): boolean {
  return deviceId === "local" || deviceId === "web" || deviceId.startsWith("local:") || deviceId.startsWith("web:");
}

function clonePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function boundedMs(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

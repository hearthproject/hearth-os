import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { EventEnvelope, SyncConflict, SyncPeer } from "@hearth/core";
import { MASTER_KEY_PATH } from "./config.ts";
import type { HearthService } from "./service.ts";
import { SecretBox } from "./secrets.ts";

export type SyncPeerView = Omit<SyncPeer, "tokenHash">;

export interface SyncEventPage {
  instanceId: string;
  events: EventEnvelope[];
  nextCursor: number;
  latestSeq: number;
  hasMore: boolean;
}

export interface SyncSnapshot {
  instanceId: string;
  latestSeq: number;
  peers: SyncPeerView[];
  conflicts: SyncConflict[];
}

export interface CreateSyncPeerInput {
  name: string;
  baseUrl: string;
  token?: string;
  lastPullSeq?: number;
}

export class SyncError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const BLOCKED_SYNC_PREFIXES = ["approval.", "source.", "outbox.", "device.", "desktop.", "connection.", "security.", "sync."];

export class SyncService {
  private readonly service: HearthService;
  private secretBox: SecretBox | null;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;

  constructor(service: HearthService, options: { secretBox?: SecretBox; fetchImpl?: typeof fetch; clock?: () => Date } = {}) {
    this.service = service;
    this.secretBox = options.secretBox ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? (() => new Date());
  }

  private get secrets(): SecretBox {
    this.secretBox ??= SecretBox.fromKeyFile(MASTER_KEY_PATH);
    return this.secretBox;
  }

  reloadSecrets(): void {
    this.secretBox = null;
  }

  snapshot(): SyncSnapshot {
    return {
      instanceId: this.service.store.instanceId,
      latestSeq: this.service.store.latestEventSeq(),
      peers: this.service.store.listSyncPeers().map(peerView),
      conflicts: this.service.store.listSyncConflicts()
    };
  }

  createPeer(input: CreateSyncPeerInput): { peer: SyncPeerView; token: string } {
    const name = input.name.trim();
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const token = input.token?.trim() || randomBytes(32).toString("base64url");
    if (token.length < 32 || token.length > 256 || /\s/.test(token)) {
      throw new SyncError("SYNC_TOKEN_INVALID", "同步令牌至少需要 32 个字符且不能包含空白");
    }
    const now = this.nowIso();
    const peer: SyncPeer = {
      id: randomUUID(),
      name,
      baseUrl,
      status: "active",
      tokenHash: hashToken(token),
      lastPullSeq: Math.max(0, Math.floor(input.lastPullSeq ?? 0)),
      lastPullAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    };
    this.emitPeer("sync.peer.created", peer, this.secrets.encrypt(token), null);
    return { peer: peerView(peer), token };
  }

  rotatePeerToken(id: string): { peer: SyncPeerView; token: string } {
    const peer = this.requirePeer(id);
    if (peer.status === "revoked") throw new SyncError("SYNC_PEER_REVOKED", "已撤销的对端不能轮换令牌", 409);
    const token = randomBytes(32).toString("base64url");
    const next: SyncPeer = {
      ...peer,
      tokenHash: hashToken(token),
      status: "active",
      lastError: null,
      updatedAt: this.nowIso()
    };
    this.emitPeer("sync.peer.updated", next, this.secrets.encrypt(token), null);
    return { peer: peerView(next), token };
  }

  revokePeer(id: string): SyncPeerView {
    const peer = this.requirePeer(id);
    if (peer.status === "revoked") return peerView(peer);
    const next: SyncPeer = { ...peer, status: "revoked", updatedAt: this.nowIso() };
    this.emitPeer("sync.peer.updated", next, this.service.store.getSyncPeerTokenCipher(id), null);
    return peerView(next);
  }

  authenticateInbound(token: string): SyncPeer {
    if (!token || token.length < 32 || token.length > 256) throw new SyncError("SYNC_UNAUTHORIZED", "同步令牌无效", 401);
    const peer = this.service.store.getSyncPeerByTokenHash(hashToken(token));
    if (!peer || peer.status !== "active") throw new SyncError("SYNC_UNAUTHORIZED", "同步令牌无效或对端已撤销", 401);
    return peer;
  }

  exportEvents(afterSeq = 0, limit = 200): SyncEventPage {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const raw = this.service.store.listEvents(Math.max(0, afterSeq)).slice(0, safeLimit + 1);
    const page = raw.slice(0, safeLimit);
    const events = page.map((event) => sanitizeSyncEvent(event)).filter((event): event is EventEnvelope => Boolean(event));
    return {
      instanceId: this.service.store.instanceId,
      events,
      nextCursor: page.at(-1)?.seq ?? Math.max(0, afterSeq),
      latestSeq: this.service.store.latestEventSeq(),
      hasMore: raw.length > safeLimit
    };
  }

  applyPage(page: SyncEventPage, peerId?: string): { imported: number; skipped: number; conflicts: number } {
    if (page.instanceId === this.service.store.instanceId) {
      throw new SyncError("SYNC_SELF", "不能从当前实例自身同步", 409);
    }
    let imported = 0;
    let skipped = 0;
    let conflicts = 0;
    for (const event of page.events) {
      if (event.originInstanceId === this.service.store.instanceId || this.service.store.getEventById(event.id)) {
        skipped += 1;
        continue;
      }
      if (!event.originInstanceId) {
        skipped += 1;
        continue;
      }
      const conflict = this.detectConflict(event);
      if (conflict) {
        this.emit("sync.conflict.created", conflict);
        skipped += 1;
        conflicts += 1;
        continue;
      }
      this.importEvent(event);
      imported += 1;
    }
    if (peerId) this.recordPull(peerId, page.nextCursor, page.instanceId, null);
    return { imported, skipped, conflicts };
  }

  async pull(peerId: string, limit = 200): Promise<{ imported: number; skipped: number; conflicts: number; peer: SyncPeerView }> {
    const peer = this.requirePeer(peerId);
    if (peer.status !== "active") throw new SyncError("SYNC_PEER_REVOKED", "同步对端不可用", 409);
    const cipher = this.service.store.getSyncPeerTokenCipher(peer.id);
    if (!cipher) throw new SyncError("SYNC_TOKEN_MISSING", "同步对端没有可用的加密令牌", 409);
    const token = this.secrets.decrypt(cipher);
    const url = new URL("/api/sync/events", peer.baseUrl);
    url.searchParams.set("after", String(peer.lastPullSeq));
    url.searchParams.set("limit", String(limit));
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { authorization: "Bearer " + token } });
    } catch (error) {
      this.recordPull(peer.id, peer.lastPullSeq, null, error instanceof Error ? error.message : String(error));
      throw new SyncError("SYNC_OFFLINE", "同步对端离线或不可达", 503);
    }
    if (!response.ok) {
      this.recordPull(peer.id, peer.lastPullSeq, null, "HTTP " + response.status);
      throw new SyncError("SYNC_REMOTE_ERROR", "同步对端返回错误：" + response.status, 502);
    }
    const page = await response.json() as SyncEventPage;
    const result = this.applyPage(page, peer.id);
    return { ...result, peer: peerView(this.requirePeer(peer.id)) };
  }

  resolveConflict(id: string, resolution: "local" | "remote"): SyncConflict {
    const conflict = this.service.store.getSyncConflict(id);
    if (!conflict) throw new SyncError("SYNC_CONFLICT_NOT_FOUND", "同步冲突不存在", 404);
    if (conflict.status !== "pending") return conflict;
    if (resolution === "remote") {
      const event = conflict.remotePayload as unknown as EventEnvelope;
      if (event && typeof event.id === "string" && typeof event.type === "string") {
        if (!this.service.store.getEventById(event.id)) this.importEvent(event);
      }
    }
    const resolved: SyncConflict = {
      ...conflict,
      status: resolution,
      resolvedAt: this.nowIso()
    };
    this.emit("sync.conflict.updated", resolved);
    return resolved;
  }

  private detectConflict(event: EventEnvelope): SyncConflict | null {
    const now = this.nowIso();
    const conflict = (entityType: string, entityId: string, localUpdatedAt: string | null, localPayload: Record<string, unknown>): SyncConflict => ({
      id: randomUUID(),
      entityType,
      entityId,
      localUpdatedAt,
      remoteUpdatedAt: event.createdAt,
      localPayload,
      remotePayload: event as unknown as Record<string, unknown>,
      status: "pending",
      createdAt: now,
      resolvedAt: null
    });
    if (event.type === "task.updated" && event.taskId) {
      const local = this.service.store.getTask(event.taskId);
      if (local && Date.parse(local.updatedAt) > Date.parse(event.createdAt)) {
        return conflict("task", local.id, local.updatedAt, local as unknown as Record<string, unknown>);
      }
    }
    if (event.type === "memory.updated") {
      const payload = event.payload as { id?: string; updatedAt?: string };
      if (payload.id) {
        const local = this.service.store.getMemory(payload.id);
        if (local && payload.updatedAt && Date.parse(local.updatedAt) > Date.parse(payload.updatedAt)) {
          return conflict("memory", local.id, local.updatedAt, local as unknown as Record<string, unknown>);
        }
      }
    }
    if (event.type === "method.candidate.updated") {
      const payload = event.payload as { id?: string; updatedAt?: string };
      if (payload.id) {
        const local = this.service.store.getMethodCandidate(payload.id);
        if (local && payload.updatedAt && Date.parse(local.updatedAt) > Date.parse(payload.updatedAt)) {
          return conflict("method", local.id, local.updatedAt, local as unknown as Record<string, unknown>);
        }
      }
    }
    return null;
  }

  private importEvent(event: EventEnvelope): void {
    if (!event.originInstanceId) throw new SyncError("SYNC_ORIGIN_MISSING", "同步事件缺少来源实例", 409);
    const imported = this.service.store.appendEvent({
      id: event.id,
      type: event.type,
      taskId: event.taskId,
      runId: event.runId,
      payload: event.payload,
      createdAt: event.createdAt
    }, { instanceId: event.originInstanceId, seq: event.originSeq ?? event.seq });
    this.service.bus.publish(imported);
  }

  private recordPull(peerId: string, cursor: number, remoteInstanceId: string | null, error: string | null): void {
    const peer = this.requirePeer(peerId);
    const now = this.nowIso();
    const next: SyncPeer = {
      ...peer,
      status: error ? "error" : "active",
      lastPullSeq: cursor,
      lastPullAt: error ? peer.lastPullAt : now,
      lastError: error,
      updatedAt: now
    };
    this.emitPeer("sync.peer.updated", next, this.service.store.getSyncPeerTokenCipher(peerId), remoteInstanceId);
  }

  private emitPeer(type: string, peer: SyncPeer, tokenCipher: string | null, remoteInstanceId: string | null): void {
    this.emit(type, { ...peer, tokenCipher, remoteInstanceId });
  }

  private requirePeer(id: string): SyncPeer {
    const peer = this.service.store.getSyncPeer(id);
    if (!peer) throw new SyncError("SYNC_PEER_NOT_FOUND", "同步对端不存在", 404);
    return peer;
  }

  private emit(type: string, payload: unknown): void {
    const event = this.service.store.appendEvent({ type, payload });
    this.service.bus.publish(event);
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }
}

function sanitizeSyncEvent(event: EventEnvelope): EventEnvelope | null {
  if (BLOCKED_SYNC_PREFIXES.some((prefix) => event.type.startsWith(prefix))) return null;
  if (event.type === "memory.recalled") return null;
  const payload = clonePayload(event.payload);
  if (event.type.startsWith("memory.")) {
    const sensitivity = (payload as { sensitivity?: string }).sensitivity;
    if (sensitivity === "sensitive" || sensitivity === "secret") return null;
  }
  if (event.type === "task.created") {
    const task = payload as Record<string, unknown>;
    task.inputs = [];
    task.networkHosts = [];
  }
  if (event.type === "run.created") {
    const run = payload as Record<string, unknown>;
    run.workspace = "[remote]";
  }
  if (event.type === "artifact.published") {
    const artifact = payload as Record<string, unknown>;
    artifact.absolutePath = "";
  }
  return { ...event, payload };
}

function clonePayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") return payload;
  return JSON.parse(JSON.stringify(payload)) as unknown;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new SyncError("SYNC_BASE_URL_INVALID", "同步地址不是有效 URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new SyncError("SYNC_BASE_URL_INVALID", "同步地址必须是 http(s)，且不能包含内嵌凭据");
  }
  return url.toString().replace(/\/$/, "");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function peerView(peer: SyncPeer): SyncPeerView {
  const { tokenHash: _tokenHash, ...view } = peer;
  return view;
}

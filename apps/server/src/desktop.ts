import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DesktopCommandKind,
  DesktopCommandRecord,
  DesktopFrameRecord,
  DesktopSessionRecord,
  DeviceCapabilityKind,
  DevicePairingRequest,
  DeviceRecord
} from "@hearth/core";
import { DEVICE_CAPABILITY_KINDS } from "@hearth/core";
import type { HearthService } from "./service.ts";

const PAIRING_TTL_MS = 5 * 60 * 1000;
const DEVICE_ONLINE_MS = 30_000;
const DEVICE_TOUCH_MS = 5_000;
const FRAME_TTL_MS = 2 * 60 * 1000;
const COMMAND_TTL_MS = 30_000;
const MAX_FRAME_BYTES = 4_000_000;
const ALLOWED_PRESS_KEYS = new Set(["Enter", "Tab", "Escape", "Ctrl+S"]);
const ALLOWED_CONTROL_TYPES = new Set([
  "Button", "MenuItem", "Edit", "ListItem", "TabItem", "Hyperlink", "CheckBox", "ComboBox", "TreeItem"
]);
const APP_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}$/;

export type DeviceView = Omit<DeviceRecord, "tokenHash"> & { online: boolean };
export type PairingRequestView = Omit<DevicePairingRequest, "secretHash" | "deviceTokenHash">;
export type DesktopFrameView = Omit<DesktopFrameRecord, "storagePath"> & { url: string };
export type DesktopCommandView = Omit<DesktopCommandRecord, "payload"> & { payload: Record<string, unknown> };

export interface DesktopSessionView {
  session: DesktopSessionRecord;
  device: DeviceView;
  frame: DesktopFrameView | null;
  frames: DesktopFrameView[];
  commands: DesktopCommandView[];
}

export interface DesktopDashboard {
  devices: DeviceView[];
  pairings: PairingRequestView[];
  sessions: DesktopSessionView[];
}

export interface PairingStartInput {
  name: string;
  version: string;
  deviceToken: string;
  apps: string[];
  capabilities: DeviceCapabilityKind[];
}

export type DesktopActionInput =
  | { kind: "click"; frameId: string; x: number; y: number }
  | { kind: "type"; frameId: string; text: string }
  | { kind: "press"; frameId: string; keys: string }
  | { kind: "focus"; frameId: string; app: string; windowTitle?: string }
  | { kind: "uia.invoke"; frameId: string; elementName: string; controlType?: string }
  | { kind: "uia.setvalue"; frameId: string; elementName: string; value: string; controlType?: string };

export interface CommandResultInput {
  status: "succeeded" | "failed";
  result?: Record<string, unknown>;
  error?: string;
}

export interface ObservationInput {
  sessionId: string;
  commandId?: string;
  jpegBase64: string;
  width: number;
  height: number;
  activeApp: string;
  windowTitle: string;
}

export interface StoredFrame {
  frame: DesktopFrameView;
  absolutePath: string;
}

export class DesktopError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "DesktopError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class DesktopService {
  private readonly service: HearthService;
  private readonly frameRoot: string;

  constructor(service: HearthService, frameRoot: string) {
    this.service = service;
    this.frameRoot = frameRoot;
  }

  createPairingRequest(input: PairingStartInput): { request: PairingRequestView; secret: string } {
    const name = normalizeText(input.name, 120, "设备名称");
    const version = normalizeText(input.version, 40, "助手版本");
    if (!input.deviceToken || input.deviceToken.length < 32 || input.deviceToken.length > 256 || /\s/.test(input.deviceToken)) {
      throw new DesktopError("INVALID_DEVICE_TOKEN", "助手需要生成至少 32 字节的设备令牌", 400);
    }
    const apps = normalizeApps(input.apps);
    const capabilities = normalizeCapabilities(input.capabilities);
    const now = new Date().toISOString();
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const request: DevicePairingRequest = {
      id,
      code: randomInt(0, 1_000_000).toString().padStart(6, "0"),
      secretHash: hashToken(secret),
      deviceTokenHash: hashToken(input.deviceToken),
      name,
      platform: "windows",
      version,
      requestedApps: apps,
      requestedCapabilities: capabilities,
      status: "pending",
      deviceId: null,
      expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
      createdAt: now,
      updatedAt: now
    };
    this.service.createPairingRequest(request);
    return { request: publicPairing(request), secret };
  }

  getPairingStatus(id: string, secret: string): { request: PairingRequestView; device: DeviceView | null } {
    const request = this.requirePairing(id);
    if (!secret || !safeEqual(hashToken(secret), request.secretHash)) {
      throw new DesktopError("PAIRING_SECRET_INVALID", "配对查询密钥不正确", 401);
    }
    const refreshed = this.refreshPairingExpiry(request);
    if (refreshed.status === "approved" && refreshed.deviceId) {
      const redeemed = this.updatePairing({ ...refreshed, status: "redeemed", updatedAt: new Date().toISOString() });
      const device = this.service.store.getDevice(redeemed.deviceId as string);
      return { request: publicPairing(redeemed), device: device ? this.deviceView(device) : null };
    }
    const device = refreshed.deviceId ? this.service.store.getDevice(refreshed.deviceId) : null;
    return { request: publicPairing(refreshed), device: device ? this.deviceView(device) : null };
  }

  dashboard(): DesktopDashboard {
    this.refreshExpiredPairings();
    return {
      devices: this.service.store.listDevices().map((device) => this.deviceView(device)),
      pairings: this.service.store.listPairingRequests().slice(0, 20).map(publicPairing),
      sessions: this.service.store.listDesktopSessions().slice(0, 20).map((session) => this.sessionView(session.id))
    };
  }

  approvePairing(id: string): DeviceView {
    const current = this.refreshPairingExpiry(this.requirePairing(id));
    if (current.status !== "pending") {
      throw new DesktopError("PAIRING_NOT_PENDING", "这个配对请求已经处理或过期", 409);
    }
    const now = new Date().toISOString();
    const device: DeviceRecord = {
      id: randomUUID(),
      pairingRequestId: current.id,
      name: current.name,
      platform: "windows",
      version: current.version,
      status: "offline",
      tokenHash: current.deviceTokenHash,
      capabilities: current.requestedCapabilities.map((kind) => ({
        kind,
        status: "pending",
        apps: current.requestedApps,
        requestedAt: now,
        approvedAt: null,
        revokedAt: null
      })),
      lastSeenAt: null,
      createdAt: now,
      updatedAt: now
    };
    this.service.createDevice(device);
    this.updatePairing({ ...current, status: "approved", deviceId: device.id, updatedAt: now });
    return this.deviceView(device);
  }

  rejectPairing(id: string): PairingRequestView {
    const current = this.refreshPairingExpiry(this.requirePairing(id));
    if (current.status !== "pending") {
      throw new DesktopError("PAIRING_NOT_PENDING", "这个配对请求已经处理或过期", 409);
    }
    return publicPairing(this.updatePairing({ ...current, status: "rejected", updatedAt: new Date().toISOString() }));
  }

  approveCapability(deviceId: string, kind: DeviceCapabilityKind, apps: string[]): DeviceView {
    const device = this.requireActiveDevice(deviceId);
    const index = device.capabilities.findIndex((capability) => capability.kind === kind);
    if (index < 0) throw new DesktopError("CAPABILITY_NOT_REQUESTED", "设备没有申请这项能力", 404);
    const current = device.capabilities[index];
    if (!current) throw new DesktopError("CAPABILITY_NOT_FOUND", "能力项不存在", 404);
    const now = new Date().toISOString();
    const capabilities = [...device.capabilities];
    capabilities[index] = {
      ...current,
      status: "approved",
      apps: normalizeApps(apps.length > 0 ? apps : current.apps),
      approvedAt: now,
      revokedAt: null
    };
    return this.deviceView(this.service.updateDevice({ ...device, capabilities, updatedAt: now }));
  }

  revokeCapability(deviceId: string, kind: DeviceCapabilityKind): DeviceView {
    const device = this.requireActiveDevice(deviceId);
    const index = device.capabilities.findIndex((capability) => capability.kind === kind);
    if (index < 0) throw new DesktopError("CAPABILITY_NOT_FOUND", "能力项不存在", 404);
    const current = device.capabilities[index];
    if (!current) throw new DesktopError("CAPABILITY_NOT_FOUND", "能力项不存在", 404);
    const now = new Date().toISOString();
    const capabilities = [...device.capabilities];
    capabilities[index] = { ...current, status: "revoked", revokedAt: now };
    const updated = this.service.updateDevice({ ...device, capabilities, updatedAt: now });
    for (const session of this.service.store.listDesktopSessions(deviceId)) {
      if (session.status === "terminated") continue;
      if (kind === "observe") this.terminateSessionForPolicy(session, "观察能力已撤销");
      else if (kind === "desktop.control") this.pauseSessionForPolicy(session, "桌面控制能力已撤销");
    }
    return this.deviceView(updated);
  }

  revokeDevice(deviceId: string): DeviceView {
    const device = this.service.store.getDevice(deviceId);
    if (!device) throw new DesktopError("DEVICE_NOT_FOUND", "设备不存在", 404);
    if (device.status === "revoked") return this.deviceView(device);
    const now = new Date().toISOString();
    for (const session of this.service.store.listDesktopSessions(deviceId)) {
      if (session.status !== "terminated") this.terminateSessionForPolicy(session, "设备已撤销");
    }
    const updated = this.service.updateDevice({
      ...device,
      status: "revoked",
      capabilities: device.capabilities.map((capability) => ({ ...capability, status: "revoked", revokedAt: now })),
      updatedAt: now
    });
    return this.deviceView(updated);
  }

  authenticateDevice(token: string): DeviceRecord {
    if (!token || token.length < 32 || token.length > 256) {
      throw new DesktopError("DEVICE_UNAUTHORIZED", "设备令牌无效", 401);
    }
    const device = this.service.store.getDeviceByTokenHash(hashToken(token));
    if (!device || device.status === "revoked") {
      throw new DesktopError("DEVICE_UNAUTHORIZED", "设备令牌无效或设备已撤销", 401);
    }
    return this.touchDevice(device);
  }

  deviceState(deviceId: string): { device: DeviceView; sessions: DesktopSessionView[] } {
    const device = this.requireActiveDevice(deviceId);
    return { device: this.deviceView(device), sessions: this.service.store.listDesktopSessions(deviceId).slice(0, 5).map((session) => this.sessionView(session.id)) };
  }

  createSession(deviceId: string): DesktopSessionView {
    const device = this.requireActiveDevice(deviceId);
    this.assertOnline(device);
    this.assertCapability(device, "observe");
    const existing = this.service.store.listDesktopSessions(deviceId).find((session) => session.status !== "terminated");
    if (existing) return this.sessionView(existing.id);
    const now = new Date().toISOString();
    const session: DesktopSessionRecord = {
      id: randomUUID(), deviceId, status: "active", controlEpoch: 1, currentFrameId: null,
      lastError: null, createdAt: now, updatedAt: now, terminatedAt: null
    };
    this.service.createDesktopSession(session);
    this.enqueueObservation(session, device);
    return this.sessionView(session.id);
  }

  requestObservation(sessionId: string): DesktopSessionView {
    const session = this.requireSession(sessionId);
    if (session.status === "terminated") throw new DesktopError("SESSION_TERMINATED", "桌面会话已经终止", 409);
    const device = this.requireActiveDevice(session.deviceId);
    this.assertOnline(device);
    this.assertCapability(device, "observe");
    this.enqueueObservation(session, device);
    return this.sessionView(session.id);
  }

  pauseSession(sessionId: string): DesktopSessionView {
    const session = this.requireSession(sessionId);
    if (session.status !== "active") throw new DesktopError("SESSION_NOT_ACTIVE", "只有进行中的桌面会话可以暂停", 409);
    this.cancelPendingCommands(session, "用户暂停了桌面会话");
    const updated = this.updateSession(session, { status: "paused", controlEpoch: session.controlEpoch + 1 });
    return this.sessionView(updated.id);
  }

  resumeSession(sessionId: string): DesktopSessionView {
    const session = this.requireSession(sessionId);
    if (session.status !== "paused") throw new DesktopError("SESSION_NOT_PAUSED", "只有已暂停的桌面会话可以继续", 409);
    const device = this.requireActiveDevice(session.deviceId);
    this.assertOnline(device);
    this.assertCapability(device, "observe");
    const updated = this.updateSession(session, { status: "active", controlEpoch: session.controlEpoch + 1 });
    this.enqueueObservation(updated, device);
    return this.sessionView(updated.id);
  }

  takeOverSession(sessionId: string): DesktopSessionView {
    const session = this.requireSession(sessionId);
    if (session.status !== "active" && session.status !== "paused") {
      throw new DesktopError("SESSION_NOT_CONTROLLED", "当前会话不能由你接管", 409);
    }
    this.cancelPendingCommands(session, "用户接管了桌面会话");
    return this.sessionView(this.updateSession(session, {
      status: "taken_over",
      controlEpoch: session.controlEpoch + 1
    }).id);
  }

  releaseSession(sessionId: string): DesktopSessionView {
    const session = this.requireSession(sessionId);
    if (session.status !== "taken_over") {
      throw new DesktopError("SESSION_NOT_TAKEN_OVER", "当前会话没有被你接管", 409);
    }
    const device = this.requireActiveDevice(session.deviceId);
    this.assertOnline(device);
    this.assertCapability(device, "observe");
    const updated = this.updateSession(session, {
      status: "active",
      controlEpoch: session.controlEpoch + 1,
      currentFrameId: null
    });
    this.enqueueObservation(updated, device);
    return this.sessionView(updated.id);
  }

  terminateSession(sessionId: string): DesktopSessionView {
    const session = this.requireSession(sessionId);
    if (session.status === "terminated") return this.sessionView(session.id);
    return this.sessionView(this.terminateSessionRecord(session, "用户终止了桌面会话").id);
  }

  enqueueAction(sessionId: string, input: DesktopActionInput): DesktopCommandView {
    const session = this.requireSession(sessionId);
    if (session.status !== "active") throw new DesktopError("SESSION_NOT_ACTIVE", "桌面会话不在自动控制状态", 409);
    const device = this.requireActiveDevice(session.deviceId);
    this.assertOnline(device);
    this.assertCapability(device, "observe");
    const requiresUiAutomation = input.kind === "uia.invoke" || input.kind === "uia.setvalue";
    this.assertCapability(device, "desktop.control");
    if (requiresUiAutomation) this.assertCapability(device, "ui.automation");
    if (this.service.store.listQueuedDesktopCommands(device.id).length > 0) {
      throw new DesktopError("SESSION_BUSY", "上一项桌面命令还没有完成", 409);
    }
    const frame = this.requireCurrentFrame(session, input.frameId);
    const controlCapability = capability(device, "desktop.control");
    this.assertAppAllowed(controlCapability, frame.activeApp);
    const payload = actionPayload(input);
    if (input.kind === "focus") this.assertAppAllowed(controlCapability, normalizeApp(input.app));
    const command = this.createCommand(session, input.kind, payload, frame.id);
    this.updateSession(session, { currentFrameId: null });
    return publicCommand(command);
  }

  nextCommand(device: DeviceRecord): DesktopCommandView | null {
    this.expireStaleCommands(device.id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const command = this.service.store.nextQueuedDesktopCommand(device.id);
      if (!command) return null;
      const session = this.service.store.getDesktopSession(command.sessionId);
      if (!session || session.status === "terminated") {
        this.updateCommand(command, { status: "cancelled", error: "桌面会话已经终止", completedAt: new Date().toISOString() });
        continue;
      }
      if (command.kind !== "observe" && (session.status !== "active" || session.controlEpoch !== command.controlEpoch)) {
        this.updateCommand(command, { status: "cancelled", error: "桌面控制状态已经变化", completedAt: new Date().toISOString() });
        continue;
      }
      return publicCommand(this.updateCommand(command, { status: "claimed", updatedAt: new Date().toISOString() }));
    }
    return null;
  }

  completeCommand(device: DeviceRecord, commandId: string, input: CommandResultInput): DesktopCommandView {
    const command = this.service.store.getDesktopCommand(commandId);
    if (!command || command.deviceId !== device.id) throw new DesktopError("COMMAND_NOT_FOUND", "桌面命令不存在", 404);
    if (command.status === "succeeded" || command.status === "failed") return publicCommand(command);
    if (command.status !== "claimed") throw new DesktopError("COMMAND_NOT_CLAIMED", "桌面命令当前不能被完成", 409);
    const now = new Date().toISOString();
    const result = sanitizeResult(input.result);
    return publicCommand(this.updateCommand(command, {
      status: input.status,
      result,
      error: input.status === "failed" ? normalizeText(input.error ?? "助手执行失败", 1000, "错误") : null,
      updatedAt: now,
      completedAt: now
    }));
  }

  uploadObservation(device: DeviceRecord, input: ObservationInput): DesktopFrameView {
    const session = this.requireSession(input.sessionId);
    if (session.deviceId !== device.id) throw new DesktopError("SESSION_NOT_FOUND", "桌面会话不存在", 404);
    if (session.status === "terminated") throw new DesktopError("SESSION_TERMINATED", "桌面会话已经终止", 409);
    this.assertCapability(device, "observe");
    const observeCapability = capability(device, "observe");
    const activeApp = normalizeApp(input.activeApp);
    this.assertAppAllowed(observeCapability, activeApp);
    if (!Number.isInteger(input.width) || input.width < 1 || input.width > 10_000 || !Number.isInteger(input.height) || input.height < 1 || input.height > 10_000) {
      throw new DesktopError("INVALID_FRAME_SIZE", "截图尺寸不正确", 400);
    }
    const bytes = decodeBase64(input.jpegBase64);
    if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) {
      throw new DesktopError("FRAME_TOO_LARGE", "截图为空或超过 4 MB", 413);
    }
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new DesktopError("INVALID_FRAME", "截图必须是 JPEG 图片", 400);
    }
    const id = randomUUID();
    const directory = join(this.frameRoot, device.id);
    mkdirSync(directory, { recursive: true });
    const absolutePath = join(directory, `${id}.jpg`);
    writeFileSync(absolutePath, bytes);
    const now = new Date().toISOString();
    const frame: DesktopFrameRecord = {
      id, deviceId: device.id, sessionId: session.id, mimeType: "image/jpeg",
      width: input.width, height: input.height, sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length, storagePath: absolutePath, activeApp,
      windowTitle: normalizeText(input.windowTitle, 300, "窗口标题"), capturedAt: now,
      expiresAt: new Date(Date.now() + FRAME_TTL_MS).toISOString()
    };
    this.service.updateDesktopFrame(frame);
    this.updateSession(session, { currentFrameId: frame.id, lastError: null });
    if (input.commandId) {
      const command = this.service.store.getDesktopCommand(input.commandId);
      if (command && command.deviceId === device.id && command.sessionId === session.id && command.kind === "observe" && command.status === "claimed") {
        this.updateCommand(command, {
          status: "succeeded", result: { frameId: frame.id }, updatedAt: now, completedAt: now
        });
      }
    }
    this.cleanupFrames(device.id);
    return publicFrame(frame);
  }

  readFrame(deviceId: string, frameId: string): StoredFrame {
    const frame = this.service.store.getDesktopFrame(frameId);
    if (!frame || frame.deviceId !== deviceId) throw new DesktopError("FRAME_NOT_FOUND", "桌面截图不存在", 404);
    if (Date.parse(frame.expiresAt) <= Date.now()) throw new DesktopError("FRAME_EXPIRED", "桌面截图已经过期", 410);
    if (!existsSync(frame.storagePath)) throw new DesktopError("FRAME_UNAVAILABLE", "桌面截图已清理", 410);
    return { frame: publicFrame(frame), absolutePath: frame.storagePath };
  }

  sessionView(sessionId: string): DesktopSessionView {
    const session = this.requireSession(sessionId);
    const device = this.service.store.getDevice(session.deviceId);
    if (!device) throw new DesktopError("DEVICE_NOT_FOUND", "设备不存在", 404);
    const current = session.currentFrameId ? this.service.store.getDesktopFrame(session.currentFrameId) : null;
    return {
      session,
      device: this.deviceView(device),
      frame: current ? publicFrame(current) : null,
      frames: this.service.store.listDesktopFrames(session.id, 12).map(publicFrame),
      commands: this.service.store.listDesktopCommands(session.id, 50).map(publicCommand)
    };
  }

  private enqueueObservation(session: DesktopSessionRecord, device: DeviceRecord): DesktopCommandRecord {
    const existing = this.service.store.listQueuedDesktopCommands(device.id).find((command) => command.sessionId === session.id && command.kind === "observe");
    if (existing) return existing;
    return this.createCommand(session, "observe", {}, null);
  }

  private createCommand(
    session: DesktopSessionRecord,
    kind: DesktopCommandKind,
    payload: Record<string, unknown>,
    frameId: string | null
  ): DesktopCommandRecord {
    const now = new Date().toISOString();
    const command: DesktopCommandRecord = {
      id: randomUUID(), deviceId: session.deviceId, sessionId: session.id, kind,
      status: "queued", frameId, controlEpoch: session.controlEpoch, payload,
      result: null, error: null, createdAt: now, updatedAt: now, completedAt: null
    };
    return this.service.createDesktopCommand(command);
  }

  private updateCommand(command: DesktopCommandRecord, patch: Partial<DesktopCommandRecord>): DesktopCommandRecord {
    return this.service.updateDesktopCommand({ ...command, ...patch });
  }

  private updateSession(session: DesktopSessionRecord, patch: Partial<DesktopSessionRecord>): DesktopSessionRecord {
    return this.service.updateDesktopSession({ ...session, ...patch, updatedAt: new Date().toISOString() });
  }

  private cancelPendingCommands(session: DesktopSessionRecord, reason: string): void {
    const now = new Date().toISOString();
    for (const command of this.service.store.listQueuedDesktopCommands(session.deviceId)) {
      if (command.sessionId !== session.id) continue;
      this.updateCommand(command, { status: "cancelled", error: reason, updatedAt: now, completedAt: now });
    }
  }

  private expireStaleCommands(deviceId: string): void {
    const now = Date.now();
    for (const command of this.service.store.listQueuedDesktopCommands(deviceId)) {
      if (command.status !== "claimed") continue;
      if (now - Date.parse(command.updatedAt) <= COMMAND_TTL_MS) continue;
      this.updateCommand(command, {
        status: "expired",
        error: "桌面助手没有在时限内完成命令",
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      });
    }
  }

  private terminateSessionRecord(session: DesktopSessionRecord, reason: string): DesktopSessionRecord {
    this.cancelPendingCommands(session, reason);
    const now = new Date().toISOString();
    return this.updateSession(session, {
      status: "terminated",
      controlEpoch: session.controlEpoch + 1,
      currentFrameId: null,
      lastError: reason,
      terminatedAt: now
    });
  }

  private terminateSessionForPolicy(session: DesktopSessionRecord, reason: string): void {
    this.terminateSessionRecord(session, reason);
  }

  private pauseSessionForPolicy(session: DesktopSessionRecord, reason: string): void {
    this.cancelPendingCommands(session, reason);
    this.updateSession(session, {
      status: "paused",
      controlEpoch: session.controlEpoch + 1,
      currentFrameId: null,
      lastError: reason
    });
  }

  private requireCurrentFrame(session: DesktopSessionRecord, frameId: string): DesktopFrameRecord {
    if (!session.currentFrameId || session.currentFrameId !== frameId) {
      throw new DesktopError("FRAME_STALE", "请重新观察后再执行桌面动作", 409);
    }
    const frame = this.service.store.getDesktopFrame(frameId);
    if (!frame || frame.sessionId !== session.id || rowDateExpired(frame.expiresAt)) {
      throw new DesktopError("FRAME_STALE", "当前观察结果已经过期", 409);
    }
    return frame;
  }

  private cleanupFrames(deviceId: string): void {
    for (const session of this.service.store.listDesktopSessions(deviceId)) {
      for (const frame of this.service.store.listDesktopFrames(session.id, 50)) {
        if (!rowDateExpired(frame.expiresAt)) continue;
        if (existsSync(frame.storagePath)) {
          try {
            unlinkSync(frame.storagePath);
          } catch {
            continue;
          }
        }
      }
    }
  }

  private refreshExpiredPairings(): void {
    for (const request of this.service.store.listPairingRequests()) this.refreshPairingExpiry(request);
  }

  private refreshPairingExpiry(request: DevicePairingRequest): DevicePairingRequest {
    if (request.status !== "pending" || Date.parse(request.expiresAt) > Date.now()) return request;
    return this.updatePairing({ ...request, status: "expired", updatedAt: new Date().toISOString() });
  }

  private requirePairing(id: string): DevicePairingRequest {
    const request = this.service.store.getPairingRequest(id);
    if (!request) throw new DesktopError("PAIRING_NOT_FOUND", "配对请求不存在", 404);
    return request;
  }

  private updatePairing(request: DevicePairingRequest): DevicePairingRequest {
    return this.service.updatePairingRequest(request);
  }

  private requireSession(id: string): DesktopSessionRecord {
    const session = this.service.store.getDesktopSession(id);
    if (!session) throw new DesktopError("SESSION_NOT_FOUND", "桌面会话不存在", 404);
    return session;
  }

  private requireActiveDevice(id: string): DeviceRecord {
    const device = this.service.store.getDevice(id);
    if (!device) throw new DesktopError("DEVICE_NOT_FOUND", "设备不存在", 404);
    if (device.status === "revoked") throw new DesktopError("DEVICE_REVOKED", "设备已经撤销", 409);
    return device;
  }

  private touchDevice(device: DeviceRecord): DeviceRecord {
    const now = Date.now();
    const lastSeen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
    if (device.status === "online" && now - lastSeen < DEVICE_TOUCH_MS) return device;
    const timestamp = new Date(now).toISOString();
    return this.service.updateDevice({ ...device, status: "online", lastSeenAt: timestamp, updatedAt: timestamp });
  }

  private assertOnline(device: DeviceRecord): void {
    if (!device.lastSeenAt || Date.now() - Date.parse(device.lastSeenAt) > DEVICE_ONLINE_MS) {
      throw new DesktopError("DEVICE_OFFLINE", "设备当前不在线", 409);
    }
  }

  private assertCapability(device: DeviceRecord, kind: DeviceCapabilityKind): void {
    const item = device.capabilities.find((candidate) => candidate.kind === kind);
    if (!item || item.status !== "approved") {
      throw new DesktopError("CAPABILITY_NOT_APPROVED", `设备尚未获准使用${capabilityLabel(kind)}`, 403);
    }
  }

  private assertAppAllowed(capabilityValue: DeviceRecord["capabilities"][number], app: string): void {
    if (!capabilityValue.apps.includes(normalizeApp(app))) {
      throw new DesktopError("APP_NOT_ALLOWED", `应用 ${app} 不在已批准的白名单内`, 403);
    }
  }

  private deviceView(device: DeviceRecord): DeviceView {
    const { tokenHash: _tokenHash, ...view } = device;
    const online = device.status !== "revoked" && Boolean(device.lastSeenAt) && Date.now() - Date.parse(device.lastSeenAt as string) <= DEVICE_ONLINE_MS;
    return { ...view, online };
  }
}

function publicPairing(request: DevicePairingRequest): PairingRequestView {
  const { secretHash: _secretHash, deviceTokenHash: _deviceTokenHash, ...view } = request;
  return view;
}

function publicFrame(frame: DesktopFrameRecord): DesktopFrameView {
  const { storagePath: _storagePath, ...view } = frame;
  return { ...view, url: `/api/devices/${frame.deviceId}/frames/${frame.id}` };
}

function publicCommand(command: DesktopCommandRecord): DesktopCommandView {
  return { ...command, payload: command.payload };
}

function capability(device: DeviceRecord, kind: DeviceCapabilityKind): DeviceRecord["capabilities"][number] {
  const found = device.capabilities.find((candidate) => candidate.kind === kind);
  if (!found || found.status !== "approved") throw new DesktopError("CAPABILITY_NOT_APPROVED", "设备能力没有批准", 403);
  return found;
}

function actionPayload(input: DesktopActionInput): Record<string, unknown> {
  if (input.kind === "click") {
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.x > 1 || input.y < 0 || input.y > 1) {
      throw new DesktopError("INVALID_ACTION", "点击位置必须位于当前截图内", 400);
    }
    return { x: input.x, y: input.y, button: "left" };
  }
  if (input.kind === "type") {
    if (!input.text || input.text.length > 1000 || /[\u0000-\u001F\u007F]/.test(input.text)) {
      throw new DesktopError("INVALID_ACTION", "一次最多输入 1000 个字符，且不能包含控制字符", 400);
    }
    return { text: input.text };
  }
  if (input.kind === "press") {
    if (!ALLOWED_PRESS_KEYS.has(input.keys)) {
      throw new DesktopError("INVALID_ACTION", "这个按键组合不在低风险白名单内", 400);
    }
    return { keys: input.keys };
  }
  if (input.kind === "focus") {
    return {
      app: normalizeApp(input.app),
      windowTitle: input.windowTitle ? normalizeText(input.windowTitle, 200, "窗口标题") : ""
    };
  }
  const elementName = normalizeText(input.elementName, 200, "元素名称");
  const controlType = input.controlType ? normalizeText(input.controlType, 40, "控件类型") : "";
  if (controlType && !ALLOWED_CONTROL_TYPES.has(controlType)) {
    throw new DesktopError("INVALID_ACTION", "这个控件类型不在低风险白名单内", 400);
  }
  if (input.kind === "uia.invoke") return { elementName, controlType };
  if (input.value.length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(input.value)) {
    throw new DesktopError("INVALID_ACTION", "控件值过长或包含控制字符", 400);
  }
  return { elementName, controlType, value: input.value };
}

function normalizeCapabilities(values: DeviceCapabilityKind[]): DeviceCapabilityKind[] {
  const unique = [...new Set(values)];
  if (unique.length === 0) throw new DesktopError("CAPABILITY_REQUIRED", "配对请求至少需要一项能力", 400);
  for (const value of unique) {
    if (!DEVICE_CAPABILITY_KINDS.includes(value)) throw new DesktopError("INVALID_CAPABILITY", "设备能力类型不正确", 400);
  }
  return unique;
}

function normalizeApps(values: string[]): string[] {
  const apps = [...new Set(values.map(normalizeApp).filter(Boolean))];
  if (apps.length === 0) throw new DesktopError("APP_REQUIRED", "至少需要批准一个应用或窗口", 400);
  if (apps.length > 30) throw new DesktopError("TOO_MANY_APPS", "一次最多批准 30 个应用", 400);
  for (const app of apps) {
    if (!APP_PATTERN.test(app)) throw new DesktopError("INVALID_APP", `应用名称不正确：${app}`, 400);
  }
  return apps;
}

function normalizeApp(value: string): string {
  return value.trim().toLowerCase().replace(/\.exe$/, "");
}

function normalizeText(value: string, maxLength: number, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DesktopError("INVALID_INPUT", `${label}不能为空`, 400);
  if (normalized.length > maxLength) throw new DesktopError("INVALID_INPUT", `${label}超过 ${maxLength} 个字符`, 400);
  return normalized;
}

function sanitizeResult(result: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!result) return null;
  const serialized = JSON.stringify(result);
  if (serialized.length > 20_000) throw new DesktopError("RESULT_TOO_LARGE", "命令结果过大", 400);
  return JSON.parse(serialized) as Record<string, unknown>;
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/^data:image\/jpeg;base64,/, "");
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new DesktopError("INVALID_FRAME", "截图编码不正确", 400);
  }
  return Buffer.from(normalized, "base64");
}

function rowDateExpired(value: string): boolean {
  return Date.parse(value) <= Date.now();
}

function capabilityLabel(kind: DeviceCapabilityKind): string {
  if (kind === "observe") return "桌面观察";
  if (kind === "desktop.control") return "桌面控制";
  return "UI 自动化";
}

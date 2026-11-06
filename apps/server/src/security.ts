import { randomUUID } from "node:crypto";
import type { HearthService } from "./service.ts";

export interface SecurityState {
  killSwitch: boolean;
  reason: string | null;
  updatedAt: string | null;
}

export interface SecurityAudit {
  id: string;
  action: string;
  subjectId: string | null;
  subjectLabel: string | null;
  detail: string;
  at: string;
}

export interface SecuritySnapshot {
  state: SecurityState;
  audits: SecurityAudit[];
}

export class SecurityError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "SecurityError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const KILL_SWITCH_META_KEY = "security.killSwitch";

export class SecurityService {
  private readonly service: HearthService;
  private readonly clock: () => Date;

  constructor(service: HearthService, options: { clock?: () => Date } = {}) {
    this.service = service;
    this.clock = options.clock ?? (() => new Date());
  }

  state(): SecurityState {
    const raw = this.service.store.getMeta(KILL_SWITCH_META_KEY);
    if (!raw) return { killSwitch: false, reason: null, updatedAt: null };
    try {
      const parsed = JSON.parse(raw) as Partial<SecurityState>;
      return {
        killSwitch: parsed.killSwitch === true,
        reason: typeof parsed.reason === "string" ? parsed.reason : null,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
      };
    } catch {
      return { killSwitch: false, reason: null, updatedAt: null };
    }
  }

  setKillSwitch(enabled: boolean, reason?: string): SecurityState {
    const current = this.state();
    if (current.killSwitch === enabled) return current;
    const state: SecurityState = {
      killSwitch: enabled,
      reason: enabled ? (reason?.trim() || "用户启用了全局停止") : null,
      updatedAt: this.clock().toISOString()
    };
    this.service.store.setMeta(KILL_SWITCH_META_KEY, JSON.stringify(state));
    this.emit("security.kill-switch.updated", state);
    this.record(
      enabled ? "security.kill-switch.enabled" : "security.kill-switch.disabled",
      null,
      null,
      state.reason ?? "全局动作限制已解除"
    );
    return state;
  }

  assertActionsAllowed(): void {
    const state = this.state();
    if (state.killSwitch) {
      throw new SecurityError("KILL_SWITCH_ACTIVE", state.reason ? `全局停止已启用：${state.reason}` : "全局停止已启用", 423);
    }
  }

  record(action: string, subjectId: string | null, subjectLabel: string | null, detail: string): SecurityAudit {
    const audit: SecurityAudit = {
      id: randomUUID(),
      action,
      subjectId,
      subjectLabel,
      detail,
      at: this.clock().toISOString()
    };
    this.emit("security.audit", audit);
    return audit;
  }

  snapshot(): SecuritySnapshot {
    const audits = this.service.store.listEvents()
      .filter((event) => event.type === "security.audit")
      .map((event) => event.payload as SecurityAudit)
      .slice(-50)
      .reverse();
    return { state: this.state(), audits };
  }

  private emit(type: string, payload: unknown): void {
    const event = this.service.store.appendEvent({ type, payload });
    this.service.bus.publish(event);
  }
}

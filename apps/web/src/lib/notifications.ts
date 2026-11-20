import type { EventEnvelope } from "./types.ts";

export type NotificationTone = "approval" | "effect";

export interface AppNotification {
  key: string;
  tone: NotificationTone;
  title: string;
  body: string;
  href: string;
}

const DESKTOP_KEY = "hearth.notifications.desktop";

export function notificationForEvent(event: string, envelope?: EventEnvelope): AppNotification | null {
  if (!envelope) return null;
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const key = envelope.id || `${event}:${envelope.seq}:${envelope.createdAt}`;

  if (event === "approval.created") {
    if (payload.status !== "pending") return null;
    const summary = typeof payload.summary === "string" ? payload.summary : "外部动作需要你的确认";
    return {
      key,
      tone: "approval",
      title: "有一项外部动作等你确认",
      body: summary,
      href: "/"
    };
  }

  if (event === "effect.updated") {
    if (payload.status !== "uncertain") return null;
    return {
      key,
      tone: "effect",
      title: "外部动作结果不确定",
      body: "先核对目标系统是否已经生效，再决定是否重试。",
      href: "/"
    };
  }

  return null;
}

export function desktopNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(DESKTOP_KEY) === "on";
  } catch {
    return false;
  }
}

export function setDesktopNotificationsEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(DESKTOP_KEY, "on");
    else localStorage.removeItem(DESKTOP_KEY);
  } catch {
    // Storage may be unavailable in private browsing.
  }
}

export async function requestDesktopPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

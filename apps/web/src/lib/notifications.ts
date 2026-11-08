import type { EventEnvelope } from "./types.ts";

export type NotificationTone = "approval" | "suggestion" | "task" | "effect";

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
  const taskId = typeof payload.taskId === "string" ? payload.taskId : envelope.taskId;

  if (event === "approval.created") {
    if (payload.status !== "pending") return null;
    const summary = typeof payload.summary === "string" ? payload.summary : "外部动作需要你的确认";
    return {
      key,
      tone: "approval",
      title: "有一项外部动作等你确认",
      body: summary,
      href: taskId ? `/tasks/${encodeURIComponent(taskId)}` : "/tasks"
    };
  }

  if (event === "suggestion.event") {
    if (payload.action !== "delivered") return null;
    const title = typeof payload.title === "string" ? payload.title : "有一条主动建议";
    const whyNow = typeof payload.whyNow === "string" ? payload.whyNow : "打开“需要你”查看建议和依据。";
    return { key, tone: "suggestion", title, body: whyNow, href: "/inbox" };
  }

  if (event === "task.updated") {
    if (payload.status !== "waiting_input") return null;
    return {
      key,
      tone: "task",
      title: "任务需要你补充信息",
      body: "执行器停在一个需要判断的位置，打开任务继续。",
      href: taskId ? `/tasks/${encodeURIComponent(taskId)}` : "/tasks"
    };
  }

  if (event === "effect.updated") {
    if (payload.status !== "uncertain") return null;
    return {
      key,
      tone: "effect",
      title: "外部动作结果不确定",
      body: "先核对目标系统是否已经生效，再决定是否重试。",
      href: taskId ? `/tasks/${encodeURIComponent(taskId)}` : "/tasks"
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
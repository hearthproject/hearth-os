import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BellRing, CheckCircle2, ShieldAlert, Sparkles, X } from "lucide-react";
import { subscribeToEvents } from "../lib/api.ts";
import { desktopNotificationsEnabled, notificationForEvent, type AppNotification } from "../lib/notifications.ts";

const ICONS = {
  approval: ShieldAlert,
  suggestion: Sparkles,
  task: BellRing,
  effect: CheckCircle2
} as const;

export function NotificationCenter() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const timers = new Map<string, number>();
    const dismiss = (key: string) => {
      setItems((current) => current.filter((item) => item.key !== key));
      const timer = timers.get(key);
      if (timer) window.clearTimeout(timer);
      timers.delete(key);
    };
    const unsubscribe = subscribeToEvents((event, envelope) => {
      const notification = notificationForEvent(event, envelope);
      if (!notification || seen.current.has(notification.key)) return;
      seen.current.add(notification.key);
      if (seen.current.size > 100) {
        const oldest = seen.current.values().next().value;
        if (oldest) seen.current.delete(oldest);
      }
      setItems((current) => [notification, ...current].slice(0, 3));
      timers.set(notification.key, window.setTimeout(() => dismiss(notification.key), 9_000));
      if (desktopNotificationsEnabled() && typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
        new Notification(notification.title, { body: notification.body, tag: notification.key });
      }
    });
    return () => {
      unsubscribe();
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="notification-stack" aria-live="polite" aria-label="通知">
      {items.map((notification) => {
        const Icon = ICONS[notification.tone];
        return (
          <div key={notification.key} className={`notification-toast ${notification.tone}`}>
            <Link to={notification.href} className="notification-main" onClick={() => setItems((current) => current.filter((item) => item.key !== notification.key))}>
              <span className="notification-icon"><Icon size={16} /></span>
              <span className="notification-copy">
                <strong>{notification.title}</strong>
                <small>{notification.body}</small>
              </span>
            </Link>
            <button
              className="notification-close"
              aria-label="关闭通知"
              onClick={() => setItems((current) => current.filter((item) => item.key !== notification.key))}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
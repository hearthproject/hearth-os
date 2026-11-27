interface TauriInternals {
  __TAURI_INTERNALS__?: {
    invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

export function hasDesktopBridge(): boolean {
  return Boolean((window as unknown as TauriInternals).__TAURI_INTERNALS__?.invoke);
}

/**
 * 在系统默认浏览器里打开一个预览地址。桌面壳提供 open_external_url 命令；
 * 纯网页环境退回 window.open，保证两条路径都能用。
 */
export async function openInBrowser(url: string): Promise<void> {
  const target = /^https?:\/\//i.test(url) ? url : new URL(url, window.location.origin).toString();
  const internal = (window as unknown as TauriInternals).__TAURI_INTERNALS__;
  if (internal?.invoke) {
    try {
      await internal.invoke("open_external_url", { url: target });
      return;
    } catch {
      // 旧版桌面壳没有注册这个命令时，继续走 window.open。
    }
  }
  const opened = window.open(target, "_blank", "noopener,noreferrer");
  if (!opened) throw new Error("浏览器阻止了打开新窗口，请允许弹窗后重试");
}

export async function pickFolder(): Promise<string | null> {
  const internal = (window as unknown as TauriInternals).__TAURI_INTERNALS__;
  if (!internal?.invoke) return null;
  const picked = await internal.invoke("pick_folder");
  return typeof picked === "string" && picked.trim() ? picked : null;
}

/**
 * Tauri rejects with strings, not Error instances. Surfacing only
 * `caught instanceof Error` hides ACL/permission failures behind a generic
 * message, so normalize both shapes before showing anything to the user.
 */
export function desktopErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof Error && caught.message.trim()) return caught.message.trim();
  if (typeof caught === "string" && caught.trim()) return caught.trim();
  if (caught && typeof caught === "object" && "message" in caught) {
    const message = (caught as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return fallback;
}
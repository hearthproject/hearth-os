interface TauriInternals {
  __TAURI_INTERNALS__?: {
    invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

export function hasDesktopBridge(): boolean {
  return Boolean((window as unknown as TauriInternals).__TAURI_INTERNALS__?.invoke);
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
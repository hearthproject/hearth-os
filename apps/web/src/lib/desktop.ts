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
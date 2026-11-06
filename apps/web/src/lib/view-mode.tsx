import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ViewMode = "simple" | "pro";

const STORAGE_KEY = "hearth.view-mode";

export function resolveViewMode(stored: string | null, urlOverride: string | null = null): ViewMode {
  if (urlOverride === "simple" || urlOverride === "pro") return urlOverride;
  return stored === "pro" ? "pro" : "simple";
}

export function shouldPersistViewMode(urlOverride: string | null): boolean {
  return urlOverride !== "simple" && urlOverride !== "pro";
}

function readStoredMode(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // Safari 隐私模式下 localStorage 会抛错，降级为简单版
  }
}

function readUrlOverride(): string | null {
  return new URLSearchParams(window.location.search).get("mode");
}

interface ViewModeContextValue {
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
  toggle: () => void;
}

const ViewModeContext = createContext<ViewModeContextValue | null>(null);

export function ViewModeProvider({ children }: { children: ReactNode }) {
  const [urlOverride] = useState(readUrlOverride);
  const [mode, setModeState] = useState<ViewMode>(() => resolveViewMode(readStoredMode(), urlOverride));

  const setMode = useCallback((next: ViewMode) => {
    setModeState(next);
    if (!shouldPersistViewMode(urlOverride)) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 写入失败只影响下次打开时的默认值
    }
  }, [urlOverride]);

  const toggle = useCallback(() => {
    setMode(mode === "pro" ? "simple" : "pro");
  }, [mode, setMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.key.toLowerCase() !== "m") return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || (target && /^(input|textarea|select)$/i.test(target.tagName))) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  const value = useMemo<ViewModeContextValue>(() => ({ mode, setMode, toggle }), [mode, setMode, toggle]);
  return <ViewModeContext.Provider value={value}>{children}</ViewModeContext.Provider>;
}

export function useViewMode(): ViewModeContextValue {
  const context = useContext(ViewModeContext);
  if (!context) throw new Error("useViewMode 必须在 ViewModeProvider 内使用");
  return context;
}

export function ProOnly({ children }: { children: ReactNode }) {
  const { mode } = useViewMode();
  return mode === "pro" ? <>{children}</> : null;
}

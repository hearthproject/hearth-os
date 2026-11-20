import { useEffect, useState } from "react";
import { ArrowRight, Search, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { NAV_ITEMS, matchesNavItem } from "../lib/navigation.ts";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const navMatches = NAV_ITEMS.filter((item) => matchesNavItem(item, query));
  const hasResults = navMatches.length > 0;

  function go(path: string) {
    navigate(path);
    onClose();
  }

  return (
    <div className="command-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="command-dialog" role="dialog" aria-modal="true" aria-label="搜索">
        <div className="command-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索"
            autoFocus
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              if (navMatches[0]) go(navMatches[0].path);
            }}
          />
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={15} /></button>
        </div>
        <div className="command-results">
          {!hasResults && <p className="command-empty">没有结果</p>}
          {navMatches.length > 0 && (
            <section className="command-group">
              <h3>页面</h3>
              {navMatches.map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.path} className="command-item" onClick={() => go(item.path)}>
                    <Icon size={14} />
                    <span><strong>{item.label}</strong></span>
                    <ArrowRight size={13} />
                  </button>
                );
              })}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

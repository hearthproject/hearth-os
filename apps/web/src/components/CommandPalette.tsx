import { useEffect, useState } from "react";
import { ArrowRight, Search, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { TASK_STATUS_LABELS } from "../lib/labels.ts";
import { NAV_ITEMS, matchesNavItem } from "../lib/navigation.ts";
import type { TaskListItem } from "../lib/types.ts";

interface CommandPaletteProps {
  open: boolean;
  tasks: TaskListItem[];
  onClose: () => void;
}

export function CommandPalette({ open, tasks, onClose }: CommandPaletteProps) {
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
  const taskMatches = tasks
    .filter((task) => !task.archivedAt)
    .filter((task) => {
      const normalized = query.trim().toLowerCase();
      return !normalized
        || task.title.toLowerCase().includes(normalized)
        || task.id.toLowerCase().includes(normalized);
    })
    .sort((a, b) => Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt)));
  const hasResults = navMatches.length > 0 || taskMatches.length > 0;

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
              else if (taskMatches[0]) go(`/tasks/${taskMatches[0].id}`);
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
          {taskMatches.length > 0 && (
            <section className="command-group">
              <h3>任务</h3>
              {taskMatches.slice(0, 12).map((task) => (
                <button key={task.id} className="command-item" onClick={() => go(`/tasks/${task.id}`)}>
                  <span className={`command-task-dot ${task.status}`} />
                  <span><strong>{task.title}</strong><small>{TASK_STATUS_LABELS[task.status]}</small></span>
                  <ArrowRight size={13} />
                </button>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

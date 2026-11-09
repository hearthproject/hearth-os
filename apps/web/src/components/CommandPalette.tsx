import { useEffect, useState } from "react";
import { ArrowRight, Command, Search, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { TASK_STATUS_LABELS } from "../lib/labels.ts";
import type { TaskListItem } from "../lib/types.ts";

interface CommandPaletteProps {
  open: boolean;
  tasks: TaskListItem[];
  onClose: () => void;
}

const NAV_ITEMS = [
  { label: "聊天", detail: "问答与派发任务", path: "/" },
  { label: "任务", detail: "查看全部任务与运行状态", path: "/tasks" },
  { label: "需要你", detail: "审批、接管与主动建议", path: "/inbox" },
  { label: "设备", detail: "设备、桌面与远程能力", path: "/devices" },
  { label: "定时任务", detail: "周期执行与运行记录", path: "/schedules" },
  { label: "邮件", detail: "邮箱连接与同步", path: "/mail" },
  { label: "设置", detail: "模型、执行器与存储", path: "/settings" }
];

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

  const normalized = query.trim().toLowerCase();
  const navMatches = NAV_ITEMS.filter((item) => !normalized
    || item.label.toLowerCase().includes(normalized)
    || item.detail.toLowerCase().includes(normalized));
  const taskMatches = tasks
    .filter((task) => !task.archivedAt)
    .filter((task) => !normalized
      || task.title.toLowerCase().includes(normalized)
      || task.id.toLowerCase().includes(normalized))
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
      <div className="command-dialog" role="dialog" aria-modal="true" aria-label="快速跳转">
        <div className="command-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索页面或任务…"
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
          {!hasResults && <p className="command-empty">没有匹配的页面或任务。</p>}
          {navMatches.length > 0 && (
            <section className="command-group">
              <h3>页面</h3>
              {navMatches.map((item) => (
                <button key={item.path} className="command-item" onClick={() => go(item.path)}>
                  <Command size={14} />
                  <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                  <ArrowRight size={13} />
                </button>
              ))}
            </section>
          )}
          {taskMatches.length > 0 && (
            <section className="command-group">
              <h3>任务 · {taskMatches.length}</h3>
              {taskMatches.slice(0, 12).map((task) => (
                <button key={task.id} className="command-item" onClick={() => go(`/tasks/${task.id}`)}>
                  <span className={`command-task-dot ${task.status}`} />
                  <span><strong>{task.title}</strong><small>{task.pinnedAt ? "已置顶 · " : ""}{TASK_STATUS_LABELS[task.status]} · {task.id.slice(0, 8)}</small></span>
                  <ArrowRight size={13} />
                </button>
              ))}
            </section>
          )}
        </div>
        <div className="command-footer"><span>Enter 打开第一项</span><span>Esc 关闭</span><span>Ctrl/⌘ + K</span></div>
      </div>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { Brain, Cable, CalendarDays, FileText, Inbox, Lightbulb, Mail, Monitor, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles } from "lucide-react";
import { NavLink, Outlet, useNavigate, useOutletContext } from "react-router-dom";
import { useState } from "react";
import { api } from "../lib/api.ts";
import { needsAttention } from "../lib/format.ts";
import type { TaskRecord } from "../lib/types.ts";
import { HearthMark } from "./HearthMark.tsx";
import { NewTaskModal } from "./NewTaskModal.tsx";
import { Topbar } from "./Topbar.tsx";

export interface ShellContext {
  openNewTask: () => void;
}

export function useShell(): ShellContext {
  return useOutletContext<ShellContext>();
}

export function AppShell() {
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const navigate = useNavigate();
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 10_000 });
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const proactiveQuery = useQuery({ queryKey: ["proactive"], queryFn: api.proactive, refetchInterval: 15_000 });
  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: api.templates, enabled: newTaskOpen });
  const attentionCount = (tasksQuery.data?.tasks ?? []).filter((task) => needsAttention(task.status)).length;
  const proactiveCount = (proactiveQuery.data?.suggestions ?? []).filter((suggestion) =>
    ["new", "snoozed", "accepted"].includes(suggestion.status)
  ).length;
  const codex = healthQuery.data?.codex;

  function handleCreated(task: TaskRecord) {
    setNewTaskOpen(false);
    navigate(`/tasks/${task.id}`);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <HearthMark size={22} />
          <span className="brand-name">Hearth</span>
        </div>

        <button className="sidebar-create" onClick={() => setNewTaskOpen(true)}>
          <Plus size={16} /> <span className="nav-label">新建任务</span>
        </button>

        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
            <CalendarDays size={16} /> <span className="nav-label">今天</span>
          </NavLink>
          <NavLink to="/inbox" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
            <Lightbulb size={16} /> <span className="nav-label">主动收件箱</span>
            {proactiveCount > 0 && <span className="nav-badge">{proactiveCount}</span>}
          </NavLink>
          <NavLink to="/attention" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
            <Inbox size={16} /> <span className="nav-label">需要你</span>
            {attentionCount > 0 && <span className="nav-badge">{attentionCount}</span>}
          </NavLink>
          <NavLink to="/memory" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
            <Brain size={16} /> <span className="nav-label">记忆</span>
          </NavLink>
          <NavLink to="/methods" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
            <Sparkles size={16} /> <span className="nav-label">方法进化</span>
          </NavLink>
          <NavLink to="/artifacts" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
            <FileText size={16} /> <span className="nav-label">产物</span>
          </NavLink>
          <NavLink to="/outbox" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
            <Mail size={16} /> <span className="nav-label">发件箱</span>
          </NavLink>
          <NavLink to="/sources" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
            <Cable size={16} /> <span className="nav-label">来源</span>
          </NavLink>
          <NavLink to="/devices" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
            <Monitor size={16} /> <span className="nav-label">设备</span>
          </NavLink>
          <NavLink to="/sync" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
            <RefreshCw size={16} /> <span className="nav-label">同步</span>
          </NavLink>
          <NavLink to="/security" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
            <ShieldCheck size={16} /> <span className="nav-label">安全</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
            <Settings2 size={16} /> <span className="nav-label">设置</span>
          </NavLink>
        </nav>

        <div className="sidebar-spacer" />

        <NavLink to="/settings" className="codex-status">
          <span className={`status-dot ${codex?.canRun ? "online" : "offline"}`} />
          <span>
            <strong>{codex?.canRun ? "执行器可用" : "执行器不可用"}</strong>
            <small>{codex ? `${codex.providerName} · ${codex.model ?? "默认模型"}` : "读取本机配置中"}</small>
          </span>
        </NavLink>
        <p className="sidebar-note">仅监听 127.0.0.1</p>
      </aside>

      <main className="main">
        <Topbar />
        <div className="main-body">
          <Outlet context={{ openNewTask: () => setNewTaskOpen(true) } satisfies ShellContext} />
        </div>
      </main>

      <NewTaskModal
        open={newTaskOpen}
        templates={templatesQuery.data?.templates ?? []}
        onClose={() => setNewTaskOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  );
}

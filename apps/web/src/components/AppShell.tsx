import { useQuery } from "@tanstack/react-query";
import { Flame, Inbox, Package, Plus, Settings2, Sun } from "lucide-react";
import { NavLink, Outlet, useNavigate, useOutletContext } from "react-router-dom";
import { useState } from "react";
import { api } from "../lib/api.ts";
import { needsAttention } from "../lib/format.ts";
import type { TaskRecord, TaskTemplate } from "../lib/types.ts";
import { NewTaskModal } from "./NewTaskModal.tsx";

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
  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: api.templates, enabled: newTaskOpen });
  const tasks = tasksQuery.data?.tasks ?? [];
  const attentionCount = tasks.filter((task) => needsAttention(task.status)).length;

  function handleCreated(task: TaskRecord) {
    setNewTaskOpen(false);
    navigate(`/tasks/${task.id}`);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Flame size={21} strokeWidth={1.8} /></span>
          <span className="brand-name">Hearth</span>
          <span className="brand-tag">LOCAL</span>
        </div>

        <button className="sidebar-create" onClick={() => setNewTaskOpen(true)}>
          <Plus size={17} /> 新建任务
        </button>

        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}>
            <Sun size={18} /> 今天
          </NavLink>
          <NavLink to="/attention" className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}>
            <Inbox size={18} /> 需要你
            {attentionCount > 0 && <span className="nav-badge">{attentionCount}</span>}
          </NavLink>
          <NavLink to="/artifacts" className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}>
            <Package size={18} /> 产物
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}>
            <Settings2 size={18} /> 设置
          </NavLink>
        </nav>

        <div className="sidebar-spacer" />
        <NavLink to="/settings" className="codex-status">
          <span className={`status-dot ${healthQuery.data?.codex.canRun ? "online" : "offline"}`} />
          <span>
            <strong>{healthQuery.data?.codex.canRun ? "Codex 已连接" : "Codex 待连接"}</strong>
            <small>{healthQuery.data?.codex.providerName ?? "检查本地配置"}</small>
          </span>
        </NavLink>
        <p className="sidebar-note">所有任务在本机执行<br />数据不会离开这台电脑</p>
      </aside>

      <main className="main">
        <Outlet context={{ openNewTask: () => setNewTaskOpen(true) } satisfies ShellContext} />
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

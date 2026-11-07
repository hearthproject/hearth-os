import { useQuery } from "@tanstack/react-query";
import { CalendarClock, ListChecks, MessageCircle, Monitor, Settings2 } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "../lib/api.ts";
import { isActive, needsAttention } from "../lib/format.ts";
import { HearthMark } from "./HearthMark.tsx";

export function AppShell() {
  const { pathname } = useLocation();
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 10_000 });
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const tasks = tasksQuery.data?.tasks ?? [];
  const activeCount = tasks.filter((task) => isActive(task.status) || needsAttention(task.status)).length;
  const codex = healthQuery.data?.codex;
  const chatModel = healthQuery.data?.chatModel;
  const chatMode = pathname === "/";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <HearthMark size={22} />
          <span className="brand-name">Hearth</span>
        </div>

        <nav className="nav">
          <NavLink to="/" end className={({ isActive: active }) => (active ? "nav-item active" : "nav-item")}>
            <MessageCircle size={16} /> <span className="nav-label">聊天</span>
          </NavLink>
          <NavLink to="/tasks" className={({ isActive: active }) => (active ? "nav-item active" : "nav-item")}>
            <ListChecks size={16} /> <span className="nav-label">任务</span>
            {activeCount > 0 && <span className="nav-badge">{activeCount}</span>}
          </NavLink>
          <NavLink to="/devices" className={({ isActive: active }) => (active ? "nav-item active" : "nav-item")}>
            <Monitor size={16} /> <span className="nav-label">设备</span>
          </NavLink>
          <NavLink to="/schedules" className={({ isActive: active }) => (active ? "nav-item active" : "nav-item")}>
            <CalendarClock size={16} /> <span className="nav-label">定时任务</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive: active }) => (active ? "nav-item active" : "nav-item")}>
            <Settings2 size={16} /> <span className="nav-label">设置</span>
          </NavLink>
        </nav>

        <div className="sidebar-spacer" />

        <NavLink to="/settings" className="codex-status">
          <span className={`status-dot ${chatModel?.configured ? "online" : "offline"}`} />
          <span>
            <strong>{chatModel?.configured ? "聊天模型已接入" : "聊天模型未配置"}</strong>
            <small>{chatModel?.configured ? `${chatModel.settings.providerName} · ${chatModel.settings.model}` : "到设置里接入"}</small>
          </span>
        </NavLink>

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
        <div className={`main-body ${chatMode ? "chat-body" : ""}`}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

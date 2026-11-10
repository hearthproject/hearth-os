import { useQuery } from "@tanstack/react-query";
import { Activity, CalendarClock, Command, Inbox, ListChecks, Mail, MessageCircle, Monitor, Settings2, UserRound } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "../lib/api.ts";
import { isActive, needsAttention } from "../lib/format.ts";
import { HearthMark } from "./HearthMark.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { useEffect, useState } from "react";

export function AppShell() {
  const { pathname } = useLocation();
  const [commandOpen, setCommandOpen] = useState(false);
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 10_000 });
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const executorsQuery = useQuery({ queryKey: ["executors"], queryFn: api.executors, refetchInterval: 30_000 });
  const proactiveQuery = useQuery({ queryKey: ["proactive"], queryFn: api.proactive, refetchInterval: 15_000 });
  const attentionQuery = useQuery({ queryKey: ["attention"], queryFn: api.attention, refetchInterval: 15_000 });
  const reconcileQuery = useQuery({ queryKey: ["reconcile"], queryFn: () => api.reconcile(), refetchInterval: 15_000 });
  const tasks = tasksQuery.data?.tasks ?? [];
  const activeCount = tasks.filter((task) => !task.archivedAt && (isActive(task.status) || needsAttention(task.status))).length;
  const reconcileCount = (reconcileQuery.data?.items ?? [])
    .filter((item) => ["open", "checking", "needs_human", "conflicting"].includes(item.status)).length;
  const attentionCount = (attentionQuery.data?.items ?? []).filter((item) => item.waitingOn === "user").length;
  const needsYouCount = Math.max(
    attentionCount,
    (proactiveQuery.data?.suggestions ?? []).filter((suggestion) => ["new", "snoozed", "accepted"].includes(suggestion.status)).length + reconcileCount
  );
  const chatModel = healthQuery.data?.chatModel;
  const readyExecutors = (executorsQuery.data?.executors ?? []).filter((executor) => executor.health.canRun);
  const primaryExecutor = readyExecutors.find((executor) => executor.id === "native")
    ?? readyExecutors.find((executor) => executor.id === "codex")
    ?? readyExecutors[0]
    ?? null;
  const chatMode = pathname === "/";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <HearthMark size={22} />
          <span className="brand-name">Hearth</span>
        </div>

        <button className="command-trigger" onClick={() => setCommandOpen(true)} title="快速跳转（Ctrl/⌘ + K）">
          <Command size={15} />
          <span>快速跳转</span>
          <kbd>Ctrl K</kbd>
        </button>

        <nav className="nav">
          <NavLink to="/" end className={({ isActive: active }) => (active ? "nav-item active" : "nav-item")}>
            <MessageCircle size={18} /> <span className="nav-label">聊天</span>
          </NavLink>
          <NavLink to="/tasks" className={({ isActive: active }) => (active ? "nav-item active" : "nav-item")}>
            <ListChecks size={18} /> <span className="nav-label">任务</span>
            {activeCount > 0 && <span className="nav-badge">{activeCount}</span>}
          </NavLink>
          <NavLink to="/inbox" className={({ isActive: active }) => (active ? "nav-item active" : "nav-item")}>
            <Inbox size={18} /> <span className="nav-label">需要你</span>
            {needsYouCount > 0 && <span className="nav-badge">{needsYouCount}</span>}
          </NavLink>
          <NavLink to="/personal" className={({ isActive: active }) => (active ? "nav-item active" : "nav-item")}>
            <UserRound size={18} /> <span className="nav-label">个人</span>
          </NavLink>
          <NavLink to="/runtime" className={({ isActive: active }) => (active ? "nav-item active" : "nav-item")}>
            <Activity size={18} /> <span className="nav-label">运行</span>
          </NavLink>
          <NavLink to="/devices" className={({ isActive: active }) => (active ? "nav-item active" : "nav-item")}>
            <Monitor size={18} /> <span className="nav-label">设备</span>
          </NavLink>
          <NavLink to="/schedules" className={({ isActive: active }) => (active ? "nav-item active" : "nav-item")}>
            <CalendarClock size={18} /> <span className="nav-label">定时任务</span>
          </NavLink>
          <NavLink to="/mail" className={({ isActive: active }) => (active ? "nav-item active" : "nav-item")}>
            <Mail size={18} /> <span className="nav-label">邮件</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive: active }) => (active ? "nav-item active" : "nav-item")}>
            <Settings2 size={18} /> <span className="nav-label">设置</span>
          </NavLink>
        </nav>

        <div className="sidebar-spacer" />

        <NavLink to={chatModel?.configured ? "/settings" : "/welcome"} className="codex-status">
          <span className={`status-dot ${chatModel?.configured ? "online" : "offline"}`} />
          <span>
            <strong>{chatModel?.configured ? "聊天模型已接入" : "聊天模型未配置"}</strong>
            <small>{chatModel?.configured ? `${chatModel.settings.providerName} · ${chatModel.settings.model}` : "开始设置"}</small>
          </span>
        </NavLink>

        <NavLink to="/settings" className="codex-status">
          <span className={`status-dot ${primaryExecutor ? "online" : "offline"}`} />
          <span>
            <strong>{primaryExecutor ? "执行器可用" : "执行器不可用"}</strong>
            <small>{primaryExecutor ? `${primaryExecutor.name} · 已就绪` : executorsQuery.isLoading ? "读取执行器…" : "到设置里检查"}</small>
          </span>
        </NavLink>
        <p className="sidebar-note">仅监听 127.0.0.1</p>
      </aside>

      <main className="main">
        <div className={`main-body ${chatMode ? "chat-body" : ""}`}>
          <Outlet />
        </div>
      </main>

      <nav className="mobile-nav" aria-label="移动端导航">
        <NavLink to="/" end className={({ isActive: active }) => (active ? "mobile-nav-item active" : "mobile-nav-item")}>
          <MessageCircle size={19} /><span>聊天</span>
        </NavLink>
        <NavLink to="/tasks" className={({ isActive: active }) => (active ? "mobile-nav-item active" : "mobile-nav-item")}>
          <ListChecks size={19} /><span>任务</span>
          {activeCount > 0 && <span className="mobile-nav-badge">{activeCount}</span>}
        </NavLink>
        <NavLink to="/inbox" className={({ isActive: active }) => (active ? "mobile-nav-item active" : "mobile-nav-item")}>
          <Inbox size={19} /><span>需要你</span>
          {needsYouCount > 0 && <span className="mobile-nav-badge">{needsYouCount}</span>}
        </NavLink>
        <NavLink to="/settings" className={({ isActive: active }) => (active ? "mobile-nav-item active" : "mobile-nav-item")}>
          <Settings2 size={19} /><span>设置</span>
        </NavLink>
        <button className="mobile-nav-item" onClick={() => setCommandOpen(true)}>
          <Command size={19} /><span>更多</span>
        </button>
      </nav>
      <CommandPalette open={commandOpen} tasks={tasks} onClose={() => setCommandOpen(false)} />
    </div>
  );
}

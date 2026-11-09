import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ClipboardCheck,
  FlaskConical,
  Flame,
  GitCompareArrows,
  LayoutDashboard,
  LibraryBig,
  Menu,
  Settings2,
  X
} from "lucide-react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "../lib/api.ts";

const NAV_ITEMS = [
  { to: "/", label: "总览", icon: LayoutDashboard, end: true },
  { to: "/cases", label: "任务目录", icon: LibraryBig },
  { to: "/experiments", label: "实验", icon: FlaskConical },
  { to: "/reviews", label: "复核队列", icon: ClipboardCheck, badge: "reviews" as const },
  { to: "/compare", label: "对比", icon: GitCompareArrows },
  { to: "/activity", label: "活动流", icon: Activity },
  { to: "/system", label: "系统", icon: Settings2 }
];

const TITLES: Array<[RegExp, string]> = [
  [/^\/$/, "总览"],
  [/^\/cases\/[^/]+$/, "任务详情"],
  [/^\/cases$/, "任务目录"],
  [/^\/experiments\/new$/, "新建实验"],
  [/^\/experiments\/[^/]+$/, "实验详情"],
  [/^\/experiments$/, "实验"],
  [/^\/runs\/[^/]+$/, "运行详情"],
  [/^\/reviews$/, "复核队列"],
  [/^\/compare$/, "实验对比"],
  [/^\/activity$/, "活动流"],
  [/^\/system$/, "系统状态"]
];

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const systemQuery = useQuery({ queryKey: ["system"], queryFn: api.system, refetchInterval: 10_000 });
  const system = systemQuery.data;
  const title = TITLES.find(([pattern]) => pattern.test(location.pathname))?.[1] ?? "评测台";

  return (
    <div className="app-frame">
      {mobileOpen && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />}
      <aside className={`sidebar ${mobileOpen ? "is-open" : ""}`}>
        <Link className="brand" to="/" onClick={() => setMobileOpen(false)}>
          <span className="brand-mark"><Flame size={16} strokeWidth={2} /></span>
          <span className="brand-copy">
            <strong>Hearth</strong>
            <small>Evaluation</small>
          </span>
        </Link>

        <nav className="side-nav" aria-label="主导航">
          {NAV_ITEMS.map((item) => (
            <NavItem
              key={item.to}
              item={item}
              pending={item.badge === "reviews" ? system?.pendingReviews ?? 0 : 0}
              onNavigate={() => setMobileOpen(false)}
            />
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="service-row">
            <span className={`service-dot ${system?.hearthReachable ? "online" : "offline"}`} />
            <strong>{system?.hearthReachable ? "Hearth 已连接" : "Hearth 未连接"}</strong>
            <span className="version-tag">v{system?.evalVersion ?? "0.1"}</span>
          </div>
          <small>{system?.hearthUrl ?? "127.0.0.1:4317"}</small>
        </div>
      </aside>

      <div className="content-frame">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setMobileOpen(true)}>
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          <div className="breadcrumb"><span>评测台</span><b>/</b><strong>{title}</strong></div>
          <div className="topbar-status">
            <span className={`tiny-status ${system?.hearthReachable ? "ok" : "bad"}`}>
              <i /> {system?.hearthReachable ? "Hearth 在线" : "Hearth 离线"}
            </span>
            <span className={`tiny-status ${system?.judgeConfigured ? "ok" : "warn"}`}>
              <i /> {system?.judgeConfigured ? "评委就绪" : "评委未配置"}
            </span>
            {(system?.runningExperiments ?? 0) > 0 && (
              <span className="tiny-status info"><i /> {system?.runningExperiments} 个实验运行中</span>
            )}
          </div>
        </header>
        <main className="page-container"><Outlet /></main>
      </div>
    </div>
  );
}

function NavItem({
  item,
  pending,
  onNavigate
}: {
  item: (typeof NAV_ITEMS)[number];
  pending: number;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  const badge = item.badge === "reviews" && pending > 0 ? pending : null;
  return (
    <NavLink
      to={item.to}
      end={item.end ?? false}
      onClick={onNavigate}
      className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
    >
      <Icon size={16} strokeWidth={1.8} />
      <span>{item.label}</span>
      {badge !== null && <em>{badge > 99 ? "99+" : badge}</em>}
    </NavLink>
  );
}

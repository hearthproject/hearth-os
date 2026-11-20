import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Command, MoreHorizontal } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { FOOTER_NAV, MAIN_NAV, MORE_NAV, type NavItem } from "../lib/navigation.ts";
import { HearthMark } from "./HearthMark.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { ConversationSidebar } from "./ConversationSidebar.tsx";

const MORE_STORAGE_KEY = "hearth.nav-more";

export function AppShell() {
  const { pathname } = useLocation();
  const [commandOpen, setCommandOpen] = useState(false);
  const moreActive = MORE_NAV.some((item) => pathname === item.path || pathname.startsWith(`${item.path}/`));
  const [moreOpen, setMoreOpen] = useState(() => moreActive || readMoreOpen());
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const executorsQuery = useQuery({ queryKey: ["executors"], queryFn: api.executors, refetchInterval: 30_000 });
  const chatModel = healthQuery.data?.chatModel;
  const readyExecutors = (executorsQuery.data?.executors ?? []).filter((executor) => executor.health.canRun);
  const primaryExecutor = readyExecutors.find((executor) => executor.id === "native")
    ?? readyExecutors.find((executor) => executor.id === "codex")
    ?? readyExecutors[0]
    ?? null;
  const chatMode = pathname === "/";
  const connectionIssue = healthQuery.isSuccess && !chatModel?.configured
    ? { label: "聊天模型未配置", to: "/welcome" }
    : executorsQuery.isSuccess && !primaryExecutor
      ? { label: "执行器不可用", to: "/settings" }
      : null;

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

  useEffect(() => {
    if (moreActive) setMoreOpen(true);
  }, [moreActive]);

  function toggleMore() {
    setMoreOpen((current) => {
      writeMoreOpen(!current);
      return !current;
    });
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <HearthMark size={22} />
          <span className="brand-name">Hearth</span>
        </div>

        <button className="command-trigger" onClick={() => setCommandOpen(true)} aria-label="搜索（Ctrl/⌘ + K）">
          <Command size={15} />
          <span>搜索</span>
          <kbd>Ctrl K</kbd>
        </button>

        <nav className="nav" aria-label="主导航">
          {MAIN_NAV.map((item) => <NavRow key={item.id} item={item} />)}
          <button
            className={`nav-item nav-more-toggle${moreOpen ? " open" : ""}`}
            onClick={toggleMore}
            aria-expanded={moreOpen}
            aria-controls="nav-more"
          >
            <MoreHorizontal size={18} />
            <span className="nav-label">更多</span>
            <ChevronDown size={14} className="nav-more-chevron" />
          </button>
          {moreOpen && (
            <div className="nav-more" id="nav-more">
              {MORE_NAV.map((item) => <NavRow key={item.id} item={item} />)}
            </div>
          )}
        </nav>

        <ConversationSidebar />

        <NavRow item={SETTINGS_ITEM} />

        {connectionIssue && (
          <NavLink
            to={connectionIssue.to}
            className="connection-state"
            data-connection-state="degraded"
          >
            <span className="status-dot offline" />
            <span>{connectionIssue.label}</span>
          </NavLink>
        )}
      </aside>

      <main className="main">
        <div className={`main-body ${chatMode ? "chat-body" : ""}`}>
          <Outlet />
        </div>
      </main>

      <nav className="mobile-nav" aria-label="移动端导航">
        {MAIN_NAV.map((item) => <NavRow key={item.id} item={item} mobile />)}
        <button className="mobile-nav-item" onClick={() => setCommandOpen(true)}>
          <Command size={19} /><span>更多</span>
        </button>
      </nav>
      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
    </div>
  );
}

function NavRow({ item, mobile = false }: { item: NavItem; mobile?: boolean }) {
  const Icon = item.icon;
  const base = mobile ? "mobile-nav-item" : "nav-item";
  return (
    <NavLink
      to={item.path}
      end={item.end === true}
      className={({ isActive: active }) => (active ? `${base} active` : base)}
    >
      <Icon size={mobile ? 19 : 18} />
      <span className={mobile ? undefined : "nav-label"}>{item.label}</span>
    </NavLink>
  );
}

const SETTINGS_ITEM = FOOTER_NAV[0]!;

function readMoreOpen(): boolean {
  try {
    return window.localStorage.getItem(MORE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMoreOpen(open: boolean): void {
  try {
    window.localStorage.setItem(MORE_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // localStorage 不可用时只影响下次打开时的默认值
  }
}

import { Activity, Brain, CalendarClock, Mail, MessageCircle, Monitor, Settings2, UserRound, type LucideIcon } from "lucide-react";

export type NavPlacement = "main" | "more" | "footer";

export interface NavItem {
  id: string;
  label: string;
  path: string;
  icon: LucideIcon;
  placement: NavPlacement;
  end?: boolean;
  keywords: string[];
}

export const NAV_ITEMS: NavItem[] = [
  { id: "chat", label: "聊天", path: "/", icon: MessageCircle, placement: "main", end: true, keywords: ["聊天", "对话", "chat", "conversation"] },
  { id: "knowledge", label: "记忆", path: "/knowledge", icon: Brain, placement: "main", keywords: ["记忆", "知识库", "经验", "openviking", "memory", "knowledge"] },
  { id: "mail", label: "邮件", path: "/mail", icon: Mail, placement: "more", keywords: ["邮件", "邮箱", "mail"] },
  { id: "schedules", label: "定时任务", path: "/schedules", icon: CalendarClock, placement: "more", keywords: ["定时", "周期", "schedule"] },
  { id: "devices", label: "设备", path: "/devices", icon: Monitor, placement: "more", keywords: ["设备", "桌面", "device", "desktop"] },
  { id: "runtime", label: "运行", path: "/runtime", icon: Activity, placement: "more", keywords: ["运行", "后台", "runtime"] },
  { id: "personal", label: "个人", path: "/personal", icon: UserRound, placement: "more", keywords: ["个人", "画像", "personal"] },
  { id: "settings", label: "设置", path: "/settings", icon: Settings2, placement: "footer", keywords: ["设置", "配置", "settings"] }
];

export const MAIN_NAV = NAV_ITEMS.filter((item) => item.placement === "main");
export const MORE_NAV = NAV_ITEMS.filter((item) => item.placement === "more");
export const FOOTER_NAV = NAV_ITEMS.filter((item) => item.placement === "footer");

export function matchesNavItem(item: NavItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [item.label, item.path, ...item.keywords].some((value) => value.toLowerCase().includes(normalized));
}

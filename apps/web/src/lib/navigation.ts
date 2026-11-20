import { CalendarClock, Library, Link2, Mail, MessageCircle, Settings2, type LucideIcon } from "lucide-react";

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
  { id: "library", label: "资料库", path: "/library", icon: Library, placement: "main", keywords: ["资料", "文件", "记忆", "技能", "搜索", "library", "memory", "knowledge"] },
  { id: "mail", label: "邮件", path: "/mail", icon: Mail, placement: "more", keywords: ["邮件", "邮箱", "mail"] },
  { id: "schedules", label: "定时任务", path: "/schedules", icon: CalendarClock, placement: "more", keywords: ["定时", "周期", "schedule"] },
  { id: "connections", label: "连接", path: "/connections", icon: Link2, placement: "more", keywords: ["连接", "飞书", "集成", "connection", "feishu"] },
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

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({ icon: Icon, title, body, action }: { icon: LucideIcon; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon size={26} strokeWidth={1.6} /></span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

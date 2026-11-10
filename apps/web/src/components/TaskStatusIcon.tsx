import {
  Ban,
  CheckCircle2,
  Clock3,
  Loader2,
  MessageCircleQuestion,
  ShieldQuestion,
  TriangleAlert,
  XCircle
} from "lucide-react";
import type { TaskStatus } from "../lib/types.ts";

const ICONS = {
  queued: Clock3,
  running: Loader2,
  waiting_input: MessageCircleQuestion,
  waiting_approval: ShieldQuestion,
  waiting_budget: Clock3,
  completed: CheckCircle2,
  failed: XCircle,
  recoverable: TriangleAlert,
  cancelled: Ban
} satisfies Record<TaskStatus, typeof Clock3>;

export function TaskStatusIcon({
  status,
  size = 13,
  className = ""
}: {
  status: TaskStatus;
  size?: number;
  className?: string;
}) {
  const Icon = ICONS[status];
  return (
    <span className={`task-status-icon ${status} ${className}`.trim()} aria-hidden="true">
      <Icon size={size} className={status === "running" ? "spin" : undefined} />
    </span>
  );
}

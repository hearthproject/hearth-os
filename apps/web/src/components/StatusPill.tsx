import { AlertCircle, CheckCircle2, CircleDot, Clock3, Hand, Loader2, RotateCcw, XCircle } from "lucide-react";
import type { TaskStatus } from "../lib/types.ts";
import { STATUS_LABELS } from "../lib/format.ts";

const ICONS = {
  queued: Clock3,
  running: Loader2,
  waiting_input: CircleDot,
  waiting_approval: Hand,
  completed: CheckCircle2,
  failed: XCircle,
  recoverable: RotateCcw,
  cancelled: AlertCircle
} satisfies Record<TaskStatus, typeof CircleDot>;

export function StatusPill({ status }: { status: TaskStatus }) {
  const Icon = ICONS[status];
  return (
    <span className={`status-pill status-${status}`}>
      <Icon size={13} className={status === "running" ? "spin" : undefined} />
      {STATUS_LABELS[status]}
    </span>
  );
}

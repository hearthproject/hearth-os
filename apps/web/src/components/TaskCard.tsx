import { ArrowUpRight, CalendarDays, Flame } from "lucide-react";
import { Link } from "react-router-dom";
import type { TaskRecord, TaskTemplate } from "../lib/types.ts";
import { CATEGORY_LABELS, needsAttention, relativeTime } from "../lib/format.ts";
import { StatusPill } from "./StatusPill.tsx";

export function TaskCard({ task, template, featured = false }: { task: TaskRecord; template?: TaskTemplate | undefined; featured?: boolean }) {
  return (
    <Link to={`/tasks/${task.id}`} className={`task-card ${featured ? "task-card-featured" : ""} ${needsAttention(task.status) ? "task-card-attention" : ""}`}>
      <div className="task-card-top">
        <StatusPill status={task.status} />
        <span className="task-card-time">{relativeTime(task.updatedAt)}</span>
      </div>
      <div className="task-card-body">
        <div>
          <div className="task-card-meta">
            {task.templateId && <span className="mono-chip">{task.templateId}</span>}
            {template && <span>{CATEGORY_LABELS[template.category] ?? template.category}</span>}
          </div>
          <h3>{task.title}</h3>
          <p>{task.error?.message ?? task.nextAction ?? task.goal}</p>
        </div>
        <ArrowUpRight className="task-card-arrow" size={20} />
      </div>
      <div className="task-card-foot">
        <span><CalendarDays size={14} /> {relativeTime(task.createdAt)}</span>
        {task.networkHosts.length > 0 && <span><Flame size={14} /> 来源网页 {task.networkHosts.length}</span>}
      </div>
      {task.status === "running" && <span className="task-running-line" />}
    </Link>
  );
}

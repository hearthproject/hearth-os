import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, FileText, ListChecks, RefreshCw } from "lucide-react";
import { api } from "../lib/api.ts";
import { formatDuration, formatTokens, isActive, needsAttention, relativeTime } from "../lib/format.ts";
import { executorLabel } from "../lib/labels.ts";
import { StatusPill } from "../components/StatusPill.tsx";
import type { TaskListItem } from "../lib/types.ts";

type Filter = "all" | "active" | "done" | "problem";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "done", label: "已完成" },
  { id: "problem", label: "需要处理" }
];

export function TasksPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 5_000 });
  const tasks = tasksQuery.data?.tasks ?? [];
  const visible = tasks.filter((task) => matchesFilter(task, filter));

  return (
    <div className="page tasks-page">
      <div className="page-head">
        <div>
          <h1>任务</h1>
          <p className="page-meta">在这里看每一次派出去的执行：当前阶段、Token、耗时和最终结果。</p>
        </div>
        <button className="ghost-button" onClick={() => void tasksQuery.refetch()} disabled={tasksQuery.isFetching}>
          <RefreshCw size={15} className={tasksQuery.isFetching ? "spin" : ""} /> 刷新
        </button>
      </div>

      <div className="filter-row">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            className={`filter-chip ${filter === item.id ? "active" : ""}`}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
            <span>{tasks.filter((task) => matchesFilter(task, item.id)).length}</span>
          </button>
        ))}
      </div>

      {tasks.length === 0 ? (
        <div className="empty-panel">
          <ListChecks size={22} />
          <h2>还没有任务</h2>
          <p>回到聊天页，直接说出你要完成的事。执行类请求会自动出现在这里。</p>
          <Link className="primary-button" to="/">去聊天</Link>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty-panel">
          <h2>这个筛选下没有任务</h2>
          <button className="ghost-button" onClick={() => setFilter("all")}>查看全部</button>
        </div>
      ) : (
        <div className="task-table-wrap">
          <table className="task-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>执行器</th>
                <th>当前阶段</th>
                <th>Token</th>
                <th>耗时</th>
                <th className="result-column">结果</th>
                <th aria-label="打开" />
              </tr>
            </thead>
            <tbody>
              {visible.map((task) => (
                <tr key={task.id} onClick={() => navigate(`/tasks/${task.id}`)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") navigate(`/tasks/${task.id}`); }}>
                  <td>
                    <div className="task-title-line">
                      <strong>{task.title}</strong>
                      <StatusPill status={task.status} />
                    </div>
                    <p className="task-goal">{task.goal}</p>
                    <span className="task-time">{relativeTime(task.updatedAt)}</span>
                  </td>
                  <td><span className="executor-tag">{executorLabel(task.executorId)}</span></td>
                  <td><span className={`phase-tag ${phaseTone(task.status)}`}>{task.summary.phase}</span></td>
                  <td className="mono">{formatTokens(task.summary.lastUsage)}</td>
                  <td className="mono">{formatDuration(task.summary.lastDurationMs)}</td>
                  <td className="result-column">
                    <ResultCell task={task} />
                  </td>
                  <td><ArrowRight size={15} className="row-arrow" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ResultCell({ task }: { task: TaskListItem }) {
  const summary = task.resultSummary?.replace(/\s+/g, " ").trim();
  const deliverables = task.summary.deliverables;
  if (summary) {
    return (
      <div className="result-cell">
        <p>{summary.length > 120 ? `${summary.slice(0, 120)}…` : summary}</p>
        {deliverables.length > 0 && (
          <span className="deliverable-count"><FileText size={12} /> {deliverables.length} 个文件</span>
        )}
      </div>
    );
  }
  if (deliverables.length > 0) {
    return (
      <div className="result-cell">
        <p>{deliverables.map((item) => item.name).join("、")}</p>
        <span className="deliverable-count"><FileText size={12} /> {deliverables.length} 个文件</span>
      </div>
    );
  }
  if (task.status === "completed") return <span className="muted">已完成，没有文字总结</span>;
  if (task.error) return <span className="result-error">{task.error.message}</span>;
  return <span className="muted">—</span>;
}

function matchesFilter(task: TaskListItem, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return isActive(task.status);
  if (filter === "done") return task.status === "completed";
  return needsAttention(task.status) || task.status === "failed" || task.status === "recoverable";
}

function phaseTone(status: TaskListItem["status"]): string {
  if (status === "running") return "running";
  if (status === "completed") return "done";
  if (status === "failed" || status === "recoverable") return "problem";
  if (status === "waiting_approval" || status === "waiting_input") return "waiting";
  return "queued";
}

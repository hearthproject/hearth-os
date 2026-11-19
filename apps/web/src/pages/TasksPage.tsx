import { TaskActionsMenu } from "../components/TaskActionsMenu.tsx";
import { TaskTokens } from "../components/TaskTokens.tsx";
import { useEffect, useState } from "react";
import { markTasksRead } from "../lib/task-read-state.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { FileText, Pin, PinOff, RefreshCw } from "lucide-react";
import { api } from "../lib/api.ts";
import { formatDuration, isActive, needsAttention, relativeTime } from "../lib/format.ts";
import { executorLabel, executionModeLabel } from "../lib/labels.ts";
import { StatusPill } from "../components/StatusPill.tsx";
import type { TaskListItem } from "../lib/types.ts";

type Filter = "all" | "active" | "done" | "problem" | "archived";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "done", label: "已完成" },
  { id: "problem", label: "需要处理" },
  { id: "archived", label: "已归档" }
];

export function TasksPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 5_000 });
  useEffect(() => {
    if (tasksQuery.data) markTasksRead(tasksQuery.data.tasks.filter((task) => matchesFilter(task, filter)));
  }, [tasksQuery.data, filter]);
  const tasks = tasksQuery.data?.tasks ?? [];
  const organization = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { pinned?: boolean; archived?: boolean } }) =>
      api.setTaskOrganization(id, patch),
    onSuccess: (_task, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["task", variables.id] });
    }
  });
  const ordered = [...tasks].sort((a, b) => Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt)));
  const visible = ordered.filter((task) => matchesFilter(task, filter));

  return (
    <div className="page tasks-page">
      <div className="page-head tasks-head">
        <h1>任务</h1>
        <button
          className="icon-button tasks-refresh"
          onClick={() => void tasksQuery.refetch()}
          disabled={tasksQuery.isFetching}
          aria-label="刷新任务"
          title="刷新任务"
        >
          <RefreshCw size={15} className={tasksQuery.isFetching ? "spin" : ""} />
        </button>
      </div>

      <div className="filter-row task-filters">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            className={`filter-tab ${filter === item.id ? "active" : ""}`}
            onClick={() => setFilter(item.id)}
            aria-pressed={filter === item.id}
          >
            {item.label}
            <span className="filter-count">{tasks.filter((task) => matchesFilter(task, item.id)).length}</span>
          </button>
        ))}
      </div>

      {organization.isError && <p className="form-error" role="alert">整理任务失败，请重试。</p>}
      {tasks.length === 0 ? (
        <div className="task-empty">
          <p>还没有任务。从<Link to="/">聊天</Link>开始。</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="task-empty">
          <h2>{filter === "archived" ? "还没有归档任务" : "这个筛选下没有任务"}</h2>
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
              <th className="task-row-actions-head" aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {visible.map((task) => (
                <tr key={task.id} className={task.pinnedAt ? "pinned" : ""} onClick={() => navigate(`/tasks/${task.id}`)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") navigate(`/tasks/${task.id}`); }}>
                  <td>
                    <div className="task-title-line">
                      {task.pinnedAt && <span className="task-pin-badge" title="已置顶"><Pin size={11} /></span>}
                      <strong>{task.title}</strong>
                      <StatusPill status={task.status} />
                      {task.archivedAt && <span className="task-archive-badge">已归档</span>}
                    </div>
                    <p className="task-goal">{task.goal}</p>
                    <span className="task-time">{relativeTime(task.updatedAt)}</span>
                  </td>
                  <td><span className="executor-tag">{executorLabel(task.executorId)}</span><span className="task-mode-tag">{executionModeLabel(task.executionMode)}</span></td>
                  <td><span className={`phase-tag ${phaseTone(task.status)}`}>{task.summary.phase}</span></td>
                  <td className="mono task-token-cell"><TaskTokens usage={task.summary.lastUsage} /></td>
                  <td className="mono task-duration-cell">{formatDuration(task.summary.lastDurationMs)}</td>
                  <td className="result-column">
                    <ResultCell task={task} />
                  </td>
                  <td className="task-row-actions">
                    <button
                      className={`icon-button ${task.pinnedAt ? "active" : ""}`}
                      title={task.pinnedAt ? "取消置顶" : "置顶"}
                      aria-label={task.pinnedAt ? "取消置顶" : "置顶"}
                      aria-pressed={Boolean(task.pinnedAt)}
                      disabled={organization.isPending && organization.variables?.id === task.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        organization.mutate({ id: task.id, patch: { pinned: !task.pinnedAt } });
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      {task.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />}
                    </button>
                    <TaskActionsMenu task={task} />
                  </td>
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
  if (filter === "archived") return Boolean(task.archivedAt);
  if (task.archivedAt) return false;
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

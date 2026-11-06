import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useShell } from "../components/AppShell.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { TaskTable } from "../components/TaskRow.tsx";
import { api } from "../lib/api.ts";
import { countTotal, formatDuration, formatTokens, isActive, needsAttention, todayLabel } from "../lib/format.ts";
import { useViewMode } from "../lib/view-mode.tsx";
import type { TaskListItem } from "../lib/types.ts";

const SIMPLE_ROW_LIMIT = 12;

export function TodayPage() {
  const { openNewTask } = useShell();
  const { mode } = useViewMode();
  const [showAll, setShowAll] = useState(false);
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 10_000 });
  const statsQuery = useQuery({ queryKey: ["stats"], queryFn: api.stats, refetchInterval: 20_000, enabled: mode === "pro" });
  const tasks = tasksQuery.data?.tasks ?? [];
  const stats = statsQuery.data;

  const attention = tasks.filter((task) => needsAttention(task.status));
  const active = tasks.filter((task) => isActive(task.status));
  const completed = tasks.filter((task) => task.status === "completed");
  const ordered = [...tasks].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  const visible = mode === "pro" || showAll ? ordered : ordered.slice(0, SIMPLE_ROW_LIMIT);

  return (
    <div className="page today-page">
      <div className="page-head">
        <h1>今天</h1>
        <span className="page-meta">{todayLabel()}</span>
        <button className="primary-button" onClick={openNewTask}><Plus size={15} /> 新建任务</button>
      </div>

      <div className="stat-line">
        <Link to="/attention">需要你 {attention.length}</Link>
        <span>进行中 {active.length}</span>
        <span>已完成 {completed.length}</span>
        {mode === "pro" && stats && (
          <>
            <span>执行 {stats.runs.total} 次</span>
            <span>累计 {formatDuration(stats.runs.durationMs)}</span>
            <span className="mono">Token {formatTokens(stats.runs.usage)}</span>
            <span>外部动作 {countTotal(stats.effects.byStatus)}</span>
            <span>事实记录 {stats.events.total} 条</span>
          </>
        )}
      </div>

      {tasksQuery.isLoading && <p className="section-empty">正在读取本机任务…</p>}

      {!tasksQuery.isLoading && tasks.length === 0 && (
        <section className="panel">
          <EmptyState
            title="还没有任务"
            body="创建一个任务，或从任务库选一个。"
            action={<button className="primary-button" onClick={openNewTask}><Plus size={15} /> 新建任务</button>}
          />
        </section>
      )}

      {tasks.length > 0 && (
        <section className="panel table-panel">
          <TaskTable tasks={visible} />
          {mode === "simple" && ordered.length > visible.length && (
            <button className="table-more" onClick={() => setShowAll(true)}>显示全部 {ordered.length} 条任务</button>
          )}
        </section>
      )}
    </div>
  );
}

function rank(task: TaskListItem): number {
  if (needsAttention(task.status)) return 0;
  if (task.status === "running") return 1;
  if (task.status === "queued") return 2;
  if (task.status === "completed") return 3;
  return 4;
}

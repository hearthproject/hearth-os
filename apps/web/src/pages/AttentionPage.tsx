import { useQuery } from "@tanstack/react-query";
import { TaskTable } from "../components/TaskRow.tsx";
import { api } from "../lib/api.ts";
import { needsAttention } from "../lib/format.ts";

export function AttentionPage() {
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 8_000 });
  const tasks = (tasksQuery.data?.tasks ?? []).filter((task) => needsAttention(task.status));

  return (
    <div className="page">
      <div className="page-head">
        <h1>需要你</h1>
        <span className="page-meta">审批、失败恢复、待补充。</span>
      </div>

      {tasksQuery.isLoading ? (
        <p className="section-empty">正在读取待办…</p>
      ) : tasks.length === 0 ? (
        <section className="panel">
          <p className="section-empty">现在没有要你决定的事。</p>
        </section>
      ) : (
        <section className="panel table-panel">
          <TaskTable tasks={tasks} />
        </section>
      )}
    </div>
  );
}

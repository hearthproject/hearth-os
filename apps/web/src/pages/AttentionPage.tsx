import { useQuery } from "@tanstack/react-query";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { TaskTable } from "../components/TaskRow.tsx";
import { api } from "../lib/api.ts";
import { needsAttention } from "../lib/format.ts";

export function AttentionPage() {
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 8_000 });
  const approvalsQuery = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => api.approvals({ status: "pending", limit: 50 }),
    refetchInterval: 8_000
  });
  const pendingApprovals = approvalsQuery.data?.approvals ?? [];
  const tasks = (tasksQuery.data?.tasks ?? []).filter(
    (task) => needsAttention(task.status) && task.status !== "waiting_approval"
  );
  const loading = tasksQuery.isLoading || approvalsQuery.isLoading;
  const empty = tasks.length === 0 && pendingApprovals.length === 0;

  return (
    <div className="page">
      <div className="page-head">
        <h1>需要你</h1>
        <span className="page-meta">审批、失败恢复、待补充。</span>
      </div>

      {loading ? (
        <p className="section-empty">正在读取待办…</p>
      ) : empty ? (
        <section className="panel">
          <p className="section-empty">现在没有要你决定的事。</p>
        </section>
      ) : (
        <>
          {pendingApprovals.length > 0 && (
            <section className="attention-approvals">
              <div className="panel-head">
                <h2>待确认的动作</h2>
                <span className="panel-meta">短时有效 · 每项只执行一次</span>
              </div>
              {pendingApprovals.map((approval) => (
                <ApprovalCard key={approval.id} approval={approval} />
              ))}
            </section>
          )}
          {tasks.length > 0 && (
            <section className="panel table-panel">
              <TaskTable tasks={tasks} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

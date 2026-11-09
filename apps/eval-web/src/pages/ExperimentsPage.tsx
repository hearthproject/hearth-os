import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import { executorLabel, formatDate, formatPercent } from "../lib/labels.ts";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusPill } from "../components/ui.tsx";

export function ExperimentsPage() {
  const query = useQuery({ queryKey: ["experiments"], queryFn: api.experiments, refetchInterval: 5_000 });
  if (query.isLoading) return <LoadingState text="正在读取实验列表" />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const experiments = query.data!.experiments;

  return (
    <div className="page-stack">
      <PageHeader
        title="实验"
        description="每条实验记录都固定任务版本、执行器、运行模式和模型环境，便于复现与对比。"
        actions={<Link className="button button-primary" to="/experiments/new"><Plus size={15} /> 新建实验</Link>}
      />

      <section className="panel">
        <div className="section-header"><div><h2>全部实验</h2><span>{experiments.length} 条记录</span></div></div>
        {experiments.length === 0 ? (
          <EmptyState title="还没有实验" description="创建实验后，评测 Agent 将自动驱动 Hearth 并追踪完整生命周期。" action={<Link className="button" to="/experiments/new">新建第一条实验</Link>} />
        ) : (
          <div className="table-wrap">
            <table className="data-table experiments-table">
              <thead><tr><th>实验</th><th>状态</th><th>任务</th><th>执行器</th><th>模式</th><th>通过率</th><th>均分</th><th>开始时间</th><th /></tr></thead>
              <tbody>
                {experiments.map((experiment) => (
                  <tr key={experiment.id}>
                    <td><Link className="table-primary" to={`/experiments/${experiment.id}`}>{experiment.name}<small>{experiment.id}</small></Link></td>
                    <td><StatusPill status={experiment.status} /></td>
                    <td><strong>{experiment.config.caseIds.length}</strong><span className="table-muted"> × {experiment.config.repetitions}</span></td>
                    <td>{experiment.config.executorIds.map(executorLabel).join(", ")}</td>
                    <td><span className={`mode-badge mode-${experiment.config.runMode}`}>{experiment.config.runMode === "offline" ? "离线" : "在线"}</span></td>
                    <td>{formatPercent(experiment.summary?.passRate ?? null)}</td>
                    <td>{experiment.summary?.avgScore === null || experiment.summary?.avgScore === undefined ? "—" : experiment.summary.avgScore.toFixed(1)}</td>
                    <td className="table-muted">{formatDate(experiment.startedAt ?? experiment.createdAt)}</td>
                    <td><Link className="table-arrow" to={`/experiments/${experiment.id}`} aria-label="打开实验"><ArrowRight size={15} /></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

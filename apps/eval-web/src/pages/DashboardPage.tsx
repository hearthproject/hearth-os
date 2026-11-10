import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ClipboardCheck,
  FlaskConical,
  Layers3,
  Play,
  ShieldCheck,
  TimerReset
} from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import { FAMILY_LABELS, formatDate, formatPercent } from "../lib/labels.ts";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageHeader,
  SectionHeader,
  StatusPill
} from "../components/ui.tsx";

export function DashboardPage() {
  const dashboardQuery = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard, refetchInterval: 5_000 });
  if (dashboardQuery.isLoading) return <LoadingState text="正在汇总评测数据" />;
  if (dashboardQuery.error) return <ErrorState error={dashboardQuery.error} onRetry={() => void dashboardQuery.refetch()} />;
  const data = dashboardQuery.data!;
  const summary = data.latestSummary;
  const latest = data.recentExperiments[0] ?? null;
  const totalCases = data.catalog.cases.length;
  const pending = data.pendingReviews;

  return (
    <div className="page-stack dashboard-page">
      <PageHeader
        title="总览"
        description="查看个人 Agent 的任务覆盖、最近实验与待处理结论。"
        actions={<Link className="button button-primary" to="/experiments/new"><Play size={15} /> 新建实验</Link>}
      />

      <section className="overview-card panel">
        <div className="overview-main">
          <div className="overview-label">
            <span>最近实验</span>
            {latest && <StatusPill status={latest.status} />}
          </div>
          {latest ? (
            <Link className="overview-name" to={`/experiments/${latest.id}`}>{latest.name}</Link>
          ) : (
            <strong className="overview-name">还没有实验</strong>
          )}
          <p>
            {latest
              ? `${formatDate(latest.createdAt)} 创建 · ${latest.config.caseIds.length} 个任务 · ${latest.config.executorIds.length} 个执行器`
              : "选择任务与执行器，建立第一条可追溯的质量基线。"}
          </p>
        </div>
        <div className="overview-stats">
          <div><span>通过率</span><strong>{formatPercent(summary?.passRate ?? null)}</strong><small>{summary ? `${summary.passed} / ${summary.totalRuns} 通过` : "等待运行"}</small></div>
          <div><span>平均分</span><strong>{summary?.avgScore === null || summary?.avgScore === undefined ? "—" : summary.avgScore.toFixed(1)}</strong><small>最新实验</small></div>
          <div><span>平均耗时</span><strong>{summary?.avgDurationMs === null || summary?.avgDurationMs === undefined ? "—" : `${(summary.avgDurationMs / 1_000).toFixed(1)}s`}</strong><small>{summary ? `${summary.totalRuns} 次运行` : "暂无数据"}</small></div>
        </div>
        <div className="overview-actions">
          {latest ? (
            <Link className="button" to={`/experiments/${latest.id}`}>打开实验 <ArrowRight size={15} /></Link>
          ) : (
            <Link className="button button-primary" to="/experiments/new">创建实验</Link>
          )}
        </div>
      </section>

      <section className="metric-grid">
        <MetricCard label="任务目录" value={totalCases} detail={`${Object.values(data.catalog.counts).filter((count) => count > 0).length} 个任务族`} icon={<Layers3 size={16} />} />
        <MetricCard label="最近通过率" value={formatPercent(summary?.passRate ?? null)} detail={summary ? `${summary.passed} / ${summary.totalRuns} 通过` : "尚未产生运行"} icon={<ShieldCheck size={16} />} tone="success" />
        <MetricCard label="待人工复核" value={pending} detail={pending > 0 ? "等待确认最终结论" : "队列已清空"} icon={<ClipboardCheck size={16} />} tone={pending > 0 ? "warning" : "neutral"} />
        <MetricCard label="运行中实验" value={data.runningExperiments} detail={data.system.judgeConfigured ? `评委：${data.system.judgeModel ?? "已配置"}` : "模型评委未配置"} icon={<FlaskConical size={16} />} />
      </section>

      <div className="dashboard-grid">
        <section className="panel span-2">
          <SectionHeader
            title="最近实验"
            detail="状态、规模与评分"
            action={<Link className="text-link" to="/experiments">查看全部 <ArrowRight size={14} /></Link>}
          />
          {data.recentExperiments.length === 0 ? (
            <EmptyState
              title="还没有实验"
              description="选择一个任务族和执行器，开始第一条可追踪的质量基线。"
              action={<Link className="button" to="/experiments/new">新建实验</Link>}
            />
          ) : (
            <div className="table-wrap">
              <table className="data-table dashboard-table">
                <thead><tr><th>实验</th><th>状态</th><th>任务 / 执行器</th><th>通过率</th><th>均分</th><th>创建时间</th></tr></thead>
                <tbody>
                  {data.recentExperiments.map((experiment) => {
                    const currentSummary = experiment.summary ?? (experiment.id === latest?.id ? summary : null);
                    return (
                      <tr key={experiment.id}>
                        <td><Link className="table-primary" to={`/experiments/${experiment.id}`}>{experiment.name}<small>{experiment.id}</small></Link></td>
                        <td><StatusPill status={experiment.status} /></td>
                        <td>{experiment.config.caseIds.length} / {experiment.config.executorIds.length}</td>
                        <td>{formatPercent(currentSummary?.passRate ?? null)}</td>
                        <td>{currentSummary?.avgScore === null || currentSummary?.avgScore === undefined ? "—" : currentSummary.avgScore.toFixed(1)}</td>
                        <td className="table-muted">{formatDate(experiment.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <SectionHeader title="最新结果" detail={summary ? `${summary.totalRuns} 次运行` : "等待实验"} />
          {summary ? (
            <>
              <div className="stage-split" aria-label="运行结果分布">
                <span className="stage-passed" style={{ width: `${percent(summary.passed, summary.totalRuns)}%` }} />
                <span className="stage-failed" style={{ width: `${percent(summary.failed, summary.totalRuns)}%` }} />
                <span className="stage-blocked" style={{ width: `${percent(summary.blocked, summary.totalRuns)}%` }} />
                <span className="stage-review" style={{ width: `${percent(summary.needsReview, summary.totalRuns)}%` }} />
              </div>
              <div className="legend-grid">
                <LegendRow label="通过" value={summary.passed} tone="passed" />
                <LegendRow label="失败" value={summary.failed} tone="failed" />
                <LegendRow label="阻塞" value={summary.blocked} tone="blocked" />
                <LegendRow label="待复核" value={summary.needsReview} tone="review" />
              </div>
              <div className="summary-facts">
                <div><span>平均耗时</span><strong>{summary.avgDurationMs === null ? "—" : `${(summary.avgDurationMs / 1_000).toFixed(1)}s`}</strong></div>
                <div><span>重试</span><strong>{summary.retries}</strong></div>
                <div><span>审批</span><strong>{summary.approvals}</strong></div>
              </div>
              <Link className="side-action" to="/reviews"><ClipboardCheck size={15} /> 处理待复核结论 <ArrowRight size={14} /></Link>
            </>
          ) : (
            <EmptyState title="等待实验数据" description="运行完成后这里会展示结果分布。" />
          )}
        </section>
      </div>

      <section className="panel">
        <SectionHeader
          title="任务覆盖"
          detail={`${totalCases} 个任务，横跨个人 Agent 的主要工作面`}
          action={<Link className="text-link" to="/cases">浏览目录 <ArrowRight size={14} /></Link>}
        />
        <div className="coverage-grid">
          {(Object.keys(FAMILY_LABELS) as Array<keyof typeof FAMILY_LABELS>).map((family) => (
            <Link key={family} className="coverage-item" to={`/cases?family=${family}`}>
              <span>{FAMILY_LABELS[family]}</span>
              <strong>{data.catalog.counts[family] ?? 0}</strong>
              <TimerReset size={14} />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function LegendRow({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className="legend-row"><span className={`legend-swatch ${tone}`} /> <span>{label}</span><strong>{value}</strong></div>;
}

function percent(value: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, value / total * 100)) : 0;
}

import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  ClipboardCheck,
  FlaskConical,
  Layers3,
  Play,
  ShieldCheck,
  Sparkles,
  TimerReset
} from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import {
  FAMILY_COLORS,
  FAMILY_LABELS,
  formatDate,
  formatPercent
} from "../lib/labels.ts";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageHeader,
  ProgressBar,
  ScoreDial,
  SectionHeader,
  StatusPill
} from "../components/ui.tsx";

export function DashboardPage() {
  const dashboardQuery = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard, refetchInterval: 5_000 });
  if (dashboardQuery.isLoading) return <LoadingState text="正在汇总评测控制台" />;
  if (dashboardQuery.error) return <ErrorState error={dashboardQuery.error} onRetry={() => void dashboardQuery.refetch()} />;
  const data = dashboardQuery.data!;
  const summary = data.latestSummary;
  const latest = data.recentExperiments[0] ?? null;
  const totalCases = data.catalog.cases.length;
  const pending = data.pendingReviews;

  return (
    <div className="page-stack dashboard-page">
      <PageHeader
        eyebrow="PERSONAL AGENT QUALITY"
        title="评测控制台"
        description="从任务目录、执行轨迹到模型评委与人工复核，在一个视图中掌握个人 Agent 的质量全周期。"
        actions={<Link className="button button-primary" to="/experiments/new"><Play size={15} /> 发起实验</Link>}
      />

      <section className="hero-panel">
        <div className="hero-copy">
          <span className="hero-kicker"><Sparkles size={14} /> LIVE BENCHMARK</span>
          <h2>{latest ? latest.name : "建立你的第一条质量基线"}</h2>
          <p>
            {latest
              ? `最近一次实验创建于 ${formatDate(latest.createdAt)}，覆盖 ${latest.config.caseIds.length} 个任务、${latest.config.executorIds.length} 个执行器。`
              : "任务库已经就绪。创建实验后，评测 Agent 会驱动 Hearth 完成任务、评分并整理可复核的轨迹。"}
          </p>
          <div className="hero-actions">
            {latest ? (
              <Link className="button button-dark" to={`/experiments/${latest.id}`}>查看最新实验 <ArrowRight size={15} /></Link>
            ) : (
              <Link className="button button-dark" to="/experiments/new">创建实验 <ArrowRight size={15} /></Link>
            )}
            <Link className="text-link" to="/cases">浏览 {totalCases} 个任务 <ArrowUpRight size={14} /></Link>
          </div>
        </div>
        <div className="hero-score">
          <ScoreDial score={summary?.avgScore ?? null} caption="最近实验均分" />
          <div className="hero-score-foot">
            <span><ShieldCheck size={14} /> {formatPercent(summary?.passRate ?? null)} 通过率</span>
            <span><TimerReset size={14} /> {summary ? `${summary.totalRuns} 次运行` : "等待首跑"}</span>
          </div>
        </div>
        <div className="hero-orbit orbit-one" />
        <div className="hero-orbit orbit-two" />
      </section>

      <section className="metric-grid">
        <MetricCard label="任务目录" value={totalCases} detail={`${Object.values(data.catalog.counts).filter((count) => count > 0).length} 个任务族已覆盖`} icon={<Layers3 size={17} />} />
        <MetricCard label="最近通过率" value={formatPercent(summary?.passRate ?? null)} detail={summary ? `${summary.passed} / ${summary.totalRuns} 通过` : "尚未产生运行"} icon={<ShieldCheck size={17} />} tone="success" />
        <MetricCard label="待人工复核" value={pending} detail={pending > 0 ? "存在需要确认的结论" : "队列已清空"} icon={<ClipboardCheck size={17} />} tone={pending > 0 ? "warning" : "neutral"} />
        <MetricCard label="运行中实验" value={data.runningExperiments} detail={data.system.judgeConfigured ? `评委：${data.system.judgeModel ?? "已配置"}` : "模型评委未配置"} icon={<FlaskConical size={17} />} tone={data.runningExperiments > 0 ? "accent" : "neutral"} />
      </section>

      <div className="dashboard-grid">
        <section className="panel span-2">
          <SectionHeader
            title="最近实验"
            detail="实验级生命周期与评分汇总"
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
              <table className="data-table">
                <thead><tr><th>实验</th><th>状态</th><th>规模</th><th>通过率</th><th>均分</th><th>创建时间</th></tr></thead>
                <tbody>
                  {data.recentExperiments.map((experiment) => {
                    const currentSummary = experiment.summary ?? (experiment.id === latest?.id ? summary : null);
                    return (
                      <tr key={experiment.id}>
                        <td><Link className="table-primary" to={`/experiments/${experiment.id}`}>{experiment.name}<small>{experiment.id}</small></Link></td>
                        <td><StatusPill status={experiment.status} /></td>
                        <td><strong>{experiment.config.caseIds.length}</strong> cases <span className="table-muted">/ {experiment.config.executorIds.length} executors</span></td>
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
          <SectionHeader title="结果构成" detail={summary ? `${summary.totalRuns} 次运行` : "最新实验"} />
          {summary ? (
            <>
              <div className="stage-split" aria-label="运行结果分布">
                <span className="stage-passed" style={{ width: `${percent(summary.passed, summary.totalRuns)}%` }} />
                <span className="stage-failed" style={{ width: `${percent(summary.failed, summary.totalRuns)}%` }} />
                <span className="stage-blocked" style={{ width: `${percent(summary.blocked, summary.totalRuns)}%` }} />
                <span className="stage-review" style={{ width: `${percent(summary.needsReview, summary.totalRuns)}%` }} />
              </div>
              <div className="result-legend">
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
            </>
          ) : (
            <EmptyState title="等待实验数据" description="运行完成后这里会展示通过、失败、阻塞与复核的分布。" />
          )}
        </section>
      </div>

      <div className="dashboard-grid">
        <section className="panel span-2">
          <SectionHeader title="任务族覆盖" detail="60 个离线优先任务，横跨个人 Agent 的主要工作面" action={<Link className="text-link" to="/cases">查看目录 <ArrowRight size={14} /></Link>} />
          <div className="family-coverage">
            {(Object.keys(FAMILY_LABELS) as Array<keyof typeof FAMILY_LABELS>).map((family) => {
              const count = data.catalog.counts[family] ?? 0;
              return (
                <Link key={family} className="family-coverage-row" to={`/cases?family=${family}`}>
                  <span className="family-dot" style={{ background: FAMILY_COLORS[family] }} />
                  <span>{FAMILY_LABELS[family]}</span>
                  <div className="coverage-track"><i style={{ width: `${Math.max(8, count / 12 * 100)}%`, background: FAMILY_COLORS[family] }} /></div>
                  <strong>{count}</strong>
                </Link>
              );
            })}
          </div>
        </section>

        <section className="panel loop-panel">
          <SectionHeader title="评测闭环" detail="每次运行都可追溯" />
          <div className="loop-list">
            <LoopStep index="01" title="提交任务" detail="隔离输入与输出目录" />
            <LoopStep index="02" title="观察执行" detail="任务、运行与事件同步" />
            <LoopStep index="03" title="自动评分" detail="确定性规则 + 模型评委" />
            <LoopStep index="04" title="人工定稿" detail="冲突与低置信度可复核" />
          </div>
          <Link className="button button-wide" to="/reviews"><ClipboardCheck size={15} /> 打开复核队列</Link>
        </section>
      </div>
    </div>
  );
}

function LegendRow({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className="legend-row"><span className={`legend-swatch ${tone}`} /> <span>{label}</span><strong>{value}</strong></div>;
}

function LoopStep({ index, title, detail }: { index: string; title: string; detail: string }) {
  return <div className="loop-step"><span>{index}</span><div><strong>{title}</strong><small>{detail}</small></div></div>;
}

function percent(value: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, value / total * 100)) : 0;
}

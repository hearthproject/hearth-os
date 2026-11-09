import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Ban,
  Clock3,
  Cpu,
  Gauge,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api.ts";
import {
  EVENT_LABELS,
  FAMILY_LABELS,
  STATUS_OPTIONS,
  executorLabel,
  formatDate,
  formatDateTime,
  formatDuration,
  formatPercent,
  isActiveExperiment,
  shortId
} from "../lib/labels.ts";
import {
  EmptyState,
  ErrorState,
  KeyValue,
  LifecycleRail,
  LoadingState,
  MetricCard,
  PageHeader,
  ProgressBar,
  ScoreDial,
  SectionHeader,
  StatusPill
} from "../components/ui.tsx";

export function ExperimentDetailPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const experimentQuery = useQuery({
    queryKey: ["experiment", id],
    queryFn: () => api.experiment(id),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.experiment.status;
      return status && isActiveExperiment(status) ? 2_000 : false;
    }
  });
  const casesQuery = useQuery({ queryKey: ["cases", "all"], queryFn: () => api.cases() });
  const cancelMutation = useMutation({
    mutationFn: () => api.cancelExperiment(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["experiment", id] });
      void queryClient.invalidateQueries({ queryKey: ["experiments"] });
    }
  });

  if (experimentQuery.isLoading) return <LoadingState text="正在读取实验生命周期" />;
  if (experimentQuery.error) return <ErrorState error={experimentQuery.error} onRetry={() => void experimentQuery.refetch()} />;
  const data = experimentQuery.data!;
  const experiment = data.experiment;
  const summary = data.summary;
  const caseByKey = new Map((casesQuery.data?.cases ?? []).map((item) => [item.caseKey, item]));
  const active = isActiveExperiment(experiment.status);
  const runs = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return data.runs.filter((run) => {
      if (statusFilter === "active" && !["queued", "created", "running", "waiting", "grading"].includes(run.status)) return false;
      if (statusFilter !== "all" && statusFilter !== "active" && run.status !== statusFilter) return false;
      if (!needle) return true;
      return `${run.caseKey} ${run.executorId} ${run.error ?? ""}`.toLowerCase().includes(needle);
    });
  }, [data.runs, search, statusFilter]);

  return (
    <div className="page-stack experiment-detail-page">
      <Link className="back-link" to="/experiments"><ArrowLeft size={14} /> 返回实验列表</Link>
      <PageHeader
        eyebrow="EXPERIMENT"
        title={experiment.name}
        description={<span className="header-meta-line"><code>{experiment.id}</code><span>·</span><span>创建于 {formatDate(experiment.createdAt)}</span></span>}
        actions={
          <>
            {active && <button className="button button-danger-ghost" disabled={cancelMutation.isPending} onClick={() => { if (window.confirm("确定取消这次实验？正在执行的 Hearth 任务也会被取消。")) cancelMutation.mutate(); }}><Ban size={15} /> 取消实验</button>}
            <button className="button" onClick={() => void experimentQuery.refetch()}><RefreshCw size={15} /> 刷新</button>
          </>
        }
      />

      <section className="experiment-status-banner">
        <div className="status-banner-main"><StatusPill status={experiment.status} /><span>{active ? "评测 Agent 正在推进实验，页面会自动刷新。" : `实验结束于 ${formatDateTime(experiment.finishedAt)}`}</span></div>
        <LifecycleRail status={experiment.status} />
      </section>

      <section className="metric-grid">
        <MetricCard label="通过率" value={formatPercent(summary?.passRate ?? null)} detail={summary ? `${summary.passed} 通过 / ${summary.totalRuns} 运行` : "等待运行数据"} icon={<ShieldCheck size={17} />} tone="success" />
        <MetricCard label="平均分" value={summary?.avgScore === null || summary?.avgScore === undefined ? "—" : summary.avgScore.toFixed(1)} detail="确定性 + 模型评委 + 人工" icon={<Gauge size={17} />} />
        <MetricCard label="待复核" value={summary?.needsReview ?? 0} detail="低置信度、冲突或失败样本" icon={<TriangleAlert size={17} />} tone={(summary?.needsReview ?? 0) > 0 ? "warning" : "neutral"} />
        <MetricCard label="平均耗时" value={summary?.avgDurationMs === null || summary?.avgDurationMs === undefined ? "—" : `${(summary.avgDurationMs / 1_000).toFixed(1)}s`} detail={`${summary?.retries ?? 0} 次重试 · ${summary?.approvals ?? 0} 次审批`} icon={<Clock3 size={17} />} />
      </section>

      <div className="detail-grid result-overview">
        <section className="panel">
          <SectionHeader title="评测结果" detail={`${data.runs.length} 次运行`} />
          <div className="result-hero">
            <ScoreDial score={summary?.avgScore ?? null} caption="实验均分" />
            <div className="result-bars">
              <ProgressBar value={summary?.passRate ?? null} label="通过率" tone="success" />
              <div className="result-stat-row">
                <span><i className="dot passed" /> 通过 <strong>{summary?.passed ?? 0}</strong></span>
                <span><i className="dot failed" /> 失败 <strong>{summary?.failed ?? 0}</strong></span>
                <span><i className="dot blocked" /> 阻塞 <strong>{summary?.blocked ?? 0}</strong></span>
                <span><i className="dot review" /> 待复核 <strong>{summary?.needsReview ?? 0}</strong></span>
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <SectionHeader title="任务族结果" detail="按 case family 聚合" />
          {summary ? (
            <div className="family-result-list">
              {summary.families.filter((family) => family.total > 0).map((family) => (
                <div key={family.family} className="family-result-row">
                  <span>{FAMILY_LABELS[family.family]}</span>
                  <div className="mini-track"><i style={{ width: `${family.passRate ?? 0}%` }} /></div>
                  <strong>{formatPercent(family.passRate)}</strong>
                  <small>{family.passed}/{family.total}</small>
                </div>
              ))}
            </div>
          ) : <EmptyState title="尚无汇总" description="运行数据完成后自动生成。" />}
        </section>
      </div>

      {summary && summary.failureDiagnostics.length > 0 && (
        <section className="panel failure-panel">
          <SectionHeader title="失败诊断" detail="按错误类型聚类" />
          <div className="diagnostic-grid">
            {summary.failureDiagnostics.map((diagnostic) => (
              <div className="diagnostic-card" key={diagnostic.kind}><span>{diagnostic.kind}</span><strong>{diagnostic.count}</strong><small>{diagnostic.runIds.slice(0, 3).map((runId) => shortId(runId, 8)).join(" · ")}</small></div>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <SectionHeader title="运行列表" detail={`${runs.length} / ${data.runs.length} 条`} />
        <div className="run-toolbar">
          <div className="status-filter-tabs">
            {STATUS_OPTIONS.map((option) => <button key={option.value} className={statusFilter === option.value ? "active" : ""} onClick={() => setStatusFilter(option.value)}>{option.label}</button>)}
          </div>
          <div className="search-field compact"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 case、执行器或错误" /></div>
        </div>
        {runs.length === 0 ? <EmptyState title="没有匹配的运行" description="调整状态筛选或搜索词。" /> : (
          <div className="table-wrap">
            <table className="data-table runs-table">
              <thead><tr><th>Case</th><th>执行器</th><th>重复</th><th>状态</th><th>分数</th><th>耗时</th><th>任务 / 错误</th><th /></tr></thead>
              <tbody>
                {runs.map((run) => {
                  const caseSummary = caseByKey.get(run.caseKey);
                  return (
                    <tr key={run.id}>
                      <td><Link className="table-primary" to={`/runs/${run.id}`}>{caseSummary?.title ?? run.caseKey}<small>{run.caseKey}</small></Link></td>
                      <td><span className="executor-tag"><Cpu size={13} /> {executorLabel(run.executorId)}</span></td>
                      <td>#{run.repetition}</td>
                      <td><StatusPill status={run.status} /></td>
                      <td>{run.score === null ? "—" : run.score.toFixed(1)}</td>
                      <td className="table-muted">{formatDuration(run.startedAt, run.finishedAt)}</td>
                      <td>{run.hearthTaskId ? <code className="task-ref">{shortId(run.hearthTaskId, 12)}</code> : <span className="table-muted">—</span>}{run.error && <small className="error-line">{run.error}</small>}</td>
                      <td><Link className="table-arrow" to={`/runs/${run.id}`} aria-label="查看运行"><ArrowRight size={15} /></Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="detail-grid">
        <section className="panel">
          <SectionHeader title="运行环境" detail="创建实验时固定" />
          <div className="kv-stack">
            <KeyValue label="Hearth" mono>{experiment.environment.hearthUrl}</KeyValue>
            <KeyValue label="Hearth 时间">{formatDateTime(experiment.environment.hearthNow)}</KeyValue>
            <KeyValue label="Schema">v{experiment.environment.schemaVersion ?? "—"}</KeyValue>
            <KeyValue label="实例" mono>{shortId(experiment.environment.instanceId, 24)}</KeyValue>
            <KeyValue label="评委模型">{experiment.environment.judgeModel ?? "未配置"}</KeyValue>
            <KeyValue label="评测版本">v{experiment.environment.evalVersion}</KeyValue>
          </div>
        </section>
        <section className="panel">
          <SectionHeader title="实验事件" detail={`${data.events.length} 条`} action={<Activity size={17} />} />
          <div className="compact-timeline">
            {data.events.slice(-30).reverse().map((event) => (
              <div className="compact-event" key={event.seq}>
                <i />
                <div><strong>{EVENT_LABELS[event.type] ?? event.type}</strong><small>{formatDateTime(event.createdAt)}{event.runId ? ` · ${shortId(event.runId, 8)}` : ""}</small></div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

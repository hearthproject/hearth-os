import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  GitCompareArrows,
  Minus,
  TrendingDown,
  TrendingUp
} from "lucide-react";
import { Link } from "react-router-dom";
import type { CompareResponse } from "@hearth/eval-core";
import { api } from "../lib/api.ts";
import {
  FAMILY_LABELS,
  formatPercent,
  statusMeta
} from "../lib/labels.ts";
import { EmptyState, ErrorState, LoadingState, PageHeader, SectionHeader } from "../components/ui.tsx";

export function ComparePage() {
  const experimentsQuery = useQuery({ queryKey: ["experiments"], queryFn: api.experiments });
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const experiments = experimentsQuery.data?.experiments ?? [];

  useEffect(() => {
    if (left || right || experiments.length < 2) return;
    setLeft(experiments[1]?.id ?? "");
    setRight(experiments[0]?.id ?? "");
  }, [experiments, left, right]);

  const compareQuery = useQuery({
    queryKey: ["compare", left, right],
    queryFn: () => api.compare(left, right),
    enabled: Boolean(left && right)
  });

  if (experimentsQuery.isLoading) return <LoadingState text="正在读取实验" />;
  if (experimentsQuery.error) return <ErrorState error={experimentsQuery.error} onRetry={() => void experimentsQuery.refetch()} />;

  return (
    <div className="page-stack compare-page">
      <PageHeader
        title="实验对比"
        description="对齐 case、执行器与运行模式，观察通过率和任务族层面的质量变化。"
      />

      {experiments.length < 2 ? (
        <EmptyState title="至少需要两条实验" description="完成两次实验后即可进行基线与候选版本对比。" action={<Link className="button" to="/experiments/new">新建实验</Link>} />
      ) : (
        <>
          <section className="compare-picker">
            <label className="compare-select left">
              <span><b>A</b> 基线实验</span>
              <select value={left} onChange={(event) => setLeft(event.target.value)}>
                {experiments.map((experiment) => <option key={experiment.id} value={experiment.id}>{experiment.name} · {statusMeta(experiment.status).label}</option>)}
              </select>
            </label>
            <div className="compare-glyph"><ArrowLeftRight size={20} /></div>
            <label className="compare-select right">
              <span><b>B</b> 候选实验</span>
              <select value={right} onChange={(event) => setRight(event.target.value)}>
                {experiments.map((experiment) => <option key={experiment.id} value={experiment.id}>{experiment.name} · {statusMeta(experiment.status).label}</option>)}
              </select>
            </label>
          </section>

          {compareQuery.isLoading && <LoadingState text="正在计算实验差异" />}
          {compareQuery.error && <ErrorState error={compareQuery.error} onRetry={() => void compareQuery.refetch()} />}
          {compareQuery.data && <CompareResult data={compareQuery.data} />}
        </>
      )}
    </div>
  );
}

function CompareResult({ data }: { data: CompareResponse }) {
  if (!data.left || !data.right) {
    return <EmptyState title="汇总尚未就绪" description="实验结束后刷新页面再比较。" />;
  }
  return (
    <>
      <div className={`alignment-banner ${data.aligned ? "aligned" : "warning"}`}>
        {data.aligned ? <GitCompareArrows size={18} /> : <AlertTriangle size={18} />}
        <div><strong>{data.aligned ? "实验条件已对齐" : "实验条件不完全一致"}</strong><span>{data.aligned ? "case、执行器、运行模式与重复次数一致，差值可直接参考。" : data.warnings.join(" ")}</span></div>
      </div>

      <section className="compare-hero">
        <div className="compare-side">
          <span className="compare-label"><b>A</b> {data.leftName}</span>
          <div className="compare-big">{formatPercent(data.left.passRate)}</div>
          <small>通过率</small>
          <div className="compare-side-stats"><span>{data.left.passed} 通过</span><span>{data.left.failed} 失败</span><span>{data.left.needsReview} 待复核</span></div>
        </div>
        <div className="compare-delta-main">
          <DeltaValue value={(data.right.passRate ?? 0) - (data.left.passRate ?? 0)} suffix="pp" />
          <span>通过率变化</span>
        </div>
        <div className="compare-side">
          <span className="compare-label"><b>B</b> {data.rightName}</span>
          <div className="compare-big">{formatPercent(data.right.passRate)}</div>
          <small>通过率</small>
          <div className="compare-side-stats"><span>{data.right.passed} 通过</span><span>{data.right.failed} 失败</span><span>{data.right.needsReview} 待复核</span></div>
        </div>
      </section>

      <section className="metric-grid">
        <CompareMetric label="平均分" left={data.left.avgScore} right={data.right.avgScore} suffix="" />
        <CompareMetric label="运行数" left={data.left.totalRuns} right={data.right.totalRuns} suffix="" />
        <CompareMetric label="平均耗时" left={data.left.avgDurationMs === null ? null : data.left.avgDurationMs / 1_000} right={data.right.avgDurationMs === null ? null : data.right.avgDurationMs / 1_000} suffix="s" />
        <CompareMetric label="重试次数" left={data.left.retries} right={data.right.retries} suffix="" lowerIsBetter />
      </section>

      <section className="panel">
        <SectionHeader title="任务族差异" detail="B 相对 A 的通过率变化" />
        <div className="table-wrap">
          <table className="data-table family-delta-table">
            <thead><tr><th>任务族</th><th>A 通过率</th><th>B 通过率</th><th>变化</th><th className="delta-visual-col" /></tr></thead>
            <tbody>
              {data.familyDeltas.map((row) => (
                <tr key={row.family}>
                  <td><strong>{FAMILY_LABELS[row.family]}</strong></td>
                  <td>{formatPercent(row.leftPassRate)}</td>
                  <td>{formatPercent(row.rightPassRate)}</td>
                  <td><DeltaValue value={row.delta} suffix="pp" /></td>
                  <td className="delta-visual-col">
                    <div className="delta-track"><span className={row.delta === null ? "" : row.delta >= 0 ? "positive" : "negative"} style={{ width: `${row.delta === null ? 0 : Math.min(50, Math.abs(row.delta) / 2)}%` }} /></div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="compare-links">
        <Link className="button" to={`/experiments/${data.leftExperimentId}`}>打开 A 实验 <ArrowRight size={14} /></Link>
        <Link className="button" to={`/experiments/${data.rightExperimentId}`}>打开 B 实验 <ArrowRight size={14} /></Link>
      </section>
    </>
  );
}

function CompareMetric({ label, left, right, suffix, lowerIsBetter = false }: { label: string; left: number | null; right: number | null; suffix: string; lowerIsBetter?: boolean }) {
  const delta = left === null || right === null ? null : right - left;
  return (
    <article className="compare-metric">
      <span>{label}</span>
      <div><strong>{formatValue(left, suffix)}</strong><i /><strong>{formatValue(right, suffix)}</strong></div>
      <DeltaValue value={delta} suffix={suffix} lowerIsBetter={lowerIsBetter} />
    </article>
  );
}

function DeltaValue({ value, suffix, lowerIsBetter = false }: { value: number | null; suffix: string; lowerIsBetter?: boolean }) {
  if (value === null) return <span className="delta-value neutral"><Minus size={13} /> —</span>;
  const positive = lowerIsBetter ? value < 0 : value > 0;
  const negative = lowerIsBetter ? value > 0 : value < 0;
  return (
    <span className={`delta-value ${positive ? "positive" : negative ? "negative" : "neutral"}`}>
      {positive ? <TrendingUp size={13} /> : negative ? <TrendingDown size={13} /> : <Minus size={13} />}
      {value > 0 ? "+" : ""}{Number.isInteger(value) ? value : value.toFixed(1)}{suffix}
    </span>
  );
}

function formatValue(value: number | null, suffix: string): string {
  if (value === null) return "—";
  return `${Number.isInteger(value) ? value : value.toFixed(1)}${suffix}`;
}

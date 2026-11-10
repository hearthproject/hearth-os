import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ClipboardCheck,
  Cpu,
  FileSearch,
  X
} from "lucide-react";
import { Link } from "react-router-dom";
import type { ReviewQueueItem } from "@hearth/eval-core";
import { api } from "../lib/api.ts";
import {
  DIFFICULTY_LABELS,
  FAMILY_LABELS,
  REASON_LABELS,
  REVIEW_REASON_OPTIONS,
  executorLabel,
  formatDate
} from "../lib/labels.ts";
import { EmptyState, ErrorState, LoadingState, MetricCard, PageHeader, StatusPill } from "../components/ui.tsx";

export function ReviewsPage() {
  const queryClient = useQueryClient();
  const [reasonFilter, setReasonFilter] = useState("all");
  const reviewsQuery = useQuery({ queryKey: ["reviews"], queryFn: api.reviews, refetchInterval: 5_000 });
  const reviews = reviewsQuery.data?.reviews ?? [];
  const filtered = useMemo(() => reviews.filter((item) => reasonFilter === "all" || item.reasons.includes(reasonFilter as ReviewQueueItem["reasons"][number])), [reasonFilter, reviews]);
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const item of reviews) for (const reason of item.reasons) result.set(reason, (result.get(reason) ?? 0) + 1);
    return result;
  }, [reviews]);

  if (reviewsQuery.isLoading) return <LoadingState text="正在读取复核队列" />;
  if (reviewsQuery.error) return <ErrorState error={reviewsQuery.error} onRetry={() => void reviewsQuery.refetch()} />;

  return (
    <div className="page-stack reviews-page">
      <PageHeader
        title="复核队列"
        description="这里汇聚低置信度、评委冲突、阻塞异常、失败样本和固定抽样的运行。你的判断会更新实验汇总。"
      />

      <section className="metric-grid review-metrics">
        <MetricCard label="待复核" value={reviews.length} detail={reviews.length > 0 ? "按最早更新时间优先" : "队列已清空"} icon={<ClipboardCheck size={16} />} tone={reviews.length > 0 ? "warning" : "success"} />
        <MetricCard label="低置信度" value={counts.get("low_confidence") ?? 0} detail="模型评委信心不足" icon={<FileSearch size={16} />} />
        <MetricCard label="评委冲突" value={counts.get("judge_conflict") ?? 0} detail="确定性结论与评委冲突" icon={<FileSearch size={16} />} />
        <MetricCard label="失败样本" value={counts.get("failed_sample") ?? 0} detail="失败运行也需要确认" icon={<FileSearch size={16} />} />
      </section>

      <div className="review-filter-bar">
        <button className={reasonFilter === "all" ? "active" : ""} onClick={() => setReasonFilter("all")}>全部 <em>{reviews.length}</em></button>
        {REVIEW_REASON_OPTIONS.map((reason) => <button key={reason} className={reasonFilter === reason ? "active" : ""} onClick={() => setReasonFilter(reason)}>{REASON_LABELS[reason]} <em>{counts.get(reason) ?? 0}</em></button>)}
      </div>

      {filtered.length === 0 ? (
        <EmptyState title={reviews.length === 0 ? "复核队列已清空" : "当前筛选没有结果"} description={reviews.length === 0 ? "新的冲突、低置信度或失败样本会自动出现在这里。" : "切换原因筛选查看其他待复核运行。"} />
      ) : (
        <div className="review-list">
          {filtered.map((item) => (
            <ReviewCard
              key={item.run.id}
              item={item}
              onReviewed={() => {
                void queryClient.invalidateQueries({ queryKey: ["reviews"] });
                void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
                void queryClient.invalidateQueries({ queryKey: ["experiments"] });
                void queryClient.invalidateQueries({ queryKey: ["experiment", item.run.experimentId] });
                void queryClient.invalidateQueries({ queryKey: ["run", item.run.id] });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewCard({ item, onReviewed }: { item: ReviewQueueItem; onReviewed: () => void }) {
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState(false);
  const mutation = useMutation({
    mutationFn: (decision: "pass" | "fail") => api.submitReview(item.run.id, {
      decision,
      reviewer: "local",
      ...(note.trim() ? { note: note.trim() } : {})
    }),
    onSuccess: onReviewed
  });
  const family = item.case?.family;
  return (
    <article className="review-card">
      <div className="review-card-head">
        <div className="review-case-line">
          {family && <span className="family-tag">{FAMILY_LABELS[family]}</span>}
          {item.case && <span className={`difficulty-tag difficulty-${item.case.difficulty}`}>{DIFFICULTY_LABELS[item.case.difficulty]}</span>}
          <StatusPill status={item.run.status} subtle />
        </div>
        <Link className="text-link" to={`/runs/${item.run.id}`}>打开轨迹 <ArrowRight size={14} /></Link>
      </div>
      <div className="review-card-body">
        <div>
          <h2>{item.case?.title ?? item.run.caseKey}</h2>
          <p className="review-experiment"><Link to={`/experiments/${item.run.experimentId}`}>{item.experimentName}</Link> · {formatDate(item.run.updatedAt)}</p>
          <p className="review-summary">{item.summary}</p>
          <div className="review-reasons">{item.reasons.map((reason) => <span key={reason}>{REASON_LABELS[reason]}</span>)}</div>
        </div>
        <div className="review-run-meta">
          <span><Cpu size={14} /> {executorLabel(item.run.executorId)}</span>
          <span>重复 #{item.run.repetition}</span>
          <span>分数 {item.run.score === null ? "—" : item.run.score.toFixed(1)}</span>
        </div>
      </div>
      <div className="review-card-actions">
        {!expanded ? (
          <button className="button button-pass" onClick={() => setExpanded(true)}><Check size={15} /> 快速复核</button>
        ) : (
          <div className="inline-review-form">
            <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="可选：记录判断依据" maxLength={4000} />
            <button className="button button-pass" disabled={mutation.isPending} onClick={() => mutation.mutate("pass")}><Check size={15} /> 通过</button>
            <button className="button button-fail" disabled={mutation.isPending} onClick={() => mutation.mutate("fail")}><X size={15} /> 未通过</button>
            <button className="icon-button" onClick={() => setExpanded(false)} aria-label="收起"><X size={15} /></button>
          </div>
        )}
        {mutation.error && <span className="inline-error">{mutation.error.message}</span>}
      </div>
    </article>
  );
}

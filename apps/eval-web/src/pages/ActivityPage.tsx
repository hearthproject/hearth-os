import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Pause, Play, Search, Stethoscope } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import { EVENT_LABELS, formatDateTime, shortId } from "../lib/labels.ts";
import { EmptyState, ErrorState, LoadingState, MetricCard, PageHeader, SectionHeader } from "../components/ui.tsx";

const EVENT_GROUPS = [
  { value: "all", label: "全部" },
  { value: "experiment", label: "实验" },
  { value: "run", label: "运行" },
  { value: "review", label: "复核" },
  { value: "system", label: "系统" }
];

export function ActivityPage() {
  const [group, setGroup] = useState("all");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const eventsQuery = useQuery({
    queryKey: ["events", "activity"],
    queryFn: () => api.events({ limit: 500 }),
    refetchInterval: paused ? false : 3_000
  });
  const events = eventsQuery.data?.events ?? [];
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return events.filter((event) => {
      if (group !== "all" && !event.type.startsWith(`${group}.`)) return false;
      if (!needle) return true;
      return `${event.type} ${event.experimentId ?? ""} ${event.runId ?? ""} ${JSON.stringify(event.payload)}`.toLowerCase().includes(needle);
    }).slice().reverse();
  }, [events, group, search]);
  const latest = events[events.length - 1];

  if (eventsQuery.isLoading) return <LoadingState text="正在读取评测活动" />;
  if (eventsQuery.error) return <ErrorState error={eventsQuery.error} onRetry={() => void eventsQuery.refetch()} />;

  return (
    <div className="page-stack activity-page">
      <PageHeader
        eyebrow="EVENT STREAM"
        title="活动流"
        description="评测 Agent 的每次实验创建、任务推进、评分、复核与恢复都会在这里留下时间戳。"
        actions={<button className="button" onClick={() => setPaused((value) => !value)}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? "继续刷新" : "暂停刷新"}</button>}
      />

      <section className="metric-grid">
        <MetricCard label="最近事件" value={events.length} detail="最多显示 500 条" icon={<Activity size={17} />} />
        <MetricCard label="最新序号" value={latest?.seq ?? "—"} detail={latest ? formatDateTime(latest.createdAt) : "暂无活动"} icon={<Stethoscope size={17} />} />
        <MetricCard label="进行中实验" value={new Set(events.filter((event) => event.type === "experiment.started").map((event) => event.experimentId)).size} detail="当前窗口内启动过" icon={<Activity size={17} />} tone="accent" />
        <MetricCard label="刷新状态" value={paused ? "已暂停" : "实时"} detail={paused ? "点击右上角继续" : "每 3 秒轮询"} icon={<Activity size={17} />} tone={paused ? "warning" : "success"} />
      </section>

      <section className="panel">
        <SectionHeader title="事件时间线" detail={`${filtered.length} 条匹配`} action={<Activity size={18} />} />
        <div className="run-toolbar">
          <div className="status-filter-tabs">{EVENT_GROUPS.map((item) => <button key={item.value} className={group === item.value ? "active" : ""} onClick={() => setGroup(item.value)}>{item.label}</button>)}</div>
          <div className="search-field compact"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索事件、实验或运行 ID" /></div>
        </div>
        {filtered.length === 0 ? <EmptyState title="没有匹配的事件" description="调整类型筛选或搜索词。" /> : (
          <div className="activity-feed">
            {filtered.map((event) => (
              <article className={`activity-item activity-${event.type.split(".")[0]}`} key={event.seq}>
                <div className="activity-seq">#{event.seq}</div>
                <div className="activity-main">
                  <div className="activity-head"><strong>{EVENT_LABELS[event.type] ?? event.type}</strong><time>{formatDateTime(event.createdAt)}</time></div>
                  <code>{event.type}</code>
                  <div className="activity-links">
                    {event.experimentId && <Link to={`/experiments/${event.experimentId}`}>实验 {shortId(event.experimentId, 12)}</Link>}
                    {event.runId && <Link to={`/runs/${event.runId}`}>运行 {shortId(event.runId, 10)}</Link>}
                  </div>
                  {Object.keys(event.payload).length > 0 && <pre>{JSON.stringify(event.payload, null, 2)}</pre>}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

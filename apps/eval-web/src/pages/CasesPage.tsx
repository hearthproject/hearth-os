import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Filter, Search, Sparkles } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.ts";
import {
  DIFFICULTY_LABELS,
  FAMILY_COLORS,
  FAMILY_LABELS,
  RUN_MODE_LABELS
} from "../lib/labels.ts";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../components/ui.tsx";

export function CasesPage() {
  const [params, setParams] = useSearchParams();
  const family = params.get("family") ?? "";
  const difficulty = params.get("difficulty") ?? "";
  const runMode = params.get("runMode") ?? "";
  const search = params.get("search") ?? "";

  const casesQuery = useQuery({
    queryKey: ["cases", family, difficulty, runMode, search],
    queryFn: () => api.cases({
      ...(family ? { family } : {}),
      ...(difficulty ? { difficulty } : {}),
      ...(runMode ? { runMode } : {}),
      ...(search ? { search } : {})
    })
  });

  const families = useMemo(() => Object.keys(FAMILY_LABELS) as Array<keyof typeof FAMILY_LABELS>, []);
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const cases = casesQuery.data?.cases ?? [];
  const counts = casesQuery.data?.counts;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="CASE LIBRARY"
        title="任务目录"
        description="覆盖邮件、日程、文档、研究、代码、网页、桌面与跨应用任务。每个 case 都带有输入、grader、评分标准与人工复核指引。"
        actions={<Link className="button button-primary" to="/experiments/new"><Sparkles size={15} /> 从目录创建实验</Link>}
      />

      <section className="filter-panel">
        <div className="search-field">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setFilter("search", event.target.value)}
            placeholder="搜索 case、标题或标签"
            aria-label="搜索任务"
          />
        </div>
        <label className="select-field"><Filter size={14} /><select value={difficulty} onChange={(event) => setFilter("difficulty", event.target.value)}><option value="">全部难度</option>{(Object.keys(DIFFICULTY_LABELS) as Array<keyof typeof DIFFICULTY_LABELS>).map((key) => <option key={key} value={key}>{DIFFICULTY_LABELS[key]}</option>)}</select></label>
        <label className="select-field"><select value={runMode} onChange={(event) => setFilter("runMode", event.target.value)}><option value="">全部运行模式</option>{Object.entries(RUN_MODE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {(family || difficulty || runMode || search) && <button className="button button-ghost" onClick={() => setParams({}, { replace: true })}>清除筛选</button>}
      </section>

      <div className="family-tabs" role="tablist" aria-label="任务族">
        <button className={!family ? "active" : ""} onClick={() => setFilter("family", "")}>全部 <em>{counts ? Object.values(counts).reduce((sum, count) => sum + count, 0) : "—"}</em></button>
        {families.map((key) => (
          <button key={key} className={family === key ? "active" : ""} onClick={() => setFilter("family", key)}>
            <i style={{ background: FAMILY_COLORS[key] }} />{FAMILY_LABELS[key]} <em>{counts?.[key] ?? "—"}</em>
          </button>
        ))}
      </div>

      {casesQuery.isLoading && <LoadingState text="正在读取任务目录" />}
      {casesQuery.error && <ErrorState error={casesQuery.error} onRetry={() => void casesQuery.refetch()} />}
      {!casesQuery.isLoading && !casesQuery.error && cases.length === 0 && (
        <EmptyState title="没有匹配的任务" description="调整任务族、难度或搜索词后再试。" />
      )}

      <section className="case-grid">
        {cases.map((item) => (
          <Link className="case-card" key={item.caseKey} to={`/cases/${item.caseKey}`}>
            <div className="case-card-top">
              <span className="family-tag" style={{ color: FAMILY_COLORS[item.family] }}><i style={{ background: FAMILY_COLORS[item.family] }} />{FAMILY_LABELS[item.family]}</span>
              <span className={`difficulty-tag difficulty-${item.difficulty}`}>{DIFFICULTY_LABELS[item.difficulty]}</span>
            </div>
            <h3>{item.title}</h3>
            <code>{item.caseKey}</code>
            <div className="case-card-foot">
              <span>v{item.version} · {item.runModes.map((mode) => RUN_MODE_LABELS[mode] ?? mode).join(" / ")}</span>
              <ArrowRight size={15} />
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}

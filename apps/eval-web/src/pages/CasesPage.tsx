import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Filter, Plus, Search } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.ts";
import {
  DIFFICULTY_LABELS,
  FAMILY_LABELS,
  RUN_MODE_LABELS
} from "../lib/labels.ts";
import { EmptyState, ErrorState, LoadingState, PageHeader, SectionHeader } from "../components/ui.tsx";

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
  const hasFilters = Boolean(family || difficulty || runMode || search);

  return (
    <div className="page-stack">
      <PageHeader
        title="任务目录"
        description="覆盖邮件、日程、文档、研究、代码、网页、桌面与跨应用任务。每个任务都有输入、评分标准与人工复核指引。"
        actions={<Link className="button button-primary" to="/experiments/new"><Plus size={15} /> 新建实验</Link>}
      />

      <section className="filter-panel">
        <div className="search-field">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setFilter("search", event.target.value)}
            placeholder="搜索任务、标题或标签"
            aria-label="搜索任务"
          />
        </div>
        <label className="select-field"><Filter size={14} /><select value={difficulty} onChange={(event) => setFilter("difficulty", event.target.value)}><option value="">全部难度</option>{(Object.keys(DIFFICULTY_LABELS) as Array<keyof typeof DIFFICULTY_LABELS>).map((key) => <option key={key} value={key}>{DIFFICULTY_LABELS[key]}</option>)}</select></label>
        <label className="select-field"><select value={runMode} onChange={(event) => setFilter("runMode", event.target.value)}><option value="">全部运行模式</option>{Object.entries(RUN_MODE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {hasFilters && <button className="button button-ghost" onClick={() => setParams({}, { replace: true })}>清除筛选</button>}
      </section>

      <div className="family-tabs" role="tablist" aria-label="任务族">
        <button className={!family ? "active" : ""} onClick={() => setFilter("family", "")}>全部 <em>{counts ? Object.values(counts).reduce((sum, count) => sum + count, 0) : "—"}</em></button>
        {families.map((key) => (
          <button key={key} className={family === key ? "active" : ""} onClick={() => setFilter("family", key)}>
            {FAMILY_LABELS[key]} <em>{counts?.[key] ?? "—"}</em>
          </button>
        ))}
      </div>

      {casesQuery.isLoading && <LoadingState text="正在读取任务目录" />}
      {casesQuery.error && <ErrorState error={casesQuery.error} onRetry={() => void casesQuery.refetch()} />}
      {!casesQuery.isLoading && !casesQuery.error && cases.length === 0 && (
        <EmptyState title="没有匹配的任务" description="调整任务族、难度或搜索词后再试。" />
      )}

      {cases.length > 0 && (
        <section className="panel">
          <SectionHeader title="全部任务" detail={`${cases.length} 个匹配任务`} />
          <div className="table-wrap">
            <table className="data-table case-table">
              <thead><tr><th>任务</th><th>任务族</th><th>难度</th><th>运行模式</th><th>版本</th><th /></tr></thead>
              <tbody>
                {cases.map((item) => (
                  <tr key={item.caseKey}>
                    <td>
                      <Link className="table-primary" to={`/cases/${item.caseKey}`}>
                        {item.title}
                        <small>{item.caseKey}</small>
                      </Link>
                    </td>
                    <td>{FAMILY_LABELS[item.family]}</td>
                    <td><span className={`difficulty-tag difficulty-${item.difficulty}`}>{DIFFICULTY_LABELS[item.difficulty]}</span></td>
                    <td className="table-muted">{item.runModes.map((mode) => RUN_MODE_LABELS[mode] ?? mode).join(" / ")}</td>
                    <td className="table-muted">v{item.version}</td>
                    <td><Link className="table-arrow" to={`/cases/${item.caseKey}`} aria-label={`打开 ${item.title}`}><ChevronRight size={15} /></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

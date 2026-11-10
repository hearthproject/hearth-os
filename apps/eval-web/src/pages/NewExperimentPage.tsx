import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Layers3,
  Play,
  Search,
  Settings2,
  ShieldCheck
} from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { CaseVersionSummary, CreateExperimentRequest } from "@hearth/eval-core";
import { api } from "../lib/api.ts";
import {
  DIFFICULTY_LABELS,
  FAMILY_LABELS,
  executorLabel
} from "../lib/labels.ts";
import { ErrorState, LoadingState, PageHeader } from "../components/ui.tsx";

type RunMode = "offline" | "live";

export function NewExperimentPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const casesQuery = useQuery({ queryKey: ["cases", "all"], queryFn: () => api.cases() });
  const systemQuery = useQuery({ queryKey: ["system"], queryFn: api.system });
  const experimentsQuery = useQuery({ queryKey: ["experiments"], queryFn: api.experiments });
  const [name, setName] = useState("");
  const [runMode, setRunMode] = useState<RunMode>("offline");
  const [selectedCases, setSelectedCases] = useState<Set<string>>(() => {
    const initial = params.get("case");
    return new Set(initial ? [initial] : []);
  });
  const [executorIds, setExecutorIds] = useState<Set<string>>(new Set());
  const [repetitions, setRepetitions] = useState(1);
  const [maxConcurrency, setMaxConcurrency] = useState(1);
  const [autoJudge, setAutoJudge] = useState(true);
  const [autoRetry, setAutoRetry] = useState(true);
  const [baselineExperimentId, setBaselineExperimentId] = useState("");
  const [familyFilter, setFamilyFilter] = useState("");
  const [search, setSearch] = useState("");
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(() => new Set());

  const executors = systemQuery.data?.executors ?? [];
  useEffect(() => {
    if (executorIds.size > 0 || executors.length === 0) return;
    const firstReady = executors.find((executor) => executor.canRun);
    if (firstReady) setExecutorIds(new Set([firstReady.id]));
  }, [executors, executorIds.size]);

  const cases = casesQuery.data?.cases ?? [];
  const eligibleCases = useMemo(() => cases.filter((item) => supportsRunMode(item, runMode)), [cases, runMode]);
  const familyOptions = useMemo(() => [...new Set(cases.map((item) => item.family))], [cases]);
  const visibleCases = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return eligibleCases.filter((item) => {
      if (familyFilter && item.family !== familyFilter) return false;
      if (!needle) return true;
      return `${item.caseKey} ${item.title}`.toLowerCase().includes(needle);
    });
  }, [eligibleCases, familyFilter, search]);
  const groupedCases = useMemo(() => groupByFamily(visibleCases), [visibleCases]);
  const validSelected = useMemo(() => cases.filter((item) => selectedCases.has(item.caseKey) && supportsRunMode(item, runMode)), [cases, selectedCases, runMode]);

  const createMutation = useMutation({
    mutationFn: (request: CreateExperimentRequest) => api.createExperiment(request),
    onSuccess: (experiment) => navigate(`/experiments/${experiment.id}`)
  });

  if (casesQuery.isLoading || systemQuery.isLoading) return <LoadingState text="正在准备实验参数" />;
  if (casesQuery.error) return <ErrorState error={casesQuery.error} onRetry={() => void casesQuery.refetch()} />;
  if (systemQuery.error) return <ErrorState error={systemQuery.error} onRetry={() => void systemQuery.refetch()} />;

  const toggleCase = (caseKey: string) => {
    setSelectedCases((previous) => {
      const next = new Set(previous);
      if (next.has(caseKey)) next.delete(caseKey); else next.add(caseKey);
      return next;
    });
  };
  const toggleExecutor = (id: string) => {
    setExecutorIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const switchRunMode = (mode: RunMode) => {
    setRunMode(mode);
    setSelectedCases((previous) => new Set([...previous].filter((key) => {
      const item = cases.find((candidate) => candidate.caseKey === key);
      return item ? supportsRunMode(item, mode) : false;
    })));
  };
  const selectVisible = () => setSelectedCases((previous) => new Set([...previous, ...visibleCases.map((item) => item.caseKey)]));
  const clearVisible = () => setSelectedCases((previous) => {
    const next = new Set(previous);
    for (const item of visibleCases) next.delete(item.caseKey);
    return next;
  });
  const toggleFamily = (family: string) => setExpandedFamilies((previous) => {
    const next = new Set(previous);
    if (next.has(family)) next.delete(family); else next.add(family);
    return next;
  });

  const canSubmit = validSelected.length > 0 && executorIds.size > 0 && !createMutation.isPending;
  const submit = () => {
    if (!canSubmit) return;
    const request: CreateExperimentRequest = {
      ...(name.trim() ? { name: name.trim() } : {}),
      caseIds: validSelected.map((item) => item.caseKey),
      executorIds: [...executorIds],
      repetitions,
      runMode,
      autoJudge,
      autoRetry,
      maxConcurrency,
      baselineExperimentId: baselineExperimentId || null
    };
    createMutation.mutate(request);
  };

  return (
    <div className="page-stack new-experiment-page">
      <PageHeader
        title="创建评测实验"
        description="固定任务、执行器和运行环境，生成一条可追踪、可比较的质量记录。"
        actions={<Link className="button button-ghost" to="/experiments">取消</Link>}
      />

      <div className="experiment-builder">
        <div className="builder-main">
          <section className="panel">
            <div className="step-heading"><div><h2>实验信息</h2><p>给这次质量基线一个可识别的名字。</p></div></div>
            <label className="field-label">实验名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：v0.3 本地工作流基线" maxLength={120} /></label>
            <div className="option-grid">
              <label className={`option-card ${runMode === "offline" ? "selected" : ""}`}><input type="radio" checked={runMode === "offline"} onChange={() => switchRunMode("offline")} /><span><strong>离线评测</strong><small>仅使用仓库内固定输入与 golden，结果可复现。</small></span></label>
              <label className={`option-card ${runMode === "live" ? "selected" : ""}`}><input type="radio" checked={runMode === "live"} onChange={() => switchRunMode("live")} /><span><strong>在线评测</strong><small>允许访问 case 声明的网络域名，适合 live-only 任务。</small></span></label>
            </div>
          </section>

          <section className="panel">
            <div className="step-heading"><div><h2>选择任务</h2><p>已选择 <strong>{validSelected.length}</strong> 个任务，当前模式可用 {eligibleCases.length} 个。</p></div></div>
            <div className="case-picker-toolbar">
              <div className="search-field"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 case 或标题" /></div>
              <label className="select-field"><select value={familyFilter} onChange={(event) => setFamilyFilter(event.target.value)}><option value="">全部任务族</option>{familyOptions.map((family) => <option key={family} value={family}>{FAMILY_LABELS[family]}</option>)}</select></label>
              <div className="case-picker-actions">
                <button className="button button-ghost" onClick={selectVisible}>全选当前</button>
                <button className="button button-ghost" onClick={clearVisible}>取消当前</button>
              </div>
            </div>
            <div className="case-picker">
              {[...groupedCases.entries()].map(([family, items]) => {
                const expanded = expandedFamilies.size === 0 || expandedFamilies.has(family);
                const selectedCount = items.filter((item) => selectedCases.has(item.caseKey)).length;
                return (
                  <div className="case-family" key={family}>
                    <button className="case-family-head" onClick={() => toggleFamily(family)}>
                      {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <strong>{FAMILY_LABELS[family]}</strong>
                      <span>{selectedCount} / {items.length} 已选</span>
                    </button>
                    {expanded && (
                      <div className="case-choice-grid">
                        {items.map((item) => (
                          <label key={item.caseKey} className={`case-choice ${selectedCases.has(item.caseKey) ? "selected" : ""}`}>
                            <input type="checkbox" checked={selectedCases.has(item.caseKey)} onChange={() => toggleCase(item.caseKey)} />
                            <span className="choice-check"><Check size={12} /></span>
                            <span className="choice-copy"><strong>{item.title}</strong><small>{item.caseKey} · {DIFFICULTY_LABELS[item.difficulty]}</small></span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {groupedCases.size === 0 && <p className="muted-copy">没有符合条件的任务。</p>}
            </div>
          </section>

          <section className="panel">
            <div className="step-heading"><div><h2>执行器</h2><p>只显示 Hearth 当前检测到的执行器；不可用执行器会附带原因。</p></div></div>
            <div className="executor-choice-grid">
              {executors.map((executor) => (
                <label key={executor.id} className={`executor-choice ${executorIds.has(executor.id) ? "selected" : ""} ${!executor.canRun ? "disabled" : ""}`}>
                  <input type="checkbox" disabled={!executor.canRun} checked={executorIds.has(executor.id)} onChange={() => toggleExecutor(executor.id)} />
                  <span className="executor-icon"><Cpu size={17} /></span>
                  <span className="executor-copy"><strong>{executorLabel(executor.id)}</strong><small>{executor.description}</small></span>
                  <span className={`ready-dot ${executor.canRun ? "ok" : "bad"}`}>{executor.canRun ? "可运行" : "不可用"}</span>
                  {!executor.canRun && executor.issues.length > 0 && <em>{executor.issues[0]}</em>}
                </label>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="step-heading"><div><h2>运行参数</h2><p>控制重复次数、并发和自动评分行为。</p></div></div>
            <div className="form-grid">
              <label className="field-label">重复次数<input type="number" min={1} max={5} value={repetitions} onChange={(event) => setRepetitions(clamp(Number(event.target.value), 1, 5))} /></label>
              <label className="field-label">最大并发<input type="number" min={1} max={8} value={maxConcurrency} onChange={(event) => setMaxConcurrency(clamp(Number(event.target.value), 1, 8))} /></label>
              <label className="field-label full">基线实验<select value={baselineExperimentId} onChange={(event) => setBaselineExperimentId(event.target.value)}><option value="">不指定基线</option>{(experimentsQuery.data?.experiments ?? []).filter((item) => item.id !== undefined).map((experiment) => <option key={experiment.id} value={experiment.id}>{experiment.name}</option>)}</select></label>
            </div>
            <div className="switch-list">
              <ToggleRow checked={autoJudge} onChange={setAutoJudge} title="自动调用模型评委" detail="对 judge 类标准生成带证据的判断；不可用时转人工复核。" icon={<ShieldCheck size={17} />} />
              <ToggleRow checked={autoRetry} onChange={setAutoRetry} title="评分异常自动重试" detail="模型评委临时失败时最多重试一次。" icon={<Settings2 size={17} />} />
            </div>
          </section>
        </div>

        <aside className="builder-summary">
          <div className="summary-card sticky-card">
            <h2>运行摘要</h2>
            <p className="summary-name">{name.trim() || "未命名实验"}</p>
            <div className="summary-numbers">
              <div><strong>{validSelected.length}</strong><span>任务</span></div>
              <div><strong>{executorIds.size}</strong><span>执行器</span></div>
              <div><strong>{validSelected.length * executorIds.size * repetitions}</strong><span>运行</span></div>
            </div>
            <div className="summary-list">
              <span><Layers3 size={15} /> 模式 <b>{runMode === "offline" ? "离线" : "在线"}</b></span>
              <span><Cpu size={15} /> 执行器 <b>{[...executorIds].map(executorLabel).join(", ") || "未选择"}</b></span>
              <span><Settings2 size={15} /> 并发 <b>{maxConcurrency}</b></span>
              <span><ShieldCheck size={15} /> 评委 <b>{autoJudge ? "自动" : "关闭"}</b></span>
            </div>
            <div className="run-warning"><AlertTriangle size={15} /><span>提交后将立即调用 Hearth 开始真实评测。请确认执行器、case 与产物目录。</span></div>
            {createMutation.error && <div className="inline-error">{createMutation.error.message}</div>}
            <button className="button button-primary button-wide" disabled={!canSubmit} onClick={submit}>
              <Play size={15} /> {createMutation.isPending ? "正在创建…" : `开始 ${validSelected.length * executorIds.size * repetitions} 次运行`}
            </button>
            <small className="summary-foot">产物写入 .hearth/eval-artifacts，实验可随时取消。</small>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ToggleRow({ checked, onChange, title, detail, icon }: { checked: boolean; onChange: (value: boolean) => void; title: string; detail: string; icon: React.ReactNode }) {
  return (
    <label className="toggle-row">
      <span className="toggle-icon">{icon}</span>
      <span><strong>{title}</strong><small>{detail}</small></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i className="toggle-visual" />
    </label>
  );
}

function supportsRunMode(item: CaseVersionSummary, mode: RunMode): boolean {
  return mode === "offline"
    ? item.runModes.some((candidate) => candidate !== "live-only")
    : item.runModes.some((candidate) => candidate === "live-only" || candidate === "live-optional");
}

function groupByFamily(cases: CaseVersionSummary[]): Map<CaseVersionSummary["family"], CaseVersionSummary[]> {
  const groups = new Map<CaseVersionSummary["family"], CaseVersionSummary[]>();
  for (const item of cases) {
    const members = groups.get(item.family) ?? [];
    members.push(item);
    groups.set(item.family, members);
  }
  return groups;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

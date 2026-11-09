import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileInput, Play, ShieldCheck, Target } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api.ts";
import {
  DIFFICULTY_LABELS,
  FAMILY_LABELS,
  RUN_MODE_LABELS,
  shortId
} from "../lib/labels.ts";
import { ErrorState, KeyValue, LoadingState, PageHeader } from "../components/ui.tsx";

export function CaseDetailPage() {
  const { caseKey = "" } = useParams();
  const query = useQuery({ queryKey: ["case", caseKey], queryFn: () => api.caseDetail(caseKey), enabled: Boolean(caseKey) });
  if (query.isLoading) return <LoadingState text="正在读取任务定义" />;
  if (query.error) return <ErrorState error={query.error} />;
  const data = query.data!;
  const manifest = data.manifest;

  return (
    <div className="page-stack">
      <Link className="back-link" to="/cases"><ArrowLeft size={14} /> 返回任务目录</Link>
      <PageHeader
        title={manifest.title}
        description={manifest.description}
        actions={<Link className="button button-primary" to={`/experiments/new?case=${encodeURIComponent(manifest.id)}`}><Play size={15} /> 发起实验</Link>}
      />

      <section className="panel case-summary">
        <div className="case-summary-head">
          <div>
            <span className="case-family-label">{FAMILY_LABELS[manifest.family]}</span>
            <h2>{manifest.id}</h2>
          </div>
          <div className="case-summary-badges">
            <span className={`difficulty-tag difficulty-${manifest.difficulty}`}>{DIFFICULTY_LABELS[manifest.difficulty]}</span>
            <span className="family-tag">{manifest.runModes.map((mode) => RUN_MODE_LABELS[mode] ?? mode).join(" / ")}</span>
          </div>
        </div>
        <div className="case-summary-body">
          <p>{manifest.goal}</p>
          <div className="case-summary-facts">
            <div><span>版本</span><strong>v{manifest.version}</strong></div>
            <div><span>难度</span><strong>{DIFFICULTY_LABELS[manifest.difficulty]}</strong></div>
            <div><span>超时</span><strong>{Math.round(manifest.timeoutMs / 1_000)}s</strong></div>
            <div><span>评分标准</span><strong>{manifest.criteria.length}</strong></div>
          </div>
        </div>
      </section>

      <div className="detail-grid">
        <section className="panel">
          <div className="section-header"><div><h2>输入与期望</h2><span>任务隔离材料</span></div><FileInput size={18} /></div>
          <h3 className="subheading">输入</h3>
          <div className="item-list">
            {manifest.inputs.map((input) => (
              <div className="item-row" key={`${input.kind}-${input.label}`}>
                <span className={`kind-badge kind-${input.kind}`}>{input.kind}</span>
                <div><strong>{input.label}</strong><code>{input.path ?? input.value ?? "URL"}</code></div>
                {input.optional && <em>可选</em>}
              </div>
            ))}
          </div>
          <h3 className="subheading">期望产物</h3>
          <div className="chip-list">{manifest.expectedOutputs.map((output) => <code key={output}>{output}</code>)}</div>
        </section>

        <section className="panel">
          <div className="section-header"><div><h2>任务元数据</h2><span>内容指纹与标签</span></div><Target size={18} /></div>
          <div className="kv-stack">
            <KeyValue label="内容哈希" mono>{shortId(data.case.contentHash, 28)}</KeyValue>
            <KeyValue label="Golden 产物">{data.hasGolden ? "已提供" : "仅在线"}</KeyValue>
            <KeyValue label="网络域名">{manifest.networkHosts?.length ? manifest.networkHosts.join(", ") : "无"}</KeyValue>
          </div>
          <h3 className="subheading">标签</h3>
          <div className="chip-list">{manifest.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
          <h3 className="subheading">人工复核</h3>
          <p className="muted-copy">{manifest.humanReview.prompt}</p>
          <KeyValue label="抽样率">{Math.round(manifest.humanReview.sampleRate * 100)}%</KeyValue>
        </section>
      </div>

      <section className="panel">
        <div className="section-header"><div><h2>评分标准</h2><span>确定性、模型评委与人工标准</span></div><ShieldCheck size={18} /></div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>标准</th><th>来源</th><th>级别</th><th>分值</th><th>说明</th></tr></thead>
            <tbody>
              {manifest.criteria.map((criterion) => (
                <tr key={criterion.id}>
                  <td><strong>{criterion.label}</strong><small>{criterion.id}</small></td>
                  <td><span className={`source-badge source-${criterion.source}`}>{criterion.source}</span></td>
                  <td><span className={`severity-badge ${criterion.severity}`}>{criterion.severity === "blocker" ? "阻塞" : "计分"}</span></td>
                  <td>{criterion.points}</td>
                  <td className="table-muted">{criterion.rubric ?? criterion.graderId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="section-header"><div><h2>Grader 配置</h2><span>{manifest.graders.length} 个确定性检查</span></div></div>
        <div className="grader-grid">
          {manifest.graders.map((grader) => (
            <article key={grader.id} className="grader-card">
              <span className="kind-badge">{grader.config.kind}</span>
              <strong>{grader.title}</strong>
              <code>{grader.id}</code>
              <pre>{JSON.stringify(grader.config, null, 2)}</pre>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

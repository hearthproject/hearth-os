import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Database,
  FolderOpen,
  Gauge,
  HardDrive,
  RefreshCw,
  Server,
  ShieldCheck,
  XCircle
} from "lucide-react";
import { api } from "../lib/api.ts";
import { executorLabel, formatDateTime } from "../lib/labels.ts";
import { ErrorState, KeyValue, LoadingState, MetricCard, PageHeader, SectionHeader } from "../components/ui.tsx";

export function SystemPage() {
  const query = useQuery({ queryKey: ["system"], queryFn: api.system, refetchInterval: 10_000 });
  if (query.isLoading) return <LoadingState text="正在检查评测环境" />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const system = query.data!;
  const readyExecutors = system.executors.filter((executor) => executor.canRun).length;

  return (
    <div className="page-stack system-page">
      <PageHeader
        eyebrow="ENVIRONMENT"
        title="系统状态"
        description="评测服务与 Hearth、模型评委、执行器和本地存储之间的连接状态。"
        actions={<button className="button" onClick={() => void query.refetch()}><RefreshCw size={15} /> 重新检查</button>}
      />

      <section className={`system-banner ${system.hearthReachable ? "ok" : "bad"}`}>
        <span className="system-banner-icon">{system.hearthReachable ? <CheckCircle2 size={23} /> : <XCircle size={23} />}</span>
        <div><strong>{system.hearthReachable ? "Hearth 已连接" : "Hearth 不可达"}</strong><span>{system.hearthUrl} · 状态 {system.hearthStatus}</span></div>
        <small>检查于 {formatDateTime(system.generatedAt)}</small>
      </section>

      <section className="metric-grid">
        <MetricCard label="任务目录" value={system.catalogCases} detail={system.catalogIssues > 0 ? `${system.catalogIssues} 个目录问题` : "目录校验通过"} icon={<Database size={17} />} tone={system.catalogIssues > 0 ? "warning" : "neutral"} />
        <MetricCard label="可用执行器" value={`${readyExecutors} / ${system.executors.length}`} detail="来自 Hearth 实时探测" icon={<Cpu size={17} />} tone={readyExecutors > 0 ? "success" : "danger"} />
        <MetricCard label="模型评委" value={system.judgeConfigured ? "已配置" : "未配置"} detail={system.judgeModel ?? "自动评分将回退到人工复核"} icon={<ShieldCheck size={17} />} tone={system.judgeConfigured ? "success" : "warning"} />
        <MetricCard label="运行 / 复核" value={`${system.runningExperiments} / ${system.pendingReviews}`} detail="进行中实验 / 待人工复核" icon={<Gauge size={17} />} tone={system.pendingReviews > 0 ? "warning" : "neutral"} />
      </section>

      <div className="detail-grid">
        <section className="panel">
          <SectionHeader title="执行器" detail="Hearth 当前运行时" action={<Server size={18} />} />
          <div className="system-executor-list">
            {system.executors.map((executor) => (
              <article className={`system-executor ${executor.canRun ? "ready" : "unavailable"}`} key={executor.id}>
                <span className="executor-icon"><Cpu size={16} /></span>
                <div><strong>{executorLabel(executor.id)}</strong><small>{executor.description}</small>{executor.issues.map((issue) => <em key={issue}>{issue}</em>)}</div>
                <span className={`ready-badge ${executor.canRun ? "ok" : "bad"}`}>{executor.canRun ? "Ready" : "Unavailable"}</span>
                {executor.version && <code>{executor.version}</code>}
              </article>
            ))}
            {system.executors.length === 0 && <p className="muted-copy">Hearth 未返回执行器列表，请先在主控制台检查执行器设置。</p>}
          </div>
        </section>

        <section className="panel">
          <SectionHeader title="连接与模型" detail="评测依赖" />
          <div className="kv-stack">
            <KeyValue label="Hearth URL" mono>{system.hearthUrl}</KeyValue>
            <KeyValue label="Hearth 状态">{system.hearthReachable ? <span className="text-success">在线 · {system.hearthStatus}</span> : <span className="text-danger">离线</span>}</KeyValue>
            <KeyValue label="评委模型">{system.judgeModel ?? "未配置"}</KeyValue>
            <KeyValue label="评委状态">{system.judgeConfigured ? "可自动评分" : "仅确定性评分"}</KeyValue>
            <KeyValue label="评测版本">v{system.evalVersion}</KeyValue>
          </div>
          {!system.judgeConfigured && <div className="system-note warning"><AlertTriangle size={15} /><span>模型评委不可用时，judge 标准会触发人工复核，不会静默通过。</span></div>}
          {!system.hearthReachable && <div className="system-note danger"><XCircle size={15} /><span>先启动主服务 `npm run dev`，再回到评测控制台发起实验。</span></div>}
        </section>
      </div>

      <section className="panel">
        <SectionHeader title="本地存储" detail="评测数据库与产物根目录" action={<HardDrive size={18} />} />
        <div className="storage-grid">
          <div className="storage-card"><span className="storage-icon"><Database size={18} /></span><div><strong>评测数据库</strong><code>{system.dataDir}</code><small>SQLite 记录实验、运行、grader、复核和事件。</small></div></div>
          <div className="storage-card"><span className="storage-icon"><FolderOpen size={18} /></span><div><strong>产物目录</strong><code>{system.artifactRoot}</code><small>按实验 / case / 执行器 / 重复次数隔离。</small></div></div>
        </div>
      </section>

      <section className="panel">
        <SectionHeader title="启动方式" detail="开发环境最终检查" />
        <div className="command-grid">
          <div><span>主服务</span><code>npm run dev</code><small>Hearth API · 127.0.0.1:4317</small></div>
          <div><span>评测服务</span><code>npm run dev:eval</code><small>Eval API · 127.0.0.1:4318</small></div>
          <div><span>评测前端</span><code>npm run dev:eval-web</code><small>Console · 127.0.0.1:5174</small></div>
          <div><span>生产构建</span><code>npm run build:eval-web</code><small>由评测服务托管 dist</small></div>
        </div>
      </section>
    </div>
  );
}

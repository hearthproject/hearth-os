import type { ReactNode } from "react";
import type { ExperimentRunStatus, ExperimentStatus } from "@hearth/eval-core";
import { AlertTriangle, Inbox, LoaderCircle } from "lucide-react";
import { statusMeta } from "../lib/labels.ts";

export function PageHeader({
  title,
  description,
  actions
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function StatusPill({ status, subtle = false }: { status: ExperimentRunStatus | ExperimentStatus; subtle?: boolean }) {
  const meta = statusMeta(status);
  return <span className={`status-pill tone-${meta.tone} ${subtle ? "subtle" : ""}`}><i />{meta.label}</span>;
}

export function MetricCard({
  label,
  value,
  detail,
  icon,
  tone = "neutral"
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
}) {
  return (
    <article className={`metric-card tone-${tone}`}>
      <div className="metric-head"><span>{label}</span>{icon && <span className="metric-icon">{icon}</span>}</div>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </article>
  );
}

export function ProgressBar({
  value,
  tone = "accent",
  label
}: {
  value: number | null;
  tone?: "accent" | "success" | "danger" | "warning";
  label?: string;
}) {
  const width = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="progress-wrap">
      {label && <div className="progress-label"><span>{label}</span><strong>{value === null ? "—" : `${value.toFixed(1)}%`}</strong></div>}
      <div className="progress-track"><span className={`progress-fill tone-${tone}`} style={{ width: `${width}%` }} /></div>
    </div>
  );
}

export function ScoreDial({ score, caption }: { score: number | null; caption?: string }) {
  return (
    <div className="score-figure">
      <strong>{score === null ? "—" : score.toFixed(1)}</strong>
      <small>{caption ?? "平均分"}</small>
    </div>
  );
}

export function LoadingState({ text = "正在读取评测数据" }: { text?: string }) {
  return <div className="state-box"><LoaderCircle className="spin" size={20} /><span>{text}</span></div>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state-box error">
      <AlertTriangle size={20} />
      <div><strong>读取失败</strong><span>{error instanceof Error ? error.message : String(error)}</span></div>
      {onRetry && <button className="button" onClick={onRetry}>重试</button>}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <Inbox size={26} />
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

export function SectionHeader({ title, detail, action }: { title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-header">
      <div><h2>{title}</h2>{detail && <span>{detail}</span>}</div>
      {action}
    </div>
  );
}

export function LifecycleRail({ status }: { status: ExperimentRunStatus | ExperimentStatus }) {
  const current = statusMeta(status).step;
  const steps = ["排队", "创建任务", "Agent 执行", "等待处理", "自动评分", "人工复核", "完成"];
  return (
    <div className="lifecycle-rail" aria-label="运行生命周期">
      {steps.map((label, index) => {
        const state = index < current ? "done" : index === current ? "current" : "upcoming";
        return (
          <div key={label} className={`lifecycle-step ${state}`}>
            <span className="lifecycle-node">{index < current ? "✓" : index + 1}</span>
            <small>{label}</small>
          </div>
        );
      })}
    </div>
  );
}

export function KeyValue({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return <div className="key-value"><span>{label}</span><div className={mono ? "mono" : ""}>{children}</div></div>;
}
